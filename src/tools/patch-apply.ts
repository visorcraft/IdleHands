import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ReplayStore } from '../replay.js';
import { checkPathSafety } from '../safety.js';
import type { ApprovalMode } from '../types.js';

import { extractTouchedFilesFromPatch, normalizePatchPath } from './patch.js';
import {
  checkCwdWarning,
  enforceMutationWithinCwd,
  redactPath,
  resolvePath,
} from './path-safety.js';
import { checkpointReplay } from './replay-utils.js';
import { snapshotBeforeEdit } from './sys-notes.js';
import { truncateBytes, stripAnsi } from './text-utils.js';
import { backupFile } from './undo.js';

export type PatchApplyContext = {
  cwd: string;
  noConfirm: boolean;
  dryRun: boolean;
  mode?: 'code' | 'sys';
  approvalMode?: ApprovalMode;
  confirm?: (
    prompt: string,
    ctx?: { tool?: string; args?: Record<string, unknown>; diff?: string }
  ) => Promise<boolean>;
  replay?: ReplayStore;
  vault?: { note: (k: string, v: string) => Promise<string> };
  lens?: {
    summarizeDiffToText: (
      before: string,
      after: string,
      filePath: string
    ) => Promise<string | undefined>;
  };
  onMutation?: (absPath: string) => void;
  maxExecBytes?: number;
};

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

export async function applyPatchTool(ctx: PatchApplyContext, args: any): Promise<string> {
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
  if (!touched.paths.length)
    throw new Error('apply_patch: patch contains no recognizable file headers');

  const declared = new Set(files.map(normalizePatchPath));
  const unknown = touched.paths.filter((p) => !declared.has(p));
  if (unknown.length)
    throw new Error(`apply_patch: patch touches undeclared file(s): ${unknown.join(', ')}`);

  const absPaths = touched.paths.map((rel) => resolvePath(ctx as any, rel));
  for (const abs of absPaths) enforceMutationWithinCwd('apply_patch', abs, ctx as any);

  const verdicts = absPaths.map((p) => ({ p, v: checkPathSafety(p) }));
  const forbidden = verdicts.filter(({ v }) => v.tier === 'forbidden');
  if (forbidden.length)
    throw new Error(`apply_patch: ${forbidden[0].v.reason} (${forbidden[0].p})`);

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

  const maxToolBytes = ctx.maxExecBytes ?? 16384;
  const stripArg = `-p${strip}`;

  if (ctx.dryRun) {
    const haveGit = !spawn('git', ['--version'], { stdio: 'ignore' }).pid ? false : true;
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
      redactPath(resolvePath(ctx as any, rel), path.resolve(ctx.cwd))
    );
    return `dry-run: patch would apply cleanly (${touched.paths.length} files): ${redactedPaths.join(', ')}`;
  }

  const beforeMap = new Map<string, Buffer>();
  for (const abs of absPaths) {
    if (ctx.mode === 'sys' && ctx.vault)
      await snapshotBeforeEdit(ctx.vault as any, abs).catch(() => {});
    const before = await fs.readFile(abs).catch(() => Buffer.from(''));
    beforeMap.set(abs, before);
    await backupFile(abs, ctx as any);
  }

  const gitProbe = await runCommandWithStdin('git', ['--version'], '', ctx.cwd, maxToolBytes).catch(
    () => ({ rc: 1, out: '', err: '' })
  );
  const haveGit = gitProbe.rc === 0;

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

  let replayNotes = '';
  let cwdWarnings = '';
  for (const abs of absPaths) {
    const after = await fs.readFile(abs).catch(() => Buffer.from(''));
    ctx.onMutation?.(abs);
    replayNotes += await checkpointReplay(ctx as any, {
      op: 'apply_patch',
      filePath: abs,
      before: beforeMap.get(abs) ?? Buffer.from(''),
      after,
    });
    cwdWarnings += checkCwdWarning('apply_patch', abs, ctx as any);
  }

  const redactedPaths = touched.paths.map((rel) =>
    redactPath(resolvePath(ctx as any, rel), path.resolve(ctx.cwd))
  );
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
    } catch {}
  }
  if (absPaths.length > 2) patchReadback += `\n...(${absPaths.length - 2} more files)`;

  return `applied patch (${touched.paths.length} files): ${redactedPaths.join(', ')}${replayNotes}${cwdWarnings}${patchReadback}`;
}
