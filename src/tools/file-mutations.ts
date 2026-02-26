import fs from 'node:fs/promises';
import path from 'node:path';

import { checkPathSafety } from '../safety.js';

import {
  checkCwdWarning,
  enforceMutationWithinCwd,
  redactPath,
  resolvePath,
} from './path-safety.js';
import { checkpointReplay } from './replay-utils.js';
import { bigramSimilarity } from './search-utils.js';
import { snapshotBeforeEdit } from './sys-notes.js';
import { mutationReadback } from './text-utils.js';
import { atomicWrite, backupFile } from './undo.js';

function normalizeEscapedLineBreaks(
  input: string,
  opts?: { enabled?: boolean; onlyWhenNoRealNewlines?: boolean }
): { text: string; normalized: boolean } {
  const enabled = opts?.enabled !== false;
  if (!enabled) return { text: input, normalized: false };

  const hasLiteralEscapedNewlines = input.includes('\\n') || input.includes('\\r');
  const hasRealNewlines = input.includes('\n') || input.includes('\r');
  if (!hasLiteralEscapedNewlines) return { text: input, normalized: false };
  if (opts?.onlyWhenNoRealNewlines !== false && hasRealNewlines) {
    return { text: input, normalized: false };
  }

  const next = input
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"');
  return { text: next, normalized: next !== input };
}

export async function writeFileTool(ctx: any, args: any): Promise<string> {
  const p = resolvePath(ctx, args?.path);
  const absCwd = path.resolve(ctx.cwd);
  const redactedPath = redactPath(p, absCwd);
  const raw = args?.content;
  const contentWasObject = raw != null && typeof raw === 'object';
  let content =
    typeof raw === 'string' ? raw : contentWasObject ? JSON.stringify(raw, null, 2) : undefined;
  if (contentWasObject) {
    console.warn(
      `[write_file] Warning: content for "${args?.path}" arrived as ${typeof raw} — auto-serialized to JSON string. If this was intentional (e.g. package.json), the write succeeded.`
    );
  }
  if (!p) throw new Error('write_file: missing path');
  if (content == null) throw new Error('write_file: missing content (got ' + typeof raw + ')');

  const normalizeEscaped = args?.normalize_escaped_newlines === true;
  const normalizedContent = normalizeEscapedLineBreaks(content, {
    enabled: normalizeEscaped,
    onlyWhenNoRealNewlines: true,
  });
  content = normalizedContent.text;

  const overwrite = Boolean(args?.overwrite ?? args?.force);
  enforceMutationWithinCwd('write_file', p, ctx);
  const cwdWarning = checkCwdWarning('write_file', p, ctx);

  const pathVerdict = checkPathSafety(p);
  if (pathVerdict.tier === 'forbidden') throw new Error(`write_file: ${pathVerdict.reason}`);
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

  if (ctx.mode === 'sys' && ctx.vault) await snapshotBeforeEdit(ctx.vault, p).catch(() => {});

  const beforeBuf = await fs.readFile(p).catch(() => Buffer.from(''));
  await backupFile(p, ctx);
  await atomicWrite(p, content);
  ctx.onMutation?.(p);

  const replayNote = await checkpointReplay(ctx, {
    op: 'write_file',
    filePath: p,
    before: beforeBuf,
    after: Buffer.from(content, 'utf8'),
  });

  const contentLines = content.split(/\r?\n/);
  const readback =
    contentLines.length <= 40
      ? mutationReadback(content, 0, contentLines.length)
      : mutationReadback(content, 0, 20) +
        '\n...\n' +
        mutationReadback(content, contentLines.length - 10, contentLines.length);
  const normalizationNote = normalizedContent.normalized
    ? '\n[normalized escaped newline sequences in content]'
    : '';
  return `wrote ${redactedPath} (${Buffer.byteLength(content, 'utf8')} bytes)${normalizationNote}${replayNote}${cwdWarning}${readback}`;
}

