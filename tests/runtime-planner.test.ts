import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plan } from '../dist/runtime/planner.js';
import type { ActiveRuntime, PlanError, RuntimesConfig } from '../dist/runtime/types.js';

function makeConfig(): RuntimesConfig {
  return {
    schema_version: 1,
    hosts: [
      {
        id: 'test-host',
        display_name: 'Test',
        enabled: true,
        transport: 'local',
        connection: {},
        capabilities: { gpu: [], backends: [] },
        health: { check_cmd: 'echo ok' },
        model_control: { stop_cmd: 'pkill -f llama-server || true' },
      },
    ],
    backends: [
      {
        id: 'vulkan',
        display_name: 'Vulkan',
        enabled: true,
        type: 'vulkan',
        host_filters: 'any',
      },
    ],
    models: [
      {
        id: 'test-model',
        display_name: 'Test Model',
        enabled: true,
        source: '/models/test.gguf',
        host_policy: 'any',
        backend_policy: 'any',
        launch: {
          start_cmd: 'llama-server --model {source} --port {port}',
          probe_cmd: 'curl -sf http://localhost:{port}/health',
        },
        runtime_defaults: { port: 8080 },
      },
    ],
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

    const out = plan(
      { modelId: 'test-model', hostOverride: 'other-host', mode: 'live' },
      cfg,
      null
    );

    assert.equal(out.ok, false);
    assert.equal((out as PlanError).code, 'HOST_POLICY_VIOLATION');
  });

  it('plan() with backend omitted has no backend steps', () => {
    const cfg = makeConfig();

    const out = plan({ modelId: 'test-model', mode: 'live' }, cfg, null);

    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.backend, null);
    assert.equal(
      out.steps.some((s) => s.kind === 'apply_backend' || s.kind === 'verify_backend'),
      false
    );
  });

  it('plan() with exact active match reuses runtime and includes health probe step(s)', () => {
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
    assert.equal(out.steps.length > 0, true);
    assert.equal(
      out.steps.every((s) => s.kind === 'probe_health'),
      true
    );
  });

  it('plan() with forceRestart bypasses reuse on exact active match', () => {
    const cfg = makeConfig();
    const active: ActiveRuntime = {
      modelId: 'test-model',
      hostIds: ['test-host'],
      healthy: true,
      startedAt: new Date(0).toISOString(),
    };

    const out = plan({ modelId: 'test-model', mode: 'live', forceRestart: true }, cfg, active);

    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.reuse, false);
    assert.equal(
      out.steps.some((s) => s.kind === 'start_model'),
      true
    );
    assert.equal(
      out.steps.some((s) => s.kind === 'probe_health'),
      true
    );
  });

  it('plan() includes backend verify even when backend does not change', () => {
    const cfg = makeConfig();
    cfg.backends = [
      {
        id: 'rocm',
        display_name: 'ROCm',
        enabled: true,
        type: 'rocm',
        host_filters: 'any',
        verify_cmd: 'echo verify',
      } as any,
    ];
    cfg.models[0].backend_policy = ['rocm'];

    const active: ActiveRuntime = {
      modelId: 'test-model',
      backendId: 'rocm',
      hostIds: ['test-host'],
      healthy: false,
      startedAt: new Date(0).toISOString(),
    };

    const out = plan({ modelId: 'test-model', mode: 'live' }, cfg, active);

    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.reuse, false);
    assert.equal(
      out.steps.some((s) => s.kind === 'verify_backend'),
      true
    );
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
    assert.equal(
      out.steps.some((s) => s.kind === 'stop_model'),
      true
    );
    assert.equal(
      out.steps.some((s) => s.kind === 'start_model'),
      true
    );
  });

  it('plan() interpolates {chat_template_args} with --chat-template for built-in names', () => {
    const cfg = makeConfig();
    cfg.models[0].launch.start_cmd =
      'llama-server --model {source} --port {port} {chat_template_args}';
    (cfg.models[0] as any).chat_template = 'chatml';

    const out = plan({ modelId: 'test-model', mode: 'live' }, cfg, null);
    assert.equal(out.ok, true);
    if (!out.ok) return;

    const startStep = out.steps.find((s) => s.kind === 'start_model');
    assert.ok(startStep);
    assert.ok(startStep.command.includes("--chat-template 'chatml'"));
    assert.ok(!startStep.command.includes('--chat-template-file'));
  });

  it('plan() interpolates {chat_template_args} with --chat-template-file using remote path', () => {
    const cfg = makeConfig();
    cfg.models[0].launch.start_cmd =
      'llama-server --model {source} --port {port} {chat_template_args}';
    (cfg.models[0] as any).chat_template = '/home/user/templates/qwen3.jinja';

    const out = plan({ modelId: 'test-model', mode: 'live' }, cfg, null);
    assert.equal(out.ok, true);
    if (!out.ok) return;

    const startStep = out.steps.find((s) => s.kind === 'start_model');
    assert.ok(startStep);
    // Planner outputs just the filename; executor resolves the full remote path
    assert.ok(startStep.command.includes("--chat-template-file 'qwen3.jinja'"));
  });

  it('plan() leaves {chat_template_args} empty when chat_template is not set', () => {
    const cfg = makeConfig();
    cfg.models[0].launch.start_cmd =
      'llama-server --model {source} --port {port} {chat_template_args}';

    const out = plan({ modelId: 'test-model', mode: 'live' }, cfg, null);
    assert.equal(out.ok, true);
    if (!out.ok) return;

    const startStep = out.steps.find((s) => s.kind === 'start_model');
    assert.ok(startStep);
    assert.ok(!startStep.command.includes('--chat-template'));
  });

  it('plan() for RPC-backed model pre-clears target and RPC helper hosts', () => {
    const cfg: RuntimesConfig = {
      schema_version: 1,
      hosts: [
        {
          id: 'bee',
          display_name: 'Bee',
          enabled: true,
          transport: 'ssh',
          connection: { host: '192.168.68.119', user: 'thomas' },
          capabilities: { gpu: ['gfx'], backends: ['rocm'] },
          health: { check_cmd: 'true' },
          model_control: { stop_cmd: 'pkill llama-server || true' },
        },
        {
          id: 'evo-x2',
          display_name: 'Evo',
          enabled: true,
          transport: 'ssh',
          connection: { host: '10.10.25.1', user: 'thomas' },
          capabilities: { gpu: ['gfx'], backends: ['rocm'] },
          health: { check_cmd: 'true' },
          model_control: { stop_cmd: 'pkill llama-server || true' },
        },
      ],
      backends: [
        {
          id: 'rocm-rpc-evo',
          display_name: 'ROCm + RPC',
          enabled: true,
          type: 'rocm',
          host_filters: ['bee'],
          args: ['-ngl', '99', '--rpc', '10.10.25.1:50052', '-ts', '1/1'],
        },
      ],
      models: [
        {
          id: 'qwen-rpc',
          display_name: 'Qwen RPC',
          enabled: true,
          source: '/models/qwen.gguf',
          host_policy: ['bee'],
          backend_policy: ['rocm-rpc-evo'],
          launch: {
            start_cmd: 'llama-server --model {source} --port {port} {backend_args}',
            probe_cmd: 'curl -sf http://127.0.0.1:{port}/health',
          },
          runtime_defaults: { port: 8088 },
        },
      ],
    };

    const out = plan({ modelId: 'qwen-rpc', mode: 'live' }, cfg, null);
    assert.equal(out.ok, true);
    if (!out.ok) return;

    // Plan hosts include target + RPC helper host so stop steps can execute on both.
    assert.deepEqual(
      out.hosts.map((h) => h.id),
      ['bee', 'evo-x2']
    );

    const stopHosts = out.steps.filter((s) => s.kind === 'stop_model').map((s) => s.host_id);
    assert.deepEqual(stopHosts.sort(), ['bee', 'evo-x2'].sort());

    // Start/probe should still run only on target host.
    assert.deepEqual(
      out.steps.filter((s) => s.kind === 'start_model').map((s) => s.host_id),
      ['bee']
    );
    assert.deepEqual(
      out.steps.filter((s) => s.kind === 'probe_health').map((s) => s.host_id),
      ['bee']
    );
  });

  it('planner has no I/O imports', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/runtime/planner.ts', 'utf8');
    const matches = src.match(/from\s+['\"]node:(fs|child_process)['\"]/g) ?? [];
    assert.equal(matches.length, 0);
  });
});
