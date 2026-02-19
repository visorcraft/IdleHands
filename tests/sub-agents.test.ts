import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSession } from '../dist/agent.js';

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-subagents-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

function baseConfig(dir: string, overrides?: Record<string, any>): any {
  return {
    endpoint: 'http://127.0.0.1:0',
    model: 'fake-model',
    dir,
    max_tokens: 128,
    temperature: 0.2,
    top_p: 0.95,
    timeout: 20,
    max_iterations: 5,
    approval_mode: 'yolo',
    no_confirm: true,
    verbose: false,
    dry_run: false,
    context_window: 4096,
    cache_prompt: true,
    i_know_what_im_doing: true,
    harness: '',
    context_file: '',
    context_file_names: ['.idlehands.md', 'AGENTS.md'],
    context_max_tokens: 2048,
    no_context: false,
    trifecta: {
      enabled: true,
      vault: { enabled: true, mode: 'active' },
      lens: { enabled: false },
      replay: { enabled: false },
    },
    sub_agents: {
      enabled: true,
      max_iterations: 3,
      max_tokens: 777,
      timeout_sec: 2,
      result_token_cap: 300,
      inherit_context_file: true,
      inherit_vault: true,
    },
    ...(overrides ?? {}),
  };
}

function spawnCall(task: string, id = 'call_spawn') {
  return {
    id,
    type: 'function',
    function: {
      name: 'spawn_task',
      arguments: JSON.stringify({ task }),
    },
  };
}

describe('sub-agent config validation and limits', () => {
  it('sub_agents.enabled=false prevents delegation tool registration', async () => {
    let toolNames: string[] = [];
    const fakeClient: any = {
      async models() { return { data: [{ id: 'fake-model' }] }; },
      async chatStream(req: any) {
        toolNames = (req?.tools ?? []).map((t: any) => String(t?.function?.name ?? ''));
        return {
          id: 'fake-1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { sub_agents: { enabled: false } }),
      runtime: { client: fakeClient },
    });

    try {
      await session.ask('hello');
      assert.equal(toolNames.includes('spawn_task'), false);
    } finally {
      await session.close();
    }
  });

  it('blocks spawn_task when user explicitly forbids delegation in the instruction', async () => {
    let callNo = 0;

    const fakeClient: any = {
      async models() { return { data: [{ id: 'fake-model' }] }; },
      async chatStream() {
        callNo++;

        if (callNo === 1) {
          return {
            id: 'p-1',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [spawnCall('delegate anyway')],
              },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          };
        }

        return {
          id: 'p-2',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done directly' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { sub_agents: { enabled: true } }),
      runtime: { client: fakeClient },
    });

    try {
      await session.ask('Build this yourself. Do NOT use spawn_task or sub-agents.');
      const toolMsg = session.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_spawn') as any;
      assert.ok(toolMsg, 'expected spawn_task tool result');
      assert.ok(String(toolMsg.content ?? '').includes('blocked — user explicitly asked for no delegation/sub-agents'));
      assert.equal(callNo, 2, 'should not create nested sub-agent model calls when delegation is forbidden');
    } finally {
      await session.close();
    }
  });

  it('honors sub-agent max_iterations/max_tokens/timeout_sec and result_token_cap', async () => {
    let callNo = 0;
    const subMaxTokensSeen: number[] = [];

    const fakeClient: any = {
      async models() { return { data: [{ id: 'fake-model' }] }; },
      async chatStream(req: any) {
        callNo++;

        // Parent first turn: request delegation with overrides.
        if (callNo === 1) {
          return {
            id: 'p-1',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_spawn',
                    type: 'function',
                    function: {
                      name: 'spawn_task',
                      arguments: JSON.stringify({
                        task: 'loop sub agent forever',
                        max_iterations: 2,
                        max_tokens: 321,
                        timeout_sec: 1,
                      }),
                    },
                  },
                ],
              },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          };
        }

        // Sub-agent: always emits tool call -> exceeds max_iterations (2).
        // Record that max_tokens was propagated.
        if (callNo === 2 || callNo === 3) {
          subMaxTokensSeen.push(Number(req?.max_tokens ?? 0));
          return {
            id: `s-${callNo}`,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                  id: `s-tool-${callNo}`,
                  type: 'function',
                  function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
                }],
              },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          };
        }

        // Parent final.
        return {
          id: 'p-2',
          choices: [{ index: 0, message: { role: 'assistant', content: 'parent done' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { sub_agents: { enabled: true, result_token_cap: 256 } }),
      runtime: { client: fakeClient },
    });

    try {
      await session.ask('delegate');
      const toolMsg = session.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_spawn') as any;
      assert.ok(toolMsg, 'expected spawn_task tool result');
      const content = String(toolMsg.content ?? '');
      assert.ok(content.includes('status=failed'));
      assert.ok(content.includes('max iterations exceeded (2)'));
      assert.ok(content.includes('approval_mode: yolo'));
      assert.deepEqual(subMaxTokensSeen, [321, 321]);
    } finally {
      await session.close();
    }
  });
});

