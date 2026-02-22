import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { ExecResult, type ToolStreamEvent, type ApprovalMode } from './types.js';
import { ToolError } from './tools/tool-error.js';

import type { ReplayStore } from './replay.js';
import type { VaultStore } from './vault.js';
import type { LensStore } from './lens.js';
import { checkExecSafety, checkPathSafety, isProtectedDeleteTarget } from './safety.js';
import { sys_context as sysContextTool } from './sys/context.js';
import { stateDir, shellEscape, BASH_PATH } from './utils.js';

const DEFAULT_MAX_BACKUPS_PER_FILE = 5;

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
  confirm?: (prompt: string, ctx?: { tool?: string; args?: Record<string, unknown>; diff?: string }) => Promise<boolean>; // interactive confirmation hook
  replay?: ReplayStore;
  vault?: VaultStore;
  lens?: LensStore;
  signal?: AbortSignal; // propagated to exec child processes
  lastEditedPath?: string; // most recently touched file for undo fallback
  onMutation?: (absPath: string) => void; // optional hook for tracking last edited file

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
      console.error('[warn] node-pty not available; interactive sudo is disabled. Install build tools (python3, make, g++) and reinstall to enable it.');
    }
    return null;
  }
}

/** Best-effort MIME type guess from magic bytes + extension (§7/§8). */
function guessMimeType(filePath: string, buf: Buffer): string {
  // Magic byte signatures
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'; // RIFF+WEBP
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'application/zip';
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return 'application/x-elf';
    if (buf[0] === 0x1f && buf[1] === 0x8b) return 'application/gzip';
  }
  // Fall back to extension
  const ext = path.extname(filePath).toLowerCase();
  const extMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
    '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
    '.wasm': 'application/wasm', '.so': 'application/x-sharedlib',
    '.exe': 'application/x-executable', '.o': 'application/x-object',
  };
  return extMap[ext] ?? 'application/octet-stream';
}

function defaultBackupDir() {
  return path.join(stateDir(), 'backups');
}

function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function keyFromPath(absPath: string) {
  return sha256(absPath);
}

function backupDirForPath(ctx: ToolContext, absPath: string) {
  const bdir = ctx.backupDir ?? defaultBackupDir();
  const key = keyFromPath(absPath);
  return { bdir, key, keyDir: path.join(bdir, key) };
}

function formatBackupTs() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function restoreLatestBackup(absPath: string, ctx: ToolContext): Promise<string> {
  const { key, keyDir } = backupDirForPath(ctx, absPath);
  const legacyDir = ctx.backupDir ?? defaultBackupDir();

  const latestInDir = async (dir: string): Promise<string | undefined> => {
    const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    return ents
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((n) => n.endsWith('.bak'))
      .sort()
      .reverse()[0];
  };

  let bakDir = keyDir;
  let bakFile = await latestInDir(keyDir);

  if (!bakFile) {
    // Compatibility with older flat backup format (without nested key dir).
    const ents = await fs.readdir(legacyDir, { withFileTypes: true }).catch(() => []);
    const legacy = ents
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((n) => n.startsWith(`${key}.`) && !n.endsWith('.json'))
      .sort()
      .reverse()[0];
    if (legacy) {
      bakFile = legacy;
      bakDir = legacyDir;
    }
  }

  if (!bakFile) {
    throw new Error(`undo: no backups found for ${absPath} in ${legacyDir}`);
  }

  const bakPath = path.join(bakDir, bakFile);
  const buf = await fs.readFile(bakPath);

  // backup current file before restoring
  await backupFile(absPath, ctx);
  await atomicWrite(absPath, buf);
  return `restored ${absPath} from backup ${bakPath}`;
}

function stripAnsi(s: string) {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')   // CSI sequences (SGR, cursor, erase, scroll, etc.)
    .replace(/\u001b\][^\u0007]*\u0007/g, '')   // OSC sequences
    .replace(/\u001b[()][AB012]/g, '')           // Character set selection
    .replace(/\u001b[=>Nc7-9]/g, '');            // Other common single-char escapes
}

function dedupeRepeats(lines: string[], maxLineLen = 400) {
  const out: string[] = [];
  let prev: string | null = null;
  let count = 0;
  const flush = () => {
    if (prev == null) return;
    if (count <= 1) out.push(prev);
    else out.push(prev, `[repeated ${count - 1} more times]`);
  };

  for (const raw of lines) {
    const line = raw.length > maxLineLen ? raw.slice(0, maxLineLen) + '…' : raw;
    if (prev === line) {
      count++;
      continue;
    }
    flush();
    prev = line;
    count = 1;
  }
  flush();
  return out;
}

function collapseStackTraces(lines: string[]): string[] {
  const out: string[] = [];
  let inStack = false;
  let stackCount = 0;
  let firstFrame = '';
  let lastError = '';

  const isStackFrame = (l: string) => /^\s+at\s/.test(l);

  const flush = () => {
    if (!inStack) return;
    if (firstFrame) out.push(firstFrame);
    if (stackCount > 1) out.push(`    [${stackCount - 1} more frames]`);
    if (lastError) out.push(lastError);
    inStack = false;
    stackCount = 0;
    firstFrame = '';
    lastError = '';
  };

  for (const line of lines) {
    if (isStackFrame(line)) {
      if (!inStack) {
        inStack = true;
        stackCount = 1;
        firstFrame = line;
      } else {
        stackCount++;
      }
    } else {
      if (inStack) {
        // Lines between stack frames that look like error messages
        if (/^\w*(Error|Exception|Caused by)/.test(line.trim())) {
          lastError = line;
          continue;
        }
        flush();
      }
      out.push(line);
    }
  }
  flush();
  return out;
}

function truncateBytes(
  s: string,
  maxBytes: number,
  totalBytesHint?: number
): { text: string; truncated: boolean } {
  const b = Buffer.from(s, 'utf8');
  const total = typeof totalBytesHint === 'number' && Number.isFinite(totalBytesHint) ? totalBytesHint : b.length;
  if (b.length <= maxBytes) return { text: s, truncated: false };
  // cut to boundary
  const cut = b.subarray(0, maxBytes);
  return { text: cut.toString('utf8') + `\n[truncated, ${total} bytes total]`, truncated: true };
}

