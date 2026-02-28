import fs from 'node:fs/promises';
import path from 'node:path';

import { resolvePath, redactPath } from './path-safety.js';
import { guessMimeType, truncateBytes } from './text-utils.js';
import { ToolError } from './tool-error.js';

export type ReadToolContext = {
  cwd: string;
  maxReadLines?: number;
};

export async function readFileTool(ctx: ReadToolContext, args: any): Promise<string> {
  const p = resolvePath(ctx as any, args?.path);
  const absCwd = path.resolve(ctx.cwd);
  const redactedPath = redactPath(p, absCwd);
  const offset = args?.offset != null ? Number(args.offset) : undefined;

  const rawLimit = args?.limit != null ? Number(args.limit) : undefined;
  const defaultLimit = (ctx.maxReadLines != null && ctx.maxReadLines > 0) ? ctx.maxReadLines : 200;
  // Allow explicit limit up to 2000 lines (models need to read large files for context).
  // Only the *default* (when no limit is specified) stays at defaultLimit.
  const maxAllowedLimit = 2000;
  let limit =
    Number.isFinite(rawLimit as number) && (rawLimit as number) > 0
      ? Math.min(Math.max(1, Math.floor(rawLimit as number)), maxAllowedLimit)
      : defaultLimit;

  const search = typeof args?.search === 'string' ? args.search : undefined;

  const rawContext = args?.context != null ? Number(args.context) : undefined;
  const context =
    Number.isFinite(rawContext as number) && (rawContext as number) >= 0
      ? Math.max(0, Math.min(200, Math.floor(rawContext as number)))
      : 10;

  const formatRaw =
    typeof args?.format === 'string' ? args.format.trim().toLowerCase() : 'numbered';
  const format: 'plain' | 'numbered' | 'sparse' =
    formatRaw === 'plain' || formatRaw === 'numbered' || formatRaw === 'sparse'
      ? (formatRaw as 'plain' | 'numbered' | 'sparse')
      : 'numbered';

  const rawMaxBytes = args?.max_bytes != null ? Number(args.max_bytes) : undefined;
  const maxBytes =
    Number.isFinite(rawMaxBytes as number) && (rawMaxBytes as number) > 0
      ? Math.min(256 * 1024, Math.max(256, Math.floor(rawMaxBytes as number)))
      : 20 * 1024;

  if (!p) throw new Error('read_file: missing path');

  try {
    const stat = await fs.stat(p);
    if (stat.isDirectory()) {
      return `read_file: "${redactedPath}" is a directory, not a file. Use list_dir to see its contents, or search_files to find specific code.`;
    }
  } catch {
    // let readFile error path handle ENOENT/etc
  }

  const buf = await fs.readFile(p).catch((e: any) => {
    throw new Error(`read_file: cannot read ${p}: ${e?.message ?? String(e)}`);
  });

  for (let i = 0; i < Math.min(buf.length, 512); i++) {
    if (buf[i] === 0) {
      const mimeGuess = guessMimeType(p, buf);
      return `[binary file, ${buf.length} bytes, detected type: ${mimeGuess}]`;
    }
  }

  const text = buf.toString('utf8');
  if (!text) return `# ${p}\n[file is empty (0 bytes)]`;

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
    out.push(
      `# matches at lines: ${shown.join(', ')}${matchLines.length > shown.length ? ' …' : ''}`
    );
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

    const isAnchor = ln === start || ln === end || (ln - start) % 10 === 0;
    if (isAnchor || matchSet.has(ln)) out.push(renderNumbered(ln, body));
    else out.push(body);
  }

  if (end < lines.length) out.push(`# ... (${lines.length - end} more lines)`);
  return truncateBytes(out.join('\n'), maxBytes).text;
}

export async function readFilesTool(ctx: ReadToolContext, args: any): Promise<string> {
  const reqs = Array.isArray(args?.requests) ? args.requests : [];
  if (!reqs.length) {
    throw new ToolError(
      'invalid_args',
      'read_files: missing requests[]',
      false,
      'Provide requests as an array of {path, limit,...} objects.'
    );
  }

  const parts: string[] = [];
  let failures = 0;

  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i];
    const p = typeof r?.path === 'string' ? r.path : `request[${i}]`;
    try {
      parts.push(await readFileTool(ctx, r));
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
