import fs from 'node:fs/promises';
import path from 'node:path';

import type { ExecResult } from '../types.js';
import { shellEscape } from '../utils.js';

import { resolvePath, redactPath } from './path-safety.js';
import { globishMatch, hasRg } from './search-utils.js';
import { ToolError } from './tool-error.js';

type DiscoveryContext = {
  cwd: string;
};

export async function listDirTool(ctx: DiscoveryContext, args: any): Promise<string> {
  const p = resolvePath(ctx as any, args?.path ?? '.');
  const recursive = Boolean(args?.recursive);
  const maxEntries = Math.min(args?.max_entries ? Number(args.max_entries) : 200, 500);
  if (!p) throw new Error('list_dir: missing path');

  const absCwd = path.resolve(ctx.cwd);
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
      lines.push(`${kind}\t${st?.size ?? 0}\t${redactPath(full, absCwd)}`);
      count++;
      if (recursive && ent.isDirectory() && depth < 3) {
        await walk(full, depth + 1);
      }
    }
  }

  await walk(p, 0);
  if (count >= maxEntries) lines.push(`[truncated after ${maxEntries} entries]`);
  if (!lines.length) return `[empty directory: ${redactPath(p, absCwd)}]`;
  return lines.join('\n');
}

export async function searchFilesTool(
  ctx: DiscoveryContext,
  args: any,
  execFn: (ctx: any, args: any) => Promise<string>
): Promise<string> {
  const root = resolvePath(ctx as any, args?.path ?? '.');
  const pattern = typeof args?.pattern === 'string' ? args.pattern : undefined;
  const include = typeof args?.include === 'string' ? args.include : undefined;
  const maxResults = Math.min(args?.max_results ? Number(args.max_results) : 50, 100);
  if (!root) throw new Error('search_files: missing path');
  if (!pattern) throw new Error('search_files: missing pattern');

  const absCwd = path.resolve(ctx.cwd);

  if (await hasRg()) {
    const cmd = ['rg', '-n', '--no-heading', '--color', 'never', pattern, root];
    if (include) cmd.splice(1, 0, '-g', include);
    try {
      const rawJson = await execFn(ctx, { command: cmd.map(shellEscape).join(' '), timeout: 30 });
      const parsed: ExecResult = JSON.parse(rawJson);
      if (parsed.rc === 1 && !parsed.out?.trim()) {
        return `No matches for pattern \"${pattern}\" in ${root}. STOP — do NOT read files individually to search. Try a broader regex pattern, different keywords, or use exec: grep -rn \"keyword\" ${root}`;
      }
      if (parsed.rc < 2) {
        const rgOutput = parsed.out ?? '';
        if (rgOutput) {
          const lines = rgOutput.split(/\r?\n/).filter(Boolean).slice(0, maxResults);
          if (lines.length >= maxResults) lines.push(`[truncated after ${maxResults} results]`);
          const redactedLines = lines.map((line) => {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) return line;
            const filePath = line.substring(0, colonIdx);
            const rest = line.substring(colonIdx + 1);
            return redactPath(filePath, absCwd) + ':' + rest;
          });
          return redactedLines.join('\n');
        }
      }
    } catch {
      // fall through
    }
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e: any) {
    throw new ToolError(
      'invalid_args',
      `search_files: invalid regex pattern: ${e?.message ?? String(e)}`,
      false,
      'Escape regex metacharacters (\\\\, [, ], (, ), +, *, ?). If you intended literal text, use an escaped/literal pattern.'
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
        if (
          ent.name === 'node_modules' ||
          ent.name === '.git' ||
          ent.name === 'dist' ||
          ent.name === 'build'
        )
          continue;
        if (depth < 6) await walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (include && !globishMatch(ent.name, include)) continue;
      const rawBuf = await fs.readFile(full).catch(() => null);
      if (!rawBuf) continue;
      let isBinary = false;
      for (let bi = 0; bi < Math.min(rawBuf.length, 512); bi++) {
        if (rawBuf[bi] === 0) {
          isBinary = true;
          break;
        }
      }
      if (isBinary) continue;
      const buf = rawBuf.toString('utf8');
      const lines = buf.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push(`${redactPath(full, absCwd)}:${i + 1}:${lines[i]}`);
          if (out.length >= maxResults) return;
        }
      }
    }
  }

  await walk(root, 0);
  if (out.length >= maxResults) out.push(`[truncated after ${maxResults} results]`);
  if (!out.length) return `No matches for pattern \"${pattern}\" in ${redactPath(root, absCwd)}.`;
  return out.join('\n');
}
