import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  writeAutosave,
  readAutosave,
  clearAutosave,
  formatRecoveryPrompt,
  createAutosaveController,
  acquireLock,
  releaseLock,
  forceAcquireLock,
  isPidAlive,
  type AutosaveData
} from '../dist/recovery.js';

// Override state dir for testing by writing directly to temp paths
// We test the public API functions which use the real paths, so we
// test the logic with direct file operations in a temp dir.

describe('recovery: autosave', () => {
  it('writeAutosave + readAutosave round-trips session state', async () => {
    const data: AutosaveData = {
      messages: [
        { role: 'system', content: 'You are a coding agent.' },
        { role: 'user', content: 'Fix the bug' },
        { role: 'assistant', content: 'Done.' }
      ],
      model: 'test-model',
      harness: 'generic',
      cwd: '/tmp/test',
      turns: 3,
      toolCalls: 1,
      savedAt: new Date().toISOString(),
      pid: process.pid
    };

    await writeAutosave(data);
    const loaded = await readAutosave();

    assert.ok(loaded, 'should load autosave');
    assert.equal(loaded!.messages.length, 3);
    assert.equal(loaded!.model, 'test-model');
    assert.equal(loaded!.turns, 3);
    assert.equal(loaded!.toolCalls, 1);
    assert.equal(loaded!.cwd, '/tmp/test');

    await clearAutosave();
    const after = await readAutosave();
    assert.equal(after, null, 'should be null after clear');
  });

  it('readAutosave returns null for corrupt data', async () => {
    const stateDir = path.join(os.homedir(), '.local', 'state', 'idlehands');
    const autosavePath = path.join(stateDir, 'autosave.json');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(autosavePath, 'not json', 'utf8');

    const loaded = await readAutosave();
    assert.equal(loaded, null);

    await clearAutosave();
  });

  it('readAutosave returns null for missing system message', async () => {
    const stateDir = path.join(os.homedir(), '.local', 'state', 'idlehands');
    const autosavePath = path.join(stateDir, 'autosave.json');
    await fs.mkdir(stateDir, { recursive: true });
    // messages[0].role is 'user' instead of 'system'
    await fs.writeFile(autosavePath, JSON.stringify({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'x', harness: 'x', cwd: '/tmp', turns: 1, toolCalls: 0,
      savedAt: new Date().toISOString(), pid: process.pid
    }), 'utf8');

    const loaded = await readAutosave();
    assert.equal(loaded, null);

    await clearAutosave();
  });

  it('formatRecoveryPrompt produces human-readable message', () => {
    const data: AutosaveData = {
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      model: 'test',
      harness: 'generic',
      cwd: '/tmp',
      turns: 8,
      toolCalls: 3,
      savedAt: new Date(Date.now() - 2 * 60_000).toISOString(), // 2 min ago
      pid: process.pid
    };

    const prompt = formatRecoveryPrompt(data);
    assert.ok(prompt.includes('8 turns'));
    assert.ok(prompt.includes('3 tool calls'));
    assert.ok(prompt.includes('2 min ago'));
    assert.ok(prompt.includes('Resume?'));
  });

  it('formatRecoveryPrompt says "just now" for recent saves', () => {
    const data: AutosaveData = {
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      model: 'test',
      harness: 'generic',
      cwd: '/tmp',
      turns: 1,
      toolCalls: 0,
      savedAt: new Date().toISOString(),
      pid: process.pid
    };

    const prompt = formatRecoveryPrompt(data);
    assert.ok(prompt.includes('just now'));
  });
});

describe('recovery: autosave controller', () => {
  it('saves after turnInterval turns', async () => {
    const ctrl = createAutosaveController({ turnInterval: 2, intervalMs: 999_999 });

    const msgs = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hi' }
    ];
    const meta = { model: 'test', harness: 'generic', cwd: '/tmp', turns: 0, toolCalls: 0 };

    // Turn 1: no save yet
    meta.turns = 1;
    ctrl.tick(msgs, meta);
    // Give async save a moment
    await new Promise((r) => setTimeout(r, 50));
    // Turn 2: should trigger save (turnInterval=2)
    meta.turns = 2;
    ctrl.tick(msgs, meta);
    await new Promise((r) => setTimeout(r, 100));

    const loaded = await readAutosave();
    assert.ok(loaded, 'should have autosaved after 2 turns');
    assert.equal(loaded!.turns, 2);

    ctrl.stop();
    await clearAutosave();
  });

  it('flush forces immediate save', async () => {
    const ctrl = createAutosaveController({ turnInterval: 999, intervalMs: 999_999 });

    const msgs = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'test' }
    ];
    const meta = { model: 'test', harness: 'generic', cwd: '/tmp', turns: 1, toolCalls: 0 };

    await ctrl.flush(msgs, meta);

    const loaded = await readAutosave();
    assert.ok(loaded);
    assert.equal(loaded!.turns, 1);

    ctrl.stop();
    await clearAutosave();
  });
});

describe('recovery: lockfile', () => {
  it('acquireLock succeeds on first call, detects stale on second', async () => {
    // Clean up any stale lock
    await releaseLock();

    const first = await acquireLock();
    assert.equal(first.acquired, true);

    // Second call should detect existing lock
    const second = await acquireLock();
    assert.equal(second.acquired, false);
    assert.equal(second.stalePid, process.pid);

    await releaseLock();

    // After release, should succeed again
    const third = await acquireLock();
    assert.equal(third.acquired, true);
    await releaseLock();
  });

  it('forceAcquireLock overwrites stale lock', async () => {
    await releaseLock();
    await acquireLock();

    // Force acquire overwrites
    await forceAcquireLock();
    // Second acquire should still detect lock (from forceAcquire)
    const result = await acquireLock();
    assert.equal(result.acquired, false);
    assert.equal(result.stalePid, process.pid);

    await releaseLock();
  });

  it('isPidAlive returns true for current process', () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  it('isPidAlive returns false for non-existent PID', () => {
    // PID 99999999 is extremely unlikely to exist
    assert.equal(isPidAlive(99999999), false);
  });
});
