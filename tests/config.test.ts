import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { loadConfig } from '../dist/config.js';

describe('config resolution: CLI > env > file > defaults', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  // Env vars we might set during tests — save & restore
  const ENV_KEYS = [
    'IDLEHANDS_ENDPOINT',
    'IDLEHANDS_MODEL',
    'IDLEHANDS_MAX_TOKENS',
    'IDLEHANDS_TEMPERATURE',
    'IDLEHANDS_TIMEOUT',
    'IDLEHANDS_NO_CONFIRM',
    'IDLEHANDS_VERBOSE',
    'IDLEHANDS_APPROVAL_MODE',
    'IDLEHANDS_HARNESS',
    'IDLEHANDS_CONTEXT_WINDOW',
    'IDLEHANDS_DIR',
    'IDLEHANDS_MODE',
    'IDLEHANDS_OUTPUT_FORMAT',
    'IDLEHANDS_FAIL_ON_ERROR',
    'IDLEHANDS_DIFF_ONLY',
    'IDLEHANDS_THEME',
    'IDLEHANDS_SYSTEM_PROMPT_OVERRIDE',
    'IDLEHANDS_ANTON_MAX_RETRIES',
    'IDLEHANDS_ANTON_VERIFY_AI',
    'IDLEHANDS_NO_SUB_AGENTS'
  ];

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-cfg-test-'));
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  after(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('uses defaults when no config file, env, or CLI overrides exist', async () => {
    const { config } = await loadConfig({
      configPath: path.join(tmpDir, 'nonexistent.json')
    });

    assert.equal(config.endpoint, 'http://localhost:8080/v1');
    assert.equal(config.max_tokens, 16384);
    assert.equal(config.temperature, 0.2);
    assert.equal(config.approval_mode, 'auto-edit');
    assert.equal(config.mode, 'code');
    assert.equal(config.no_confirm, false);
    assert.equal(config.verbose, false);
  });

  it('file config overrides defaults', async () => {
    const cfgPath = path.join(tmpDir, 'file-test.json');
    await fs.writeFile(cfgPath, JSON.stringify({
      endpoint: 'http://fileserver:9999/v1',
      max_tokens: 4096,
      temperature: 0.7,
      verbose: true
    }), 'utf8');

    const { config } = await loadConfig({ configPath: cfgPath });

    assert.equal(config.endpoint, 'http://fileserver:9999/v1');
    assert.equal(config.max_tokens, 4096);
    assert.equal(config.temperature, 0.7);
    assert.equal(config.verbose, true);
    // Defaults still apply for unspecified fields
    assert.equal(config.timeout, 600);
    assert.equal(config.approval_mode, 'auto-edit');
  });

  it('env overrides file config', async () => {
    const cfgPath = path.join(tmpDir, 'env-test.json');
    await fs.writeFile(cfgPath, JSON.stringify({
      endpoint: 'http://fileserver:9999/v1',
      max_tokens: 4096,
      temperature: 0.7
    }), 'utf8');

    process.env.IDLEHANDS_ENDPOINT = 'http://envserver:1111/v1';
    process.env.IDLEHANDS_MAX_TOKENS = '8192';

    try {
      const { config } = await loadConfig({ configPath: cfgPath });

      // Env wins over file
      assert.equal(config.endpoint, 'http://envserver:1111/v1');
      assert.equal(config.max_tokens, 8192);
      // File still applies for fields not in env
      assert.equal(config.temperature, 0.7);
    } finally {
      delete process.env.IDLEHANDS_ENDPOINT;
      delete process.env.IDLEHANDS_MAX_TOKENS;
    }
  });

  it('CLI overrides both env and file config', async () => {
    const cfgPath = path.join(tmpDir, 'cli-test.json');
    await fs.writeFile(cfgPath, JSON.stringify({
      endpoint: 'http://fileserver:9999/v1',
      max_tokens: 4096,
      temperature: 0.7,
      timeout: 120
    }), 'utf8');

    process.env.IDLEHANDS_ENDPOINT = 'http://envserver:1111/v1';
    process.env.IDLEHANDS_MAX_TOKENS = '8192';
    process.env.IDLEHANDS_TIMEOUT = '300';

    try {
      const { config } = await loadConfig({
        configPath: cfgPath,
        cli: {
          endpoint: 'http://cliserver:2222/v1',
          max_tokens: 2048,
          timeout: 60
        }
      });

      // CLI wins over everything
      assert.equal(config.endpoint, 'http://cliserver:2222/v1');
      assert.equal(config.max_tokens, 2048);
      assert.equal(config.timeout, 60);
      // File value for temperature (not overridden by env or CLI)
      assert.equal(config.temperature, 0.7);
    } finally {
      delete process.env.IDLEHANDS_ENDPOINT;
      delete process.env.IDLEHANDS_MAX_TOKENS;
      delete process.env.IDLEHANDS_TIMEOUT;
    }
  });

  it('env booleans parse correctly (yes/no/1/0/true/false)', async () => {
    process.env.IDLEHANDS_VERBOSE = 'yes';
    process.env.IDLEHANDS_NO_CONFIRM = '1';

    try {
      const { config } = await loadConfig({
        configPath: path.join(tmpDir, 'nonexistent.json')
      });
      assert.equal(config.verbose, true);
      assert.equal(config.no_confirm, true);
      // no_confirm forces approval_mode to yolo
      assert.equal(config.approval_mode, 'yolo');
    } finally {
      delete process.env.IDLEHANDS_VERBOSE;
      delete process.env.IDLEHANDS_NO_CONFIRM;
    }
  });

  it('invalid approval_mode in env falls back to auto-edit with warning', async () => {
    process.env.IDLEHANDS_APPROVAL_MODE = 'invalid_mode';

    try {
      const { config } = await loadConfig({
        configPath: path.join(tmpDir, 'nonexistent.json')
      });
      assert.equal(config.approval_mode, 'auto-edit');
    } finally {
      delete process.env.IDLEHANDS_APPROVAL_MODE;
    }
  });

  it('CLI approval_mode overrides env approval_mode', async () => {
    process.env.IDLEHANDS_APPROVAL_MODE = 'plan';

    try {
      const { config } = await loadConfig({
        configPath: path.join(tmpDir, 'nonexistent.json'),
        cli: { approval_mode: 'yolo' }
      });
      assert.equal(config.approval_mode, 'yolo');
    } finally {
      delete process.env.IDLEHANDS_APPROVAL_MODE;
    }
  });

  it('sys mode defaults approval_mode to default when approval not explicitly set', async () => {
    const { config } = await loadConfig({
      configPath: path.join(tmpDir, 'nonexistent.json'),
      cli: { mode: 'sys' as any }
    });
    assert.equal(config.mode, 'sys');
    assert.equal(config.approval_mode, 'default');
  });

  it('sys mode keeps explicit approval_mode override', async () => {
    const { config } = await loadConfig({
      configPath: path.join(tmpDir, 'nonexistent.json'),
      cli: { mode: 'sys' as any, approval_mode: 'yolo' as any }
    });
    assert.equal(config.mode, 'sys');
    assert.equal(config.approval_mode, 'yolo');
  });

  it('reject approval_mode is accepted via CLI', async () => {
    const { config } = await loadConfig({
      configPath: path.join(tmpDir, 'nonexistent.json'),
      cli: { approval_mode: 'reject' as any }
    });
    assert.equal(config.approval_mode, 'reject');
  });

  it('reject approval_mode is accepted via env', async () => {
    process.env.IDLEHANDS_APPROVAL_MODE = 'reject';
    try {
      const { config } = await loadConfig({ configPath: path.join(tmpDir, 'nonexistent.json') });
      assert.equal(config.approval_mode, 'reject');
    } finally {
      delete process.env.IDLEHANDS_APPROVAL_MODE;
    }
  });

  it('env mode is parsed from IDLEHANDS_MODE', async () => {
    process.env.IDLEHANDS_MODE = 'sys';
    try {
      const { config } = await loadConfig({ configPath: path.join(tmpDir, 'nonexistent.json') });
      assert.equal(config.mode, 'sys');
      assert.equal(config.approval_mode, 'default');
    } finally {
      delete process.env.IDLEHANDS_MODE;
    }
  });

  it('endpoint trailing slashes are normalized', async () => {
    const { config } = await loadConfig({
      configPath: path.join(tmpDir, 'nonexistent.json'),
      cli: { endpoint: 'http://example.com/v1///' }
    });
    assert.equal(config.endpoint, 'http://example.com/v1');
  });

  it('dir is resolved to absolute path', async () => {
    // Use a path that actually exists (tmpDir) so the stale-dir safety check doesn't override it
    const { config } = await loadConfig({
      configPath: path.join(tmpDir, 'nonexistent.json'),
      cli: { dir: tmpDir }
    });
    assert.ok(path.isAbsolute(config.dir));
    assert.equal(config.dir, tmpDir);
  });

  it('dir falls back to cwd when configured dir does not exist', async () => {
    const { config } = await loadConfig({
      configPath: path.join(tmpDir, 'nonexistent.json'),
      cli: { dir: './nonexistent/ghost/path' }
    });
    assert.ok(path.isAbsolute(config.dir));
    assert.equal(config.dir, process.cwd());
  });

  it('parses output_format from env', async () => {
    process.env.IDLEHANDS_OUTPUT_FORMAT = 'json';
    try {
      const { config } = await loadConfig({ configPath: path.join(tmpDir, 'nonexistent.json') });
      assert.equal(config.output_format, 'json');
    } finally {
      delete process.env.IDLEHANDS_OUTPUT_FORMAT;
    }
  });

  it('reads system_prompt_override from env', async () => {
    process.env.IDLEHANDS_SYSTEM_PROMPT_OVERRIDE = 'custom system prompt';
    try {
      const { config } = await loadConfig({ configPath: path.join(tmpDir, 'nonexistent.json') });
      assert.equal(config.system_prompt_override, 'custom system prompt');
    } finally {
      delete process.env.IDLEHANDS_SYSTEM_PROMPT_OVERRIDE;
    }
  });

  it('invalid output_format falls back to text', async () => {
    process.env.IDLEHANDS_OUTPUT_FORMAT = 'nope';
    try {
      const { config } = await loadConfig({ configPath: path.join(tmpDir, 'nonexistent.json') });
      assert.equal(config.output_format, 'text');
    } finally {
      delete process.env.IDLEHANDS_OUTPUT_FORMAT;
    }
  });

  it('parses fail_on_error and diff_only booleans from env', async () => {
    process.env.IDLEHANDS_FAIL_ON_ERROR = '1';
    process.env.IDLEHANDS_DIFF_ONLY = 'true';
    try {
      const { config } = await loadConfig({ configPath: path.join(tmpDir, 'nonexistent.json') });
      assert.equal(config.fail_on_error, true);
      assert.equal(config.diff_only, true);
    } finally {
      delete process.env.IDLEHANDS_FAIL_ON_ERROR;
      delete process.env.IDLEHANDS_DIFF_ONLY;
    }
  });

  it('provides sane sub_agents defaults', async () => {
    const { config } = await loadConfig({ configPath: path.join(tmpDir, 'nonexistent.json') });
    assert.equal(config.sub_agents?.enabled, true);
    assert.equal(config.sub_agents?.max_iterations, 50);
    assert.equal(config.sub_agents?.max_tokens, 16384);
    assert.equal(config.sub_agents?.timeout_sec, 600);
    assert.equal(config.sub_agents?.result_token_cap, 4000);
  });

  it('--no-sub-agents CLI flag disables sub-agents', async () => {
    const { config } = await loadConfig({
      configPath: path.join(tmpDir, 'nonexistent.json'),
      cli: { sub_agents: { enabled: false } },
    });
    assert.equal(config.sub_agents?.enabled, false);
    // Other sub_agents defaults still intact
    assert.equal(config.sub_agents?.max_iterations, 50);
  });

  it('IDLEHANDS_NO_SUB_AGENTS=1 env var disables sub-agents', async () => {
    process.env.IDLEHANDS_NO_SUB_AGENTS = '1';
    try {
      const { config } = await loadConfig({ configPath: path.join(tmpDir, 'nonexistent.json') });
      assert.equal(config.sub_agents?.enabled, false);
      assert.equal(config.sub_agents?.max_iterations, 50);
    } finally {
      delete process.env.IDLEHANDS_NO_SUB_AGENTS;
    }
  });

  it('file config sub_agents.enabled=false is respected', async () => {
    const cfgFile = path.join(tmpDir, 'sub-agents-off.json');
    await fs.writeFile(cfgFile, JSON.stringify({ sub_agents: { enabled: false } }));
    const { config } = await loadConfig({ configPath: cfgFile });
    assert.equal(config.sub_agents?.enabled, false);
    assert.equal(config.sub_agents?.max_iterations, 50);
  });

  it('CLI --no-sub-agents overrides file config sub_agents.enabled=true', async () => {
    const cfgFile = path.join(tmpDir, 'sub-agents-on.json');
    await fs.writeFile(cfgFile, JSON.stringify({ sub_agents: { enabled: true } }));
    const { config } = await loadConfig({
      configPath: cfgFile,
      cli: { sub_agents: { enabled: false } },
    });
    assert.equal(config.sub_agents?.enabled, false);
  });

});

