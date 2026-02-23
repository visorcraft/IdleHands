/**
 * Patch parsing helpers for the apply_patch tool.
 * Extracts touched file paths from unified diff / git-style patches.
 */

import path from 'node:path';

export type PatchTouchInfo = {
  paths: string[]; // normalized relative paths
  created: Set<string>;
  deleted: Set<string>;
};

export function normalizePatchPath(p: string): string {
  let s = String(p ?? '').trim();
  if (!s || s === '/dev/null') return '';

  // Strip quotes some generators add
  s = s.replace(/^"|"$/g, '');
  // Drop common diff prefixes
  s = s.replace(/^[ab]\//, '').replace(/^\.\/+/, '');
  // Normalize to posix separators for diffs
  s = s.replace(/\\/g, '/');

  const norm = path.posix.normalize(s);
  if (norm.startsWith('../') || norm === '..' || norm.startsWith('/')) {
    throw new Error(`apply_patch: unsafe path in patch: ${JSON.stringify(s)}`);
  }
  return norm;
}

export function extractTouchedFilesFromPatch(patchText: string): PatchTouchInfo {
  const paths: string[] = [];
  const created = new Set<string>();
  const deleted = new Set<string>();

  let pendingOld: string | null = null;
  let pendingNew: string | null = null;

  const seen = new Set<string>();
  const lines = String(patchText ?? '').split(/\r?\n/);

  for (const line of lines) {
    // Primary: git-style header
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git\s+a\/(.+?)\s+b\/(.+?)\s*$/.exec(line);
      if (m) {
        const aPath = normalizePatchPath(m[1]);
        const bPath = normalizePatchPath(m[2]);
        const use = bPath || aPath;
        if (use && !seen.has(use)) {
          seen.add(use);
          paths.push(use);
        }
      }
      pendingOld = null;
      pendingNew = null;
      continue;
    }

    // Fallback: unified diff headers
    if (line.startsWith('--- ')) {
      pendingOld = line.slice(4).trim();
      continue;
    }
    if (line.startsWith('+++ ')) {
      pendingNew = line.slice(4).trim();

      const oldP = pendingOld ? pendingOld.replace(/^a\//, '').trim() : '';
      const newP = pendingNew ? pendingNew.replace(/^b\//, '').trim() : '';

      const oldIsDevNull = oldP === '/dev/null';
      const newIsDevNull = newP === '/dev/null';

      if (!newIsDevNull) {
        const rel = normalizePatchPath(newP);
        if (rel && !seen.has(rel)) {
          seen.add(rel);
          paths.push(rel);
        }
        if (oldIsDevNull) created.add(rel);
      }

      if (!oldIsDevNull && newIsDevNull) {
        const rel = normalizePatchPath(oldP);
        if (rel && !seen.has(rel)) {
          seen.add(rel);
          paths.push(rel);
        }
        deleted.add(rel);
      }

      pendingOld = null;
      pendingNew = null;
      continue;
    }
  }

  return { paths, created, deleted };
}
