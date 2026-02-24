import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { LensStore } from './lens.js';
import type { ReplayStore } from './replay.js';
import { checkExecSafety, checkPathSafety, isProtectedDeleteTarget } from './safety.js';
import { sys_context as sysContextTool } from './sys/context.js';
import { execWithPty } from './tools/exec-pty.js';
import { hasBackgroundExecIntent, makeExecStreamer } from './tools/exec-utils.js';
import { listDirTool, searchFilesTool } from './tools/file-discovery.js';
import { readFileTool, readFilesTool } from './tools/file-read.js';
import { normalizePatchPath, extractTouchedFilesFromPatch } from './tools/patch.js';
import {
  isWithinDir,
  resolvePath,
  redactPath,
  checkCwdWarning,
  enforceMutationWithinCwd,
} from './tools/path-safety.js';
import { checkpointReplay } from './tools/replay-utils.js';
import { bigramSimilarity } from './tools/search-utils.js';
import { autoNoteSysChange, snapshotBeforeEdit } from './tools/sys-notes.js';
import {
  stripAnsi,
  dedupeRepeats,
  collapseStackTraces,
  truncateBytes,
  mutationReadback,
} from './tools/text-utils.js';
import { atomicWrite, backupFile } from './tools/undo.js';
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
  const p = resolvePath(ctx, args?.path);
  const absCwd = path.resolve(ctx.cwd);
  const redactedPath = redactPath(p, absCwd);
  // Content may arrive as a string (normal) or as a parsed JSON object
  // (when llama-server's XML parser auto-parses JSON content values).
  const raw = args?.content;
  const contentWasObject = raw != null && typeof raw === 'object';
  const content =
    typeof raw === 'string' ? raw : contentWasObject ? JSON.stringify(raw, null, 2) : undefined;
  // Warn when content arrives as an object (model passed JSON object instead of string)
  // to help diagnose serialization-induced loops where the model retries thinking it failed.
  if (contentWasObject) {
    console.warn(
      `[write_file] Warning: content for "${args?.path}" arrived as ${typeof raw} — auto-serialized to JSON string. If this was intentional (e.g. package.json), the write succeeded.`
    );
  }
  if (!p) throw new Error('write_file: missing path');
  if (content == null) throw new Error('write_file: missing content (got ' + typeof raw + ')');

  const overwrite = Boolean(args?.overwrite ?? args?.force);

  enforceMutationWithinCwd('write_file', p, ctx);
  const cwdWarning = checkCwdWarning('write_file', p, ctx);

  // Path safety check (Phase 9)
  const pathVerdict = checkPathSafety(p);
  if (pathVerdict.tier === 'forbidden') {
    throw new Error(`write_file: ${pathVerdict.reason}`);
  }
  if (pathVerdict.tier === 'cautious' && !ctx.noConfirm) {
    if (ctx.confirm) {
      const ok = await ctx.confirm(pathVerdict.prompt || `Write to ${redactedPath}?`, {
        tool: 'write_file',
        args: { path: p },
      });
      if (!ok) throw new Error(`write_file: cancelled by user (${pathVerdict.reason})`);
    } else {
      throw new Error(`write_file: blocked (${pathVerdict.reason}) without --no-confirm/--yolo`);
    }
  }

  const existingStat = await fs.stat(p).catch(() => null);
  if (existingStat?.isFile() && existingStat.size > 0 && !overwrite) {
    throw new Error(
      `write_file: refusing to overwrite existing non-empty file ${redactedPath} without explicit overwrite=true (or force=true). ` +
        `Use edit_range/apply_patch for surgical edits, or set overwrite=true for intentional full-file replacement.`
    );
  }

  if (ctx.dryRun) {
    const mode = existingStat?.isFile()
      ? existingStat.size > 0
        ? 'overwrite'
        : 'update-empty'
      : 'create';
    return `dry-run: would write ${p} (${Buffer.byteLength(content, 'utf8')} bytes, mode=${mode}${overwrite ? ', explicit-overwrite' : ''})${cwdWarning}`;
  }

  // Phase 9d: snapshot /etc/ files before editing
  if (ctx.mode === 'sys' && ctx.vault) {
    await snapshotBeforeEdit(ctx.vault, p).catch(() => {});
  }

  const beforeBuf = await fs.readFile(p).catch(() => Buffer.from(''));

  await backupFile(p, ctx);
  await atomicWrite(p, content);
  ctx.onMutation?.(p);

  const afterBuf = Buffer.from(content, 'utf8');
  const replayNote = await checkpointReplay(ctx, {
    op: 'write_file',
    filePath: p,
    before: beforeBuf,
    after: afterBuf,
  });

  const contentLines = content.split(/\r?\n/);
  const readback =
    contentLines.length <= 40
      ? mutationReadback(content, 0, contentLines.length)
      : mutationReadback(content, 0, 20) +
        '\n...\n' +
        mutationReadback(content, contentLines.length - 10, contentLines.length);
  return `wrote ${redactedPath} (${Buffer.byteLength(content, 'utf8')} bytes)${replayNote}${cwdWarning}${readback}`;
}