async function rotateBackups(absPath: string, ctx: ToolContext) {
  const { keyDir } = backupDirForPath(ctx, absPath);
  const limit = ctx.maxBackupsPerFile ?? DEFAULT_MAX_BACKUPS_PER_FILE;
  if (limit <= 0) return;

  await fs.mkdir(keyDir, { recursive: true });

  const ents = await fs.readdir(keyDir, { withFileTypes: true }).catch(() => []);
  const backups = ents
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => n.endsWith('.bak'))
    .sort(); // oldest → newest due to ISO timestamp

  const toDelete = backups.length > limit ? backups.slice(0, backups.length - limit) : [];
  for (const name of toDelete) {
    const bak = path.join(keyDir, name);
    const meta = path.join(keyDir, `${name.replace(/\.bak$/, '')}.meta.json`);
    await fs.rm(bak, { force: true }).catch(() => {});
    await fs.rm(meta, { force: true }).catch(() => {});
  }
}

async function backupFile(absPath: string, ctx: ToolContext) {
  const { bdir, keyDir } = backupDirForPath(ctx, absPath);
  await fs.mkdir(bdir, { recursive: true });
  await fs.mkdir(keyDir, { recursive: true });

  // Auto-create .gitignore in state dir to prevent backups from being committed
  const gitignorePath = path.join(bdir, '.gitignore');
  await fs.writeFile(gitignorePath, '*\n', { flag: 'wx' }).catch(() => {});
  // 'wx' flag = create only if doesn't exist, silently skip if it does

  const st = await fs.stat(absPath).catch(() => null);
  if (!st || !st.isFile()) return;

  const content = await fs.readFile(absPath);
  const hash = crypto.createHash('sha256').update(content).digest('hex');

  const ts = formatBackupTs();
  const bakName = `${ts}.bak`;
  const metaName = `${ts}.meta.json`;
  const bakPath = path.join(keyDir, bakName);
  const metaPath = path.join(keyDir, metaName);

  await fs.writeFile(bakPath, content);
  await fs.writeFile(
    metaPath,
    JSON.stringify({ original_path: absPath, timestamp: ts, size: st.size, sha256_before: hash }, null, 2) + '\n',
    'utf8'
  );

  await rotateBackups(absPath, ctx);
}

async function checkpointReplay(ctx: ToolContext, payload: Parameters<ReplayStore['checkpoint']>[0]): Promise<string> {
  if (!ctx.replay) return '';

  let note: string | undefined;
  if (ctx.lens && payload.before && payload.after) {
    try {
      note = await ctx.lens.summarizeDiffToText(payload.before.toString('utf8'), payload.after.toString('utf8'), payload.filePath);
    } catch {
      // ignore and fallback to raw checkpoint
    }
  }

  try {
    await ctx.replay.checkpoint({ ...payload, note });
    return '';
  } catch (e: any) {
    return ` replay_skipped: ${e?.message ?? String(e)}`;
  }
}

export async function atomicWrite(absPath: string, data: string | Buffer) {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });

  // Capture original permissions before overwriting
  const origStat = await fs.stat(absPath).catch(() => null);
  const origMode = origStat?.mode;

  const tmp = path.join(dir, `.${path.basename(absPath)}.idlehands.tmp.${process.pid}.${Date.now()}`);
  await fs.writeFile(tmp, data);

  // Restore original file mode bits if the file existed
  if (origMode != null) {
    await fs.chmod(tmp, origMode & 0o7777).catch(() => {});
  }

  await fs.rename(tmp, absPath);
}

export async function undo_path(ctx: ToolContext, args: any) {
  const directPath = args?.path === undefined ? undefined : String(args.path);
  const p = directPath ? resolvePath(ctx, directPath) : ctx.lastEditedPath;
  if (!p) throw new Error('undo: missing path');
  if (!ctx.noConfirm && ctx.confirm) {
    const ok = await ctx.confirm(`Restore latest backup for:\n  ${p}\nThis will overwrite the current file. Proceed? (y/N) `);
    if (!ok) return 'undo: cancelled';
  }
  if (!ctx.noConfirm && !ctx.confirm) {
    throw new Error('undo: confirmation required (run with --no-confirm/--yolo or in interactive mode)');
  }
  if (ctx.dryRun) return `dry-run: would restore latest backup for ${p}`;
  return await restoreLatestBackup(p, ctx);
}

export async function read_file(ctx: ToolContext, args: any) {
  const p = resolvePath(ctx, args?.path);
  const offset = args?.offset != null ? Number(args.offset) : undefined;

  const rawLimit = args?.limit != null ? Number(args.limit) : undefined;
  const limit = Number.isFinite(rawLimit as number) && (rawLimit as number) > 0
    ? Math.max(1, Math.floor(rawLimit as number))
    : 200;

  const search = typeof args?.search === 'string' ? args.search : undefined;

  const rawContext = args?.context != null ? Number(args.context) : undefined;
  const context = Number.isFinite(rawContext as number) && (rawContext as number) >= 0
    ? Math.max(0, Math.min(200, Math.floor(rawContext as number)))
    : 10;

  const formatRaw = typeof args?.format === 'string' ? args.format.trim().toLowerCase() : 'numbered';
  const format: 'plain' | 'numbered' | 'sparse' =
    (formatRaw === 'plain' || formatRaw === 'numbered' || formatRaw === 'sparse')
      ? (formatRaw as 'plain' | 'numbered' | 'sparse')
      : 'numbered';

  const rawMaxBytes = args?.max_bytes != null ? Number(args.max_bytes) : undefined;
  const maxBytes = Number.isFinite(rawMaxBytes as number) && (rawMaxBytes as number) > 0
    ? Math.min(256 * 1024, Math.max(256, Math.floor(rawMaxBytes as number)))
    : 20 * 1024;

  if (!p) throw new Error('read_file: missing path');

  // Detect directories early with a helpful message instead of cryptic EISDIR
  try {
    const stat = await fs.stat(p);
    if (stat.isDirectory()) {
      return `read_file: "${p}" is a directory, not a file. Use list_dir to see its contents, or search_files to find specific code.`;
    }
  } catch (e: any) {
    // stat failure (ENOENT etc.) — let readFile handle it for the standard error path
  }

  const buf = await fs.readFile(p).catch((e: any) => {
    throw new Error(`read_file: cannot read ${p}: ${e?.message ?? String(e)}`);
  });

  // Binary detection: NUL byte in first 512 bytes (§8)
  for (let i = 0; i < Math.min(buf.length, 512); i++) {
    if (buf[i] === 0) {
      const mimeGuess = guessMimeType(p, buf);
      return `[binary file, ${buf.length} bytes, detected type: ${mimeGuess}]`;
    }
  }

  const text = buf.toString('utf8');

  if (!text) {
    return `# ${p}\n[file is empty (0 bytes)]`;
  }

  const lines = text.split(/\r?\n/);

  let start = 1;
  let end = Math.min(lines.length, limit);

  let matchLines: number[] = [];

  if (search) {
    matchLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(search)) matchLines.push(i + 1);
    }
    if (!matchLines.length) {
      return truncateBytes(
        `# ${p}\n# search not found: ${JSON.stringify(search)}\n# file has ${lines.length} lines`,
        maxBytes
      ).text;
    }
    const firstIdx = matchLines[0];
    // Window around the first match, but never return more than `limit` lines.
    start = Math.max(1, firstIdx - context);
    end = Math.min(lines.length, firstIdx + context);
    if (end - start + 1 > limit) {
      const half = Math.floor(limit / 2);
      start = Math.max(1, firstIdx - half);
      end = Math.min(lines.length, start + limit - 1);
    }
  } else if (offset && offset >= 1) {
    start = Math.max(1, Math.floor(offset));
    end = Math.min(lines.length, start + limit - 1);
  }

  const matchSet = new Set<number>(matchLines);

  const out: string[] = [];
  out.push(`# ${p} (lines ${start}-${end} of ${lines.length})`);

  if (search) {
    const shown = matchLines.slice(0, 20);
    out.push(`# matches at lines: ${shown.join(', ')}${matchLines.length > shown.length ? ' …' : ''}`);
  }

  const renderNumbered = (ln: number, body: string) => `${ln}| ${body}`;

  for (let ln = start; ln <= end; ln++) {
    const body = lines[ln - 1] ?? '';

    if (format === 'plain') {
      out.push(body);
      continue;
    }

    if (format === 'numbered') {
      out.push(renderNumbered(ln, body));
      continue;
    }

    // sparse: number anchor lines + matches; otherwise raw text.
    const isAnchor = ln === start || ln === end || (ln - start) % 10 === 0;
    if (isAnchor || matchSet.has(ln)) out.push(renderNumbered(ln, body));
    else out.push(body);
  }

  if (end < lines.length) out.push(`# ... (${lines.length - end} more lines)`);

  return truncateBytes(out.join('\n'), maxBytes).text;
}