describe('anton config', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  // Anton-specific env vars for save & restore
  const ANTON_ENV_KEYS = [
    'IDLEHANDS_ANTON_MAX_RETRIES',
    'IDLEHANDS_ANTON_MAX_ITERATIONS',
    'IDLEHANDS_ANTON_TASK_TIMEOUT_SEC',
    'IDLEHANDS_ANTON_TOTAL_TIMEOUT_SEC',
    'IDLEHANDS_ANTON_MAX_TOTAL_TOKENS',
    'IDLEHANDS_ANTON_VERIFY_AI',
    'IDLEHANDS_ANTON_VERIFY_MODEL',
    'IDLEHANDS_ANTON_VERBOSE',
    'IDLEHANDS_QUIET_WARNINGS'
  ];

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-anton-test-'));
    for (const k of ANTON_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    // Suppress console.error from validation
    process.env.IDLEHANDS_QUIET_WARNINGS = '1';
  });

  after(async () => {
    for (const k of ANTON_ENV_KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('default anton config values load correctly', async () => {
    const { config } = await loadConfig({
      configPath: path.join(tmpDir, 'nonexistent.json')
    });

    assert.ok(config.anton, 'anton config block should exist');
    assert.equal(config.anton.max_retries, 3);
    assert.equal(config.anton.max_iterations, 200);
    assert.equal(config.anton.task_timeout_sec, 600);
    assert.equal(config.anton.total_timeout_sec, 7200);
    assert.equal(config.anton.max_total_tokens, undefined);
    assert.equal(config.anton.verify_ai, true);
    assert.equal(config.anton.verify_model, undefined);
    assert.equal(config.anton.decompose, true);
    assert.equal(config.anton.max_decompose_depth, 2);
    assert.equal(config.anton.max_total_tasks, 500);
    assert.equal(config.anton.skip_on_fail, true);
    assert.equal(config.anton.approval_mode, 'yolo');
    assert.equal(config.anton.verbose, false);
    assert.equal(config.anton.auto_commit, true);
  });

  it('env overrides apply', async () => {
    process.env.IDLEHANDS_ANTON_MAX_RETRIES = '5';
    process.env.IDLEHANDS_ANTON_VERIFY_AI = 'false';

    try {
      const { config } = await loadConfig({
        configPath: path.join(tmpDir, 'nonexistent.json')
      });

      assert.equal(config.anton?.max_retries, 5);
      assert.equal(config.anton?.verify_ai, false);
      // Other defaults should remain unchanged
      assert.equal(config.anton?.max_iterations, 200);
      assert.equal(config.anton?.task_timeout_sec, 600);
    } finally {
      delete process.env.IDLEHANDS_ANTON_MAX_RETRIES;
      delete process.env.IDLEHANDS_ANTON_VERIFY_AI;
    }
  });

  it('invalid values are rejected or clamped', async () => {
    const { config } = await loadConfig({
      configPath: path.join(tmpDir, 'nonexistent.json'),
      cli: {
        anton: {
          max_retries: 0,
          max_decompose_depth: 10,
          approval_mode: 'invalid'
        }
      }
    });

    // max_retries clamped to >= 1
    assert.equal(config.anton?.max_retries, 1);
    // max_decompose_depth clamped to 0-5
    assert.equal(config.anton?.max_decompose_depth, 5);
    // invalid approval_mode defaults to 'yolo' with warning
    assert.equal(config.anton?.approval_mode, 'yolo');
  });
});