export async function insertFileTool(ctx: any, args: any): Promise<string> {
  const p = resolvePath(ctx, args?.path);
  const absCwd = path.resolve(ctx.cwd);
  const redactedPath = redactPath(p, absCwd);
  const line = Number(args?.line);
  const rawText = args?.text;
  let text =
    typeof rawText === 'string'
      ? rawText
      : rawText != null && typeof rawText === 'object'
        ? JSON.stringify(rawText, null, 2)
        : undefined;
  if (!p) throw new Error('insert_file: missing path');
  if (!Number.isFinite(line)) throw new Error('insert_file: missing/invalid line');
  if (text == null) throw new Error('insert_file: missing text (got ' + typeof rawText + ')');

  const normalizeEscaped = args?.normalize_escaped_newlines !== false;
  const normalizedText = normalizeEscapedLineBreaks(text, {
    enabled: normalizeEscaped,
    onlyWhenNoRealNewlines: true,
  });
  text = normalizedText.text;

  enforceMutationWithinCwd('insert_file', p, ctx);
  const pathVerdict = checkPathSafety(p);
  if (pathVerdict.tier === 'forbidden') throw new Error(`insert_file: ${pathVerdict.reason}`);
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

  if (ctx.mode === 'sys' && ctx.vault) await snapshotBeforeEdit(ctx.vault, p).catch(() => {});

  const beforeText = await fs.readFile(p, 'utf8').catch(() => '');
  const eol = beforeText.includes('\r\n') ? '\r\n' : '\n';

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
    const normalizationNote = normalizedText.normalized
      ? '\n[normalized escaped newline sequences in text]'
      : '';
    return `inserted into ${redactedPath} at 0${normalizationNote}${replayNote}${cwdWarning}${readback}`;
  }

  const lines = beforeText.split(/\r?\n/);
  let idx: number;
  if (line === -1) idx = lines.length;
  else idx = Math.max(0, Math.min(lines.length, line));
  if (line === -1 && lines.length > 0 && lines[lines.length - 1] === '') idx = lines.length - 1;

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
  const normalizationNote = normalizedText.normalized
    ? '\n[normalized escaped newline sequences in text]'
    : '';
  return `inserted into ${redactedPath} at ${idx}${normalizationNote}${replayNote}${cwdWarning}${readback}`;
}