export async function insert_file(ctx: ToolContext, args: any) {
  const p = resolvePath(ctx, args?.path);
  const absCwd = path.resolve(ctx.cwd);
  const redactedPath = redactPath(p, absCwd);
  const line = Number(args?.line);
  const rawText = args?.text;
  const text =
    typeof rawText === 'string'
      ? rawText
      : rawText != null && typeof rawText === 'object'
        ? JSON.stringify(rawText, null, 2)
        : undefined;
  if (!p) throw new Error('insert_file: missing path');
  if (!Number.isFinite(line)) throw new Error('insert_file: missing/invalid line');
  if (text == null) throw new Error('insert_file: missing text (got ' + typeof rawText + ')');

  enforceMutationWithinCwd('insert_file', p, ctx);

  // Path safety check (Phase 9)
  const pathVerdict = checkPathSafety(p);
  if (pathVerdict.tier === 'forbidden') {
    throw new Error(`insert_file: ${pathVerdict.reason}`);
  }
  if (pathVerdict.tier === 'cautious' && !ctx.noConfirm) {
    if (ctx.confirm) {
      const ok = await ctx.confirm(pathVerdict.prompt || `Insert into ${redactedPath}?`, {
        tool: 'insert_file',
        args: { path: p },
      });
      if (!ok) throw new Error(`insert_file: cancelled by user (${pathVerdict.reason})`);
    } else {
      throw new Error(`insert_file: blocked (${pathVerdict.reason}) without --no-confirm/--yolo`);
    }
  }

  if (ctx.dryRun)
    return `dry-run: would insert into ${redactedPath} at line=${line} (${Buffer.byteLength(text, 'utf8')} bytes)`;

  // Phase 9d: snapshot /etc/ files before editing
  if (ctx.mode === 'sys' && ctx.vault) {
    await snapshotBeforeEdit(ctx.vault, p).catch(() => {});
  }

  const beforeText = await fs.readFile(p, 'utf8').catch(() => '');
  // Detect original newline style
  const eol = beforeText.includes('\r\n') ? '\r\n' : '\n';

  // Handle empty file: just write the inserted text directly (avoid spurious leading newline).
  if (beforeText === '') {
    const out = text;
    await backupFile(p, ctx);
    await atomicWrite(p, out);
    ctx.onMutation?.(p);

    const replayNote = await checkpointReplay(ctx, {
      op: 'insert_file',
      filePath: p,
      before: Buffer.from(beforeText, 'utf8'),
      after: Buffer.from(out, 'utf8'),
    });

    const cwdWarning = checkCwdWarning('insert_file', p, ctx);
    const readback = mutationReadback(out, 0, out.split(/\r?\n/).length);
    return `inserted into ${redactedPath} at 0${replayNote}${cwdWarning}${readback}`;
  }

  const lines = beforeText.split(/\r?\n/);

  let idx: number;
  if (line === -1) idx = lines.length;
  else idx = Math.max(0, Math.min(lines.length, line));

  // When appending to a file that ends with a newline, the split produces a
  // trailing empty element (e.g. "a\n" → ["a",""]). Inserting at lines.length
  // pushes content AFTER that empty element, producing a double-newline on rejoin.
  // Fix: when appending (line === -1) and the last element is empty (trailing newline),
  // insert before the trailing empty element instead.
  if (line === -1 && lines.length > 0 && lines[lines.length - 1] === '') {
    idx = lines.length - 1;
  }

  const insertLines = text.split(/\r?\n/);
  lines.splice(idx, 0, ...insertLines);
  const out = lines.join(eol);

  await backupFile(p, ctx);
  await atomicWrite(p, out);
  ctx.onMutation?.(p);

  const replayNote = await checkpointReplay(ctx, {
    op: 'insert_file',
    filePath: p,
    before: Buffer.from(beforeText, 'utf8'),
    after: Buffer.from(out, 'utf8'),
  });

  const cwdWarning = checkCwdWarning('insert_file', p, ctx);
  const insertEndLine = idx + insertLines.length;
  const readback = mutationReadback(out, idx, insertEndLine);
  return `inserted into ${redactedPath} at ${idx}${replayNote}${cwdWarning}${readback}`;
}