export async function read_files(ctx: ToolContext, args: any) {
  const reqs = Array.isArray(args?.requests) ? args.requests : [];
  if (!reqs.length) throw new ToolError('invalid_args', 'read_files: missing requests[]', false, 'Provide requests as an array of {path, limit,...} objects.');

  const parts: string[] = [];
  let failures = 0;

  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i];
    const p = typeof r?.path === 'string' ? r.path : `request[${i}]`;
    try {
      parts.push(await read_file(ctx, r));
    } catch (e: any) {
      failures++;
      const te = ToolError.fromError(e, 'internal');
      parts.push(`[file:${p}] ERROR: code=${te.code} msg=${te.message}`);
    }
    parts.push('');
  }

  if (failures > 0) {
    parts.push(`# read_files completed with partial failures: ${failures}/${reqs.length}`);
  }

  return parts.join('\n');
}

export async function write_file(ctx: ToolContext, args: any) {
  const p = resolvePath(ctx, args?.path);
  // Content may arrive as a string (normal) or as a parsed JSON object
  // (when llama-server's XML parser auto-parses JSON content values).
  const raw = args?.content;
  const contentWasObject = raw != null && typeof raw === 'object';
  const content = typeof raw === 'string' ? raw
    : (contentWasObject ? JSON.stringify(raw, null, 2) : undefined);
  // Warn when content arrives as an object (model passed JSON object instead of string)
  // to help diagnose serialization-induced loops where the model retries thinking it failed.
  if (contentWasObject) {
    console.warn(`[write_file] Warning: content for "${args?.path}" arrived as ${typeof raw} — auto-serialized to JSON string. If this was intentional (e.g. package.json), the write succeeded.`);
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
      const ok = await ctx.confirm(
        pathVerdict.prompt || `Write to ${p}?`,
        { tool: 'write_file', args: { path: p } }
      );
      if (!ok) throw new Error(`write_file: cancelled by user (${pathVerdict.reason})`);
    } else {
      throw new Error(`write_file: blocked (${pathVerdict.reason}) without --no-confirm/--yolo`);
    }
  }

  const existingStat = await fs.stat(p).catch(() => null);
  if (existingStat?.isFile() && existingStat.size > 0 && !overwrite) {
    throw new Error(
      `write_file: refusing to overwrite existing non-empty file ${p} without explicit overwrite=true (or force=true). ` +
      `Use edit_range/apply_patch for surgical edits, or set overwrite=true for intentional full-file replacement.`
    );
  }

  if (ctx.dryRun) {
    const mode = existingStat?.isFile() ? (existingStat.size > 0 ? 'overwrite' : 'update-empty') : 'create';
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
  const replayNote = await checkpointReplay(ctx, { op: 'write_file', filePath: p, before: beforeBuf, after: afterBuf });

  return `wrote ${p} (${Buffer.byteLength(content, 'utf8')} bytes)${replayNote}${cwdWarning}`;
}

export async function insert_file(ctx: ToolContext, args: any) {
  const p = resolvePath(ctx, args?.path);
  const line = Number(args?.line);
  const rawText = args?.text;
  const text = typeof rawText === 'string' ? rawText
    : (rawText != null && typeof rawText === 'object' ? JSON.stringify(rawText, null, 2) : undefined);
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
      const ok = await ctx.confirm(
        pathVerdict.prompt || `Insert into ${p}?`,
        { tool: 'insert_file', args: { path: p } }
      );
      if (!ok) throw new Error(`insert_file: cancelled by user (${pathVerdict.reason})`);
    } else {
      throw new Error(`insert_file: blocked (${pathVerdict.reason}) without --no-confirm/--yolo`);
    }
  }

  if (ctx.dryRun) return `dry-run: would insert into ${p} at line=${line} (${Buffer.byteLength(text, 'utf8')} bytes)`;

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
      after: Buffer.from(out, 'utf8')
    });

    const cwdWarning = checkCwdWarning('insert_file', p, ctx);
    return `inserted into ${p} at 0${replayNote}${cwdWarning}`;
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
    after: Buffer.from(out, 'utf8')
  });

  const cwdWarning = checkCwdWarning('insert_file', p, ctx);
  return `inserted into ${p} at ${idx}${replayNote}${cwdWarning}`;
}

