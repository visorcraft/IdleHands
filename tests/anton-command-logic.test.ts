import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { antonStatusCommand } from '../dist/bot/command-logic.js';

describe('anton command logic status', () => {
  it('includes last loop event in /anton status output', () => {
    const managed = {
      antonActive: true,
      antonAbortSignal: { aborted: false },
      antonProgress: {
        totalPending: 8,
        completedSoFar: 3,
        skippedSoFar: 0,
        iterationsUsed: 10,
        elapsedMs: 90_000,
        estimatedRemainingMs: 200_000,
        currentTask: 'Patch bot status',
        currentAttempt: 2,
      },
      antonLastLoopEvent: {
        kind: 'auto-recovered',
        taskText: 'Patch bot status',
        message: 'Auto-recovered by continuing (retry 1/3)',
        at: Date.now() - 61_000,
      },
    } as any;

    const result = antonStatusCommand(managed);
    const joined = (result.lines || []).join('\n');

    assert.match(joined, /working on:/i);
    assert.match(joined, /last loop:/i);
    assert.match(joined, /auto-recovered/i);
  });
});