export async function edit_file(ctx: ToolContext, args: any) {
  const p = resolvePath(ctx, args?.path);
  const absCwd = path.resolve(ctx.cwd);
  const redactedPath = redactPath(p, absCwd);
  const rawOld = args?.old_text;
  const oldText =
    typeof rawOld === 'string'
      ? rawOld
      : rawOld != null && typeof rawOld === 'object'
        ? JSON.stringify(rawOld, null, 2)
        : undefined;
  const rawNew = args?.new_text;
  const newText =
    typeof rawNew === 'string'
      ? rawNew
      : rawNew != null && typeof rawNew === 'object'
        ? JSON.stringify(rawNew, null, 2)
        : undefined;
  const replaceAll = Boolean(args?.replace_all);
  if (!p) throw new Error('edit_file: missing path');
  if (oldText == null) throw new Error('edit_file: missing old_text');
  if (newText == null) throw new Error('edit_file: missing new_text');

  enforceMutationWithinCwd('edit_file', p, ctx);

  // Path safety check (Phase 9)
  const pathVerdict = checkPathSafety(p);
  if (pathVerdict.tier === 'forbidden') {
    throw new Error(`edit_file: ${pathVerdict.reason}`);
  }
  if (pathVerdict.tier === 'cautious' && !ctx.noConfirm) {
    if (ctx.confirm) {
      const ok = await ctx.confirm(pathVerdict.prompt || `Edit ${redactedPath}?`, {
        tool: 'edit_file',
        args: { path: p, old_text: oldText, new_text: newText },
      });
      if (!ok) throw new Error(`edit_file: cancelled by user (${pathVerdict.reason})`);
    } else {
      throw new Error(`edit_file: blocked (${pathVerdict.reason}) without --no-confirm/--yolo`);
    }
  }

  // Phase 9d: snapshot /etc/ files before editing
  if (ctx.mode === 'sys' && ctx.vault) {
    await snapshotBeforeEdit(ctx.vault, p).catch(() => {});
  }

  const cur = await fs.readFile(p, 'utf8').catch((e: any) => {
    throw new Error(`edit_file: cannot read ${redactedPath}: ${e?.message ?? String(e)}`);
  });

  const idx = cur.indexOf(oldText);
  if (idx === -1) {
    // Find closest near-match via normalized comparison
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const needle = normalize(oldText);
    const curLines = cur.split(/\r?\n/);
    const needleLines = oldText.split(/\r?\n/).length;

    let bestScore = 0;
    let bestLine = -1;
    let bestText = '';

    for (let i = 0; i < curLines.length; i++) {
      // Build a window of the same number of lines as old_text
      const windowEnd = Math.min(curLines.length, i + needleLines);
      const window = curLines.slice(i, windowEnd).join('\n');
      const normWindow = normalize(window);

      // Similarity: count matching character bigrams (handles differences anywhere, not just prefix).
      const score = bigramSimilarity(needle, normWindow);

      if (score > bestScore) {
        bestScore = score;
        bestLine = i + 1;
        bestText = window;
      }
    }

    let hint = '';
    if (bestScore > 0.3 && bestLine > 0) {
      const preview = bestText.length > 600 ? bestText.slice(0, 600) + '…' : bestText;
      hint = `\nClosest match at line ${bestLine} (${Math.round(bestScore * 100)}% similarity):\n${preview}`;
    } else if (!cur.trim()) {
      hint = `\nFile is empty.`;
    } else {
      hint = `\nFile head (first 400 chars):\n${cur.slice(0, 400)}`;
    }

    throw new Error(
      `edit_file: old_text not found in ${redactedPath}. Re-read the file and retry with exact text.${hint}`
    );
  }

  const next = replaceAll
    ? cur.split(oldText).join(newText)
    : cur.slice(0, idx) + newText + cur.slice(idx + oldText.length);

  if (ctx.dryRun) return `dry-run: would edit ${redactedPath} (replace_all=${replaceAll})`;

  await backupFile(p, ctx);
  await atomicWrite(p, next);
  ctx.onMutation?.(p);

  const replayNote = await checkpointReplay(ctx, {
    op: 'edit_file',
    filePath: p,
    before: Buffer.from(cur, 'utf8'),
    after: Buffer.from(next, 'utf8'),
  });

  const cwdWarning = checkCwdWarning('edit_file', p, ctx);
  // Read-back: find the line range of the replacement in the new content
  const editStartLine = next.slice(0, idx).split(/\r?\n/).length - 1;
  const editEndLine = editStartLine + newText.split(/\r?\n/).length;
  const readback = mutationReadback(next, editStartLine, editEndLine);
  return `edited ${redactedPath} (replace_all=${replaceAll})${replayNote}${cwdWarning}${readback}`;
}