export async function edit_file(ctx: ToolContext, args: any) {
  const p = resolvePath(ctx, args?.path);
  const rawOld = args?.old_text;
  const oldText = typeof rawOld === 'string' ? rawOld
    : (rawOld != null && typeof rawOld === 'object' ? JSON.stringify(rawOld, null, 2) : undefined);
  const rawNew = args?.new_text;
  const newText = typeof rawNew === 'string' ? rawNew
    : (rawNew != null && typeof rawNew === 'object' ? JSON.stringify(rawNew, null, 2) : undefined);
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
      const ok = await ctx.confirm(
        pathVerdict.prompt || `Edit ${p}?`,
        { tool: 'edit_file', args: { path: p, old_text: oldText, new_text: newText } }
      );
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
    throw new Error(`edit_file: cannot read ${p}: ${e?.message ?? String(e)}`);
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
      `edit_file: old_text not found in ${p}. Re-read the file and retry with exact text.${hint}`
    );
  }

  const next = replaceAll ? cur.split(oldText).join(newText) : cur.slice(0, idx) + newText + cur.slice(idx + oldText.length);

  if (ctx.dryRun) return `dry-run: would edit ${p} (replace_all=${replaceAll})`;

  await backupFile(p, ctx);
  await atomicWrite(p, next);
  ctx.onMutation?.(p);

  const replayNote = await checkpointReplay(ctx, {
    op: 'edit_file',
    filePath: p,
    before: Buffer.from(cur, 'utf8'),
    after: Buffer.from(next, 'utf8')
  });

  const cwdWarning = checkCwdWarning('edit_file', p, ctx);
  return `edited ${p} (replace_all=${replaceAll})${replayNote}${cwdWarning}`;
}

type PatchTouchInfo = {
  paths: string[]; // normalized relative paths
  created: Set<string>;
  deleted: Set<string>;
};

function normalizePatchPath(p: string): string {
  let s = String(p ?? '').trim();
  if (!s || s === '/dev/null') return '';

  // Strip quotes some generators add
  s = s.replace(/^"|"$/g, '');
  // Drop common diff prefixes
  s = s.replace(/^[ab]\//, '').replace(/^\.\/+/, '');
  // Normalize to posix separators for diffs
  s = s.replace(/\\/g, '/');

  const norm = path.posix.normalize(s);
  if (norm.startsWith('../') || norm === '..' || norm.startsWith('/')) {
    throw new Error(`apply_patch: unsafe path in patch: ${JSON.stringify(s)}`);
  }
  return norm;
}

function extractTouchedFilesFromPatch(patchText: string): PatchTouchInfo {
  const paths: string[] = [];
  const created = new Set<string>();
  const deleted = new Set<string>();

  let pendingOld: string | null = null;
  let pendingNew: string | null = null;

  const seen = new Set<string>();
  const lines = String(patchText ?? '').split(/\r?\n/);

  for (const line of lines) {
    // Primary: git-style header
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git\s+a\/(.+?)\s+b\/(.+?)\s*$/.exec(line);
      if (m) {
        const aPath = normalizePatchPath(m[1]);
        const bPath = normalizePatchPath(m[2]);
        const use = bPath || aPath;
        if (use && !seen.has(use)) {
          seen.add(use);
          paths.push(use);
        }
      }
      pendingOld = null;
      pendingNew = null;
      continue;
    }

    // Fallback: unified diff headers
    if (line.startsWith('--- ')) {
      pendingOld = line.slice(4).trim();
      continue;
    }
    if (line.startsWith('+++ ')) {
      pendingNew = line.slice(4).trim();

      const oldP = pendingOld ? pendingOld.replace(/^a\//, '').trim() : '';
      const newP = pendingNew ? pendingNew.replace(/^b\//, '').trim() : '';

      const oldIsDevNull = oldP === '/dev/null';
      const newIsDevNull = newP === '/dev/null';

      if (!newIsDevNull) {
        const rel = normalizePatchPath(newP);
        if (rel && !seen.has(rel)) {
          seen.add(rel);
          paths.push(rel);
        }
        if (oldIsDevNull) created.add(rel);
      }

      if (!oldIsDevNull && newIsDevNull) {
        const rel = normalizePatchPath(oldP);
        if (rel && !seen.has(rel)) {
          seen.add(rel);
          paths.push(rel);
        }
        deleted.add(rel);
      }

      pendingOld = null;
      pendingNew = null;
      continue;
    }
  }

  return { paths, created, deleted };
}

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
  const replacement = typeof rawReplacement === 'string' ? rawReplacement
    : (rawReplacement != null && typeof rawReplacement === 'object' ? JSON.stringify(rawReplacement, null, 2) : undefined);

  if (!p) throw new Error('edit_range: missing path');
  if (!Number.isFinite(startLine) || startLine < 1) throw new Error('edit_range: missing/invalid start_line');
  if (!Number.isFinite(endLine) || endLine < startLine) throw new Error('edit_range: missing/invalid end_line');
  if (replacement == null) throw new Error('edit_range: missing replacement (got ' + typeof rawReplacement + ')');

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
      const ok = await ctx.confirm(
        pathVerdict.prompt || `Edit range in ${p}?`,
        { tool: 'edit_range', args: { path: p, start_line: startLine, end_line: endLine } }
      );
      if (!ok) throw new Error(`edit_range: cancelled by user (${pathVerdict.reason})`);
    } else {
      throw new Error(`edit_range: blocked (${pathVerdict.reason}) without --no-confirm/--yolo`);
    }
  }

  if (ctx.dryRun) return `dry-run: would edit_range ${p} lines ${startLine}-${endLine} (${Buffer.byteLength(replacement, 'utf8')} bytes)`;

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
    throw new Error(`edit_range: start_line ${startLine} out of range (file has ${lines.length} lines)`);
  }
  if (endLine > lines.length) {
    throw new Error(`edit_range: end_line ${endLine} out of range (file has ${lines.length} lines)`);
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
    after: Buffer.from(out, 'utf8')
  });

  const cwdWarning = checkCwdWarning('edit_range', p, ctx);
  return `edited ${p} lines ${startLine}-${endLine}${replayNote}${cwdWarning}`;
}

