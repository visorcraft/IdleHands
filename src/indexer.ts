import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { LensStore } from './lens.js';
import type { VaultStore } from './vault.js';
import { escapeRegex, estimateTokens } from './utils.js';

export type ProjectIndexFileMeta = {
  path: string;
  language: string;
  mtimeMs: number;
  tokenCount: number;
};

export type ProjectIndexMeta = {
  projectId: string;
  projectDir: string;
  indexedAt: string;
  fileCount: number;
  totalSkeletonTokens: number;
  languages: Record<string, number>;
  files: Record<string, ProjectIndexFileMeta>;
};

export type ProjectIndexKeys = {
  projectId: string;
  filePrefix: string;
  summaryKey: string;
  metaKey: string;
};

export type ProjectIndexResult = {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  filesRemoved: number;
  totalSkeletonTokens: number;
  warnings: string[];
  meta: ProjectIndexMeta;
};

export type ProjectIndexProgress = {
  scanned: number;
  indexed: number;
  skipped: number;
  current?: string;
};

const WARN_FILE_COUNT = 5_000;
const HARD_FILE_LIMIT = 20_000;

const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.cc': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.json': 'json',
  '.jsonc': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.ps1': 'powershell',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

const SOURCE_BASENAMES = new Set([
  'Dockerfile',
  'Makefile',
  'CMakeLists.txt',
]);

type IgnoreRule = {
  regex: RegExp;
  negate: boolean;
  directoryOnly: boolean;
};

function toPosixRel(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function globToRegex(glob: string, anchored: boolean, directoryOnly: boolean): RegExp {
  let src = '';
  const input = glob.replace(/\\/g, '/');

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (ch === '*') {
      if (next === '*') {
        src += '.*';
        i++;
      } else {
        src += '[^/]*';
      }
      continue;
    }

    if (ch === '?') {
      src += '[^/]';
      continue;
    }

    src += escapeRegex(ch);
  }

  const prefix = anchored ? '^' : '^(?:|.*/)' ;
  const suffix = directoryOnly ? '(?:/.*)?$' : '$';
  return new RegExp(`${prefix}${src}${suffix}`);
}

function parseIgnoreRules(raw: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    let pat = trimmed;
    let negate = false;
    if (pat.startsWith('!')) {
      negate = true;
      pat = pat.slice(1).trim();
    }

    if (!pat) continue;

    let directoryOnly = false;
    if (pat.endsWith('/')) {
      directoryOnly = true;
      pat = pat.slice(0, -1);
    }

    let anchored = false;
    if (pat.startsWith('/')) {
      anchored = true;
      pat = pat.slice(1);
    }

    if (!pat) continue;

    try {
      rules.push({
        regex: globToRegex(pat, anchored, directoryOnly),
        negate,
        directoryOnly,
      });
    } catch {
      // ignore invalid patterns
    }
  }

  return rules;
}

async function loadIgnoreRules(projectDir: string): Promise<IgnoreRule[]> {
  const files = [
    path.join(projectDir, '.gitignore'),
    path.join(projectDir, '.idlehandsignore'),
  ];

  const rules: IgnoreRule[] = [];
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
    if (!raw.trim()) continue;
    rules.push(...parseIgnoreRules(raw));
  }

  return rules;
}

function shouldIgnoreByRules(relPath: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  const rel = toPosixRel(relPath);
  let ignored = false;

  for (const rule of rules) {
    if (rule.directoryOnly && !isDir) continue;

    if (rule.regex.test(rel)) {
      ignored = !rule.negate;
    }
  }

  return ignored;
}

function hasDefaultIgnoredSegment(relPath: string): boolean {
  const parts = toPosixRel(relPath).split('/').filter(Boolean);
  return parts.some((p) => DEFAULT_SKIP_DIRS.has(p));
}

function detectLanguage(relPath: string): string {
  const base = path.basename(relPath);
  if (SOURCE_BASENAMES.has(base)) {
    if (base === 'Dockerfile') return 'dockerfile';
    if (base === 'Makefile') return 'makefile';
    if (base === 'CMakeLists.txt') return 'cmake';
  }

  const ext = path.extname(base).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? 'text';
}

function isSourceCandidate(relPath: string): boolean {
  const base = path.basename(relPath);
  if (SOURCE_BASENAMES.has(base)) return true;

  const ext = path.extname(base).toLowerCase();
  return Boolean(LANGUAGE_BY_EXT[ext]);
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(filePath);
    const head = buf.subarray(0, Math.min(512, buf.length));
    if (head.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

async function walkSourceFiles(projectDir: string, rules: IgnoreRule[]): Promise<{ files: Array<{ abs: string; rel: string; mtimeMs: number }>; warnings: string[] }> {
  const warnings: string[] = [];
  const out: Array<{ abs: string; rel: string; mtimeMs: number }> = [];
  let scanned = 0;

  const walk = async (absDir: string) => {
    const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => [] as any[]);

    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = toPosixRel(path.relative(projectDir, abs));

      if (!rel) continue;

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (hasDefaultIgnoredSegment(rel)) continue;
        if (shouldIgnoreByRules(rel, true, rules)) continue;
        await walk(abs);
        continue;
      }

      if (!entry.isFile()) continue;

      scanned++;
      if (scanned > HARD_FILE_LIMIT) {
        throw new Error(`Project has more than ${HARD_FILE_LIMIT} files after ignore filters; refusing to index.`);
      }

      if (hasDefaultIgnoredSegment(rel)) continue;
      if (shouldIgnoreByRules(rel, false, rules)) continue;
      if (!isSourceCandidate(rel)) continue;

      const st = await fs.stat(abs).catch(() => null);
      if (!st || !st.isFile()) continue;

      out.push({ abs, rel, mtimeMs: st.mtimeMs });
    }
  };

  await walk(projectDir);

  if (scanned > WARN_FILE_COUNT) {
    warnings.push(`Project has ${scanned.toLocaleString()} files; indexing may take longer.`);
  }

  return { files: out, warnings };
}

