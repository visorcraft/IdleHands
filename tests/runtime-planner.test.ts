import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

import { plan } from '../dist/runtime/planner.js';
import type { ActiveRuntime, PlanError, RuntimesConfig } from '../dist/runtime/types.js';

function makeConfig(): RuntimesConfig {
  return {
    schema_version: 1,
    hosts: [{
      id: 'test-host', display_name: 'Test', enabled: true,
      transport: 'local', connection: {},
      capabilities: { gpu: [], backends: [] },
      health: { check_cmd: 'echo ok' },
      model_control: { stop_cmd: 'pkill -f llama-server || true' },
    }],
    backends: [{
      id: 'vulkan', display_name: 'Vulkan', enabled: true,
      type: 'vulkan', host_filters: 'any',
    }],
    models: [{
      id: 'test-model', display_name: 'Test Model', enabled: true,
      source: '/models/test.gguf',
      host_policy: 'any', backend_policy: 'any',
      launch: {
        start_cmd: 'llama-server --model {source} --port {port}',
        probe_cmd: 'curl -sf http://localhost:{port}/health',
      },
      runtime_defaults: { port: 8080 },
    }],
  };
}

describe('runtime planner', () => {
  it('plan() is deterministic for same inputs', () => {
    const cfg = makeConfig();
    const req = { modelId: 'test-model', mode: 'dry-run' as const };
    const active: ActiveRuntime | null = null;

    const first = plan(req, cfg, active);
    const second = plan(req, cfg, active);

    assert.deepEqual(first, second);
  });

  it('plan() returns PlanError for disabled model', () => {
    const cfg = makeConfig();
    cfg.models[0].enabled = false;

    const out = plan({ modelId: 'test-model', mode: 'live' }, cfg, null);

    assert.equal(out.ok, false);
    assert.equal((out as PlanError).code, 'MODEL_NOT_FOUND');
  });

  it('plan() returns PlanError for host override violating policy', () => {
    const cfg = makeConfig();
    cfg.hosts.push({
      id: 'other-host',
      display_name: 'Other',
      enabled: true,
      transport: 'local',
      connection: {},
      capabilities: { gpu: [], backends: [] },
      health: { check_cmd: 'echo ok' },
      model_control: { stop_cmd: 'pkill -f llama-server || true' },
    });
    cfg.models[0].host_policy = ['test-host'];

    const out = plan({ modelId: 'test-model', hostOverride: 'other-host', mode: 'live' }, cfg, null);

    assert.equal(out.ok, false);
    assert.equal((out as PlanError).code, 'HOST_POLICY_VIOLATION');
  });

  it('plan() with backend omitted has no backend steps', () => {
    const cfg = makeConfig();

    const out = plan({ modelId: 'test-model', mode: 'live' }, cfg, null);

    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.backend, null);
    assert.equal(out.steps.some((s) => s.kind === 'apply_backend' || s.kind === 'verify_backend'), false);
  });

  it('plan() with exact active match reuses runtime', () => {
    const cfg = makeConfig();
    const active: ActiveRuntime = {
      modelId: 'test-model',
      hostIds: ['test-host'],
      healthy: true,
      startedAt: new Date(0).toISOString(),
    };

    const out = plan({ modelId: 'test-model', mode: 'live' }, cfg, active);

    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.reuse, true);
    assert.equal(out.steps.length, 0);
  });

  it('plan() with different model includes stop + start steps', () => {
    const cfg = makeConfig();
    cfg.models.push({
      id: 'test-model-2',
      display_name: 'Test Model 2',
      enabled: true,
      source: '/models/test2.gguf',
      host_policy: 'any',
      backend_policy: 'any',
      launch: {
        start_cmd: 'llama-server --model {source} --port {port}',
        probe_cmd: 'curl -sf http://localhost:{port}/health',
      },
      runtime_defaults: { port: 8081 },
    });

    const active: ActiveRuntime = {
      modelId: 'test-model',
      hostIds: ['test-host'],
      healthy: true,
      startedAt: new Date(0).toISOString(),
    };

    const out = plan({ modelId: 'test-model-2', mode: 'live' }, cfg, active);

    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.reuse, false);
    assert.equal(out.steps.some((s) => s.kind === 'stop_model'), true);
    assert.equal(out.steps.some((s) => s.kind === 'start_model'), true);
  });

  it('planner has no I/O imports', () => {
    const result = execSync('grep -c "import.*child_process\\|import.*node:fs\\|import.*spawn" src/runtime/planner.ts || true', {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: '/bin/bash',
    }).trim();

    assert.equal(result, '0');
  });
});
