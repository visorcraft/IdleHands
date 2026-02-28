import fs from 'node:fs/promises';
import path from 'node:path';

import type { ExecResult } from '../types.js';
import { shellEscape } from '../utils.js';

import { resolvePath, redactPath } from './path-safety.js';
import { globishMatch, hasRg } from './search-utils.js';
import { ToolError } from './tool-error.js';

/**
 * Build a shell command string from an array of arguments.
 * `regexArgIndex` identifies which argument is a regex pattern that needs
 * double-quoting (to preserve | and other regex metacharacters) instead of
 * the default single-quoting that shellEscape uses.
 *
 * Double-quoting: escapes \, ", $, ` so the shell passes the string through
 * intact to the program, which then interprets regex metacharacters like |.
 */
function buildSearchCommand(args: string[], regexArgIndex: number): string {
  return args.map((arg, i) => {
    if (i === regexArgIndex) {
      // Double-quote: escape shell-special chars inside double quotes
      const escaped = arg
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`')
        .replace(/!/g, '\\!');
      return `"${escaped}"`;
    }
    return shellEscape(arg);
  }).join(' ');
}

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
  // Auto-fix: model sometimes puts path in `include` instead of `path`
  if (!args?.path && args?.include && /^(src|lib|app|\.)[/\\]/.test(args.include)) {
    args = { ...args, path: args.include, include: undefined };
  }
  // Auto-fix: model sometimes puts path in `directory` or `dir`
  if (!args?.path && (args?.directory || args?.dir)) {
    args = { ...args, path: args.directory || args.dir };
  }
  const root = resolvePath(ctx as any, args?.path ?? '.');
  const pattern = typeof args?.pattern === 'string' ? args.pattern : undefined;
  const include = typeof args?.include === 'string' ? args.include : undefined;
  const maxResults = Math.min(args?.max_results ? Number(args.max_results) : 50, 100);
  if (!root) throw new Error('search_files: missing path. Use {"pattern": "...", "path": "src/bot"} — the path parameter is required.');
  if (!pattern) throw new Error('search_files: missing pattern. Use {"pattern": "keyword", "path": "."} — the pattern parameter is required.');

  const absCwd = path.resolve(ctx.cwd);

  if (await hasRg()) {
    const cmd = ['rg', '-n', '--no-heading', '--color', 'never', '-e', pattern, root];
    if (include) cmd.splice(1, 0, '-g', include);
    try {
      const patternIdx = cmd.indexOf('-e') + 1;
      const cmdStr = buildSearchCommand(cmd, patternIdx);
      const rawJson = await execFn(ctx, { command: cmdStr, timeout: 30 });
      const parsed: ExecResult = JSON.parse(rawJson);
      if (parsed.rc === 1 && !parsed.out?.trim()) {
        // No matches from rg; fall through to grep/JS fallback before declaring 0 matches.
      } else if (parsed.rc < 2) {
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
      // fall through to grep fallback
    }
  }

  // Fallback: try grep if rg is not available or failed
  if (!await hasRg()) {
    try {
      const grepCmd = ['grep', '-rn', '--color=never', '-e', pattern, root];
      if (include) grepCmd.splice(1, 0, `--include=${include}`);
      const patternIdx = grepCmd.indexOf('-e') + 1;
      const grepStr = buildSearchCommand(grepCmd, patternIdx);
      const rawJson = await execFn(ctx, { command: grepStr, timeout: 30 });
      const parsed: ExecResult = JSON.parse(rawJson);
      if (parsed.rc === 1 && !parsed.out?.trim()) {
        // grep returns 1 for no matches — fall through to JS walker
      } else if (parsed.rc < 2 && parsed.out?.trim()) {
        const grepLines = parsed.out.split(/\r?\n/).filter(Boolean).slice(0, maxResults);
        if (grepLines.length >= maxResults) grepLines.push(`[truncated after ${maxResults} results]`);
        const redactedLines = grepLines.map((line) => {
          const colonIdx = line.indexOf(':');
          if (colonIdx === -1) return line;
          const filePath = line.substring(0, colonIdx);
          const rest = line.substring(colonIdx + 1);
          return redactPath(filePath, absCwd) + ':' + rest;
        });
        return redactedLines.join('\n');
      }
    } catch {
      // fall through to JS walker
    }
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    // If regex is invalid, escape and retry as literal string match
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      re = new RegExp(escaped);
    } catch (e2: any) {
      throw new ToolError(
        'invalid_args',
        `search_files: invalid pattern: ${e2?.message ?? String(e2)}`,
        false,
        'Escape regex metacharacters (\\\\, [, ], (, ), +, *, ?). If you intended literal text, use an escaped/literal pattern.'
      );
    }
  }
  const out: string[] = [];

  // Handle single-file path: if root is a file (not directory), search it directly.
  const rootStat = await fs.stat(root).catch(() => null);
  if (rootStat?.isFile()) {
    const rawBuf = await fs.readFile(root).catch(() => null);
    if (rawBuf) {
      const buf = rawBuf.toString('utf8');
      const lines = buf.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push(`${redactPath(root, absCwd)}:${i + 1}:${lines[i]}`);
          if (out.length >= maxResults) break;
        }
      }
    }
    if (out.length >= maxResults) out.push(`[truncated after ${maxResults} results]`);
    if (!out.length) return `No matches for pattern \"${pattern}\" in ${redactPath(root, absCwd)}.`;
    return out.join('\n');
  }

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
