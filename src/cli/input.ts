/**
 * User input helpers: multi-line continuation, @-file expansion, image refs,
 * clipboard, reverse-search, stdin pipe reading.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type readline from 'node:readline/promises';

import type { makeStyler } from '../term.js';
import type { UserContent } from '../types.js';
import { escapeRegex } from '../utils.js';

import { splitTokens } from './command-utils.js';

// ── Multi-line continuation ──────────────────────────────────────────

export function hasUnclosedTripleQuote(s: string): boolean {
  const m = s.match(/"""/g);
  return (m?.length ?? 0) % 2 === 1;
}

export function hasUnbalancedDelimiters(s: string): boolean {
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let inSingle = false;
  let inDouble = false;

  const isWordChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : '';
    const next = i + 1 < s.length ? s[i + 1] : '';

    const apostropheInWord = ch === "'" && isWordChar(prev) && isWordChar(next);
    if (ch === "'" && prev !== '\\' && !inDouble && !apostropheInWord) inSingle = !inSingle;
    else if (ch === '"' && prev !== '\\' && !inSingle) inDouble = !inDouble;

    if (inSingle || inDouble) continue;

    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '{') brace++;
    else if (ch === '}') brace--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
  }

  return paren > 0 || brace > 0 || bracket > 0 || inSingle || inDouble;
}

export function needsContinuation(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith('\\')) return true;
  if (hasUnclosedTripleQuote(text)) return true;
  return hasUnbalancedDelimiters(text);
}

export async function readUserInput(rl: any, prompt: string): Promise<string> {
  let text = await rl.question(prompt);

  // Bracketed paste / multi-line chunks come through as embedded newlines.
  if (text.includes('\n')) {
    return text;
  }

  while (needsContinuation(text)) {
    const next = await rl.question('... ');
    if (text.trimEnd().endsWith('\\')) {
      text = text.trimEnd().replace(/\\$/, '') + '\n' + next;
    } else {
      text += '\n' + next;
    }
  }

  return text;
}

export async function readStdinIfPiped(): Promise<string> {
  if (process.stdin.isTTY) return '';

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

// ── Reverse search ───────────────────────────────────────────────────

export async function reverseSearchHistory(
  rl: readline.Interface,
  styler: ReturnType<typeof makeStyler>
): Promise<void> {
  const q = (await rl.question('\n(reverse-i-search) query: ')).trim();
  if (!q) {
    rl.prompt(true);
    return;
  }
  const hist: string[] = Array.isArray((rl as any).history) ? (rl as any).history : [];
  const found = hist.find((h) => h.includes(q));
  if (!found) {
    process.stderr.write(`${styler.dim(`\n(no match for "${q}")\n`)}`);
    rl.prompt(true);
    return;
  }
  rl.write(null, { ctrl: true, name: 'u' } as any);
  rl.write(found);
}

// ── Path / binary helpers ────────────────────────────────────────────

export function isLikelyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 512));
  return sample.includes(0);
}

export function isPathCompletionContext(line: string): boolean {
  const words = splitTokens(line);
  if (words.length < 2) return false;
  const first = words[0].toLowerCase();
  const pathish = new Set([
    'read_file',
    'write_file',
    'edit_file',
    'insert_file',
    'list_dir',
    'search_files',
    'cat',
    'less',
    'more',
    'vim',
    'nano',
    'code',
    'cd',
    'ls',
  ]);
  return pathish.has(first);
}

// ── .gitignore / file collection ─────────────────────────────────────

export function matchIgnorePattern(relPath: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p || p.startsWith('#') || p.startsWith('!')) return false;
  const normalized = relPath.replace(/\\/g, '/');

  if (p.endsWith('/')) {
    const dir = p.slice(0, -1).replace(/^\//, '');
    return normalized === dir || normalized.startsWith(`${dir}/`);
  }

  if (!p.includes('*')) {
    const plain = p.replace(/^\//, '');
    return normalized === plain || normalized.startsWith(`${plain}/`);
  }

  const re = new RegExp('^' + p.replace(/^\//, '').split('*').map(escapeRegex).join('.*') + '$');
  return re.test(normalized);
}

export async function loadGitIgnorePatterns(cwd: string): Promise<string[]> {
  const fixed = ['.git/', 'node_modules/', 'dist/', 'build/'];
  const raw = await fs.readFile(path.join(cwd, '.gitignore'), 'utf8').catch(() => '');
  if (!raw.trim()) return fixed;
  const fromFile = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'));
  return [...fixed, ...fromFile];
}

export function isIgnored(relPath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchIgnorePattern(relPath, p));
}

export async function collectDirectoryFiles(
  baseDir: string,
  relDir: string,
  maxDepth: number,
  patterns: string[],
  acc: string[]
): Promise<void> {
  if (maxDepth < 0) return;
  const absDir = path.join(baseDir, relDir);
  const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => [] as any[]);
  for (const e of entries) {
    const rel = path.posix.join(relDir.replace(/\\/g, '/'), e.name).replace(/^\.?\//, '');
    if (!rel) continue;
    if (isIgnored(rel, patterns)) continue;
    if (e.isDirectory()) {
      await collectDirectoryFiles(baseDir, rel, maxDepth - 1, patterns, acc);
    } else if (e.isFile()) {
      acc.push(rel);
    }
  }
}

async function resolveAtRefToFiles(
  ref: string,
  cwd: string,
  patterns: string[]
): Promise<string[]> {
  const hasGlob = /[*?[]/.test(ref);

  if (hasGlob) {
    const out: string[] = [];
    try {
      for await (const rel of fs.glob(ref, { cwd })) {
        const clean = String(rel).replace(/\\/g, '/');
        if (!clean) continue;
        if (isIgnored(clean, patterns)) continue;
        const st = await fs.stat(path.join(cwd, clean)).catch(() => null as any);
        if (st?.isFile()) out.push(clean);
      }
    } catch {}
    return out;
  }

  const abs = path.resolve(cwd, ref);
  const st = await fs.stat(abs).catch(() => null as any);
  if (!st) return [];

  if (st.isFile()) {
    const rel = path.relative(cwd, abs).replace(/\\/g, '/');
    if (!rel || isIgnored(rel, patterns)) return [];
    return [rel];
  }

  if (st.isDirectory()) {
    const rel = path.relative(cwd, abs).replace(/\\/g, '/');
    const acc: string[] = [];
    await collectDirectoryFiles(cwd, rel, 3, patterns, acc);
    return acc;
  }

  return [];
}

export async function expandAtFileRefs(
  inputText: string,
  cwd: string,
  contextMaxTokens = 8192
): Promise<{ text: string; warnings: string[] }> {
  const tokenRe = /(^|\s)@([^\s]+)/g;
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(inputText)) !== null) refs.push(m[2]);
  if (refs.length === 0) return { text: inputText, warnings: [] };

  const patterns = await loadGitIgnorePatterns(cwd);
  const warnings: string[] = [];
  let expanded = inputText;
  let usedTokens = Math.ceil(inputText.length / 4);

  for (const ref of refs) {
    const files = await resolveAtRefToFiles(ref, cwd, patterns);
    if (!files.length) continue;

    let injection = '';
    for (const relFile of files) {
      const buf = await fs.readFile(path.join(cwd, relFile)).catch(() => null);
      if (!buf) continue;

      if (isLikelyBinary(buf)) {
        warnings.push(`[at-ref] skipped binary file @${relFile}`);
        continue;
      }

      const block = `[Contents of ${relFile}]\n${buf.toString('utf8')}\n[End ${relFile}]\n`;
      const blockTokens = Math.ceil(block.length / 4);
      if (usedTokens + blockTokens > contextMaxTokens) {
        warnings.push(
          `[at-ref] context_max_tokens (${contextMaxTokens}) reached while expanding @${ref}; remaining refs truncated`
        );
        injection += `[truncated @${ref}: context_max_tokens reached]`;
        break;
      }

      usedTokens += blockTokens;
      injection += block;
    }

    if (!injection.trim()) continue;
    expanded = expanded.replace(`@${ref}`, injection.trimEnd());
  }

  return { text: expanded, warnings };
}

// ── Image handling ───────────────────────────────────────────────────

export function isImagePathLike(value: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(value);
}

export function mimeForImagePath(value: string): string {
  const lower = value.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff';
  return 'application/octet-stream';
}

export function extractImageRefs(text: string): string[] {
  const refs = new Set<string>();

  // Markdown images: ![alt](path-or-url)
  const mdRe = /!\[[^\]]*\]\(([^)]+)\)/g;
  let mm: RegExpExecArray | null;
  while ((mm = mdRe.exec(text)) !== null) {
    const v = mm[1].trim();
    if (v) refs.add(v.replace(/^['"]|['"]$/g, ''));
  }

  // Plain URLs and path-like image tokens
  const tokenRe =
    /https?:\/\/[^\s)]+\.(?:png|jpe?g|webp|gif|bmp|tiff?)(?:\?[^\s)]*)?|(?:\.\.\/|\.\/|\/|~\/)?[^\s)]+\.(?:png|jpe?g|webp|gif|bmp|tiff?)/gi;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    refs.add(m[0].trim());
  }

  return [...refs];
}

export function hasClipboardImageToken(text: string): boolean {
  return /(?:^|\s)(@clipboard|clipboard:image|\[clipboard\]|\[\[clipboard\]\])(?:$|\s)/i.test(text);
}

function readClipboardImageDataUrl(): string | null {
  const attempts: Array<{ cmd: string; args: string[]; mime: string }> = [
    { cmd: 'wl-paste', args: ['--type', 'image/png'], mime: 'image/png' },
    { cmd: 'wl-paste', args: ['--type', 'image/jpeg'], mime: 'image/jpeg' },
    { cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'], mime: 'image/png' },
    {
      cmd: 'xclip',
      args: ['-selection', 'clipboard', '-t', 'image/jpeg', '-o'],
      mime: 'image/jpeg',
    },
  ];

  for (const a of attempts) {
    const run = spawnSync(a.cmd, a.args, { encoding: null, timeout: 1500 });
    if (run.status === 0 && run.stdout && Buffer.isBuffer(run.stdout) && run.stdout.length > 0) {
      return `data:${a.mime};base64,${run.stdout.toString('base64')}`;
    }
  }
  return null;
}

export async function expandPromptImages(
  text: string,
  cwd: string,
  supportsVision: boolean
): Promise<{ content: UserContent; warnings: string[]; imageCount: number }> {
  const refs = extractImageRefs(text);
  const wantsClipboard = hasClipboardImageToken(text);
  if (!refs.length && !wantsClipboard) return { content: text, warnings: [], imageCount: 0 };

  if (!supportsVision) {
    const detected = refs.length + (wantsClipboard ? 1 : 0);
    return {
      content: text,
      warnings: [
        `[vision] detected ${detected} image reference(s), but current model does not advertise vision input support.`,
      ],
      imageCount: 0,
    };
  }

  const warnings: string[] = [];
  const parts: Exclude<UserContent, string> = [{ type: 'text', text }];
  let imageCount = 0;

  for (const ref of refs) {
    if (/^https?:\/\//i.test(ref)) {
      parts.push({ type: 'image_url', image_url: { url: ref } });
      imageCount++;
      continue;
    }

    const cleaned = ref.replace(/^['"]|['"]$/g, '');
    const abs = cleaned.startsWith('~/')
      ? path.join(os.homedir(), cleaned.slice(2))
      : path.resolve(cwd, cleaned);

    const exists = await fs.stat(abs).catch(() => null as any);
    if (!exists?.isFile()) {
      warnings.push(`[vision] image path not found: ${cleaned}`);
      continue;
    }

    if (!isImagePathLike(abs)) {
      warnings.push(`[vision] skipped non-image path: ${cleaned}`);
      continue;
    }

    const buf = await fs.readFile(abs).catch(() => null);
    if (!buf) {
      warnings.push(`[vision] failed to read: ${cleaned}`);
      continue;
    }

    const mime = mimeForImagePath(abs);
    const b64 = buf.toString('base64');
    parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
    imageCount++;
  }

  if (wantsClipboard) {
    const clip = readClipboardImageDataUrl();
    if (clip) {
      parts.push({ type: 'image_url', image_url: { url: clip } });
      imageCount++;
    } else {
      warnings.push(
        '[vision] clipboard image token detected, but no image was available from clipboard (tried wl-paste/xclip).'
      );
    }
  }

  if (imageCount === 0) {
    return { content: text, warnings, imageCount: 0 };
  }

  return { content: parts, warnings, imageCount };
}