export async function apply_patch(ctx: ToolContext, args: any) {
  const rawPatch = args?.patch;
  const patchText = typeof rawPatch === 'string' ? rawPatch
    : (rawPatch != null && typeof rawPatch === 'object' ? JSON.stringify(rawPatch, null, 2) : undefined);

  const rawFiles = Array.isArray(args?.files) ? args.files : [];
  const files = rawFiles
    .map((f: any) => (typeof f === 'string' ? f.trim() : ''))
    .filter(Boolean);

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
      const preview = patchText.length > 4000 ? patchText.slice(0, 4000) + '\n[truncated]' : patchText;
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
      const chk = await runCommandWithStdin('git', ['apply', stripArg, '--check', '--whitespace=nowarn'], patchText, ctx.cwd, maxToolBytes);
      if (chk.rc !== 0) throw new Error(`apply_patch: git apply --check failed:\n${chk.err || chk.out}`);
    } else {
      const chk = await runCommandWithStdin('patch', [stripArg, '--dry-run', '--batch'], patchText, ctx.cwd, maxToolBytes);
      if (chk.rc !== 0) throw new Error(`apply_patch: patch --dry-run failed:\n${chk.err || chk.out}`);
    }
    return `dry-run: patch would apply cleanly (${touched.paths.length} files): ${touched.paths.join(', ')}`;
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
    const chk = await runCommandWithStdin('git', ['apply', stripArg, '--check', '--whitespace=nowarn'], patchText, ctx.cwd, maxToolBytes);
    if (chk.rc !== 0) throw new Error(`apply_patch: git apply --check failed:\n${chk.err || chk.out}`);

    const app = await runCommandWithStdin('git', ['apply', stripArg, '--whitespace=nowarn'], patchText, ctx.cwd, maxToolBytes);
    if (app.rc !== 0) throw new Error(`apply_patch: git apply failed:\n${app.err || app.out}`);
  } else {
    const chk = await runCommandWithStdin('patch', [stripArg, '--dry-run', '--batch'], patchText, ctx.cwd, maxToolBytes);
    if (chk.rc !== 0) throw new Error(`apply_patch: patch --dry-run failed:\n${chk.err || chk.out}`);

    const app = await runCommandWithStdin('patch', [stripArg, '--batch'], patchText, ctx.cwd, maxToolBytes);
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
      after
    });
    replayNotes += replayNote;

    cwdWarnings += checkCwdWarning('apply_patch', abs, ctx);
  }

  return `applied patch (${touched.paths.length} files): ${touched.paths.join(', ')}${replayNotes}${cwdWarnings}`;
}

export async function list_dir(ctx: ToolContext, args: any) {
  const p = resolvePath(ctx, args?.path ?? '.');
  const recursive = Boolean(args?.recursive);
  const maxEntries = Math.min(args?.max_entries ? Number(args.max_entries) : 200, 500);
  if (!p) throw new Error('list_dir: missing path');

  const lines: string[] = [];
  let count = 0;

  async function walk(dir: string, depth: number) {
    if (count >= maxEntries) return;
    const ents = await fs.readdir(dir, { withFileTypes: true }).catch((e: any) => {
      throw new Error(`list_dir: cannot read ${dir}: ${e?.message ?? String(e)}`);
    });
    for (const ent of ents) {
      if (count >= maxEntries) return;
      const full = path.join(dir, ent.name);
      const st = await fs.lstat(full).catch(() => null);
      const kind = ent.isDirectory() ? 'dir' : ent.isSymbolicLink() ? 'link' : 'file';
      lines.push(`${kind}\t${st?.size ?? 0}\t${full}`);
      count++;
      if (recursive && ent.isDirectory() && depth < 3) {
        await walk(full, depth + 1);
      }
    }
  }

  await walk(p, 0);
  if (count >= maxEntries) lines.push(`[truncated after ${maxEntries} entries]`);
  if (!lines.length) return `[empty directory: ${p}]`;
  return lines.join('\n');
}

export async function search_files(ctx: ToolContext, args: any) {
  const root = resolvePath(ctx, args?.path ?? '.');
  const pattern = typeof args?.pattern === 'string' ? args.pattern : undefined;
  const include = typeof args?.include === 'string' ? args.include : undefined;
  const maxResults = Math.min(args?.max_results ? Number(args.max_results) : 50, 100);
  if (!root) throw new Error('search_files: missing path');
  if (!pattern) throw new Error('search_files: missing pattern');

  // Prefer rg if available (fast, bounded output)
  if (await hasRg()) {
    const cmd = ['rg', '-n', '--no-heading', '--color', 'never', pattern, root];
    if (include) cmd.splice(1, 0, '-g', include);
    try {
      const rawJson = await exec(ctx, { command: cmd.map(shellEscape).join(' '), timeout: 30 });
      const parsed: ExecResult = JSON.parse(rawJson);
      // rg exits 1 when no matches found (not an error), 2+ for real errors.
      if (parsed.rc === 1 && !parsed.out?.trim()) {
        return `No matches for pattern "${pattern}" in ${root}. STOP — do NOT read files individually to search. Try a broader regex pattern, different keywords, or use exec: grep -rn "keyword" ${root}`;
      }
      if (parsed.rc >= 2) {
        // Real rg error — fall through to regex fallback below
      } else {
        const rgOutput = parsed.out ?? '';
        if (rgOutput) {
          const lines = rgOutput.split(/\r?\n/).filter(Boolean).slice(0, maxResults);
          if (lines.length >= maxResults) lines.push(`[truncated after ${maxResults} results]`);
          return lines.join('\n');
        }
      }
    } catch {
      // JSON parse failed or exec error — fall through to regex fallback
    }
  }

  // Slow fallback
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e: any) {
    throw new ToolError(
      'invalid_args',
      `search_files: invalid regex pattern: ${e?.message ?? String(e)}`,
      false,
      'Escape regex metacharacters (\\, [, ], (, ), +, *, ?). If you intended literal text, use an escaped/literal pattern.'
    );
  }
  const out: string[] = [];

  async function walk(dir: string, depth: number) {
    if (out.length >= maxResults) return;
    const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const ent of ents) {
      if (out.length >= maxResults) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist' || ent.name === 'build') continue;
        if (depth < 6) await walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (include && !globishMatch(ent.name, include)) continue;
      // Skip binary files (NUL byte in first 512 bytes)
      const rawBuf = await fs.readFile(full).catch(() => null);
      if (!rawBuf) continue;
      let isBinary = false;
      for (let bi = 0; bi < Math.min(rawBuf.length, 512); bi++) {
        if (rawBuf[bi] === 0) { isBinary = true; break; }
      }
      if (isBinary) continue;
      const buf: string | null = rawBuf.toString('utf8');
      const lines = buf.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push(`${full}:${i + 1}:${lines[i]}`);
          if (out.length >= maxResults) return;
        }
      }
    }
  }

  await walk(root, 0);
  if (out.length >= maxResults) out.push(`[truncated after ${maxResults} results]`);
  const result = out.join('\n');
  if (!result) return `No matches for pattern "${pattern}" in ${root}. STOP — do NOT read files individually to search. Try a broader regex pattern, different keywords, or use exec: grep -rn "keyword" ${root}`;
  return result;
}