// Patch parsing helpers imported from tools/patch.ts:
// PatchTouchInfo, normalizePatchPath, extractTouchedFilesFromPatch

async function runCommandWithStdin(
  cmd: string,
  cmdArgs: string[],
  stdinText: string,
  cwd: string,
  maxOutBytes: number
): Promise<{ rc: number; out: string; err: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outSeen = 0;
    let errSeen = 0;
    let outCaptured = 0;
    let errCaptured = 0;

    const pushCapped = (chunks: Buffer[], buf: Buffer, kind: 'out' | 'err') => {
      const n = buf.length;
      if (kind === 'out') outSeen += n;
      else errSeen += n;

      const captured = kind === 'out' ? outCaptured : errCaptured;
      const remaining = maxOutBytes - captured;
      if (remaining <= 0) return;
      const take = n <= remaining ? buf : buf.subarray(0, remaining);
      chunks.push(Buffer.from(take));
      if (kind === 'out') outCaptured += take.length;
      else errCaptured += take.length;
    };

    child.stdout.on('data', (d) => pushCapped(outChunks, Buffer.from(d), 'out'));
    child.stderr.on('data', (d) => pushCapped(errChunks, Buffer.from(d), 'err'));

    child.on('error', (e: any) => reject(new Error(`${cmd}: ${e?.message ?? String(e)}`)));
    child.on('close', (code) => {
      const outRaw = stripAnsi(Buffer.concat(outChunks).toString('utf8'));
      const errRaw = stripAnsi(Buffer.concat(errChunks).toString('utf8'));

      const outT = truncateBytes(outRaw, maxOutBytes, outSeen);
      const errT = truncateBytes(errRaw, maxOutBytes, errSeen);

      resolve({ rc: code ?? 0, out: outT.text, err: errT.text });
    });

    child.stdin.write(String(stdinText ?? ''), 'utf8');
    child.stdin.end();
  });
}

