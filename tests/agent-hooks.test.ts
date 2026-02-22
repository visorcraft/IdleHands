import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createSession } from '../dist/agent.js';
import { HookManager } from '../dist/hooks/manager.js';

function baseConfig(dir: string): any {
  return {
    endpoint: 'http://127.0.0.1:0/v1',
    model: 'fake-model',
    dir,
    max_tokens: 1024,
    temperature: 0.2,
    top_p: 0.95,
    timeout: 30,
    max_iterations: 8,
    response_timeout: 30,
    approval_mode: 'auto-edit',
    no_confirm: true,
    verbose: false,
    quiet: true,
    dry_run: false,
    output_format: 'text',
    fail_on_error: true,
    diff_only: false,
    mode: 'code',
    sys_eager: false,
    context_window: 8192,
    cache_prompt: true,
    i_know_what_im_doing: true,
    theme: 'default',
    vim_mode: false,
    harness: '',
    context_file: '',
    no_context: true,
    context_file_names: ['.idlehands.md'],
    context_max_tokens: 2048,
    compact_at: 0.8,
    show_change_summary: true,
    step_mode: false,
    editor: '',
    system_prompt_override: '',
    show_server_metrics: false,
    auto_detect_model_change: false,
    slow_tg_tps_threshold: 10,
    watchdog_timeout_ms: 120000,
    watchdog_max_compactions: 3,
    watchdog_idle_grace_timeouts: 1,
    debug_abort_reason: false,
    hooks: { enabled: true, strict: true, plugin_paths: [], warn_ms: 0 },
    trifecta: {
      enabled: false,
      vault: { enabled: false },
      lens: { enabled: false },
      replay: { enabled: false },
    },
    lsp: { enabled: false, servers: [] },
    sub_agents: { enabled: false },
    mcp: { servers: [] },
    mcp_tool_budget: 100,
    mcp_call_timeout_sec: 10,
    anton: { max_retries: 1 },
    auto_update_check: false,
    offline: true,
  };
}

describe('agent hook integration', () => {
  it('fires lifecycle and tool events through hook manager', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-agent-hooks-'));
    const events: string[] = [];

    const manager = new HookManager({
      strict: true,
      warnMs: 0,
      context: () => ({
        sessionId: 'test-session',
        cwd: dir,
        model: 'fake-model',
        harness: 'openai',
        endpoint: 'http://127.0.0.1:0/v1',
      }),
    });

    manager.on('session_start', () => events.push('session_start'), 'test');
    manager.on('ask_start', () => events.push('ask_start'), 'test');
    manager.on('turn_start', () => events.push('turn_start'), 'test');
    manager.on('tool_call', ({ call }) => events.push(`tool_call:${call.name}`), 'test');
    manager.on(
      'tool_result',
      ({ result }) => events.push(`tool_result:${result.name}:${result.success ? 'ok' : 'err'}`),
      'test'
    );
    manager.on('turn_end', () => events.push('turn_end'), 'test');
    manager.on('ask_end', () => events.push('ask_end'), 'test');

    let calls = 0;
    const fakeClient: any = {
      setResponseTimeout() {},
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream() {
        calls += 1;
        if (calls === 1) {
          return {
            id: 'resp-1',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: {
                        name: 'exec',
                        arguments: JSON.stringify({ command: 'echo hook-ok', timeout: 5 }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 3 },
          };
        }

        return {
          id: 'resp-2',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(dir),
      runtime: { client: fakeClient, hookManager: manager },
    });

    try {
      const out = await session.ask('run quick command');
      assert.equal(out.text, 'done');

      assert.ok(events.includes('session_start'));
      assert.ok(events.includes('ask_start'));
      assert.ok(events.includes('turn_start'));
      assert.ok(events.includes('tool_call:exec'));
      assert.ok(events.includes('tool_result:exec:ok'));
      assert.ok(events.includes('turn_end'));
      assert.ok(events.includes('ask_end'));
    } finally {
      await session.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