function stripSimpleQuotedSegments(s: string): string {
  // Best-effort quote stripping for lightweight shell pattern checks.
  return s
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function hasBackgroundExecIntent(command: string): boolean {
  const stripped = stripSimpleQuotedSegments(command);
  // Detect standalone '&' token (background), but ignore && and redirection forms
  // like >&2, <&, and &>.
  return /(^|[;\s])&(?![&><\d])(?=($|[;\s]))/.test(stripped);
}

function safeFireAndForget(fn: (() => void | Promise<void>) | undefined): void {
  if (!fn) return;
  try {
    const r = fn();
    if (r && typeof (r as any).catch === 'function') (r as any).catch(() => {});
  } catch {
    // best effort only
  }
}

function makeExecStreamer(ctx: ToolContext) {
  const cb = ctx.onToolStream;
  if (!cb) return null;

  const id = ctx.toolCallId ?? '';
  const name = ctx.toolName ?? 'exec';

  const intervalMs = Math.max(50, Math.floor(ctx.toolStreamIntervalMs ?? 750));
  const maxChunkChars = Math.max(80, Math.floor(ctx.toolStreamMaxChunkChars ?? 900));
  const maxBufferChars = Math.max(maxChunkChars, Math.floor(ctx.toolStreamMaxBufferChars ?? 12_000));

  let outBuf = '';
  let errBuf = '';
  let lastEmit = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = (stream: 'stdout' | 'stderr', chunk: string) => {
    const trimmed = chunk.length > maxChunkChars ? chunk.slice(-maxChunkChars) : chunk;
    const ev: ToolStreamEvent = { id, name, stream, chunk: trimmed };
    safeFireAndForget(() => cb(ev));
  };

  const schedule = () => {
    if (timer) return;
    const delay = Math.max(0, intervalMs - (Date.now() - lastEmit));
    timer = setTimeout(() => {
      timer = null;
      flush(false);
    }, delay);
  };

  const flush = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < intervalMs) {
      schedule();
      return;
    }
    lastEmit = now;

    if (outBuf) {
      emit('stdout', outBuf);
      outBuf = '';
    }
    if (errBuf) {
      emit('stderr', errBuf);
      errBuf = '';
    }
  };

  const push = (stream: 'stdout' | 'stderr', textRaw: string) => {
    const text = stripAnsi(textRaw).replace(/\r/g, '\n');
    if (!text) return;

    if (stream === 'stdout') outBuf += text;
    else errBuf += text;

    if (outBuf.length > maxBufferChars) outBuf = outBuf.slice(-maxBufferChars);
    if (errBuf.length > maxBufferChars) errBuf = errBuf.slice(-maxBufferChars);

    schedule();
  };

  const done = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flush(true);
  };

  return { push, done };
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
        throw new Error(`exec: BLOCKED — cwd "${absExecCwd}" is outside the working directory "${absCwd}". Use relative paths and work within the project directory.`);
      }
      execCwdWarning = `\n[WARNING] cwd "${absExecCwd}" is outside the working directory "${absCwd}". Proceeding due to ${ctx.approvalMode} mode.`;
    }
  }
  if (command) {
    // Detect `cd /absolute/path` anywhere in the command
    const cdPattern = /\bcd\s+(['"]?)(\/[^\s'";&|]+)\1/g;
    let cdMatch: RegExpExecArray | null;
    while ((cdMatch = cdPattern.exec(command)) !== null) {
      const cdTarget = path.resolve(cdMatch[2]);
      if (!isWithinDir(cdTarget, absCwd)) {
        if (!allowOutsideCwd) {
          throw new Error(`exec: BLOCKED — command navigates to "${cdTarget}" which is outside the working directory "${absCwd}". Use relative paths and work within the project directory.`);
        }
        execCwdWarning = `\n[WARNING] Command navigates to "${cdTarget}" which is outside the working directory "${absCwd}". Proceeding due to ${ctx.approvalMode} mode.`;
      }
    }
    // Detect absolute paths in file-creating commands (mkdir, cat >, tee, touch, etc.)
    // that target directories outside cwd — HARD BLOCK unless yolo/auto-edit
    const absPathPattern = /(?:mkdir|cat\s*>|tee|touch|cp|mv)\s+(?:-\S+\s+)*(['"]?)(\/[^\s'";&|]+)\1/g;
    let apMatch: RegExpExecArray | null;
    while ((apMatch = absPathPattern.exec(command)) !== null) {
      const absTarget = path.resolve(apMatch[2]);
      if (!isWithinDir(absTarget, absCwd)) {
        if (!allowOutsideCwd) {
          throw new Error(`exec: BLOCKED — command targets "${absTarget}" which is outside the working directory "${absCwd}". Use relative paths to work within the project directory.`);
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
      throw new Error('exec: interactive sudo requires node-pty, but it is not installed. Install optional dependency `node-pty` (build tools: python3, make, g++) or use non-interactive sudo (NOPASSWD/cached credentials).');
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
      try { child.kill('SIGKILL'); } catch {}
    }
  };

  const killTimer = setTimeout(() => {
    killed = true;
    killProcessGroup();
  }, Math.max(1, timeout) * 1000);

  // §11: kill child process if parent abort signal fires (Ctrl+C).
  const onAbort = () => { killed = true; killProcessGroup(); };
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
    streamer?.push('stdout', d.toString('utf8'));
  });
  child.stderr.on('data', (d) => {
    pushCapped(errChunks, d, 'err');
    streamer?.push('stderr', d.toString('utf8'));
  });

  const rc: number = await new Promise((resolve, reject) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(killTimer);
      ctx.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`exec: failed to spawn shell: ${err.message} (${err.code ?? 'unknown'})`));
    });
    child.on('close', (code) => resolve(code ?? 0));
  });

  clearTimeout(killTimer);
  ctx.signal?.removeEventListener('abort', onAbort);
  streamer?.done();

  const outRaw = stripAnsi(Buffer.concat(outChunks).toString('utf8'));
  const errRaw = stripAnsi(Buffer.concat(errChunks).toString('utf8'));

  const outLines = collapseStackTraces(dedupeRepeats(outRaw.split(/\r?\n/))).join('\n').trimEnd();
  const errLines = collapseStackTraces(dedupeRepeats(errRaw.split(/\r?\n/))).join('\n').trimEnd();

  const outT = truncateBytes(outLines, maxBytes, outSeen);
  const errT = truncateBytes(errLines, maxBytes, errSeen);

  let outText = outT.text;
  let errText = errT.text;

  const capOut = outSeen > outCaptured;
  const capErr = errSeen > errCaptured;

  // If we had to cap capture but the post-processed output ended up short
  // (e.g., massive repeated output collapsed), still surface that truncation.
  if (capOut && !outT.truncated) {
    outText = truncateBytes(outText + `\n[capture truncated, ${outSeen} bytes total]`, maxBytes, outSeen).text;
  }
  if (capErr && !errT.truncated) {
    errText = truncateBytes(errText + `\n[capture truncated, ${errSeen} bytes total]`, maxBytes, errSeen).text;
  }

  if (killed) {
    errText = (errText ? errText + '\n' : '') + `[killed after ${timeout}s timeout]`;
  }

  // When any command produces no output, add an explicit semantic hint so the
  // model understands the result and doesn't retry the same command in a loop.
  if (!outText && !errText && !killed) {
    if (rc === 0) {
      outText = '[command completed successfully with no output. Do NOT retry — the command worked but produced no output. Move on to the next step.]';
    } else if (rc === 1) {
      outText = '[no matches found — the command returned zero results (exit code 1). Do NOT retry this command with the same arguments. The target simply has no matches. Move on or try different search terms/parameters.]';
    } else {
      outText = `[command exited with code ${rc} and produced no output. Do NOT retry with identical arguments — diagnose the issue or try a different approach.]`;
    }
  }

  const result: ExecResult = {
    rc,
    out: outText,
    err: errText,
    truncated: outT.truncated || errT.truncated || capOut || capErr,
    ...(execCwdWarning && { warnings: [execCwdWarning.trim()] })
  };

  // Phase 9d: auto-note system changes in sys mode
  if (ctx.mode === 'sys' && ctx.vault && rc === 0) {
    autoNoteSysChange(ctx.vault, command, outText).catch(() => {});
  }

  return JSON.stringify(result);
}

