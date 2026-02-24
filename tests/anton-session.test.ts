import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSessionConfig } from '../dist/anton/session.js';

describe('anton session config', () => {
  it('falls back to 50 task iterations when config value is missing', () => {
    const base = {
      endpoint: 'x',
      model: 'm',
      max_tokens: 1000,
      timeout: 30,
      max_iterations: 999,
    } as any;

    const runConfig = {
      projectDir: '/tmp',
      approvalMode: 'yolo',
      taskTimeoutSec: 60,
      taskMaxIterations: undefined,
    } as any;

    const out = buildSessionConfig(base, runConfig);
    assert.equal(out.max_iterations, 50);
  });

  it('uses positive configured task iteration count', () => {
    const base = {
      endpoint: 'x',
      model: 'm',
      max_tokens: 1000,
      timeout: 30,
      max_iterations: 999,
    } as any;

    const runConfig = {
      projectDir: '/tmp',
      approvalMode: 'yolo',
      taskTimeoutSec: 60,
      taskMaxIterations: 17.9,
    } as any;

    const out = buildSessionConfig(base, runConfig);
    assert.equal(out.max_iterations, 17);
  });
});
