import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { LensStore } from './lens.js';
import type { ReplayStore } from './replay.js';
import { checkExecSafety, isProtectedDeleteTarget } from './safety.js';
import { sys_context as sysContextTool } from './sys/context.js';
import { execWithPty } from './tools/exec-pty.js';
import { hasBackgroundExecIntent, makeExecStreamer } from './tools/exec-utils.js';
import { listDirTool, searchFilesTool } from './tools/file-discovery.js';
import {
  editFileTool,
  editRangeTool,
  insertFileTool,
  writeFileTool,
} from './tools/file-mutations.js';
import { readFileTool, readFilesTool } from './tools/file-read.js';
import { applyPatchTool } from './tools/patch-apply.js';
import { isWithinDir, resolvePath } from './tools/path-safety.js';
import { autoNoteSysChange } from './tools/sys-notes.js';
import {
  stripAnsi,
  dedupeRepeats,
  collapseStackTraces,
  truncateBytes,
} from './tools/text-utils.js';
import { vaultNoteTool, vaultSearchTool } from './tools/vault-tools.js';
import type { ToolStreamEvent, ApprovalMode, ExecResult } from './types.js';
import { BASH_PATH } from './utils.js';
import type { VaultStore } from './vault.js';

// Re-export from extracted modules so existing imports don't break
export { atomicWrite, undo_path } from './tools/undo.js';
export { snapshotBeforeEdit } from './tools/sys-notes.js';

// Backup/undo system imported from tools/undo.ts (atomicWrite, backupFile, undo_path)

export type ToolContext = {
  cwd: string;
  noConfirm: boolean;
  dryRun: boolean;
  mode?: 'code' | 'sys';
  approvalMode?: ApprovalMode;
  allowedWriteRoots?: string[];
  requireDirPinForMutations?: boolean;
  dirPinned?: boolean;
  repoCandidates?: string[];
  backupDir?: string; // defaults to ~/.local/state/idlehands/backups
  maxExecBytes?: number; // max bytes returned per stream (after processing)
  maxExecCaptureBytes?: number; // max bytes buffered per stream before processing (to prevent OOM)
  maxBackupsPerFile?: number; // FIFO retention (defaults to 5)
  confirm?: (
    prompt: string,
    ctx?: { tool?: string; args?: Record<string, unknown>; diff?: string }
  ) => Promise<boolean>; // interactive confirmation hook
  replay?: ReplayStore;
  vault?: VaultStore;
  lens?: LensStore;
  signal?: AbortSignal; // propagated to exec child processes
  lastEditedPath?: string; // most recently touched file for undo fallback
  onMutation?: (absPath: string) => void; // optional hook for tracking last edited file

  /** Cap for read_file limit (Anton sessions). */
  maxReadLines?: number;

  /** Assigned per tool-call by the agent. */
  toolCallId?: string;
  toolName?: string;

  /** Optional streaming hook for long-running tool output. */
  onToolStream?: (ev: ToolStreamEvent) => void | Promise<void>;

  /** Optional throttling knobs for tool-stream output. */
  toolStreamIntervalMs?: number;
  toolStreamMaxChunkChars?: number;
  toolStreamMaxBufferChars?: number;
};

const DEFAULT_MAX_EXEC_BYTES = 16384;

let ptyUnavailableWarned = false;

async function loadNodePty(): Promise<any | null> {
  try {
    const mod: any = await import('node-pty');
    return mod;
  } catch {
    if (!ptyUnavailableWarned) {
      ptyUnavailableWarned = true;
      console.error(
        '[warn] node-pty not available; interactive sudo is disabled. Install build tools (python3, make, g++) and reinstall to enable it.'
      );
    }
    return null;
  }
}

export async function read_file(ctx: ToolContext, args: any) {
  return readFileTool(ctx, args);
}

export async function read_files(ctx: ToolContext, args: any) {
  return readFilesTool(ctx, args);
}

export async function write_file(ctx: ToolContext, args: any) {
  return writeFileTool(ctx, args);
}

export async function insert_file(ctx: ToolContext, args: any) {
  return insertFileTool(ctx, args);
}

export async function edit_file(ctx: ToolContext, args: any) {
  return editFileTool(ctx, args);
}

export async function edit_range(ctx: ToolContext, args: any) {
  return editRangeTool(ctx, args);
}

