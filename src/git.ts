import { spawnSync } from 'node:child_process';

function runGit(
  cwd: string,
  args: string[],
  timeoutMs: number
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return {
    status: res.status ?? 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
  };
}

function isInsideWorkTree(cwd: string): boolean {
  const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree'], 1000);
  return inside.status === 0 && inside.stdout.trim().startsWith('true');
}

function clipLines(s: string, maxLines: number, maxChars: number): string {
  const lines = s.split(/\r?\n/).filter(Boolean);
  const clipped = lines.slice(0, maxLines);
  let out = clipped.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n[truncated]';
  if (lines.length > maxLines) out += `\n[truncated: ${lines.length - maxLines} more lines]`;
  return out;
}

export async function loadGitContext(cwd: string): Promise<string> {
  // Avoid slow git operations; keep it short and bounded.
  if (!isInsideWorkTree(cwd)) return '';

  const branch = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 1000).stdout;
  const status = runGit(cwd, ['status', '-s'], 2000).stdout;
  const diffstat = runGit(cwd, ['diff', '--stat'], 2000).stdout;
  const recent = runGit(cwd, ['log', '--oneline', '-5'], 2000).stdout;

  const parts: string[] = [];
  parts.push(`[git branch: ${branch.trim() || 'unknown'}]`);

  const st = clipLines(status, 40, 2000);
  if (st.trim()) {
    parts.push('[git status -s]');
    parts.push(st);
  }

  const ds = clipLines(diffstat, 40, 2000);
  if (ds.trim()) {
    parts.push('[git diff --stat]');
    parts.push(ds);
  }

  const lg = clipLines(recent, 8, 1200);
  if (lg.trim()) {
    parts.push('[git log --oneline -5]');
    parts.push(lg);
  }

  return parts.join('\n');
}

export function isGitDirty(cwd: string): boolean {
  if (!isInsideWorkTree(cwd)) return false;
  const st = runGit(cwd, ['status', '--porcelain'], 1500);
  return st.status === 0 && st.stdout.trim().length > 0;
}

export function stashWorkingTree(cwd: string): { ok: boolean; message: string } {
  const stamp = new Date().toISOString();
  const res = runGit(cwd, ['stash', 'push', '-u', '-m', `idlehands auto-stash ${stamp}`], 5000);
  const out = `${res.stdout}${res.stderr}`.trim();
  if (res.status === 0) return { ok: true, message: out || 'stashed' };
  return { ok: false, message: out || `git stash failed (rc=${res.status})` };
}

export async function loadGitStartupSummary(cwd: string): Promise<string> {
  if (!isInsideWorkTree(cwd)) return '';

  const branch = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 1000).stdout.trim() || 'unknown';
  const status = runGit(cwd, ['status', '--porcelain'], 2000).stdout.split(/\r?\n/).filter(Boolean);
  const modified = status.filter(
    (l) => /^[ MARC][MDARC]/.test(l) || /^[MDARC][ MARC]/.test(l)
  ).length;
  const untracked = status.filter((l) => l.startsWith('??')).length;

  return `${modified} modified files, ${untracked} untracked, on branch ${branch}`;
}

export function ensureCleanWorkingTree(cwd: string): void {
  if (isGitDirty(cwd)) {
    throw new Error('Anton: Working tree not clean. Commit or stash first.');
  }
}

export function getWorkingDiff(cwd: string): string {
  if (!isInsideWorkTree(cwd)) return '';
  const res = runGit(cwd, ['diff', 'HEAD'], 30000);
  return res.stdout;
}

export function commitAll(cwd: string, message: string): string {
  const addRes = runGit(cwd, ['add', '-A'], 30000);
  if (addRes.status !== 0) {
    throw new Error(`git add failed: ${addRes.stderr || addRes.stdout || 'unknown error'}`);
  }

  const commitRes = runGit(cwd, ['commit', '-m', message], 30000);
  if (commitRes.status !== 0) {
    // Check if it's because there's nothing to commit
    const status = runGit(cwd, ['status', '--porcelain'], 1500);
    if (status.status === 0 && status.stdout.trim().length === 0) {
      return '';
    }
    throw new Error(`git commit failed: ${commitRes.stderr || commitRes.stdout || 'unknown error'}`);
  }

  const hashRes = runGit(cwd, ['rev-parse', '--short', 'HEAD'], 30000);
  return hashRes.stdout.trim();
}

export function commitAmend(cwd: string): void {
  const addRes = runGit(cwd, ['add', '-A'], 30000);
  if (addRes.status !== 0) {
    throw new Error(`git add failed: ${addRes.stderr || addRes.stdout || 'unknown error'}`);
  }
  const res = runGit(cwd, ['commit', '--amend', '--no-edit'], 30000);
  if (res.status !== 0) {
    throw new Error(`git commit --amend failed: ${res.stderr || res.stdout || 'unknown error'}`);
  }
}

export function restoreTrackedChanges(cwd: string): void {
  runGit(cwd, ['checkout', '--', '.'], 30000);
}

export function cleanUntracked(cwd: string): void {
  const res = runGit(cwd, ['clean', '-fd'], 30000);
  if (res.status !== 0) {
    throw new Error(`git clean failed: ${res.stderr || res.stdout || 'unknown error'}`);
  }
}

export function getUntrackedFiles(cwd: string): string[] {
  const res = runGit(cwd, ['ls-files', '--others', '--exclude-standard'], 30000);
  return res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function removeUntrackedFiles(cwd: string, files: string[]): void {
  if (files.length === 0) return;
  const res = runGit(cwd, ['clean', '-f', '--', ...files], 30000);
  if (res.status !== 0) {
    throw new Error(`git clean files failed: ${res.stderr || res.stdout || 'unknown error'}`);
  }
}

export function createBranch(cwd: string, name: string): void {
  const res = runGit(cwd, ['checkout', '-b', name], 30000);
  if (res.status !== 0) {
    throw new Error(`git checkout -b failed: ${res.stderr || res.stdout || 'unknown error'}`);
  }
}
