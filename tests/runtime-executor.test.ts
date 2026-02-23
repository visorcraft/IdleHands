import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { PlanResult } from '../dist/runtime/types.js';

function makePlan(overrides?: Partial<PlanResult>): PlanResult {
  return {
    ok: true,
    reuse: false,
    model: {
      id: 'test-model',
      display_name: 'Test Model',
      source: '/tmp/test.gguf',
      launch: { start_cmd: 'echo started', probe_cmd: 'echo ok' },
    },
    backend: null,
    hosts: [{ id: 'local', display_name: 'Local', transport: 'local', connection: {} }],
    steps: [
      {
        kind: 'stop_model',
        host_id: 'local',
        command: 'echo stopping',
        timeout_sec: 2,
        description: 'Stop',
      },
      {
        kind: 'start_model',
        host_id: 'local',
        command: 'echo starting',
        timeout_sec: 2,
        description: 'Start',
      },
      {
        kind: 'probe_health',
        host_id: 'local',
        command: 'echo ok',
        timeout_sec: 2,
        description: 'Probe',
      },
    ],
    ...overrides,
  };
}

async function withTmpHome(fn: (home: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-runtime-executor-'));
  const prevHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    await fn(dir);
  } finally {
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function loadExecutor() {
  const modulePath = pathToFileURL(path.resolve('dist/runtime/executor.js')).href;
  return import(`${modulePath}?t=${Date.now()}-${Math.random()}`);
}

describe('runtime executor', () => {
  it('execute() with reuse=true and healthy probe skips full step list', async () => {
    await withTmpHome(async (home) => {
      const marker = path.join(home, 'ran-start-step');
      const plan = makePlan({
        reuse: true,
        steps: [
          {
            kind: 'start_model',
            host_id: 'local',
            command: `echo touched > ${marker}`,
            timeout_sec: 2,
            description: 'Start marker',
          },
          {
            kind: 'probe_health',
            host_id: 'local',
            command: 'echo ok',
            timeout_sec: 2,
            description: 'Probe',
          },
        ],
      });

      const executor = await loadExecutor();
      const result = await executor.execute(plan);

      assert.equal(result.ok, true);
      assert.equal(result.reused, true);
      assert.equal(result.steps.length, 1);
      assert.equal(result.steps[0]?.step.kind, 'probe_health');
      assert.equal(result.steps[0]?.status, 'ok');
      await assert.rejects(() => fs.access(marker));
    });
  });

  it('execute() step failure returns structured error and attempts rollback', async () => {
    await withTmpHome(async () => {
      const rollbackMarker = path.join(
        os.tmpdir(),
        `idlehands-rollback-${Date.now()}-${Math.random()}`
      );
      const plan = makePlan({
        steps: [
          {
            kind: 'apply_backend',
            host_id: 'local',
            command: 'exit 12',
            rollback_cmd: `echo rolled-back > ${rollbackMarker}`,
            timeout_sec: 2,
            description: 'Apply backend',
          },
        ],
      });

      const executor = await loadExecutor();
      const result = await executor.execute(plan);

      assert.equal(result.ok, false);
      assert.equal(result.reused, false);
      assert.equal(result.steps.length, 1);
      assert.equal(result.steps[0].status, 'error');
      assert.equal(result.steps[0].exit_code, 12);
      assert.match(result.steps[0].stderr ?? '', /Rollback attempted:/);
      await fs.access(rollbackMarker);
      await fs.rm(rollbackMarker, { force: true });
    });
  });

  it('execute() lock conflict respects confirm prompt behavior', async () => {
    await withTmpHome(async (home) => {
      const stateDir = path.join(home, '.local', 'state', 'idlehands');
      await fs.mkdir(stateDir, { recursive: true });
      const lockPath = path.join(stateDir, 'runtime.lock');
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), model: 'other' })
      );

      const executor = await loadExecutor();
      const prompts: string[] = [];
      const result = await executor.execute(makePlan(), {
        confirm: async (prompt: string) => {
          prompts.push(prompt);
          return false;
        },
      });

      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /Runtime lock held by PID/);
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /Force takeover\?/);
    });
  });

  it('execute() concurrent lock acquisition returns conflict for second executor', async () => {
    await withTmpHome(async () => {
      const executor = await loadExecutor();
      const slowPlan = makePlan({
        steps: [
          {
            kind: 'start_model',
            host_id: 'local',
            command: 'sleep 1',
            timeout_sec: 3,
            description: 'Hold lock',
          },
        ],
      });

      const first = executor.execute(slowPlan);
      await new Promise((r) => setTimeout(r, 100));
      const second = await executor.execute(makePlan(), { confirm: async () => false });
      const firstResult = await first;

      assert.equal(firstResult.ok, true);
      assert.equal(second.ok, false);
      assert.match(second.error ?? '', /Runtime lock held by PID/);
    });
  });

  it('execute() stale lock with dead PID auto-reclaims', async () => {
    await withTmpHome(async (home) => {
      const stateDir = path.join(home, '.local', 'state', 'idlehands');
      await fs.mkdir(stateDir, { recursive: true });
      const lockPath = path.join(stateDir, 'runtime.lock');
      const activePath = path.join(stateDir, 'runtime-active.json');
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString(), model: 'stale' })
      );

      const executor = await loadExecutor();
      const result = await executor.execute(makePlan());

      assert.equal(result.ok, true);
      await assert.rejects(() => fs.access(lockPath));
      const activeRaw = await fs.readFile(activePath, 'utf8');
      const active = JSON.parse(activeRaw);
      assert.equal(active.modelId, 'test-model');
      assert.equal(active.healthy, true);
    });
  });

  it('execute() stale lock older than 1 hour is reclaimed even with live PID', async () => {
    await withTmpHome(async (home) => {
      const stateDir = path.join(home, '.local', 'state', 'idlehands');
      await fs.mkdir(stateDir, { recursive: true });
      const lockPath = path.join(stateDir, 'runtime.lock');
      const staleStartedAt = new Date(Date.now() - 61 * 60 * 1000).toISOString();
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: staleStartedAt, model: 'stale-live' })
      );

      const executor = await loadExecutor();
      const result = await executor.execute(makePlan(), {
        confirm: async () => {
          throw new Error('confirm should not be called for stale locks');
        },
      });

      assert.equal(result.ok, true);
      await assert.rejects(() => fs.access(lockPath));
    });
  });
});