export async function edit_range(ctx: ToolContext, args: any) {
  const p = resolvePath(ctx, args?.path);
  const startLine = Number(args?.start_line);
  const endLine = Number(args?.end_line);
  const rawReplacement = args?.replacement;
  const replacement =
    typeof rawReplacement === 'string'
      ? rawReplacement
      : rawReplacement != null && typeof rawReplacement === 'object'
        ? JSON.stringify(rawReplacement, null, 2)
        : undefined;

  if (!p) throw new Error('edit_range: missing path');
  if (!Number.isFinite(startLine) || startLine < 1)
    throw new Error('edit_range: missing/invalid start_line');
  if (!Number.isFinite(endLine) || endLine < startLine)
    throw new Error('edit_range: missing/invalid end_line');
  if (replacement == null)
    throw new Error('edit_range: missing replacement (got ' + typeof rawReplacement + ')');

  const hasLiteralEscapedNewlines = replacement.includes('\\n');
  const hasRealNewlines = replacement.includes('\n') || replacement.includes('\r');
  if (hasLiteralEscapedNewlines && !hasRealNewlines) {
    throw new Error(
      'edit_range: replacement appears double-escaped (contains literal "\\n" sequences). ' +
        'Resend replacement with REAL newline characters (multi-line string), not escaped backslash-n text.'
    );
  }

  enforceMutationWithinCwd('edit_range', p, ctx);

  // Path safety check (Phase 9)
  const pathVerdict = checkPathSafety(p);
  if (pathVerdict.tier === 'forbidden') {
    throw new Error(`edit_range: ${pathVerdict.reason}`);
  }
  if (pathVerdict.tier === 'cautious' && !ctx.noConfirm) {
    if (ctx.confirm) {
      const ok = await ctx.confirm(pathVerdict.prompt || `Edit range in ${p}?`, {
        tool: 'edit_range',
        args: { path: p, start_line: startLine, end_line: endLine },
      });
      if (!ok) throw new Error(`edit_range: cancelled by user (${pathVerdict.reason})`);
    } else {
      throw new Error(`edit_range: blocked (${pathVerdict.reason}) without --no-confirm/--yolo`);
    }
  }

  if (ctx.dryRun)
    return `dry-run: would edit_range ${p} lines ${startLine}-${endLine} (${Buffer.byteLength(replacement, 'utf8')} bytes)`;

  // Phase 9d: snapshot /etc/ files before editing
  if (ctx.mode === 'sys' && ctx.vault) {
    await snapshotBeforeEdit(ctx.vault, p).catch(() => {});
  }

  const beforeText = await fs.readFile(p, 'utf8').catch((e: any) => {
    throw new Error(`edit_range: cannot read ${p}: ${e?.message ?? String(e)}`);
  });

  const eol = beforeText.includes('\r\n') ? '\r\n' : '\n';
  const lines = beforeText.split(/\r?\n/);

  if (startLine > lines.length) {
    throw new Error(
      `edit_range: start_line ${startLine} out of range (file has ${lines.length} lines)`
    );
  }
  if (endLine > lines.length) {
    throw new Error(
      `edit_range: end_line ${endLine} out of range (file has ${lines.length} lines)`
    );
  }

  const startIdx = startLine - 1;
  const deleteCount = endLine - startLine + 1;

  // For deletion, allow empty replacement to remove the range without leaving a blank line.
  const replacementLines = replacement === '' ? [] : replacement.split(/\r?\n/);
  lines.splice(startIdx, deleteCount, ...replacementLines);

  const out = lines.join(eol);

  await backupFile(p, ctx);
  await atomicWrite(p, out);
  ctx.onMutation?.(p);

  const replayNote = await checkpointReplay(ctx, {
    op: 'edit_range',
    filePath: p,
    before: Buffer.from(beforeText, 'utf8'),
    after: Buffer.from(out, 'utf8'),
  });

  const cwdWarning = checkCwdWarning('edit_range', p, ctx);
  const rangeEndLine = startIdx + replacementLines.length;
  const readback = mutationReadback(out, startIdx, rangeEndLine);
  return `edited ${p} lines ${startLine}-${endLine}${replayNote}${cwdWarning}${readback}`;
}