export async function editFileTool(ctx: any, args: any): Promise<string> {
  const p = resolvePath(ctx, args?.path);
  const absCwd = path.resolve(ctx.cwd);
  const redactedPath = redactPath(p, absCwd);
  const rawOld = args?.old_text;
  let oldText =
    typeof rawOld === 'string'
      ? rawOld
      : rawOld != null && typeof rawOld === 'object'
        ? JSON.stringify(rawOld, null, 2)
        : undefined;
  const rawNew = args?.new_text;
  let newText =
    typeof rawNew === 'string'
      ? rawNew
      : rawNew != null && typeof rawNew === 'object'
        ? JSON.stringify(rawNew, null, 2)
        : undefined;
  const replaceAll = Boolean(args?.replace_all);
  if (!p) throw new Error('edit_file: missing path');
  if (oldText == null) throw new Error('edit_file: missing old_text');
  if (newText == null) throw new Error('edit_file: missing new_text');

  const normalizeEscaped = args?.normalize_escaped_newlines === true;
  const normalizedOld = normalizeEscapedLineBreaks(oldText, {
    enabled: normalizeEscaped,
    onlyWhenNoRealNewlines: true,
  });
  const normalizedNew = normalizeEscapedLineBreaks(newText, {
    enabled: normalizeEscaped,
    onlyWhenNoRealNewlines: true,
  });
  oldText = normalizedOld.text;
  newText = normalizedNew.text;

  enforceMutationWithinCwd('edit_file', p, ctx);
  const pathVerdict = checkPathSafety(p);
  if (pathVerdict.tier === 'forbidden') throw new Error(`edit_file: ${pathVerdict.reason}`);
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

  if (ctx.mode === 'sys' && ctx.vault) await snapshotBeforeEdit(ctx.vault, p).catch(() => {});

  const cur = await fs.readFile(p, 'utf8').catch((e: any) => {
    throw new Error(`edit_file: cannot read ${redactedPath}: ${e?.message ?? String(e)}`);
  });

  const idx = cur.indexOf(oldText);
  if (idx === -1) {
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const needle = normalize(oldText);
    const curLines = cur.split(/\r?\n/);
    const needleLines = oldText.split(/\r?\n/).length;

    let bestScore = 0;
    let bestLine = -1;
    let bestText = '';

    for (let i = 0; i < curLines.length; i++) {
      const windowEnd = Math.min(curLines.length, i + needleLines);
      const window = curLines.slice(i, windowEnd).join('\n');
      const score = bigramSimilarity(needle, normalize(window));
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
  const editStartLine = next.slice(0, idx).split(/\r?\n/).length - 1;
  const editEndLine = editStartLine + newText.split(/\r?\n/).length;
  const readback = mutationReadback(next, editStartLine, editEndLine);
  const normalizationNote = normalizedOld.normalized || normalizedNew.normalized
    ? '\n[normalized escaped newline sequences in edit_file text]'
    : '';
  // Count replacements for replace_all mode
  const replaceCount = replaceAll ? (cur.split(oldText).length - 1) : 1;
  const replaceInfo = replaceAll && replaceCount > 1 ? ` [${replaceCount} occurrences replaced]` : "";
  return `edited ${redactedPath} (replace_all=${replaceAll})${replaceInfo}${normalizationNote}${replayNote}${cwdWarning}${readback}`;
}

export async function editRangeTool(ctx: any, args: any): Promise<string> {
  const p = resolvePath(ctx, args?.path);
  const startLine = Number(args?.start_line);
  const endLine = Number(args?.end_line);
  const rawReplacement = args?.replacement;
  let replacement =
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

  let normalizedEscapedReplacement = false;
  const hasLiteralEscapedNewlines = replacement.includes('\\n') || replacement.includes('\\r');
  const hasRealNewlines = replacement.includes('\n') || replacement.includes('\r');

  // Recover common model payload issue: replacement arrives as a single-line string
  // with literal backslash-newline sequences ("alpha\\nbeta") instead of real line breaks.
  if (hasLiteralEscapedNewlines && !hasRealNewlines) {
    replacement = replacement
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"');
    normalizedEscapedReplacement = true;
  }

  enforceMutationWithinCwd('edit_range', p, ctx);
  const pathVerdict = checkPathSafety(p);
  if (pathVerdict.tier === 'forbidden') throw new Error(`edit_range: ${pathVerdict.reason}`);
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

  if (ctx.mode === 'sys' && ctx.vault) await snapshotBeforeEdit(ctx.vault, p).catch(() => {});

  const beforeText = await fs.readFile(p, 'utf8').catch((e: any) => {
    throw new Error(`edit_range: cannot read ${p}: ${e?.message ?? String(e)}`);
  });

  const eol = beforeText.includes('\r\n') ? '\r\n' : '\n';
  const lines = beforeText.split(/\r?\n/);

  if (startLine > lines.length)
    throw new Error(
      `edit_range: start_line ${startLine} out of range (file has ${lines.length} lines)`
    );
  if (endLine > lines.length)
    throw new Error(
      `edit_range: end_line ${endLine} out of range (file has ${lines.length} lines)`
    );

  const startIdx = startLine - 1;
  const deleteCount = endLine - startLine + 1;
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
  const normalizationNote = normalizedEscapedReplacement
    ? '\n[normalized escaped newline sequences in replacement]'
    : '';
  return `edited ${p} lines ${startLine}-${endLine}${normalizationNote}${replayNote}${cwdWarning}${readback}`;
}
