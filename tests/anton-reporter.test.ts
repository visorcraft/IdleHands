import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatTaskHeartbeat,
  formatToolLoopEvent,
  formatStageUpdate,
} from '../dist/anton/reporter.js';

describe('anton reporter tool-loop messaging', () => {
  it('formats periodic heartbeat updates', () => {
    const msg = formatTaskHeartbeat({
      totalPending: 10,
      completedSoFar: 4,
      skippedSoFar: 0,
      iterationsUsed: 8,
      elapsedMs: 125000,
      estimatedRemainingMs: 300000,
      currentTask: 'Implement status updates',
      currentAttempt: 2,
    });

    assert.match(msg, /still working/i);
    assert.match(msg, /attempt 2/i);
    assert.match(msg, /\[.*\] 4\/10/);
    assert.match(msg, /ETA/i);
  });

  it('labels auto-recovered loop events explicitly', () => {
    const msg = formatToolLoopEvent('Create parser', {
      level: 'critical',
      toolName: 'edit_range',
      count: 2,
      message: 'Auto-recovered by continuing (retry 2/3)',
    });

    assert.match(msg, /auto-recovered/i);
    assert.match(msg, /retry 2\/3/i);
  });

  it('labels final loop failures explicitly', () => {
    const msg = formatToolLoopEvent('Create parser', {
      level: 'critical',
      toolName: 'edit_range',
      count: 3,
      message:
        'Final loop failure after 3/3 auto-retries: tool edit_range: identical call repeated',
    });

    assert.match(msg, /final loop failure/i);
    assert.match(msg, /3\/3/);
  });

  it('formats stage updates with consistent labels', () => {
    const planning = formatStageUpdate('planning', 'Discovery: checking if already done...');
    const preflight = formatStageUpdate('runtime_preflight', 'Requirements review: refining plan...');
    const executing = formatStageUpdate('executing', 'Implementation: executing vetted plan...');

    assert.match(planning, /Planning/i);
    assert.match(preflight, /Pre-flight/i);
    assert.match(executing, /Executing/i);
  });
});
