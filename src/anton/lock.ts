import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from '../utils.js';

function lockPath(): string {
  return path.join(stateDir(), 'anton.lock');
}
const STALE_LOCK_MS = 60 * 60 * 1000; // 1 hour

type AntonLock = {
  pid: number;
  startedAt: string;
  cwd: string;
  taskFile: string;
};

let currentLock: AntonLock | null = null;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockAgeMs(lock: AntonLock | null): number | null {
  if (!lock?.startedAt) return null;
  const ts = Date.parse(lock.startedAt);
  if (!Number.isFinite(ts)) return null;
  return Date.now() - ts;
}

function isLockStale(lock: AntonLock | null): boolean {
  if (!lock) return false;
  const age = lockAgeMs(lock);
  if (age != null && age > STALE_LOCK_MS) return true;
  return !isPidAlive(lock.pid);
}

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true });
}

async function readLock(): Promise<AntonLock | null> {
  try {
    const content = await fs.readFile(lockPath(), 'utf8');
    const parsed = JSON.parse(content);
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      taskFile: typeof parsed.taskFile === 'string' ? parsed.taskFile : '',
    };
  } catch {
    return null;
  }
}

async function writeLock(taskFile: string, cwd: string): Promise<void> {
  await ensureStateDir();
  const payload: AntonLock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd,
    taskFile,
  };
  await fs.writeFile(lockPath(), JSON.stringify(payload), { encoding: 'utf8', flag: 'wx' });
  currentLock = payload;
}

async function removeLock(): Promise<void> {
  try {
    await fs.rm(lockPath(), { force: true });
  } catch {
    // best effort
  }
  currentLock = null;
}

export async function acquireAntonLock(taskFile: string, cwd: string): Promise<void> {
  const existing = await readLock();
  
  if (existing) {
    if (isLockStale(existing)) {
      console.warn(`Warning: Stale Anton lock detected (PID ${existing.pid}), reclaiming...`);
      await removeLock();
    } else if (existing.pid === process.pid) {
      // Same process (e.g. concurrent tests in same runner) — safe to reclaim.
      await removeLock();
    } else {
      throw new Error(`Anton: Run already in progress (PID ${existing.pid}). Use /anton stop first.`);
    }
  }
  
  try {
    await writeLock(taskFile, cwd);
  } catch (error: any) {
    if (error.code === 'EEXIST') {
      // Race condition - another process created lock
      const newExisting = await readLock();
      if (newExisting && !isLockStale(newExisting)) {
        throw new Error(`Anton: Run already in progress (PID ${newExisting.pid}). Use /anton stop first.`);
      }
      // If it's stale, try again recursively (but this should be rare)
      return acquireAntonLock(taskFile, cwd);
    }
    throw error;
  }
}

export async function releaseAntonLock(): Promise<void> {
  await removeLock();
}

export async function isAntonLockHeld(): Promise<boolean> {
  const lock = await readLock();
  return lock !== null && !isLockStale(lock);
}