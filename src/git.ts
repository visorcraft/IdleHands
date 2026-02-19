import { spawn, spawnSync } from 'node:child_process';
import { BASH_PATH as BASH } from './utils.js';

async function sh(cmd: string, cwd: string, timeoutSec: number): Promise<{ rc: number; out: string }> {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(BASH, ['-lc', cmd], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ rc: 127, out: '' });
      return;
    }
    const out: Buffer[] = [];
    const t = setTimeout(() => child.kill('SIGKILL'), Math.max(1, timeoutSec) * 1000);
    child.on('error', () => {
      clearTimeout(t);
      resolve({ rc: 127, out: '' });
    });
    child.stdout.on('data', (d) => out.push(d));
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ rc: code ?? 0, out: Buffer.concat(out).toString('utf8') });
    });
  });
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
  const inside = await sh('git rev-parse --is-inside-work-tree', cwd, 1);
  if (inside.rc !== 0 || !inside.out.trim().startsWith('true')) return '';

  const branch = await sh('git rev-parse --abbrev-ref HEAD', cwd, 1);
  const status = await sh('git status -s', cwd, 2);
  const diffstat = await sh('git diff --stat', cwd, 2);
  const recent = await sh('git log --oneline -5', cwd, 2);

  const parts: string[] = [];
  parts.push(`[git branch: ${branch.out.trim() || 'unknown'}]`);

  const st = clipLines(status.out, 40, 2000);
  if (st.trim()) {
    parts.push('[git status -s]');
    parts.push(st);
  }

  const ds = clipLines(diffstat.out, 40, 2000);
  if (ds.trim()) {
    parts.push('[git diff --stat]');
    parts.push(ds);
  }

  const lg = clipLines(recent.out, 8, 1200);
  if (lg.trim()) {
    parts.push('[git log --oneline -5]');
    parts.push(lg);
  }

  return parts.join('\n');
}

export function isGitDirty(cwd: string): boolean {
  const inside = spawnSync(BASH, ['-lc', 'git rev-parse --is-inside-work-tree'], { cwd, encoding: 'utf8', timeout: 1000 });
  if (inside.status !== 0 || !String(inside.stdout || '').trim().startsWith('true')) return false;
  const st = spawnSync(BASH, ['-lc', 'git status --porcelain'], { cwd, encoding: 'utf8', timeout: 1500 });
  return st.status === 0 && String(st.stdout || '').trim().length > 0;
}

export function stashWorkingTree(cwd: string): { ok: boolean; message: string } {
  const stamp = new Date().toISOString();
  const res = spawnSync(BASH, ['-lc', `git stash push -u -m "idlehands auto-stash ${stamp}"`], { cwd, encoding: 'utf8', timeout: 5000 });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (res.status === 0) return { ok: true, message: out || 'stashed' };
  return { ok: false, message: out || `git stash failed (rc=${res.status ?? 1})` };
}

export async function loadGitStartupSummary(cwd: string): Promise<string> {
  const inside = await sh('git rev-parse --is-inside-work-tree', cwd, 1);
  if (inside.rc !== 0 || !inside.out.trim().startsWith('true')) return '';

  const branch = (await sh('git rev-parse --abbrev-ref HEAD', cwd, 1)).out.trim() || 'unknown';
  const status = (await sh('git status --porcelain', cwd, 2)).out.split(/\r?\n/).filter(Boolean);
  const modified = status.filter((l) => /^[ MARC][MDARC]/.test(l) || /^[MDARC][ MARC]/.test(l)).length;
  const untracked = status.filter((l) => l.startsWith('??')).length;

  return `${modified} modified files, ${untracked} untracked, on branch ${branch}`;
}

export function ensureCleanWorkingTree(cwd: string): void {
  if (isGitDirty(cwd)) {
    throw new Error("Anton: Working tree not clean. Commit or stash first.");
  }
}

export function getWorkingDiff(cwd: string): string {
  const inside = spawnSync(BASH, ['-lc', 'git rev-parse --is-inside-work-tree'], { cwd, encoding: 'utf8', timeout: 1000 });
  if (inside.status !== 0 || !String(inside.stdout || '').trim().startsWith('true')) return '';
  
  const res = spawnSync(BASH, ['-lc', 'git diff HEAD'], { cwd, encoding: 'utf8', timeout: 30000 });
  return String(res.stdout || '');
}

export function commitAll(cwd: string, message: string): string {
  const res = spawnSync(BASH, ['-lc', `git add -A && git commit -m ${JSON.stringify(message)}`], { cwd, encoding: 'utf8', timeout: 30000 });
  if (res.status !== 0) {
    // Check if it's because there's nothing to commit
    const status = spawnSync(BASH, ['-lc', 'git status --porcelain'], { cwd, encoding: 'utf8', timeout: 1500 });
    if (status.status === 0 && String(status.stdout || '').trim().length === 0) {
      return '';
    }
    throw new Error(`git commit failed: ${res.stderr || res.stdout || 'unknown error'}`);
  }
  
  // Get the commit hash
  const hashRes = spawnSync(BASH, ['-lc', 'git rev-parse --short HEAD'], { cwd, encoding: 'utf8', timeout: 30000 });
  return String(hashRes.stdout || '').trim();
}

export function commitAmend(cwd: string): void {
  const res = spawnSync(BASH, ['-lc', 'git add -A && git commit --amend --no-edit'], { cwd, encoding: 'utf8', timeout: 30000 });
  if (res.status !== 0) {
    throw new Error(`git commit --amend failed: ${res.stderr || res.stdout || 'unknown error'}`);
  }
}

export function restoreTrackedChanges(cwd: string): void {
  spawnSync(BASH, ['-lc', 'git checkout -- .'], { cwd, encoding: 'utf8', timeout: 30000 });
}

export function cleanUntracked(cwd: string): void {
  const res = spawnSync(BASH, ['-lc', 'git clean -fd'], { cwd, encoding: 'utf8', timeout: 30000 });
  if (res.status !== 0) {
    throw new Error(`git clean failed: ${res.stderr || res.stdout || 'unknown error'}`);
  }
}

export function createBranch(cwd: string, name: string): void {
  const res = spawnSync(BASH, ['-lc', `git checkout -b ${JSON.stringify(name)}`], { cwd, encoding: 'utf8', timeout: 30000 });
  if (res.status !== 0) {
    throw new Error(`git checkout -b failed: ${res.stderr || res.stdout || 'unknown error'}`);
  }
}
