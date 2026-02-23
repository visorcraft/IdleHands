import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.cache',
  '.local',
  '.npm',
  '.cargo',
  '.rustup',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.idea',
  '.vscode',
]);

export function expandHome(raw: string): string {
  const home = process.env.HOME || '/home';
  return raw.replace(/^~(?=$|\/)/, home);
}

export function normalizeAllowedDirs(allowed?: string[]): string[] {
  const inDirs = Array.isArray(allowed) && allowed.length ? allowed : ['~'];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of inDirs) {
    const abs = path.resolve(expandHome(String(d)));
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

export function isWithinDir(target: string, dir: string): boolean {
  if (dir === '/') return target.startsWith('/');
  return target === dir || target.startsWith(dir + path.sep);
}

export function isPathAllowed(targetPath: string, allowedDirs: string[]): boolean {
  const abs = path.resolve(expandHome(targetPath));
  return allowedDirs.some((root) => isWithinDir(abs, root));
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Detect git repos near the current workspace to determine whether /dir pinning is needed.
 * This scans a bounded tree and returns absolute repo roots.
 */
export async function detectRepoCandidates(
  seedDir: string,
  allowedDirs: string[],
  opts: { maxDepth?: number; maxDirs?: number; maxResults?: number } = {}
): Promise<string[]> {
  const maxDepth = Math.max(1, opts.maxDepth ?? 3);
  const maxDirs = Math.max(50, opts.maxDirs ?? 2000);
  const maxResults = Math.max(1, opts.maxResults ?? 20);

  const seedAbs = path.resolve(expandHome(seedDir));
  const preferredRoot = path.dirname(seedAbs);
  const scanRoot = (await isDirectory(preferredRoot))
    ? preferredRoot
    : (await isDirectory(seedAbs))
      ? seedAbs
      : process.cwd();

  const queue: Array<{ dir: string; depth: number }> = [{ dir: scanRoot, depth: 0 }];
  const visited = new Set<string>();
  const repos: string[] = [];

  while (queue.length > 0 && visited.size < maxDirs && repos.length < maxResults) {
    const { dir, depth } = queue.shift()!;
    const absDir = path.resolve(dir);
    if (visited.has(absDir)) continue;
    visited.add(absDir);

    if (!isPathAllowed(absDir, allowedDirs)) continue;

    let ents: Dirent[] = [];
    try {
      ents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const hasGit = ents.some((e) => e.isDirectory() && e.name === '.git');
    if (hasGit) {
      repos.push(absDir);
      continue; // treat repo root as terminal for this scan
    }

    if (depth >= maxDepth) continue;

    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const child = path.join(absDir, e.name);
      queue.push({ dir: child, depth: depth + 1 });
      if (queue.length > maxDirs) break;
    }
  }

  return repos.sort();
}