type ExecWithPtyArgs = {
  pty: any;
  command: string;
  cwd: string;
  timeout: number;
  maxBytes: number;
  captureLimit: number;
  signal?: AbortSignal;
  execCwdWarning?: string;
};

async function execWithPty(args: ExecWithPtyArgs): Promise<string> {
  const { pty, command, cwd, timeout, maxBytes, captureLimit, signal, execCwdWarning } = args;

  const proc = pty.spawn(BASH_PATH, ['-lc', command], {
    name: 'xterm-color',
    cwd,
    cols: 120,
    rows: 30,
    env: process.env,
  });

  const chunks: string[] = [];
  let seen = 0;
  let captured = 0;
  let killed = false;

  const onDataDisposable = proc.onData((data: string) => {
    // Real-time stream for interactive UX
    if (process.stdout.isTTY) {
      process.stdout.write(data);
    }

    const n = Buffer.byteLength(data, 'utf8');
    seen += n;

    const remaining = captureLimit - captured;
    if (remaining <= 0) return;

    if (n <= remaining) {
      chunks.push(data);
      captured += n;
    } else {
      const buf = Buffer.from(data, 'utf8');
      const slice = buf.subarray(0, remaining).toString('utf8');
      chunks.push(slice);
      captured += Buffer.byteLength(slice, 'utf8');
    }
  });

  const kill = () => {
    killed = true;
    try {
      proc.kill();
    } catch {
      // ignore
    }
  };

  const killTimer = setTimeout(kill, Math.max(1, timeout) * 1000);
  const onAbort = () => kill();
  signal?.addEventListener('abort', onAbort, { once: true });

  const rc: number = await new Promise((resolve) => {
    proc.onExit((e: any) => resolve(Number(e?.exitCode ?? 0)));
  });

  clearTimeout(killTimer);
  signal?.removeEventListener('abort', onAbort);
  onDataDisposable?.dispose?.();

  const raw = stripAnsi(chunks.join(''));
  const lines = collapseStackTraces(dedupeRepeats(raw.split(/\r?\n/))).join('\n').trimEnd();
  const outT = truncateBytes(lines, maxBytes, seen);

  let outText = outT.text;
  const cap = seen > captured;

  if (cap && !outT.truncated) {
    outText = truncateBytes(outText + `\n[capture truncated, ${seen} bytes total]`, maxBytes, seen).text;
  }

  let errText = '';
  if (killed) {
    errText = `[killed after ${timeout}s timeout]`;
  }

  // Semantic hints for empty output (same as non-pty exec path).
  if (!outText && !errText && !killed) {
    if (rc === 0) {
      outText = '[command completed successfully with no output. Do NOT retry — the command worked but produced no output. Move on to the next step.]';
    } else if (rc === 1) {
      outText = '[no matches found — the command returned zero results (exit code 1). Do NOT retry this command with the same arguments. The target simply has no matches. Move on or try different search terms/parameters.]';
    } else {
      outText = `[command exited with code ${rc} and produced no output. Do NOT retry with identical arguments — diagnose the issue or try a different approach.]`;
    }
  }

  const result: ExecResult = {
    rc,
    out: outText,
    err: errText,
    truncated: outT.truncated || cap || killed,
    ...(execCwdWarning && { warnings: [execCwdWarning.trim()] })
  };
  return JSON.stringify(result);
}

export async function vault_note(ctx: ToolContext, args: any) {
  const key = typeof args?.key === 'string' ? args.key.trim() : '';
  const value = typeof args?.value === 'string' ? args.value : undefined;

  if (!key) throw new Error('vault_note: missing key');
  if (value == null) throw new Error('vault_note: missing value');

  if (ctx.dryRun) return `dry-run: would add vault note ${JSON.stringify(key)}`;

  if (!ctx.vault) {
    throw new Error('vault_note: vault disabled');
  }

  const id = await ctx.vault.note(key, String(value));
  return `vault_note: saved ${id}`;
}

export async function vault_search(ctx: ToolContext, args: any) {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  const limit = Number(args?.limit);

  if (!query) return 'vault_search: missing query';
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.max(1, Math.floor(limit))) : 8;

  if (!ctx.vault) return 'vault disabled';

  const results = await ctx.vault.search(query, n);
  if (!results.length) {
    return `vault_search: no results for ${JSON.stringify(query)}`;
  }

  const lines = results.map((r) => {
    const title = r.kind === 'note' ? `note:${r.key}` : `tool:${r.tool || r.key || 'unknown'}`;
    const body = r.value ?? r.snippet ?? r.content ?? '';
    const short = body.replace(/\s+/g, ' ').slice(0, 160);
    return `${r.updatedAt} ${title} ${JSON.stringify(short)}`;
  });

  return lines.join('\n');
}

