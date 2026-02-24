import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSessionConfig, buildPreflightConfig } from '../dist/anton/session.js';

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

  it('builds bounded preflight session config with tools enabled', () => {
    const base = {
      endpoint: 'x',
      model: 'm',
      max_tokens: 1000,
      timeout: 999,
      max_iterations: 999,
      no_tools: true,
    } as any;

    const runConfig = {
      projectDir: '/tmp',
      approvalMode: 'yolo',
      taskTimeoutSec: 600,
      preflightSessionMaxIterations: 3,
      preflightSessionTimeoutSec: 120,
    } as any;

    const out = buildPreflightConfig(base, runConfig, 600);
    assert.equal(out.max_iterations, 3);
    assert.equal(out.timeout, 120);
    assert.equal(out.no_tools, false);
    assert.equal(out.trifecta?.enabled, false);
    assert.deepEqual(out.mcp?.servers, []);
  });
});
