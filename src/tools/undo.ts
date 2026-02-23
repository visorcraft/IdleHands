/**
 * Backup system and undo functionality for file tools.
 * Manages file backups with FIFO rotation and provides undo support.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import type { ToolContext } from '../tools.js';
import { stateDir } from '../utils.js';
import { resolvePath, redactPath } from './path-safety.js';

const DEFAULT_MAX_BACKUPS_PER_FILE = 5;

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

export async function rotateBackups(absPath: string, ctx: ToolContext) {
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
    await fs.rm(bak, { force: true }).catch(() => { });
    await fs.rm(meta, { force: true }).catch(() => { });
  }
}

export async function backupFile(absPath: string, ctx: ToolContext) {
  const { bdir, keyDir } = backupDirForPath(ctx, absPath);
  await fs.mkdir(bdir, { recursive: true });
  await fs.mkdir(keyDir, { recursive: true });

  // Auto-create .gitignore in state dir to prevent backups from being committed
  const gitignorePath = path.join(bdir, '.gitignore');
  await fs.writeFile(gitignorePath, '*\n', { flag: 'wx' }).catch(() => { });
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
    await fs.chmod(tmp, origMode & 0o7777).catch(() => { });
  }

  await fs.rename(tmp, absPath);
}

export async function undo_path(ctx: ToolContext, args: any) {
  const directPath = args?.path === undefined ? undefined : String(args.path);
  const p = directPath ? resolvePath(ctx, directPath) : ctx.lastEditedPath;
  if (!p) throw new Error('undo: missing path');
  const absCwd = path.resolve(ctx.cwd);
  const redactedPath = redactPath(p, absCwd);
  if (!ctx.noConfirm && ctx.confirm) {
    const ok = await ctx.confirm(`Restore latest backup for:\n  ${redactedPath}\nThis will overwrite the current file. Proceed? (y/N) `);
    if (!ok) return 'undo: cancelled';
  }
  if (!ctx.noConfirm && !ctx.confirm) {
    throw new Error('undo: confirmation required (run with --no-confirm/--yolo or in interactive mode)');
  }
  if (ctx.dryRun) return `dry-run: would restore latest backup for ${redactedPath}`;
  return await restoreLatestBackup(p, ctx);
}