/** Phase 9: sys_context tool (mode-gated in agent schema). */
export async function sys_context(ctx: ToolContext, args: any) {
  return sysContextTool(ctx, args);
}

function resolvePath(ctx: ToolContext, p: any): string {
  if (typeof p !== 'string' || !p.trim()) throw new Error('missing path');
  return path.resolve(ctx.cwd, p);
}

/**
 * Check if a target path is within a directory.
 * Handles the classic root directory edge case: when dir is `/`, every absolute path is valid.
 */
function isWithinDir(target: string, dir: string): boolean {
  if (dir === '/') return target.startsWith('/');
  return target === dir || target.startsWith(dir + path.sep);
}

/**
 * Check if a resolved path is outside the working directory.
 * Returns a model-visible warning string if so, empty string otherwise.
 */
function checkCwdWarning(tool: string, resolvedPath: string, ctx: ToolContext): string {
  const absCwd = path.resolve(ctx.cwd);
  if (isWithinDir(resolvedPath, absCwd)) return '';
  const warning = `\n[WARNING] Path "${resolvedPath}" is OUTSIDE the working directory "${absCwd}". You MUST use relative paths and work within the project directory. Do NOT create or edit files outside the cwd.`;
  console.warn(`[warning] ${tool}: path "${resolvedPath}" is outside the working directory "${absCwd}".`);
  return warning;
}

/**
 * Hard guard for mutating file tools in normal code mode.
 * In code mode, writing outside cwd is always blocked to prevent accidental edits
 * in the wrong repository. System mode keeps broader path freedom for /etc workflows.
 */
function enforceMutationWithinCwd(tool: string, resolvedPath: string, ctx: ToolContext): void {
  if (ctx.mode === 'sys') return;

  const absTarget = path.resolve(resolvedPath);
  const absCwd = path.resolve(ctx.cwd);
  const roots = (ctx.allowedWriteRoots ?? []).map((r) => path.resolve(r));
  const allowAny = roots.includes('/');

  // If session requires explicit /dir pinning, block all mutations until pinned.
  // Exception: if cwd matches one of the repo candidates, auto-allow.
  if (ctx.requireDirPinForMutations && !ctx.dirPinned) {
    const candidates = ctx.repoCandidates ?? [];
    const cwdMatchesCandidate = candidates.some((c) => {
      const absCandidate = path.resolve(c);
      return absCwd === absCandidate || isWithinDir(absCwd, absCandidate);
    });
    if (!cwdMatchesCandidate) {
      const hint = candidates.length ? ` Candidates: ${candidates.slice(0, 8).join(', ')}` : '';
      throw new Error(`${tool}: BLOCKED — multiple repository candidates detected. Set repo root explicitly with /dir <path> before editing files.${hint}`);
    }
  }

  // Respect allowed roots first.
  if (roots.length > 0 && !allowAny) {
    const inAllowed = roots.some((root) => isWithinDir(absTarget, root));
    if (!inAllowed) {
      throw new Error(`${tool}: BLOCKED — path "${absTarget}" is outside allowed directories: ${roots.join(', ')}`);
    }
  }

  // If / is explicitly allowed, permit filesystem-wide writes after pin policy above.
  if (allowAny) return;

  // In code mode, keep edits scoped to current working directory unless explicitly sys mode.
  if (!isWithinDir(absTarget, absCwd)) {
    throw new Error(`${tool}: BLOCKED — path "${absTarget}" is outside the working directory "${absCwd}". Run /dir <project-root> first, then retry with relative paths.`);
  }
}

async function hasRg() {
  try {
    await fs.access('/usr/bin/rg');
    return true;
  } catch {
    // try PATH
    return await new Promise<boolean>((resolve) => {
      const c = spawn(BASH_PATH, ['-lc', 'command -v rg >/dev/null 2>&1'], { stdio: 'ignore' });
      c.on('error', () => resolve(false));
      c.on('close', (code) => resolve(code === 0));
    });
  }
}

/** Sørensen-Dice coefficient on character bigrams. Returns 0–1. */
function bigramSimilarity(a: string, b: string): number {
  if (a.length < 2 && b.length < 2) return a === b ? 1 : 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bi = s.slice(i, i + 2);
      m.set(bi, (m.get(bi) ?? 0) + 1);
    }
    return m;
  };
  const aB = bigrams(a);
  const bB = bigrams(b);
  let overlap = 0;
  for (const [k, v] of aB) {
    overlap += Math.min(v, bB.get(k) ?? 0);
  }
  const total = (a.length - 1) + (b.length - 1);
  return total > 0 ? (2 * overlap) / total : 0;
}

function globishMatch(name: string, glob: string) {
  // supports only simple '*.ext' and exact matches
  if (glob === name) return true;
  const m = /^\*\.(.+)$/.exec(glob);
  if (m) return name.endsWith('.' + m[1]);
  return false;
}

// ---------------------------------------------------------------------------
// Phase 9d: System memory helpers
// ---------------------------------------------------------------------------

/** Patterns that indicate system-modifying commands worth auto-noting. */
const SYS_CHANGE_PATTERNS = [
  /\b(apt|apt-get|dnf|yum|pacman|pip|npm)\s+(install|remove|purge|upgrade|update)\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
  /\bufw\s+(allow|deny|delete|enable|disable)\b/i,
  /\biptables\s+(-A|-I|-D)\b/i,
  /\buseradd\b/i,
  /\buserdel\b/i,
  /\bcrontab\b/i,
];

/** Auto-note significant system changes to Vault (sys mode only). */
async function autoNoteSysChange(vault: VaultStore, command: string, output: string): Promise<void> {
  const isSignificant = SYS_CHANGE_PATTERNS.some(p => p.test(command));
  if (!isSignificant) return;

  const summary = output.length > 200 ? output.slice(0, 197) + '...' : output;
  const value = `Command: ${command}\nOutput: ${summary}`;
  await vault.note(`sys:${command.slice(0, 80)}`, value);
}

/** Snapshot a file's contents to Vault before editing (for /etc/ config tracking). */
export async function snapshotBeforeEdit(vault: VaultStore, filePath: string): Promise<void> {
  if (!filePath.startsWith('/etc/')) return;
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const snippet = content.length > 500 ? content.slice(0, 497) + '...' : content;
    await vault.note(`sys:pre-edit:${filePath}`, `Snapshot before edit:\n${snippet}`);
  } catch {
    // File doesn't exist yet or not readable — skip
  }
}
