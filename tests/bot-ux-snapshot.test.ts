import assert from 'node:assert/strict';
import { test } from 'node:test';

import { snapshotToBlocks } from '../dist/bot/ux/renderer.js';

function makeSnap(phase: 'queued' | 'planning' | 'runtime_preflight' | 'executing' | 'verifying' | 'complete') {
  return {
    phase,
    reason: 'manual',
    startedAt: 0,
    now: 60_000,
    elapsedMs: 60_000,
    elapsedBucketMs: 60_000,
    sinceLastActivityMs: 1000,
    statusLine: phase === 'complete' ? '✅ Done (60s)' : '⏳ Processing (60s)',
    toolLines: [],
  } as any;
}

test('snapshotToBlocks does not render progress block for complete phase', () => {
  const blocks = snapshotToBlocks(makeSnap('complete'));
  assert.ok(blocks.some((b: any) => b.type === 'message'), 'status message should still render');
  assert.ok(!blocks.some((b: any) => b.type === 'progress'), 'complete phase should not render progress bar');
});

test('snapshotToBlocks renders phase-specific progress messages', () => {
  const verifying = snapshotToBlocks(makeSnap('verifying'));
  const planning = snapshotToBlocks(makeSnap('planning'));
  const preflight = snapshotToBlocks(makeSnap('runtime_preflight'));

  const v = verifying.find((b: any) => b.type === 'progress') as any;
  const p = planning.find((b: any) => b.type === 'progress') as any;
  const r = preflight.find((b: any) => b.type === 'progress') as any;

  assert.ok(v, 'verifying should include progress block');
  assert.ok(p, 'planning should include progress block');
  assert.ok(r, 'runtime preflight should include progress block');

  assert.equal(v.message, 'Verifying...');
  assert.equal(p.message, 'Planning...');
  assert.equal(r.message, 'Running pre-flight checks...');
});