export function projectIndexId(projectDir: string): string {
  return createHash('sha256').update(path.resolve(projectDir)).digest('hex').slice(0, 16);
}

export function projectIndexKeys(projectDir: string): ProjectIndexKeys {
  const projectId = projectIndexId(projectDir);
  return {
    projectId,
    filePrefix: `index:file:${projectId}:`,
    summaryKey: `index:summary:${projectId}`,
    metaKey: `index:meta:${projectId}`,
  };
}

export function indexSummaryLine(meta: ProjectIndexMeta): string {
  const langs = Object.keys(meta.languages || {}).length;
  const tokenK = (meta.totalSkeletonTokens / 1000).toFixed(1);
  return `[index] ${meta.fileCount} files indexed (${langs} languages, ${tokenK}k skeleton tokens in Vault)`;
}

export function parseIndexMeta(raw: string): ProjectIndexMeta | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.projectId !== 'string') return null;
    if (typeof parsed.projectDir !== 'string') return null;
    if (typeof parsed.indexedAt !== 'string') return null;
    if (typeof parsed.fileCount !== 'number') return null;
    if (typeof parsed.totalSkeletonTokens !== 'number') return null;
    if (!parsed.languages || typeof parsed.languages !== 'object') return null;
    if (!parsed.files || typeof parsed.files !== 'object') return null;
    return parsed as ProjectIndexMeta;
  } catch {
    return null;
  }
}

export function isFreshIndex(meta: ProjectIndexMeta, maxAgeMs = 24 * 60 * 60 * 1000): boolean {
  const ts = Date.parse(meta.indexedAt);
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) <= maxAgeMs;
}

export async function runProjectIndex(opts: {
  projectDir: string;
  vault: VaultStore;
  lens: LensStore;
  onProgress?: (progress: ProjectIndexProgress) => void;
}): Promise<ProjectIndexResult> {
  const projectDir = path.resolve(opts.projectDir);
  const keys = projectIndexKeys(projectDir);

  const rules = await loadIgnoreRules(projectDir);
  const walked = await walkSourceFiles(projectDir, rules);
  const files = walked.files.sort((a, b) => a.rel.localeCompare(b.rel));

  const prevMetaRow = await opts.vault.getLatestByKey(keys.metaKey);
  const prevMeta = prevMetaRow?.value ? parseIndexMeta(prevMetaRow.value) : null;

  const prevFiles = prevMeta?.files ?? {};
  const currentFiles = new Set(files.map((f) => f.rel));

  const nextFiles: Record<string, ProjectIndexFileMeta> = {};
  const languages: Record<string, number> = {};

  let filesIndexed = 0;
  let filesSkipped = 0;
  let filesRemoved = 0;
  let totalSkeletonTokens = 0;

  const emitProgress = (current?: string, scannedOverride?: number) => {
    opts.onProgress?.({
      scanned: scannedOverride ?? (filesIndexed + filesSkipped),
      indexed: filesIndexed,
      skipped: filesSkipped,
      current,
    });
  };

  for (const file of files) {
    const prev = prevFiles[file.rel];
    const language = detectLanguage(file.rel);

    if (prev && prev.mtimeMs === file.mtimeMs) {
      filesSkipped++;
      nextFiles[file.rel] = prev;
      totalSkeletonTokens += prev.tokenCount;
      languages[prev.language] = (languages[prev.language] ?? 0) + 1;
      emitProgress(file.rel);
      continue;
    }

    const text = await readTextFile(file.abs);
    if (text == null) {
      filesSkipped++;
      emitProgress(file.rel);
      continue;
    }

    const skeleton = await opts.lens.projectFile(file.abs, text);
    const tokenCount = estimateTokens(skeleton);

    const value = JSON.stringify({
      kind: 'index',
      path: file.rel,
      language,
      mtimeMs: file.mtimeMs,
      tokenCount,
      skeleton,
    });

    await opts.vault.upsertNote(`${keys.filePrefix}${file.rel}`, value);

    filesIndexed++;
    nextFiles[file.rel] = {
      path: file.rel,
      language,
      mtimeMs: file.mtimeMs,
      tokenCount,
    };
    totalSkeletonTokens += tokenCount;
    languages[language] = (languages[language] ?? 0) + 1;

    emitProgress(file.rel);
  }

  for (const oldRel of Object.keys(prevFiles)) {
    if (currentFiles.has(oldRel)) continue;
    const removed = await opts.vault.deleteByKey(`${keys.filePrefix}${oldRel}`);
    if (removed > 0) filesRemoved++;
  }

  const meta: ProjectIndexMeta = {
    projectId: keys.projectId,
    projectDir,
    indexedAt: new Date().toISOString(),
    fileCount: Object.keys(nextFiles).length,
    totalSkeletonTokens,
    languages,
    files: nextFiles,
  };

  const summary = indexSummaryLine(meta);

  await opts.vault.upsertNote(keys.metaKey, JSON.stringify(meta), 'system');
  await opts.vault.upsertNote(keys.summaryKey, summary, 'system');

  emitProgress(undefined, files.length);

  return {
    filesScanned: files.length,
    filesIndexed,
    filesSkipped,
    filesRemoved,
    totalSkeletonTokens,
    warnings: walked.warnings,
    meta,
  };
}
