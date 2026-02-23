import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, describe } from 'node:test';

import { acquireAntonLock, releaseAntonLock, isAntonLockHeld } from '../dist/anton/lock.js';

// Mock stateDir to use a temp directory for tests
const originalStateDir = process.env.XDG_STATE_HOME;
let tempStateDir: string;

async function setupTestStateDir(): Promise<void> {
  tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anton-lock-test-'));
  process.env.XDG_STATE_HOME = tempStateDir;
}

async function cleanupTestStateDir(): Promise<void> {
  try {
    await fs.rm(tempStateDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
  if (originalStateDir === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = originalStateDir;
  }
}

async function writeStaleLock(age: number, pid: number, heartbeatAge?: number): Promise<void> {
  const lockPath = path.join(tempStateDir, 'idlehands', 'anton.lock');
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const staleTime = new Date(Date.now() - age);
  const hbTime = new Date(Date.now() - (heartbeatAge ?? age));
  const staleLock = {
    pid,
    startedAt: staleTime.toISOString(),
    heartbeatAt: hbTime.toISOString(),
    cwd: '/tmp/test',
    taskFile: 'test.md',
  };

  await fs.writeFile(lockPath, JSON.stringify(staleLock), 'utf8');
}

describe('Anton lock functions', () => {
  test('acquire succeeds on first call', async () => {
    await setupTestStateDir();
    try {
      await assert.doesNotReject(async () => {
        await acquireAntonLock('test.md', '/tmp/test');
      });

      // Verify lock is held
      assert.strictEqual(await isAntonLockHeld(), true);
    } finally {
      await releaseAntonLock();
      await cleanupTestStateDir();
    }
  });

  test('second acquire from different PID throws conflict error', async () => {
    await setupTestStateDir();
    try {
      // Use parent PID — guaranteed alive and accessible to process.kill(pid, 0)
      const alivePid = process.ppid;
      await writeStaleLock(0, alivePid);

      // Acquire should fail — different PID, not stale
      await assert.rejects(
        async () => await acquireAntonLock('test2.md', '/tmp/test2'),
        new RegExp(`Anton: Run already in progress \\(PID ${alivePid}\\). Use /anton stop first.`)
      );
    } finally {
      await releaseAntonLock();
      await cleanupTestStateDir();
    }
  });

  test('same-PID lock is reclaimable', async () => {
    await setupTestStateDir();
    try {
      await acquireAntonLock('test.md', '/tmp/test');
      // Same PID should be able to re-acquire (reclaims)
      await assert.doesNotReject(async () => {
        await acquireAntonLock('test2.md', '/tmp/test2');
      });
    } finally {
      await releaseAntonLock();
      await cleanupTestStateDir();
    }
  });

  test('release removes lock file', async () => {
    await setupTestStateDir();
    try {
      await acquireAntonLock('test.md', '/tmp/test');
      assert.strictEqual(await isAntonLockHeld(), true);

      await releaseAntonLock();
      assert.strictEqual(await isAntonLockHeld(), false);

      // Verify lock file is gone
      const lockPath = path.join(tempStateDir, 'idlehands', 'anton.lock');
      await assert.rejects(async () => await fs.access(lockPath), { code: 'ENOENT' });
    } finally {
      await cleanupTestStateDir();
    }
  });

  test('stale lock (fake old timestamp) is reclaimed', async () => {
    await setupTestStateDir();
    try {
      // Write a stale lock (2 hours old with current PID to make sure it's old but not dead process)
      const staleAge = 2 * 60 * 60 * 1000; // 2 hours
      await writeStaleLock(staleAge, process.pid);

      // This should succeed by reclaiming the stale lock
      await assert.doesNotReject(async () => {
        await acquireAntonLock('test.md', '/tmp/test');
      });

      assert.strictEqual(await isAntonLockHeld(), true);
    } finally {
      await releaseAntonLock();
      await cleanupTestStateDir();
    }
  });

  test('dead PID lock is reclaimed', async () => {
    await setupTestStateDir();
    try {
      // Write a lock with a dead PID (use a very high number that's unlikely to exist)
      const deadPid = 999999;
      await writeStaleLock(10 * 60 * 1000, deadPid); // 10 minutes old but dead process

      // This should succeed by reclaiming the dead lock
      await assert.doesNotReject(async () => {
        await acquireAntonLock('test.md', '/tmp/test');
      });

      assert.strictEqual(await isAntonLockHeld(), true);
    } finally {
      await releaseAntonLock();
      await cleanupTestStateDir();
    }
  });

  test('stale heartbeat lock is reclaimed even if process PID is alive', async () => {
    await setupTestStateDir();
    try {
      const alivePid = process.pid;
      // Fresh start time, but stale heartbeat (3 minutes old)
      await writeStaleLock(10_000, alivePid, 3 * 60 * 1000);

      await assert.doesNotReject(async () => {
        await acquireAntonLock('test.md', '/tmp/test');
      });

      assert.strictEqual(await isAntonLockHeld(), true);
    } finally {
      await releaseAntonLock();
      await cleanupTestStateDir();
    }
  });
});
