/**
 * Pure text-processing helpers used by tool implementations.
 * Extracted from tools.ts to reduce file size and improve reuse.
 */

import path from 'node:path';

/** Guess MIME type from magic bytes or file extension. */
export function guessMimeType(filePath: string, buf: Buffer): string {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
      return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf.length >= 12 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    )
      return 'image/webp';
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)
      return 'application/pdf';
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)
      return 'application/zip';
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46)
      return 'application/x-elf';
    if (buf[0] === 0x1f && buf[1] === 0x8b) return 'application/gzip';
  }
  const ext = path.extname(filePath).toLowerCase();
  const extMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.wasm': 'application/wasm',
    '.so': 'application/x-sharedlib',
    '.exe': 'application/x-executable',
    '.o': 'application/x-object',
  };
  return extMap[ext] ?? 'application/octet-stream';
}

/** Strip ANSI escape sequences from a string. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\u001b[()][AB012]/g, '')
    .replace(/\u001b[=>Nc7-9]/g, '');
}

/** Collapse consecutive duplicate lines into a single line + count. */
export function dedupeRepeats(lines: string[], maxLineLen = 400): string[] {
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

/** Collapse long stack traces, keeping first frame + count. */
export function collapseStackTraces(lines: string[]): string[] {
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

/** Truncate a string to maxBytes (UTF-8), appending a truncation notice. */
export function truncateBytes(
  s: string,
  maxBytes: number,
  totalBytesHint?: number
): { text: string; truncated: boolean } {
  const b = Buffer.from(s, 'utf8');
  const total =
    typeof totalBytesHint === 'number' && Number.isFinite(totalBytesHint)
      ? totalBytesHint
      : b.length;
  if (b.length <= maxBytes) return { text: s, truncated: false };
  const cut = b.subarray(0, maxBytes);
  return { text: cut.toString('utf8') + `\n[truncated, ${total} bytes total]`, truncated: true };
}

/**
 * Build a read-back snippet showing the region around a mutation.
 * Returns numbered lines ±contextLines around the changed area, capped to avoid bloat.
 */
export function mutationReadback(
  fileContent: string,
  changedStartLine: number,
  changedEndLine: number,
  contextLines = 5,
  maxLines = 40
): string {
  const lines = fileContent.split(/\r?\n/);
  const totalLines = lines.length;
  const from = Math.max(0, changedStartLine - contextLines);
  const to = Math.min(totalLines, changedEndLine + contextLines);
  let slice = lines.slice(from, to);
  let truncated = false;
  if (slice.length > maxLines) {
    slice = slice.slice(0, maxLines);
    truncated = true;
  }
  const numbered = slice.map((l, i) => `${from + i + 1}: ${l}`).join('\n');
  const header = `\n--- current state of lines ${from + 1}-${from + slice.length} (of ${totalLines}) ---\n`;
  return header + numbered + (truncated ? '\n...(truncated)' : '');
}