export async function apply_patch(ctx: ToolContext, args: any) {
  return applyPatchTool(ctx, args);
}

export async function list_dir(ctx: ToolContext, args: any) {
  return listDirTool(ctx, args);
}
export async function search_files(ctx: ToolContext, args: any) {
  return searchFilesTool(ctx, args, exec);
}

export async function exec(ctx: ToolContext, args: any) {
  const command = typeof args?.command === 'string' ? args.command : undefined;
  const cwd = args?.cwd ? resolvePath(ctx, args.cwd) : ctx.cwd;
  const defaultTimeout = ctx.mode === 'sys' ? 60 : 30;
  const timeout = Math.min(args?.timeout ? Number(args.timeout) : defaultTimeout, 120);
  if (!command) throw new Error('exec: missing command');

  // Out-of-cwd enforcement: block exec cwd or `cd` navigating outside the project.
  // Exception: in yolo/auto-edit mode, allow with a warning instead of blocking.
  const absCwd = path.resolve(ctx.cwd);
  const allowOutsideCwd = ctx.approvalMode === 'yolo' || ctx.approvalMode === 'auto-edit';
  let execCwdWarning = '';
  if (args?.cwd) {
    const absExecCwd = path.resolve(cwd);
    if (!isWithinDir(absExecCwd, absCwd)) {
      if (!allowOutsideCwd) {
        throw new Error(
          `exec: BLOCKED — cwd "${absExecCwd}" is outside the working directory "${absCwd}". Use relative paths and work within the project directory.`
        );
      }
      execCwdWarning = `\n[WARNING] cwd "${absExecCwd}" is outside the working directory "${absCwd}". Proceeding due to ${ctx.approvalMode} mode.`;
    }
  }
  if (command) {
    // Detect absolute paths in `cd` commands
    // - Unix: /path
    // - Windows: C:\path or C:/path or \path
    const cdPattern = /\bcd\s+(['"]?)(\/[^\s'";&|]+|[a-zA-Z]:[\\/][^\s'";&|]*)\1/g;
    let cdMatch: RegExpExecArray | null;
    while ((cdMatch = cdPattern.exec(command)) !== null) {
      const cdTarget = path.resolve(cdMatch[2]);
      if (!isWithinDir(cdTarget, absCwd)) {
        if (!allowOutsideCwd) {
          throw new Error(
            `exec: BLOCKED — command navigates to "${cdTarget}" which is outside the working directory "${absCwd}". Use relative paths and work within the project directory.`
          );
        }
        execCwdWarning = `\n[WARNING] Command navigates to "${cdTarget}" which is outside the working directory "${absCwd}". Proceeding due to ${ctx.approvalMode} mode.`;
      }
    }
    // Detect absolute paths in file-creating commands (mkdir, cat >, tee, touch, etc.)
    const absPathPattern =
      /(?:mkdir|cat\s*>|tee|touch|cp|mv|rm|rmdir)\s+(?:-\S+\s+)*(['"]?)(\/[^\s'";&|]+|[a-zA-Z]:[\\/][^\s'";&|]*)\1/g;
    let apMatch: RegExpExecArray | null;
    while ((apMatch = absPathPattern.exec(command)) !== null) {
      const absTarget = path.resolve(apMatch[2]);
      if (!isWithinDir(absTarget, absCwd)) {
        if (!allowOutsideCwd) {
          throw new Error(
            `exec: BLOCKED — command targets "${absTarget}" which is outside the working directory "${absCwd}". Use relative paths to work within the project directory.`
          );
        }
        execCwdWarning = `\n[WARNING] Command targets "${absTarget}" which is outside the working directory "${absCwd}". Proceeding due to ${ctx.approvalMode} mode.`;
      }
    }
  }

  if (hasBackgroundExecIntent(command)) {
    throw new Error(
      'exec: blocked background command (contains `&`). ' +
        'Long-running/background jobs can stall one-shot sessions. ' +
        'Run foreground smoke checks only, or use a dedicated service manager outside this task.'
    );
  }

  // ── Safety tier check (Phase 9) ──
  const verdict = checkExecSafety(command);

  // Forbidden: ALWAYS blocked, even in yolo/noConfirm mode. No override.
  if (verdict.tier === 'forbidden') {
    throw new Error(`exec: ${verdict.reason} — command: ${command}`);
  }

  // Extra protection: block rm targeting protected root directories
  if (isProtectedDeleteTarget(command)) {
    throw new Error(`exec: BLOCKED: rm targeting protected directory — command: ${command}`);
  }

  // Cautious: require confirmation unless yolo/noConfirm
  if (verdict.tier === 'cautious' && !ctx.noConfirm) {
    if (ctx.confirm) {
      const ok = await ctx.confirm(
        verdict.prompt || `About to run:\n\n${command}\n\nProceed? (y/N) `,
        { tool: 'exec', args: { command } }
      );
      if (!ok) {
        throw new Error(`exec: cancelled by user (${verdict.reason}): ${command}`);
      }
    } else {
      if (verdict.reason === 'package install/remove') {
        throw new Error(
          `exec: blocked (${verdict.reason}) without --no-confirm/--yolo: ${command}\n` +
            `STOP: this is a session-level approval restriction. Adding --yolo/--no-confirm inside the shell command does NOT override it. ` +
            `Re-run the parent session with --no-confirm or --yolo to allow package operations. ` +
            `Alternatively, the user can install packages manually and re-run this task. ` +
            `Do NOT use spawn_task to bypass this restriction.`
        );
      }
      throw new Error(`exec: blocked (${verdict.reason}) without --no-confirm/--yolo: ${command}`);
    }
  }

  if (ctx.dryRun) return `dry-run: would exec in ${cwd}: ${command}`;

  // ── Sudo handling (Phase 9c) ──
  // Non-TTY: probe for NOPASSWD / cached credentials before running.
  if (/^\s*sudo\s/.test(command) && !process.stdin.isTTY) {
    try {
      const probe = spawnSync('sudo', ['-n', 'true'], { timeout: 5000, stdio: 'ignore' });
      if (probe.status !== 0) {
        throw new Error(
          'exec: sudo requires a TTY for password input, but stdin is not a TTY. ' +
            'Options: run idlehands interactively, configure NOPASSWD for this command, or pre-cache sudo credentials.'
        );
      }
    } catch (e: any) {
      if (e.message?.includes('sudo requires a TTY')) throw e;
      // spawnSync error (sudo not found, etc.) — let the actual command fail naturally
    }
  }

  const maxBytes = ctx.maxExecBytes ?? DEFAULT_MAX_EXEC_BYTES;
  const captureLimit = ctx.maxExecCaptureBytes ?? Math.max(maxBytes * 64, 256 * 1024);

  // TTY interactive sudo path (Phase 9c): use node-pty when available.
  if (/^\s*sudo\s/.test(command) && process.stdin.isTTY) {
    const pty = await loadNodePty();
    if (!pty) {
      throw new Error(
        'exec: interactive sudo requires node-pty, but it is not installed. Install optional dependency `node-pty` (build tools: python3, make, g++) or use non-interactive sudo (NOPASSWD/cached credentials).'
      );
    }
    return await execWithPty({
      pty,
      command,
      cwd,
      timeout,
      maxBytes,
      captureLimit,
      signal: ctx.signal,
      execCwdWarning,
    });
  }

  // Validate cwd exists — spawn throws a cryptic ENOENT if it doesn't.
  try {
    await fs.access(cwd);
  } catch {
    throw new Error(`exec: working directory does not exist: ${cwd}`);
  }

  // Use spawn with shell:true — lets Node.js resolve the shell internally,
  // avoiding ENOENT issues with explicit bash paths in certain environments.
  const child = spawn(command, [], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: BASH_PATH,
    detached: true,
  });

  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  let outSeen = 0;
  let errSeen = 0;
  let outCaptured = 0;
  let errCaptured = 0;
  let killed = false;

  const killProcessGroup = () => {
    const pid = child.pid;
    if (!pid) return;
    try {
      // detached:true places the shell in its own process group.
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  };

  const killTimer = setTimeout(
    () => {
      killed = true;
      killProcessGroup();
    },
    Math.max(1, timeout) * 1000
  );

  // §11: kill child process if parent abort signal fires (Ctrl+C).
  const onAbort = () => {
    killed = true;
    killProcessGroup();
  };
  ctx.signal?.addEventListener('abort', onAbort, { once: true });

  const pushCapped = (chunks: Buffer[], buf: Buffer, kind: 'out' | 'err') => {
    const n = buf.length;
    if (kind === 'out') outSeen += n;
    else errSeen += n;

    const captured = kind === 'out' ? outCaptured : errCaptured;
    const remaining = captureLimit - captured;
    if (remaining <= 0) return;

    const take = n <= remaining ? buf : buf.subarray(0, remaining);
    chunks.push(Buffer.from(take));
    if (kind === 'out') outCaptured += take.length;
    else errCaptured += take.length;
  };

  const streamer = makeExecStreamer(ctx);

  child.stdout.on('data', (d) => {
    pushCapped(outChunks, d, 'out');
    streamer?.push('stdout', stripAnsi(d.toString('utf8')));
  });
  child.stderr.on('data', (d) => {
    pushCapped(errChunks, d, 'err');
    streamer?.push('stderr', stripAnsi(d.toString('utf8')));
  });

  const rc: number = await new Promise((resolve, reject) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(killTimer);
      ctx.signal?.removeEventListener('abort', onAbort);
      reject(
        new Error(
          `exec: failed to spawn shell (cwd=${cwd}): ${err.message} (${err.code ?? 'unknown'})`
        )
      );
    });
    child.on('close', (code) => resolve(code ?? 0));
  });

  clearTimeout(killTimer);
  ctx.signal?.removeEventListener('abort', onAbort);
  streamer?.done();

  const outRaw = stripAnsi(Buffer.concat(outChunks).toString('utf8'));
  const errRaw = stripAnsi(Buffer.concat(errChunks).toString('utf8'));

  const outLines = collapseStackTraces(dedupeRepeats(outRaw.split(/\r?\n/)))
    .join('\n')
    .trimEnd();
  const errLines = collapseStackTraces(dedupeRepeats(errRaw.split(/\r?\n/)))
    .join('\n')
    .trimEnd();

  const outT = truncateBytes(outLines, maxBytes, outSeen);
  const errT = truncateBytes(errLines, maxBytes, errSeen);

  let outText = outT.text;
  let errText = errT.text;

  const capOut = outSeen > outCaptured;
  const capErr = errSeen > errCaptured;

  // If we had to cap capture but the post-processed output ended up short
  // (e.g., massive repeated output collapsed), still surface that truncation.
  if (capOut && !outT.truncated) {
    outText = truncateBytes(
      outText + `\n[capture truncated, ${outSeen} bytes total]`,
      maxBytes,
      outSeen
    ).text;
  }
  if (capErr && !errT.truncated) {
    errText = truncateBytes(
      errText + `\n[capture truncated, ${errSeen} bytes total]`,
      maxBytes,
      errSeen
    ).text;
  }

  if (killed) {
    errText = (errText ? errText + '\n' : '') + `[killed after ${timeout}s timeout]`;
  }

  // When any command produces no output, add an explicit semantic hint so the
  // model understands the result and doesn't retry the same command in a loop.
  if (!outText && !errText && !killed) {
    if (rc === 0) {
      outText =
        '[command completed successfully with no output. Do NOT retry — the command worked but produced no output. Move on to the next step.]';
    } else if (rc === 1) {
      outText =
        '[no matches found — the command returned zero results (exit code 1). Do NOT retry this command with the same arguments. The target simply has no matches. Move on or try different search terms/parameters.]';
    } else {
      outText = `[command exited with code ${rc} and produced no output. Do NOT retry with identical arguments — diagnose the issue or try a different approach.]`;
    }
  }

  const result: ExecResult = {
    rc,
    out: outText,
    err: errText,
    truncated: outT.truncated || errT.truncated || capOut || capErr,
    ...(execCwdWarning && { warnings: [execCwdWarning.trim()] }),
  };

  // Phase 9d: auto-note system changes in sys mode
  if (ctx.mode === 'sys' && ctx.vault && rc === 0) {
    autoNoteSysChange(ctx.vault, command, outText).catch(() => {});
  }

  return JSON.stringify(result);
}

export async function vault_note(ctx: ToolContext, args: any) {
  return vaultNoteTool(ctx, args);
}

export async function vault_search(ctx: ToolContext, args: any) {
  return vaultSearchTool(ctx, args);
}

/** Phase 9: sys_context tool (mode-gated in agent schema). */
export async function sys_context(ctx: ToolContext, args: any) {
  return sysContextTool(ctx, args);
}

// Path safety helpers imported from tools/path-safety.ts:
// isWithinDir, resolvePath, redactPath, checkCwdWarning, enforceMutationWithinCwd
