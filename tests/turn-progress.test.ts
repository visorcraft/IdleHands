import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TurnProgressController } from '../dist/progress/turn-progress.js';

describe('TurnProgressController', () => {
  it('initializes timing on start()', () => {
    let now = 10_000;
    const snaps: any[] = [];
    const c = new TurnProgressController(
      (snap) => {
        snaps.push(snap);
      },
      {
        now: () => now,
        heartbeatMs: 1000,
      }
    );

    c.start();
    const snap = c.snapshot('manual');
    assert.equal(snap.startedAt, 10_000);
    assert.equal(snap.elapsedMs, 0);
    c.stop();
  });

  it('collapses repeated identical tool result lines', () => {
    const c = new TurnProgressController(undefined, {
      now: () => Date.now(),
    });
    c.start();

    const hooks = c.hooks;
    hooks.onToolResult?.({
      id: 'a',
      name: 'edit_range',
      success: true,
      summary: 'edited range in src/a.ts',
    } as any);
    hooks.onToolResult?.({
      id: 'b',
      name: 'edit_range',
      success: true,
      summary: 'edited range in src/a.ts',
    } as any);
    hooks.onToolResult?.({
      id: 'c',
      name: 'edit_range',
      success: true,
      summary: 'edited range in src/a.ts',
    } as any);

    const snap = c.snapshot('manual');
    assert.equal(snap.toolLines.length, 1);
    assert.ok(snap.toolLines[0].includes('(x3)'));
    c.stop();
  });

  it('sanitizes noisy write_file overwrite refusal summary', () => {
    const c = new TurnProgressController();
    c.start();

    c.hooks.onToolResult?.({
      id: 'w1',
      name: 'write_file',
      success: false,
      summary:
        'internal: write_file: refusing to overwrite existing non-empty file src/foo.ts without explicit overwrite=true (or force=true). Use edit_range/apply_patch...',
    } as any);

    const snap = c.snapshot('manual');
    const line = snap.toolLines[0] || '';
    assert.ok(line.includes('overwrite blocked'));
    assert.ok(!line.includes('refusing to overwrite existing non-empty file'));
    c.stop();
  });

  it('marks done only on final turn_end events', () => {
    const c = new TurnProgressController();
    c.start();

    c.hooks.onTurnEnd?.({
      turn: 1,
      toolCalls: 1,
      promptTokens: 100,
      completionTokens: 50,
      final: false,
    } as any);

    const mid = c.snapshot('manual');
    assert.equal(mid.phase, 'verifying');
    assert.ok(!mid.statusLine.includes('Done'));

    c.hooks.onTurnEnd?.({
      turn: 2,
      toolCalls: 2,
      promptTokens: 180,
      completionTokens: 90,
      final: true,
    } as any);

    const done = c.snapshot('manual');
    assert.equal(done.phase, 'complete');
    assert.ok(done.statusLine.includes('Done'));

    c.stop();
  });

  it('replaces planned tool line for the same tool instead of appending', () => {
    const c = new TurnProgressController();
    c.start();

    c.hooks.onToolCall?.({
      id: 't1',
      name: 'edit_range',
      phase: 'planned',
      args: { path: '/home/thomas/a.ts' },
    } as any);

    c.hooks.onToolCall?.({
      id: 't1',
      name: 'edit_range',
      phase: 'planned',
      args: { path: '/home/thomas/a.ts', start_line: 759, end_line: 764 },
    } as any);

    const snap = c.snapshot('manual');
    const planned = snap.toolLines.filter((l) => l.startsWith('… planned edit_range:'));
    assert.equal(planned.length, 1);
    assert.ok(planned[0].includes('[759..764]'));

    c.stop();
  });
});
