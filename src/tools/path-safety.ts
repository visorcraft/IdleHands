/**
 * Path safety helpers for tool operations.
 * Enforces working directory constraints, path redaction, and mutation guards.
 */

import path from 'node:path';

import type { ToolContext } from '../tools.js';

/**
 * Check if a resolved target path resides within a directory.
 * Handles the classic root directory edge case: when dir is `/`, every absolute path is valid.
 */
export function isWithinDir(target: string, dir: string): boolean {
  if (dir === '/') return target.startsWith('/') && !target.includes('..');
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve a tool argument path to an absolute path using the context's cwd.
 */
export function resolvePath(ctx: ToolContext, p: any): string {
  if (typeof p !== 'string' || !p.trim()) throw new Error('missing path');
  return path.resolve(ctx.cwd, p);
}

/**
 * Redact a path for safe output.
 * - Paths within cwd are shown as relative paths
 * - Paths outside cwd are redacted as [outside-cwd]/basename
 */
export function redactPath(filePath: string, absCwd: string): string {
  const resolved = path.resolve(filePath);
  if (isWithinDir(resolved, absCwd)) {
    return path.relative(absCwd, resolved);
  }
  const basename = path.basename(resolved);
  return `[outside-cwd]/${basename}`;
}

/**
 * Check if a resolved path is outside the working directory.
 * Returns a model-visible warning string if so, empty string otherwise.
 */
export function checkCwdWarning(tool: string, resolvedPath: string, ctx: ToolContext): string {
  const absCwd = path.resolve(ctx.cwd);
  if (isWithinDir(resolvedPath, absCwd)) return '';
  const warning = `\n[WARNING] Path "${resolvedPath}" is OUTSIDE the working directory "${absCwd}". You MUST use relative paths and work within the project directory. Do NOT create or edit files outside the cwd.`;
  console.warn(
    `[warning] ${tool}: path "${resolvedPath}" is outside the working directory "${absCwd}".`
  );
  return warning;
}

/**
 * Hard guard for mutating file tools in normal code mode.
 * In code mode, writing outside cwd is always blocked to prevent accidental edits
 * in the wrong repository. System mode keeps broader path freedom for /etc workflows.
 */
export function enforceMutationWithinCwd(
  tool: string,
  resolvedPath: string,
  ctx: ToolContext
): void {
  if (ctx.mode === 'sys') return;

  const absTarget = path.resolve(resolvedPath);
  const absCwd = path.resolve(ctx.cwd);
  const roots = (ctx.allowedWriteRoots ?? []).map((r) => path.resolve(r));
  const allowAny = roots.includes('/');

  // If session requires explicit /dir pinning, block all mutations until pinned.
  // Exception: if cwd matches one of the repo candidates, auto-allow.
  if (ctx.requireDirPinForMutations && !ctx.dirPinned) {
    const candidates = ctx.repoCandidates ?? [];
    const cwdMatchesCandidate = candidates.some((c) => {
      const absCandidate = path.resolve(c);
      return absCwd === absCandidate || isWithinDir(absCwd, absCandidate);
    });
    if (!cwdMatchesCandidate) {
      const hint = candidates.length ? ` Candidates: ${candidates.slice(0, 8).join(', ')}` : '';
      throw new Error(
        `${tool}: BLOCKED — multiple repository candidates detected. Set repo root explicitly with /dir <path> before editing files.${hint}`
      );
    }
  }

  // Respect allowed roots first.
  if (roots.length > 0 && !allowAny) {
    const inAllowed = roots.some((root) => isWithinDir(absTarget, root));
    if (!inAllowed) {
      throw new Error(
        `${tool}: BLOCKED — path "${absTarget}" is outside allowed directories: ${roots.join(', ')}`
      );
    }
  }

  // If / is explicitly allowed, permit filesystem-wide writes after pin policy above.
  if (allowAny) return;

  // In code mode, keep edits scoped to current working directory unless explicitly sys mode.
  if (!isWithinDir(absTarget, absCwd)) {
    throw new Error(
      `${tool}: BLOCKED — path "${absTarget}" is outside the working directory "${absCwd}". Run /dir <project-root> first, then retry with relative paths.`
    );
  }
}