describe('sub-agent context and vault inheritance', () => {
  it('inherit_context_file=true injects project context into sub-agent; false omits it', async () => {
    const ctxFile = path.join(tmpDir, '.idlehands.md');
    await fs.writeFile(ctxFile, 'SUB_AGENT_CONTEXT_MARKER', 'utf8');

    async function runWith(inheritContext: boolean): Promise<string[]> {
      let callNo = 0;
      const subUserMessages: string[] = [];
      const fakeClient: any = {
        async models() { return { data: [{ id: 'fake-model' }] }; },
        async chatStream(req: any) {
          callNo++;
          const userMsg = req?.messages?.find((m: any) => m.role === 'user')?.content;

          if (callNo === 1) {
            return {
              id: 'p-1',
              choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [spawnCall('check context')] } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          }

          if (callNo === 2) {
            subUserMessages.push(String(userMsg ?? ''));
            return {
              id: 's-1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'sub done' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          }

          return {
            id: 'p-2',
            choices: [{ index: 0, message: { role: 'assistant', content: 'parent done' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      };

      const session = await createSession({
        config: baseConfig(tmpDir, {
          sub_agents: { enabled: true, inherit_context_file: inheritContext },
        }),
        runtime: { client: fakeClient },
      });

      try {
        await session.ask('delegate once');
      } finally {
        await session.close();
      }
      return subUserMessages;
    }

    const withContext = await runWith(true);
    const withoutContext = await runWith(false);

    assert.ok(withContext[0].includes('SUB_AGENT_CONTEXT_MARKER'));
    assert.equal(withoutContext[0].includes('SUB_AGENT_CONTEXT_MARKER'), false);
  });

  it('inherit_vault=true shares vault object; false does not', async () => {
    const notes: Array<{ key: string; value: string }> = [];
    const fakeVault: any = {
      setProjectDir() {},
      async note(key: string, value: string) { notes.push({ key, value }); },
      async search() { return []; },
      async archiveToolMessages() { return 0; },
      async close() {},
    };

    async function runWith(inheritVault: boolean) {
      let callNo = 0;
      const fakeClient: any = {
        async models() { return { data: [{ id: 'fake-model' }] }; },
        async chatStream() {
          callNo++;
          if (callNo === 1) {
            return {
              id: 'p-1',
              choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [spawnCall('write vault note')] } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          }
          if (callNo === 2) {
            return {
              id: 's-1',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [{
                    id: 's-vault-note',
                    type: 'function',
                    function: { name: 'vault_note', arguments: JSON.stringify({ key: 'k', value: 'v' }) },
                  }],
                },
              }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          }
          if (callNo === 3) {
            return {
              id: 's-2',
              choices: [{ index: 0, message: { role: 'assistant', content: 'sub done' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          }
          return {
            id: 'p-2',
            choices: [{ index: 0, message: { role: 'assistant', content: 'parent done' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      };

      const session = await createSession({
        config: baseConfig(tmpDir, { sub_agents: { enabled: true, inherit_vault: inheritVault } }),
        runtime: { client: fakeClient, vault: fakeVault },
      });
      try {
        await session.ask('delegate');
      } finally {
        await session.close();
      }
    }

    const before = notes.length;
    await runWith(true);
    const afterTrue = notes.length;
    await runWith(false);
    const afterFalse = notes.length;

    assert.ok(afterTrue > before, 'expected shared vault to receive note from sub-agent');
    assert.equal(afterFalse, afterTrue, 'expected fake vault count unchanged when inherit_vault=false');
  });
});

describe('sub-agent failure modes and concurrency', () => {
  it('kills timed-out sub-agent gracefully', async () => {
    let callNo = 0;
    const fakeClient: any = {
      async models() { return { data: [{ id: 'fake-model' }] }; },
      async chatStream() {
        callNo++;
        if (callNo === 1) {
          return {
            id: 'p-1',
            choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [spawnCall('slow task')] } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }
        if (callNo === 2) {
          await new Promise((r) => setTimeout(r, 1200));
          return {
            id: 's-1',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                  id: 's-tool-timeout',
                  type: 'function',
                  function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
                }],
              },
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }
        return {
          id: 'p-2',
          choices: [{ index: 0, message: { role: 'assistant', content: 'parent done' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { sub_agents: { enabled: true, timeout_sec: 1 } }),
      runtime: { client: fakeClient },
    });

    try {
      await session.ask('delegate timeout');
      const toolMsg = session.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_spawn') as any;
      const content = String(toolMsg?.content ?? '');
      assert.ok(content.includes('status=failed'));
      assert.ok(content.includes('session timeout exceeded'));
    } finally {
      await session.close();
    }
  });

  it('handles concurrent spawn_task calls independently and propagates sub-agent errors', async () => {
    let callNo = 0;
    const fakeClient: any = {
      async models() { return { data: [{ id: 'fake-model' }] }; },
      async chatStream() {
        callNo++;
        if (callNo === 1) {
          return {
            id: 'p-1',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [spawnCall('good task', 'call_spawn_a'), spawnCall('bad task', 'call_spawn_b')],
              },
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }

        // Sub-agent A succeeds.
        if (callNo === 2) {
          return {
            id: 's-a-1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'good result' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }

        // Sub-agent B throws.
        if (callNo === 3) {
          throw new Error('sub-agent exploded');
        }

        return {
          id: 'p-2',
          choices: [{ index: 0, message: { role: 'assistant', content: 'parent done' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { max_iterations: 6, sub_agents: { enabled: true, result_token_cap: 128 } }),
      runtime: { client: fakeClient },
    });

    try {
      await session.ask('run two delegates');
      const a = session.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_spawn_a') as any;
      const b = session.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_spawn_b') as any;
      assert.ok(String(a?.content ?? '').includes('status=completed'));
      assert.ok(String(b?.content ?? '').includes('status=failed'));
      assert.ok(String(b?.content ?? '').includes('sub-agent exploded'));
    } finally {
      await session.close();
    }
  });

  it('truncates sub-agent result to result_token_cap', async () => {
    let callNo = 0;
    const huge = 'x'.repeat(4000);
    const fakeClient: any = {
      async models() { return { data: [{ id: 'fake-model' }] }; },
      async chatStream() {
        callNo++;
        if (callNo === 1) {
          return {
            id: 'p-1',
            choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [spawnCall('return huge text')] } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }
        if (callNo === 2) {
          return {
            id: 's-1',
            choices: [{ index: 0, message: { role: 'assistant', content: huge } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }
        return {
          id: 'p-2',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { sub_agents: { enabled: true, result_token_cap: 256 } }),
      runtime: { client: fakeClient },
    });

    try {
      await session.ask('delegate long output');
      const toolMsg = session.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'call_spawn') as any;
      const content = String(toolMsg?.content ?? '');
      assert.ok(content.includes('status=completed'));
      assert.ok(content.includes('truncated') || content.includes('capped'));
      assert.ok(content.length < huge.length);
    } finally {
      await session.close();
    }
  });
});
