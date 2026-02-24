import fs from 'node:fs/promises';
import path from 'node:path';

import { isLikelyBinaryBuffer } from './formatting.js';

/** Build bounded context block from a list of relative files for sub-agent delegation. */
export async function buildSubAgentContextBlock(
  cwd: string,
  rawFiles: unknown
): Promise<{ block: string; included: string[]; skipped: string[] }> {
  const values = Array.isArray(rawFiles) ? rawFiles : [];
  const files = values
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .slice(0, 12);

  if (!files.length) return { block: '', included: [], skipped: [] };

  const MAX_TOTAL_CHARS = 24_000;
  const MAX_PER_FILE_CHARS = 4_000;

  let total = 0;
  const parts: string[] = [];
  const included: string[] = [];
  const skipped: string[] = [];

  for (const rel of files) {
    const abs = path.resolve(cwd, rel);
    const relFromCwd = path.relative(cwd, abs);
    if (relFromCwd.startsWith('..') || path.isAbsolute(relFromCwd)) {
      skipped.push(`${rel} (outside cwd)`);
      continue;
    }

    let stat: any;
    try {
      stat = await fs.stat(abs);
    } catch {
      skipped.push(`${rel} (missing)`);
      continue;
    }

    if (!stat?.isFile()) {
      skipped.push(`${rel} (not a file)`);
      continue;
    }

    const buf = await fs.readFile(abs).catch(() => null);
    if (!buf) {
      skipped.push(`${rel} (unreadable)`);
      continue;
    }

    if (isLikelyBinaryBuffer(buf)) {
      skipped.push(`${rel} (binary)`);
      continue;
    }

    const raw = buf.toString('utf8');
    const body =
      raw.length > MAX_PER_FILE_CHARS
        ? `${raw.slice(0, MAX_PER_FILE_CHARS)}\n[truncated: ${raw.length} chars total]`
        : raw;

    const section = `[file:${rel}]\n${body}\n[/file:${rel}]`;
    if (total + section.length > MAX_TOTAL_CHARS) {
      skipped.push(`${rel} (context budget reached)`);
      continue;
    }

    parts.push(section);
    included.push(rel);
    total += section.length;
  }

  return { block: parts.join('\n\n'), included, skipped };
}

/** Strip heading wrappers from lens projection and return concise body. */
export function extractLensBody(projection: string): string {
  const lines = String(projection ?? '').split(/\r?\n/);
  if (!lines.length) return '';

  let start = 0;
  if (lines[0].startsWith('# ')) start = 1;
  if (lines[start]?.startsWith('# lens:')) start += 1;

  return lines
    .slice(start)
    .filter((line) => line.trim().length > 0)
    .slice(0, 40)
    .join('\n');
}
