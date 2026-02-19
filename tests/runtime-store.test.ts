import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { loadRuntimes, saveRuntimes, validateRuntimes, redactConfig, interpolateTemplate } from '../dist/runtime/store.js';
import { shellEscape } from '../dist/utils.js';
import type { RuntimesConfig } from '../dist/runtime/types.js';

function baseConfig(): RuntimesConfig {
  return {
    schema_version: 1,
    hosts: [{
      id: 'host-1', display_name: 'Host 1', enabled: true, transport: 'local', connection: {},
      capabilities: { gpu: [], backends: ['vulkan'] }, health: { check_cmd: 'echo ok' },
      model_control: { stop_cmd: 'pkill -f llama || true', cleanup_cmd: null },
    }],
    backends: [{
      id: 'vulkan', display_name: 'Vulkan', enabled: true, type: 'vulkan', host_filters: 'any',
      apply_cmd: null, verify_cmd: 'echo ok', rollback_cmd: null, env: { GGML_VK_DEVICE: '0' }, args: ['--foo', 'bar'],
    }],
    models: [{
      id: 'model-1', display_name: 'Model 1', enabled: true, source: '/models/m.gguf',
      host_policy: ['host-1'], backend_policy: ['vulkan'],
      launch: { start_cmd: 'llama-server --model {source} --port {port} {backend_args}', probe_cmd: 'curl -sf http://{host}:{port}/health' },
      runtime_defaults: { port: 8080, context_window: 8192, max_tokens: 1024 }, split_policy: null,
    }],
  };
}

async function withTmpDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-runtime-store-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

describe('runtime store', () => {
  it('loadRuntimes() returns empty config for missing file', async () => {
    await withTmpDir(async (dir) => {
      const cfg = await loadRuntimes(path.join(dir, 'runtimes.json'));
      assert.deepEqual(cfg, { schema_version: 1, hosts: [], backends: [], models: [] });
    });
  });

  it('loadRuntimes() rejects invalid schema_version', async () => {
    await withTmpDir(async (dir) => {
      const file = path.join(dir, 'runtimes.json');
      await fs.writeFile(file, JSON.stringify({ schema_version: 2, hosts: [], backends: [], models: [] }));
      await assert.rejects(() => loadRuntimes(file), /schema_version/i);
    });
  });

  it('loadRuntimes() rejects unknown keys inside host/backend/model objects', async () => {
    await withTmpDir(async (dir) => {
      const file = path.join(dir, 'runtimes.json');
      const cfg: any = baseConfig();

      cfg.hosts[0].oops = true;
      await fs.writeFile(file, JSON.stringify(cfg));
      await assert.rejects(() => loadRuntimes(file), /unknown key/i);

      cfg.hosts[0] = baseConfig().hosts[0];
      cfg.backends[0].oops = true;
      await fs.writeFile(file, JSON.stringify(cfg));
      await assert.rejects(() => loadRuntimes(file), /unknown key/i);

      cfg.backends[0] = baseConfig().backends[0];
      cfg.models[0].oops = true;
      await fs.writeFile(file, JSON.stringify(cfg));
      await assert.rejects(() => loadRuntimes(file), /unknown key/i);
    });
  });

  it('loadRuntimes() validates cross-references (model references nonexistent host)', async () => {
    await withTmpDir(async (dir) => {
      const file = path.join(dir, 'runtimes.json');
      const cfg = baseConfig();
      cfg.models[0].host_policy = ['missing-host'];
      await fs.writeFile(file, JSON.stringify(cfg));
      await assert.rejects(() => loadRuntimes(file), /unknown host id/i);
    });
  });

  it('saveRuntimes() creates file with 0o600 permissions', async () => {
    await withTmpDir(async (dir) => {
      const file = path.join(dir, 'runtimes.json');
      await saveRuntimes(baseConfig(), file);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    });
  });

  it('saveRuntimes() atomic write: failed write does not corrupt existing file', async () => {
    await withTmpDir(async (dir) => {
      const file = path.join(dir, 'runtimes.json');
      await saveRuntimes(baseConfig(), file);
      const before = await fs.readFile(file, 'utf8');

      await fs.chmod(dir, 0o500);
      try {
        await assert.rejects(() => saveRuntimes(baseConfig(), file));
      } finally {
        await fs.chmod(dir, 0o700);
      }

      const after = await fs.readFile(file, 'utf8');
      assert.equal(after, before);
    });
  });

  it('validateRuntimes() catches missing required fields', () => {
    const cfg: any = baseConfig();
    delete cfg.models[0].launch;
    assert.throws(() => validateRuntimes(cfg), /launch/i);
  });

  it('validateRuntimes() catches invalid ID format', () => {
    const cfg = baseConfig();
    (cfg.hosts[0] as any).id = 'Bad_ID';
    assert.throws(() => validateRuntimes(cfg), /invalid id format/i);
  });

  it('validateRuntimes() catches unknown template variables in *_cmd fields', () => {
    const cfg = baseConfig();
    cfg.models[0].launch.start_cmd = 'llama --model {source} --bad {unknown_var}';
    assert.throws(() => validateRuntimes(cfg), /unknown template variable/i);
  });

  it('redactConfig() removes all sensitive fields', () => {
    const cfg = baseConfig();
    cfg.hosts[0].connection.password = 'secret';
    cfg.hosts[0].connection.key_path = '/home/user/.ssh/id';

    const out = redactConfig(cfg);
    assert.equal(out.hosts[0].connection.password, '[REDACTED]');
    assert.equal(out.hosts[0].connection.key_path, '[REDACTED]');
    assert.equal(cfg.hosts[0].connection.password, 'secret');
  });

  it('Template interpolation with shellEscape() produces safe output', () => {
    const dangerous = `x'; rm -rf / #`;
    const out = interpolateTemplate('run --model {source} --args {backend_args}', { source: dangerous, backend_args: '--threads 4' });
    assert.equal(out.includes(shellEscape(dangerous)), true);
    assert.equal(out.includes("'\\''"), true);
  });

  it('Empty runtimes.json passes validation', () => {
    const cfg = validateRuntimes({ schema_version: 1, hosts: [], backends: [], models: [] });
    assert.deepEqual(cfg, { schema_version: 1, hosts: [], backends: [], models: [] });
  });
});
