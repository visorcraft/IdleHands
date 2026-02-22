import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createToolLoopState,
  stableStringify,
  hashToolCall,
  recordToolCall,
  recordToolCallOutcome,
  detectToolCallLoop,
} from '../dist/agent/tool-loop-detection.js';

describe('tool-loop-detection', () => {
  it('stableStringify is deterministic across key order', () => {
    const a = { b: 2, a: 1, nest: { z: 9, y: 8 } };
    const b = { nest: { y: 8, z: 9 }, a: 1, b: 2 };

    const sa = stableStringify(a);
    const sb = stableStringify(b);

    assert.equal(sa, sb);
  });

  it('hashToolCall matches for semantically identical args', () => {
    const one = hashToolCall('read_file', { path: 'x.ts', limit: 20 });
    const two = hashToolCall('read_file', { limit: 20, path: 'x.ts' });

    assert.equal(one.argsHash, two.argsHash);
    assert.equal(one.signature, two.signature);
  });

  it('generic_repeat escalates from warning to critical', () => {
    const state = createToolLoopState();
    const args = { path: 'repeat.txt', limit: 50 };

    for (let i = 0; i < 4; i++) {
      recordToolCall(state, 'read_file', args, `c${i}`, {
        warningThreshold: 4,
        criticalThreshold: 6,
      });
      recordToolCallOutcome(state, {
        toolName: 'read_file',
        toolParams: args,
        toolCallId: `c${i}`,
        result: 'same-output',
      });
    }

    const warn = detectToolCallLoop(state, 'read_file', args, {
      warningThreshold: 4,
      criticalThreshold: 6,
    });
    assert.equal(warn.level, 'warning');

    for (let i = 4; i < 6; i++) {
      recordToolCall(state, 'read_file', args, `c${i}`, {
        warningThreshold: 4,
        criticalThreshold: 6,
      });
      recordToolCallOutcome(state, {
        toolName: 'read_file',
        toolParams: args,
        toolCallId: `c${i}`,
        result: 'same-output',
      });
    }

    const critical = detectToolCallLoop(state, 'read_file', args, {
      warningThreshold: 4,
      criticalThreshold: 6,
    });
    assert.equal(critical.level, 'critical');
  });

  it('known poll no-progress detector triggers critical', () => {
    const state = createToolLoopState();
    const args = { id: 'job-1' };

    for (let i = 0; i < 8; i++) {
      recordToolCall(state, 'process.poll', args, `p${i}`);
      recordToolCallOutcome(state, {
        toolName: 'process.poll',
        toolParams: args,
        toolCallId: `p${i}`,
        result: '{"status":"running"}',
      });
    }

    const detected = detectToolCallLoop(state, 'process.poll', args, {
      criticalThreshold: 8,
      detectors: { knownPollNoProgress: true },
    });

    assert.equal(detected.level, 'critical');
    assert.equal(detected.detector, 'known_poll_no_progress');
  });
});