export async function apply_patch(ctx: ToolContext, args: any) {
  const rawPatch = args?.patch;
  const patchText =
    typeof rawPatch === 'string'
      ? rawPatch
      : rawPatch != null && typeof rawPatch === 'object'
        ? JSON.stringify(rawPatch, null, 2)
        : undefined;

  const rawFiles = Array.isArray(args?.files) ? args.files : [];
  const files = rawFiles.map((f: any) => (typeof f === 'string' ? f.trim() : '')).filter(Boolean);

  const stripRaw = Number(args?.strip);
  const strip = Number.isFinite(stripRaw) ? Math.max(0, Math.min(5, Math.floor(stripRaw))) : 0;

  if (!patchText) throw new Error('apply_patch: missing patch');
  if (!files.length) throw new Error('apply_patch: missing files[]');

  const touched = extractTouchedFilesFromPatch(patchText);
  if (!touched.paths.length) {
    throw new Error('apply_patch: patch contains no recognizable file headers');
  }

  const declared = new Set(files.map(normalizePatchPath));
  const unknown = touched.paths.filter((p) => !declared.has(p));
  if (unknown.length) {
    throw new Error(`apply_patch: patch touches undeclared file(s): ${unknown.join(', ')}`);
  }

  const absPaths = touched.paths.map((rel) => resolvePath(ctx, rel));
  for (const abs of absPaths) {
    enforceMutationWithinCwd('apply_patch', abs, ctx);
  }

  // Path safety check (Phase 9)
  const verdicts = absPaths.map((p) => ({ p, v: checkPathSafety(p) }));
  const forbidden = verdicts.filter(({ v }) => v.tier === 'forbidden');
  if (forbidden.length) {
    throw new Error(`apply_patch: ${forbidden[0].v.reason} (${forbidden[0].p})`);
  }

  const cautious = verdicts.filter(({ v }) => v.tier === 'cautious');
  if (cautious.length && !ctx.noConfirm) {
    if (ctx.confirm) {
      const preview =
        patchText.length > 4000 ? patchText.slice(0, 4000) + '\n[truncated]' : patchText;
      const ok = await ctx.confirm(
        `Apply patch touching ${touched.paths.length} file(s)?\n- ${touched.paths.join('\n- ')}\n\nProceed? (y/N) `,
        { tool: 'apply_patch', args: { files: touched.paths, strip }, diff: preview }
      );
      if (!ok) throw new Error('apply_patch: cancelled by user');
    } else {
      throw new Error('apply_patch: blocked (cautious paths) without --no-confirm/--yolo');
    }
  }

  const maxToolBytes = ctx.maxExecBytes ?? DEFAULT_MAX_EXEC_BYTES;
  const stripArg = `-p${strip}`;

  // Dry-run: validate the patch applies cleanly, but do not mutate files.
  if (ctx.dryRun) {
    const haveGit = !spawnSync('git', ['--version'], { stdio: 'ignore' }).error;
    if (haveGit) {
      const chk = await runCommandWithStdin(
        'git',
        ['apply', stripArg, '--check', '--whitespace=nowarn'],
        patchText,
        ctx.cwd,
        maxToolBytes
      );
      if (chk.rc !== 0)
        throw new Error(`apply_patch: git apply --check failed:\n${chk.err || chk.out}`);
    } else {
      const chk = await runCommandWithStdin(
        'patch',
        [stripArg, '--dry-run', '--batch'],
        patchText,
        ctx.cwd,
        maxToolBytes
      );
      if (chk.rc !== 0)
        throw new Error(`apply_patch: patch --dry-run failed:\n${chk.err || chk.out}`);
    }
    const redactedPaths = touched.paths.map((rel) =>
      redactPath(resolvePath(ctx, rel), path.resolve(ctx.cwd))
    );
    return `dry-run: patch would apply cleanly (${touched.paths.length} files): ${redactedPaths.join(', ')}`;
  }

  // Snapshot + backup before applying
  const beforeMap = new Map<string, Buffer>();
  for (const abs of absPaths) {
    // Phase 9d: snapshot /etc/ files before editing
    if (ctx.mode === 'sys' && ctx.vault) {
      await snapshotBeforeEdit(ctx.vault, abs).catch(() => {});
    }

    const before = await fs.readFile(abs).catch(() => Buffer.from(''));
    beforeMap.set(abs, before);
    await backupFile(abs, ctx);
  }

  // Apply with git apply if available; fallback to patch.
  const haveGit = !spawnSync('git', ['--version'], { stdio: 'ignore' }).error;
  if (haveGit) {
    const chk = await runCommandWithStdin(
      'git',
      ['apply', stripArg, '--check', '--whitespace=nowarn'],
      patchText,
      ctx.cwd,
      maxToolBytes
    );
    if (chk.rc !== 0)
      throw new Error(`apply_patch: git apply --check failed:\n${chk.err || chk.out}`);

    const app = await runCommandWithStdin(
      'git',
      ['apply', stripArg, '--whitespace=nowarn'],
      patchText,
      ctx.cwd,
      maxToolBytes
    );
    if (app.rc !== 0) throw new Error(`apply_patch: git apply failed:\n${app.err || app.out}`);
  } else {
    const chk = await runCommandWithStdin(
      'patch',
      [stripArg, '--dry-run', '--batch'],
      patchText,
      ctx.cwd,
      maxToolBytes
    );
    if (chk.rc !== 0)
      throw new Error(`apply_patch: patch --dry-run failed:\n${chk.err || chk.out}`);

    const app = await runCommandWithStdin(
      'patch',
      [stripArg, '--batch'],
      patchText,
      ctx.cwd,
      maxToolBytes
    );
    if (app.rc !== 0) throw new Error(`apply_patch: patch failed:\n${app.err || app.out}`);
  }

  // Replay checkpoints + mutation hooks
  let replayNotes = '';
  let cwdWarnings = '';
  for (const abs of absPaths) {
    const after = await fs.readFile(abs).catch(() => Buffer.from(''));
    ctx.onMutation?.(abs);

    const replayNote = await checkpointReplay(ctx, {
      op: 'apply_patch',
      filePath: abs,
      before: beforeMap.get(abs) ?? Buffer.from(''),
      after,
    });
    replayNotes += replayNote;

    cwdWarnings += checkCwdWarning('apply_patch', abs, ctx);
  }

  const redactedPaths = touched.paths.map((rel) =>
    redactPath(resolvePath(ctx, rel), path.resolve(ctx.cwd))
  );
  // Read-back for each patched file (brief, 3 context lines, max 2 files to avoid bloat)
  let patchReadback = '';
  for (const abs of absPaths.slice(0, 2)) {
    try {
      const content = await fs.readFile(abs, 'utf8');
      const totalLines = content.split(/\r?\n/).length;
      const rp = redactPath(abs, path.resolve(ctx.cwd));
      patchReadback += `\n--- ${rp} (${totalLines} lines) first 20 lines ---\n`;
      patchReadback += content
        .split(/\r?\n/)
        .slice(0, 20)
        .map((l, i) => `${i + 1}: ${l}`)
        .join('\n');
    } catch {
      /* skip unreadable */
    }
  }
  if (absPaths.length > 2) patchReadback += `\n...(${absPaths.length - 2} more files)`;
  return `applied patch (${touched.paths.length} files): ${redactedPaths.join(', ')}${replayNotes}${cwdWarnings}${patchReadback}`;
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
