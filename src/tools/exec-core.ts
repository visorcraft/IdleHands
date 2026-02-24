import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { checkExecSafety, isProtectedDeleteTarget } from '../safety.js';
import type { ApprovalMode, ExecResult, ToolStreamEvent } from '../types.js';
import { BASH_PATH } from '../utils.js';

import { execWithPty } from './exec-pty.js';
import { hasBackgroundExecIntent, makeExecStreamer } from './exec-utils.js';
import { isWithinDir, resolvePath } from './path-safety.js';
import { autoNoteSysChange } from './sys-notes.js';
import { stripAnsi, dedupeRepeats, collapseStackTraces, truncateBytes } from './text-utils.js';

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

export type ExecToolContext = {
  cwd: string;
  noConfirm: boolean;
  dryRun: boolean;
  mode?: 'code' | 'sys';
  approvalMode?: ApprovalMode;
  maxExecBytes?: number;
  maxExecCaptureBytes?: number;
  signal?: AbortSignal;
  onToolStream?: (ev: ToolStreamEvent) => void | Promise<void>;
  toolCallId?: string;
  toolName?: string;
  toolStreamIntervalMs?: number;
  toolStreamMaxChunkChars?: number;
  toolStreamMaxBufferChars?: number;
  vault?: { note: (k: string, v: string) => Promise<string> };
  confirm?: (
    prompt: string,
    ctx?: { tool?: string; args?: Record<string, unknown>; diff?: string }
  ) => Promise<boolean>;
};

export async function execTool(ctx: ExecToolContext, args: any): Promise<string> {
  const command = typeof args?.command === 'string' ? args.command : undefined;
  const cwd = args?.cwd ? resolvePath(ctx as any, args.cwd) : ctx.cwd;
  const defaultTimeout = ctx.mode === 'sys' ? 60 : 30;
  const timeout = Math.min(args?.timeout ? Number(args.timeout) : defaultTimeout, 120);
  if (!command) throw new Error('exec: missing command');

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
      'exec: blocked background command (contains `&`). Long-running/background jobs can stall one-shot sessions. Run foreground smoke checks only, or use a dedicated service manager outside this task.'
    );
  }

  const verdict = checkExecSafety(command);
  if (verdict.tier === 'forbidden')
    throw new Error(`exec: ${verdict.reason} — command: ${command}`);
  if (isProtectedDeleteTarget(command)) {
    throw new Error(`exec: BLOCKED: rm targeting protected directory — command: ${command}`);
  }

  if (verdict.tier === 'cautious' && !ctx.noConfirm) {
    if (ctx.confirm) {
      const ok = await ctx.confirm(
        verdict.prompt || `About to run:\n\n${command}\n\nProceed? (y/N) `,
        {
          tool: 'exec',
          args: { command },
        }
      );
      if (!ok) throw new Error(`exec: cancelled by user (${verdict.reason}): ${command}`);
    } else if (verdict.reason === 'package install/remove') {
      throw new Error(
        `exec: blocked (${verdict.reason}) without --no-confirm/--yolo: ${command}\nSTOP: this is a session-level approval restriction. Adding --yolo/--no-confirm inside the shell command does NOT override it. Re-run the parent session with --no-confirm or --yolo to allow package operations. Alternatively, the user can install packages manually and re-run this task. Do NOT use spawn_task to bypass this restriction.`
      );
    } else {
      throw new Error(`exec: blocked (${verdict.reason}) without --no-confirm/--yolo: ${command}`);
    }
  }

  if (ctx.dryRun) return `dry-run: would exec in ${cwd}: ${command}`;

  if (/^\s*sudo\s/.test(command) && !process.stdin.isTTY) {
    try {
      const probe = spawnSync('sudo', ['-n', 'true'], { timeout: 5000, stdio: 'ignore' });
      if (probe.status !== 0) {
        throw new Error(
          'exec: sudo requires a TTY for password input, but stdin is not a TTY. Options: run idlehands interactively, configure NOPASSWD for this command, or pre-cache sudo credentials.'
        );
      }
    } catch (e: any) {
      if (e.message?.includes('sudo requires a TTY')) throw e;
    }
  }

  const maxBytes = ctx.maxExecBytes ?? DEFAULT_MAX_EXEC_BYTES;
  const captureLimit = ctx.maxExecCaptureBytes ?? Math.max(maxBytes * 64, 256 * 1024);

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

  try {
    await fs.access(cwd);
  } catch {
    throw new Error(`exec: working directory does not exist: ${cwd}`);
  }

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

  if (killed) errText = (errText ? errText + '\n' : '') + `[killed after ${timeout}s timeout]`;

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

  if (ctx.mode === 'sys' && ctx.vault && rc === 0) {
    autoNoteSysChange(ctx.vault as any, command, outText).catch(() => {});
  }

  return JSON.stringify(result);
}
