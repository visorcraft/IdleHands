import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';

import { createSession, parseToolCallsFromContent } from '../dist/agent.js';

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-agent-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

function baseConfig(tmpDir: string, overrides?: Record<string, any>): any {
  return {
    endpoint: 'http://127.0.0.1:0',
    model: 'fake-model',
    dir: tmpDir,
    max_tokens: 64,
    temperature: 0.2,
    top_p: 0.95,
    timeout: 5,
    max_iterations: 2,
    no_confirm: true,
    verbose: false,
    dry_run: false,
    context_window: 128,
    cache_prompt: true,
    i_know_what_im_doing: true,
    harness: '',
    context_file: '',
    context_file_names: ['.idlehands.md', 'AGENTS.md', '.github/AGENTS.md'],
    context_max_tokens: 8192,
    no_context: true,
    trifecta: {
      enabled: true,
      vault: { enabled: true, mode: 'passive' },
      lens: { enabled: true },
      replay: { enabled: false },
    },
    ...(overrides ?? {}),
  };
}

async function makeMockMcpServerScript(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-agent-mcp-'));
  const file = path.join(dir, 'mock-mcp-server.mjs');
  const src = `
let buffer = Buffer.alloc(0);

function findHeaderDelimiter(buf) {
  const a = buf.indexOf(Buffer.from('\\r\\n\\r\\n'));
  if (a >= 0) return { index: a, sepLen: 4 };
  const b = buf.indexOf(Buffer.from('\\n\\n'));
  if (b >= 0) return { index: b, sepLen: 2 };
  return null;
}

function send(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.from('Content-Length: ' + payload.length + '\\r\\n\\r\\n', 'utf8');
  process.stdout.write(Buffer.concat([header, payload]));
}

function handle(msg) {
  const id = msg?.id;
  if (msg?.method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: {} } });
    return;
  }

  if (msg?.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'mcp_echo',
            description: 'Echo text',
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: { text: { type: 'string' } },
              required: ['text']
            }
          }
        ]
      }
    });
    return;
  }

  if (msg?.method === 'tools/call') {
    const args = msg?.params?.arguments ?? {};
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: 'echo:' + String(args?.text ?? '') }]
      }
    });
    return;
  }

  if (typeof id === 'number') {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length > 0) {
    const header = findHeaderDelimiter(buffer);
    if (!header) return;
    const headerText = buffer.subarray(0, header.index).toString('utf8');
    const match = /content-length\\s*:\\s*(\\d+)/i.exec(headerText);
    if (!match) {
      buffer = buffer.subarray(header.index + header.sepLen);
      continue;
    }
    const len = Number(match[1]);
    const start = header.index + header.sepLen;
    if (buffer.length < start + len) return;
    const body = buffer.subarray(start, start + len).toString('utf8');
    buffer = buffer.subarray(start + len);
    try {
      handle(JSON.parse(body));
    } catch {}
  }
});
`;
  await fs.writeFile(file, src, 'utf8');
  return file;
}

describe('context overflow recovery', () => {
  it('auto-compacts and retries when server returns context-size 400', async () => {
    let calls = 0;
    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream() {
        calls++;
        if (calls === 1) {
          const err: any = new Error(
            'POST /chat/completions failed: 400 Bad Request {"error":{"code":400,"message":"request (64330 tokens) exceeds the available context size (64000 tokens)"}}'
          );
          err.status = 400;
          err.retryable = false;
          throw err;
        }
        return {
          id: 'fake',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Recovered after compaction',
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 8 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { max_iterations: 3 }),
      runtime: { client: fakeClient },
    });

    const result = await session.ask('trigger overflow recovery');
    assert.equal(result.text, 'Recovered after compaction');
    assert.equal(calls, 2, 'should retry once after compacting context');
  });
});

describe('agent failure persistence', () => {
  it('persists a failure note when max iterations are exceeded', async () => {
    const notes: Array<{ key: string; value: string }> = [];
    const fakeVault: any = {
      setProjectDir() {},
      async note(key: string, value: string) {
        notes.push({ key, value });
      },
      async upsertNote() {},
    };

    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream() {
        return {
          id: 'fake',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'running',
                tool_calls: [
                  {
                    id: 'tool-0',
                    type: 'function',
                    function: {
                      name: 'list_dir',
                      arguments: JSON.stringify({ path: '.' }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        };
      },
    };

    const config = baseConfig(tmpDir, { max_iterations: 1 });

    await fs.mkdir(path.join(tmpDir, 'dir'), { recursive: true });
    const session = await createSession({
      config,
      runtime: {
        client: fakeClient,
        vault: fakeVault,
      },
    });

    await assert.rejects(() => session.ask('do too much'), /max iterations exceeded/);

    assert.equal(notes.length, 1);
    const entry = notes[0];
    assert.equal(entry.key, 'agent failure');
    assert.ok(entry.value.includes('max iterations exceeded (1)'));
  });

  it('persists a failure note when session timeout is exceeded', async () => {
    const notes: Array<{ key: string; value: string }> = [];
    let calls = 0;
    const fakeVault: any = {
      setProjectDir() {},
      async note(key: string, value: string) {
        notes.push({ key, value });
      },
      async upsertNote() {},
    };

    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream() {
        calls += 1;
        throw new Error('should not be called when timeout is exceeded before first request');
      },
    };

    const config = baseConfig(tmpDir, { timeout: -1 });

    const session = await createSession({
      config,
      runtime: {
        client: fakeClient,
        vault: fakeVault,
      },
    });

    await assert.rejects(() => session.ask('this should timeout fast'), /session timeout exceeded/);

    assert.equal(calls, 0, 'chatStream must not be called after immediate timeout');
    assert.equal(notes.length, 1);
    const entry = notes[0];
    assert.equal(entry.key, 'agent failure');
    assert.ok(entry.value.includes('session timeout exceeded'));
  });
});

describe('agent no-progress watchdog', () => {
  it('fails early after consecutive empty turns instead of burning max iterations', async () => {
    let calls = 0;

    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream() {
        calls += 1;
        return {
          id: `np-${calls}`,
          choices: [{ index: 0, message: { role: 'assistant', content: '' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };

    const config = baseConfig(tmpDir, { max_iterations: 20, verbose: false });

    const session = await createSession({
      config,
      runtime: { client: fakeClient },
    });

    try {
      await assert.rejects(
        () => session.ask('build something'),
        /no progress for 3 consecutive turns/i
      );
      assert.ok(calls <= 3, `expected early stop within 3 calls, got ${calls}`);
    } finally {
      await session.close();
    }
  });
});

describe('agent no-tool reprompt recovery', () => {
  it('reprompts once after two planning-only turns and recovers if model resumes tool use', async () => {
    let callNo = 0;

    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream() {
        callNo += 1;

        if (callNo === 1) {
          return {
            id: 'r1',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: "I'll start by checking the project structure.",
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }

        if (callNo === 2) {
          return {
            id: 'r2',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: 'Next I will inspect key files before editing.',
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }

        if (callNo === 3) {
          return {
            id: 'r3',
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'l1',
                      type: 'function',
                      function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }

        return {
          id: 'r4',
          choices: [
            { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { max_iterations: 10 }),
      runtime: { client: fakeClient },
    });

    try {
      const out = await session.ask('build it');
      assert.equal(out.text, 'done');
      assert.equal(callNo, 4);
    } finally {
      await session.close();
    }
  });

  it('fails if no-tool planning loop continues after one reprompt', async () => {
    let callNo = 0;

    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream() {
        callNo += 1;
        return {
          id: `p-${callNo}`,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: "I'll continue planning the next step." },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { max_iterations: 10 }),
      runtime: { client: fakeClient },
    });

    try {
      await assert.rejects(() => session.ask('build it'), /no-tool loop detected/i);
      assert.equal(callNo, 4, `expected break on 4th planning-only turn, got ${callNo}`);
    } finally {
      await session.close();
    }
  });
});

describe('agent package-install retry guard', () => {
  it('stops quickly when package installs are repeatedly blocked in non-yolo mode', async () => {
    let callNo = 0;

    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream() {
        callNo += 1;

        if (callNo === 1) {
          return {
            id: 'pkg-1',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'e1',
                      type: 'function',
                      function: {
                        name: 'exec',
                        arguments: JSON.stringify({ command: 'npm install' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }

        if (callNo === 2) {
          return {
            id: 'pkg-2',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'e2',
                      type: 'function',
                      function: {
                        name: 'exec',
                        arguments: JSON.stringify({ command: 'npm install --no-confirm' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }

        return {
          id: 'pkg-3',
          choices: [{ index: 0, message: { role: 'assistant', content: 'should not reach here' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };

    const config = baseConfig(tmpDir, {
      max_iterations: 10,
      approval_mode: 'auto-edit',
      no_confirm: false,
    });

    const session = await createSession({
      config,
      runtime: { client: fakeClient },
    });

    try {
      await session.ask('install deps');
      assert.ok(
        callNo <= 3,
        `expected guardrails to prevent long blocked-command loops, got ${callNo} model turns`
      );
    } finally {
      await session.close();
    }
  });
});

describe('agent vault + replay synergy', () => {
  it('compacts and archives compressed tool output when dropping context', async () => {
    const archived: any[] = [];

    const fakeVault: any = {
      setProjectDir() {},
      async archiveToolMessages(msgs: any[]) {
        archived.push(...msgs);
        return msgs.length;
      },
      async upsertNote() {
        // Mock for preserving user prompt before compaction
      },
    };

    const listingFileCount = 320;
    for (let i = 0; i < listingFileCount; i++) {
      const name = `long_file_name_${String(i).padStart(4, '0')}_${'x'.repeat(90)}.md`;
      await fs.writeFile(path.join(tmpDir, name), `payload-${i}`, 'utf8');
    }

    let calls = 0;
    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream() {
        calls += 1;
        if (calls === 1) {
          return {
            id: `fake-${calls}`,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'phase1',
                  tool_calls: Array.from({ length: 13 }, (_, i) => ({
                    id: `tool-${i}`,
                    type: 'function',
                    function: {
                      name: 'list_dir',
                      arguments: JSON.stringify({ path: '.' }),
                    },
                  })),
                },
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 20 },
          };
        }

        return {
          id: `fake-${calls}`,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'done',
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 4 },
        };
      },
    };

    const config = baseConfig(tmpDir, { max_iterations: 2 });

    const session = await createSession({
      config,
      runtime: {
        client: fakeClient,
        vault: fakeVault,
      },
    });

    // Pre-fill with token-heavy history so compaction has room to drop earlier tool messages.
    for (let i = 0; i < 25; i++) {
      session.messages.push({ role: 'assistant', content: `filler-${i} ${'y'.repeat(300)}` });
    }

    const out = await session.ask('list lots of files and return');
    assert.equal(out.text, 'done');

    const toolMsgs = archived.filter(
      (m) => m.role === 'tool' && m.tool_call_id?.startsWith('tool-')
    );
    assert.ok(toolMsgs.length > 0, 'expected tool messages were archived');

    // Lens-enabled compaction path should shrink verbose tool output before archive.
    assert.ok(
      toolMsgs.some(
        (m) =>
          typeof m.content === 'string' &&
          m.content.includes('[truncated,') &&
          m.content.includes('chars total')
      )
    );
  });
});

describe('trifecta vault passive injection', () => {
  it('does not inject passive vault context during auto-compaction', async () => {
    let seenMessages: any[] = [];

    const fakeVault: any = {
      setProjectDir() {},
      async search(_query: string, _limit: number) {
        return [
          {
            id: '1',
            kind: 'note',
            key: 'deploy',
            value: 'run tests before restart',
            updatedAt: '2026-02-16T00:00:00.000Z',
          },
        ];
      },
      async archiveToolMessages() {
        return 0;
      },
      async upsertNote() {},
    };

    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream(opts: any) {
        seenMessages = opts.messages;
        return {
          id: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        };
      },
    };

    const config = baseConfig(tmpDir, {
      model: 'fake-model',
      no_context: true,
      trifecta: {
        enabled: true,
        vault: { enabled: true, mode: 'passive' },
        lens: { enabled: false },
        replay: { enabled: false },
      },
    });

    const session = await createSession({
      config,
      runtime: { client: fakeClient, vault: fakeVault },
    });

    // Auto-compaction should NOT inject vault context (avoids context bloat spiral).
    for (let i = 0; i < 40; i++) {
      session.messages.push({ role: 'assistant', content: `filler-${i} ${'z'.repeat(500)}` });
    }

    const out = await session.ask('how should I deploy?');
    assert.equal(out.text, 'done');

    const injected = seenMessages.some(
      (m: any) => typeof m?.content === 'string' && m.content.includes('[Trifecta Vault (passive)]')
    );
    assert.equal(injected, false, 'vault context should not be injected during auto-compaction');
  });
});

describe('review artifact durability', () => {
  it('replays stored full code review without another model/tool pass', async () => {
    const rows = new Map<string, string>();

    const fakeVault: any = {
      setProjectDir() {},
      async getLatestByKey(key: string) {
        const value = rows.get(key);
        if (!value) return null;
        return {
          id: 'row-1',
          kind: 'system',
          key,
          value,
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
      },
      async upsertNote(key: string, value: string) {
        rows.set(key, value);
        return 'row-1';
      },
      async archiveToolMessages() {
        return 0;
      },
    };

    let llmCalls = 0;
    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream() {
        llmCalls += 1;
        return {
          id: `fake-${llmCalls}`,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '## Full Code Review\n\n- Finding A\n- Finding B',
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 15 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { max_iterations: 3 }),
      runtime: { client: fakeClient, vault: fakeVault },
    });

    const first = await session.ask('Please run a full code review of this repository.');
    assert.match(first.text, /Full Code Review/);
    assert.equal(llmCalls, 1);

    const second = await session.ask('print the full code review');
    assert.equal(second.text, first.text);
    assert.equal(llmCalls, 1, 'expected retrieval from stored artifact, not another LLM turn');
  });
});

describe('agent loop dispatch + hooks', () => {
  it('dispatches tool calls and emits hook lifecycle events', async () => {
    const calls: ToolCallEvent[] = [];
    const results: ToolResultEvent[] = [];
    const turns: TurnEndEvent[] = [];

    let llmCalls = 0;
    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream() {
        llmCalls += 1;
        if (llmCalls === 1) {
          return {
            id: 'fake-1',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'tool-1',
                      type: 'function',
                      function: {
                        name: 'list_dir',
                        arguments: JSON.stringify({ path: '.' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 10 },
          };
        }

        return {
          id: 'fake-2',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'done',
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        };
      },
    };

    const config = baseConfig(tmpDir, { max_iterations: 5, no_confirm: true });
    const session = await createSession({ config, runtime: { client: fakeClient } });

    const out = await session.ask('list files', {
      onToolCall: (ev) => calls.push(ev),
      onToolResult: (ev) => results.push(ev),
      onTurnEnd: (ev) => turns.push(ev),
    });

    assert.equal(out.text, 'done');
    assert.equal(out.toolCalls, 1);
    assert.equal(llmCalls, 2, 'expected one tool turn + one final answer turn');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'list_dir');

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'list_dir');
    assert.equal(results[0].success, true);

    // onTurnEnd fires for each model turn (tool turn + final assistant turn)
    assert.equal(turns.length, 2);
    assert.equal(turns[0].turn, 1);
    assert.equal(turns[0].toolCalls, 1);
    assert.equal(turns[1].turn, 2);
    assert.equal(turns[1].toolCalls, 1);
  });
});

describe('harness behavioral wiring', () => {
  it('nemotron harness breaks loop on first repeated identical call (loopsOnToolError)', async () => {
    let calls = 0;
    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'nemotron-3-nano' }] };
      },
      async warmup() {},
      async chatStream() {
        calls++;
        // Always emit the same tool call — nemotron loops on errors
        return {
          id: `fake-${calls}`,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: `tool-${calls}`,
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({ path: '/tmp/loop-test.txt', content: 'x' }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        };
      },
    };

    const config = baseConfig(tmpDir, { max_iterations: 20, model: 'nemotron-3-nano' });
    const session = await createSession({ config, runtime: { client: fakeClient } });

    // With loopsOnToolError=true, nemotron breaks after 2nd turn with identical call
    // (threshold=2) instead of the normal 3. So we expect failure after very few iterations.
    await assert.rejects(
      () => session.ask('do something'),
      /identical call repeated 2x across turns; breaking loop/
    );
    // Should have broken after just 2 LLM calls (2nd turn triggers the loop detection)
    assert.ok(calls <= 3, `expected early break but got ${calls} calls`);
  });

  it('reuses cached output for repeated read-only exec observations instead of hard-breaking', async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-exec-cache-'));
    await fs.writeFile(path.join(work, 'notes.txt'), 'hello\nworld\n', 'utf8');

    let calls = 0;
    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream() {
        calls++;
        if (calls <= 7) {
          return {
            id: `fake-${calls}`,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: `tool-${calls}`,
                      type: 'function',
                      function: {
                        name: 'exec',
                        arguments: JSON.stringify({
                          command: 'grep -n "hello" notes.txt',
                          timeout: 10,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 8 },
          };
        }

        return {
          id: `fake-${calls}`,
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 20, completion_tokens: 6 },
        };
      },
    };

    const config = baseConfig(work, { max_iterations: 12, context_window: 8192 });
    const session = await createSession({ config, runtime: { client: fakeClient } });

    try {
      const out = await session.ask('find hello in notes');
      assert.equal(out.text, 'done');
      assert.ok(calls >= 8, `expected loop to continue instead of hard-break; calls=${calls}`);

      const sawLoopReuseHint = session.messages.some((m: any) => {
        if (m.role !== 'tool' || typeof m.content !== 'string') return false;
        return (
          m.content.includes('Reused cached output for repeated read-only exec call') ||
          m.content.includes('You already ran this exact command') ||
          m.content.includes('"cached_observation":true') ||
          m.content.includes('"replayed":true')
        );
      });
      assert.equal(sawLoopReuseHint, true, 'expected loop-reuse hint in tool output');
    } finally {
      await session.close();
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reuses cached output for repeated identical read_file calls instead of hard-breaking', async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-read-cache-'));
    await fs.writeFile(path.join(work, 'repeat.txt'), 'line1\nline2\nline3\n', 'utf8');

    let calls = 0;
    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async warmup() {},
      async chatStream() {
        calls++;
        // With threshold of 6 for read_file, we need 9+ calls to see caching behavior
        if (calls <= 9) {
          return {
            id: `fake-${calls}`,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: `tool-${calls}`,
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ path: 'repeat.txt', limit: 50 }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 8 },
          };
        }

        return {
          id: `fake-${calls}`,
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 20, completion_tokens: 6 },
        };
      },
    };

    const config = baseConfig(work, { max_iterations: 15, context_window: 8192 });
    const session = await createSession({ config, runtime: { client: fakeClient } });

    try {
      const out = await session.ask('read repeat file');
      assert.equal(out.text, 'done');
      // With threshold of 6, we expect the loop to continue via cache reuse
      assert.ok(calls >= 10, `expected loop to continue via cache reuse; calls=${calls}`);

      const sawCachedHint = session.messages.some(
        (m: any) =>
          m.role === 'tool' &&
          typeof m.content === 'string' &&
          m.content.includes('[CACHE HIT] File unchanged since previous read.')
      );
      assert.equal(sawCachedHint, true, 'expected cached read hint in tool output');
    } finally {
      await session.close();
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('nemotron harness limits max_iterations via maxIterationsOverride', async () => {
    let calls = 0;
    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'nemotron-3-nano' }] };
      },
      async warmup() {},
      async chatStream() {
        calls++;
        // Each call uses `calls` in the args to make every signature unique,
        // preventing loop detection from firing before maxIterationsOverride.
        // We capture `calls` at call time to avoid closure issues.
        const n = calls;
        return {
          id: `fake-${n}`,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: `tool-${n}`,
                    type: 'function',
                    function: {
                      name: 'list_dir',
                      arguments: JSON.stringify({ path: `./unique-${n}` }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        };
      },
    };

    // User config says 20 iterations, but nemotron override caps at 10
    const config = baseConfig(tmpDir, {
      max_iterations: 20,
      model: 'nemotron-3-nano',
      context_window: 1048576,
    });
    const session = await createSession({ config, runtime: { client: fakeClient } });

    await assert.rejects(() => session.ask('loop forever'), /max iterations exceeded \(10\)/);
    assert.equal(calls, 10);
  });

  it('thinking blocks are NOT stripped when harness.thinking.strip is false', async () => {
    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'mistral-small-3.2' }] };
      },
      async warmup() {},
      async chatStream() {
        return {
          id: 'fake',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '<think>internal reasoning</think>The answer is 42.',
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        };
      },
    };

    // Mistral has thinking.strip = false, so <think> blocks stay in output
    const config = baseConfig(tmpDir, { model: 'mistral-small-3.2' });
    const session = await createSession({ config, runtime: { client: fakeClient } });
    const result = await session.ask('what is the answer?');

    // Content should retain the <think> block since mistral doesn't strip
    assert.ok(result.text.includes('<think>'), 'expected <think> block to be preserved');
    assert.ok(result.text.includes('The answer is 42.'));
  });

  it('thinking blocks ARE stripped when harness.thinking.strip is true', async () => {
    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'qwen3-coder-next' }] };
      },
      async warmup() {},
      async chatStream() {
        return {
          id: 'fake',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '<think>internal reasoning</think>The answer is 42.',
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        };
      },
    };

    const config = baseConfig(tmpDir, { model: 'qwen3-coder-next' });
    const session = await createSession({ config, runtime: { client: fakeClient } });
    const result = await session.ask('what is the answer?');

    assert.ok(!result.text.includes('<think>'), 'expected <think> block to be stripped');
    assert.equal(result.text, 'The answer is 42.');
  });

  it('malformed JSON breaks outer loop after retryOnMalformed exceeded (nemotron)', async () => {
    let calls = 0;
    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'nemotron-3-nano' }] };
      },
      async warmup() {},
      async chatStream() {
        calls++;
        const n = calls;
        // Each call has unique malformed args so loop detection doesn't fire first
        return {
          id: `fake-${n}`,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: `tool-${n}`,
                    type: 'function',
                    function: { name: 'read_file', arguments: `{invalid json attempt ${n}` },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        };
      },
    };

    // nemotron has retryOnMalformed=1, so second malformed call breaks the loop
    const config = baseConfig(tmpDir, {
      max_iterations: 20,
      model: 'nemotron-3-nano',
      context_window: 1048576,
    });
    const session = await createSession({ config, runtime: { client: fakeClient } });

    await assert.rejects(
      () => session.ask('do something'),
      /malformed JSON exceeded retry limit \(1\)/
    );
    // Should break after 2 LLM calls (first malformed → tool error, second malformed → loop break)
    assert.ok(calls <= 3, `expected early break but got ${calls} calls`);
  });

  it('parses tool calls from JSON array in content', async () => {
    let calls = 0;
    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'llama-3' }] };
      },
      async warmup() {},
      async chatStream() {
        calls++;
        if (calls === 1) {
          // Model writes tool calls as a JSON array in content instead of tool_calls
          return {
            id: `fake-${calls}`,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: `[{"name":"list_dir","arguments":{"path":"."}}]`,
                },
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 10 },
          };
        }
        return {
          id: `fake-${calls}`,
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        };
      },
    };

    const config = baseConfig(tmpDir, { model: 'llama-3' });
    const session = await createSession({ config, runtime: { client: fakeClient } });
    const result = await session.ask('list files');
    assert.equal(result.text, 'done');
    assert.equal(result.toolCalls, 1);
  });

  it('injects tool_calls format reminder for models that need it', async () => {
    const fakeClient: any = {
      async models() {
        return { data: [{ id: 'nemotron-3-nano' }] };
      },
      async warmup() {},
      async chatStream() {
        return {
          id: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        };
      },
    };

    const config = baseConfig(tmpDir, { model: 'nemotron-3-nano' });
    const session = await createSession({ config, runtime: { client: fakeClient } });

    // Session meta is now deferred and prepended to the first user instruction.
    // After ask(), messages[1] should be the user message with meta + instruction.
    const result = await session.ask('hello');
    const userMsg = session.messages[1];
    assert.ok(
      typeof userMsg.content === 'string' &&
        userMsg.content.includes('Use the tool_calls mechanism'),
      'expected tool_calls format reminder prepended to first user instruction'
    );
  });
});

describe('plan mode blocking', () => {
  it('blocks mutating tools in plan mode and accumulates plan steps', async () => {
    // Write a file first so edit_file has something to work with
    const testFile = path.join(tmpDir, 'plan-test.txt');
    await fs.writeFile(testFile, 'line one\nline two\n');

    let turnCount = 0;
    const fakeClient: any = {
      async models() {
        return [{ id: 'fake-model' }];
      },
      async chatStream(params: any, callbacks: any) {
        turnCount++;
        if (turnCount === 1) {
          // First turn: model tries to edit a file (mutating) + read a file (read-only)
          return {
            id: 'fake',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_read',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ path: testFile }),
                      },
                    },
                    {
                      id: 'call_edit',
                      function: {
                        name: 'edit_file',
                        arguments: JSON.stringify({
                          path: testFile,
                          old_text: 'line one',
                          new_text: 'LINE ONE',
                        }),
                      },
                    },
                    {
                      id: 'call_exec',
                      function: {
                        name: 'exec',
                        arguments: JSON.stringify({ command: 'echo hello' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          };
        }
        // Second turn: model acknowledges the results
        return {
          id: 'fake',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'Got it, 2 actions blocked.' } },
          ],
          usage: { prompt_tokens: 150, completion_tokens: 10 },
        };
      },
    };

    const config = baseConfig(tmpDir, { approval_mode: 'plan', no_confirm: false });
    const session = await createSession({ config, runtime: { client: fakeClient } });

    try {
      await session.ask('edit the file and run a test');

      // Plan steps should have accumulated
      assert.ok(
        session.planSteps.length >= 2,
        `Expected at least 2 plan steps, got ${session.planSteps.length}`
      );

      // Read-only tool (read_file) should NOT be in plan steps
      const readSteps = session.planSteps.filter((s) => s.tool === 'read_file');
      assert.equal(readSteps.length, 0, 'read_file should not be blocked in plan mode');

      // Mutating tools should be in plan steps
      const editSteps = session.planSteps.filter((s) => s.tool === 'edit_file');
      const execSteps = session.planSteps.filter((s) => s.tool === 'exec');
      assert.equal(editSteps.length, 1, 'edit_file should be blocked in plan mode');
      assert.equal(execSteps.length, 1, 'exec should be blocked in plan mode');

      // Steps should be blocked and not executed
      for (const step of session.planSteps) {
        assert.ok(step.blocked, `Step #${step.index} should be blocked`);
        assert.ok(!step.executed, `Step #${step.index} should not be executed yet`);
        assert.ok(step.summary, `Step #${step.index} should have a summary`);
      }

      // Verify the file was NOT modified
      const content = await fs.readFile(testFile, 'utf8');
      assert.equal(content, 'line one\nline two\n', 'File should be unchanged in plan mode');

      // Now execute the plan
      const results = await session.executePlanStep();
      assert.ok(results.length >= 2, `Expected at least 2 results, got ${results.length}`);

      // Verify the edit was applied
      const afterEdit = await fs.readFile(testFile, 'utf8');
      assert.ok(afterEdit.includes('LINE ONE'), 'File should be modified after plan execution');

      // Verify steps are marked as executed
      const executed = session.planSteps.filter((s) => s.executed);
      assert.ok(executed.length >= 1, 'At least one step should be executed');

      // Clear plan
      session.clearPlan();
      assert.equal(session.planSteps.length, 0, 'Plan should be empty after clear');
    } finally {
      await session.close();
    }
  });

  it('can execute blocked spawn_task steps via executePlanStep()', async () => {
    let calls = 0;
    const fakeClient: any = {
      async models() {
        return [{ id: 'fake-model' }];
      },
      async chatStream() {
        calls++;
        if (calls === 1) {
          return {
            id: 'fake-1',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_spawn_plan',
                      function: {
                        name: 'spawn_task',
                        arguments: JSON.stringify({ task: 'summarize files in cwd' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 10 },
          };
        }
        if (calls === 2) {
          return {
            id: 'fake-2',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'spawn_task blocked in plan mode' },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        }
        return {
          id: `fake-${calls}`,
          choices: [{ index: 0, message: { role: 'assistant', content: 'sub-agent done' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, {
        approval_mode: 'plan',
        no_confirm: false,
        max_iterations: 4,
        sub_agents: { enabled: true, max_iterations: 2, timeout_sec: 15 },
      }),
      runtime: { client: fakeClient },
    });

    try {
      await session.ask('delegate this');

      const spawnStep = session.planSteps.find((s) => s.tool === 'spawn_task');
      assert.ok(spawnStep, 'spawn_task should be captured as a blocked plan step');
      assert.ok(!spawnStep?.executed, 'spawn_task should not be executed yet');

      const results = await session.executePlanStep(spawnStep?.index);
      assert.ok(
        results.some((r) => r.includes('✓')),
        `expected an executed result row, got: ${results.join(' | ')}`
      );

      const updated = session.planSteps.find((s) => s.index === spawnStep?.index);
      assert.equal(updated?.executed, true, 'spawn_task plan step should be marked executed');
      assert.ok(
        String(updated?.result ?? '').includes('[sub-agent] status='),
        'spawn_task result should include sub-agent status'
      );
    } finally {
      await session.close();
    }
  });
});

describe('sys mode tool schema', () => {
  it('registers sys_context only when mode=sys', async () => {
    const seenTools: string[][] = [];
    const fakeClient: any = {
      async models() {
        return [{ id: 'fake-model' }];
      },
      async chatStream(params: any) {
        const toolNames = (params.tools ?? []).map((t: any) => t?.function?.name).filter(Boolean);
        seenTools.push(toolNames);
        return {
          id: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      },
    };

    const codeSession = await createSession({
      config: baseConfig(tmpDir, { mode: 'code', approval_mode: 'auto-edit' }),
      runtime: { client: fakeClient },
    });
    await codeSession.ask('hello');

    const sysSession = await createSession({
      config: baseConfig(tmpDir, { mode: 'sys', approval_mode: 'default' }),
      runtime: { client: fakeClient },
    });
    await sysSession.ask('hello');

    assert.ok(seenTools.length >= 2);
    const codeTools = seenTools[0];
    const sysTools = seenTools[1];

    assert.ok(!codeTools.includes('sys_context'), 'sys_context should not be present in code mode');
    assert.ok(sysTools.includes('sys_context'), 'sys_context should be present in sys mode');
  });
});

describe('capture tooling', () => {
  it('records exchanges to JSONL and supports captureLast', async () => {
    let exchangeHook: ((record: any) => void | Promise<void>) | undefined;

    const fakeClient: any = {
      setExchangeHook(fn: any) {
        exchangeHook = fn;
      },
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async chatStream(params: any) {
        const response = {
          id: 'fake-capture-1',
          choices: [{ index: 0, message: { role: 'assistant', content: 'captured' } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        };

        await exchangeHook?.({
          timestamp: new Date().toISOString(),
          request: {
            model: params.model,
            messages: params.messages,
            tools: params.tools,
            temperature: params.temperature,
            top_p: params.top_p,
            max_tokens: params.max_tokens,
          },
          response,
          metrics: { total_ms: 25, ttft_ms: 7, tg_speed: 42.7 },
        });

        return response;
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { model: 'fake-model' }),
      runtime: { client: fakeClient },
    });

    const outDir = path.join(tmpDir, 'captures');
    const capturePath = path.join(outDir, 'session.jsonl');
    const lastPath = path.join(outDir, 'last.jsonl');

    const enabledPath = await session.captureOn(capturePath);
    assert.equal(enabledPath, capturePath);

    const out = await session.ask('hello capture');
    assert.equal(out.text, 'captured');

    session.captureOff();

    const raw = await fs.readFile(capturePath, 'utf8');
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1);

    const row = JSON.parse(lines[0]);
    assert.equal(row.request.model, 'fake-model');
    assert.equal(row.response.choices[0].message.content, 'captured');
    assert.equal(typeof row.metrics.total_ms, 'number');

    const lastCapturePath = await session.captureLast(lastPath);
    assert.equal(lastCapturePath, lastPath);
    const rawLast = await fs.readFile(lastPath, 'utf8');
    assert.equal(rawLast.trim().split(/\r?\n/).filter(Boolean).length, 1);
  });

  it('captureLast fails before any request/response exists', async () => {
    const fakeClient: any = {
      setExchangeHook() {},
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async chatStream() {
        return {
          id: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { model: 'fake-model' }),
      runtime: { client: fakeClient },
    });

    await assert.rejects(
      () => session.captureLast(path.join(tmpDir, 'captures', 'none.jsonl')),
      /No captured request\/response pair/i
    );
  });
});

describe('system prompt controls', () => {
  it('applies config override and supports set/reset', async () => {
    const fakeClient: any = {
      setExchangeHook() {},
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async chatStream() {
        return {
          id: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, {
        model: 'fake-model',
        system_prompt_override: 'OVERRIDE PROMPT',
      }),
      runtime: { client: fakeClient },
    });

    assert.equal(session.getSystemPrompt(), 'OVERRIDE PROMPT');
    assert.equal(String(session.messages[0]?.content ?? ''), 'OVERRIDE PROMPT');

    session.setSystemPrompt('SESSION PROMPT');
    assert.equal(session.getSystemPrompt(), 'SESSION PROMPT');
    assert.equal(String(session.messages[0]?.content ?? ''), 'SESSION PROMPT');

    session.reset();
    assert.equal(session.getSystemPrompt(), 'SESSION PROMPT');
    assert.equal(String(session.messages[0]?.content ?? ''), 'SESSION PROMPT');

    session.resetSystemPrompt();
    assert.notEqual(session.getSystemPrompt(), 'SESSION PROMPT');
    assert.ok(session.getSystemPrompt().toLowerCase().includes('you are a coding agent'));
  });

  it('rejects empty system prompt values', async () => {
    const fakeClient: any = {
      setExchangeHook() {},
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async chatStream() {
        return {
          id: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { model: 'fake-model' }),
      runtime: { client: fakeClient },
    });

    assert.throws(() => session.setSystemPrompt('   '), /system prompt cannot be empty/i);
  });
});

describe('MCP lazy schema loading', () => {
  it('keeps MCP tool schemas hidden until model requests them', async () => {
    const serverScript = await makeMockMcpServerScript();
    let calls = 0;

    const fakeClient: any = {
      setExchangeHook() {},
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async chatStream(req: any) {
        calls += 1;
        const toolNames = Array.isArray(req?.tools)
          ? req.tools.map((t: any) => String(t?.function?.name ?? ''))
          : [];

        if (calls === 1) {
          assert.equal(
            toolNames.includes('mcp_echo'),
            false,
            'MCP tool should not be exposed on first turn'
          );
          return {
            id: 'fake-1',
            choices: [
              { index: 0, message: { role: 'assistant', content: '[[MCP_TOOLS_REQUEST]]' } },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }

        if (calls === 2) {
          assert.equal(
            toolNames.includes('mcp_echo'),
            true,
            'MCP tool should be exposed after request token'
          );
          return {
            id: 'fake-2',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'mcp_echo',
                        arguments: JSON.stringify({ text: 'hi' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }

        return {
          id: 'fake-3',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, {
        model: 'fake-model',
        max_iterations: 5,
        mcp: {
          servers: [
            {
              name: 'mock',
              transport: 'stdio',
              command: process.execPath,
              args: [serverScript],
            },
          ],
        },
        mcp_tool_budget: 1000,
        mcp_call_timeout_sec: 5,
      }),
      runtime: { client: fakeClient },
    });

    try {
      const out = await session.ask('use external tools if needed');
      assert.equal(out.text, 'done');
      assert.equal(out.toolCalls, 1);
      assert.equal(calls, 3);
    } finally {
      await session.close();
      await fs.rm(path.dirname(serverScript), { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('LSP tool registration', () => {
  it('registers LSP tools when lsp.enabled=true and servers are available', async () => {
    // Use a mock LSP server (the same as the one in lsp.test.ts)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-lsp-agent-'));
    const serverScript = path.join(dir, 'mock-lsp-server.mjs');

    const src = `
let buffer = Buffer.alloc(0);
function findHeaderDelimiter(buf) {
  const a = buf.indexOf(Buffer.from('\\r\\n\\r\\n'));
  if (a >= 0) return { index: a, sepLen: 4 };
  return null;
}
function send(msg) {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  process.stdout.write(Buffer.from('Content-Length: ' + payload.length + '\\r\\n\\r\\n', 'utf8'));
  process.stdout.write(payload);
}
function handle(msg) {
  const id = msg?.id;
  const method = msg?.method;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { capabilities: { documentSymbolProvider: true } } });
    return;
  }
  if (method === 'initialized') return;
  if (method === 'textDocument/documentSymbol') {
    send({ jsonrpc: '2.0', id, result: [{ name: 'hello', kind: 12, location: { uri: msg?.params?.textDocument?.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } } }] });
    return;
  }
  if (method === 'shutdown') { send({ jsonrpc: '2.0', id, result: null }); return; }
  if (method === 'exit') { process.exit(0); }
  if (typeof id === 'number') { send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'not found' } }); }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length > 0) {
    const header = findHeaderDelimiter(buffer);
    if (!header) return;
    const headerText = buffer.subarray(0, header.index).toString('utf8');
    const match = /content-length\\s*:\\s*(\\d+)/i.exec(headerText);
    if (!match) { buffer = buffer.subarray(header.index + header.sepLen); continue; }
    const len = Number(match[1]);
    const start = header.index + header.sepLen;
    if (buffer.length < start + len) return;
    const raw = buffer.subarray(start, start + len).toString('utf8');
    buffer = buffer.subarray(start + len);
    try { handle(JSON.parse(raw)); } catch {}
  }
});
`;
    await fs.writeFile(serverScript, src, 'utf8');

    let toolNames: string[] = [];
    const session = await createSession({
      config: {
        endpoint: 'http://127.0.0.1:1',
        model: 'test',
        dir: tmpDir,
        max_tokens: 200,
        temperature: 0,
        top_p: 1,
        timeout: 5,
        max_iterations: 2,
        approval_mode: 'yolo',
        no_confirm: true,
        verbose: false,
        dry_run: false,
        lsp: {
          enabled: true,
          auto_detect: false,
          servers: [{ language: 'typescript', command: process.execPath, args: [serverScript] }],
        },
      },
      runtime: {
        client: {
          chat: async (_msgs: any[], opts?: any) => {
            toolNames = (opts?.tools ?? []).map((t: any) => t?.function?.name).filter(Boolean);
            return { role: 'assistant', content: 'hello' };
          },
          chatStream: async (opts: any) => {
            toolNames = (opts?.tools ?? []).map((t: any) => t?.function?.name).filter(Boolean);
            return { role: 'assistant', content: 'hello' };
          },
          models: async () => [],
          health: async () => ({ ok: true }),
        },
      },
    });

    try {
      await session.ask('check');
      assert.ok(toolNames.includes('lsp_diagnostics'), 'should register lsp_diagnostics');
      assert.ok(toolNames.includes('lsp_symbols'), 'should register lsp_symbols');
      assert.ok(toolNames.includes('lsp_hover'), 'should register lsp_hover');
      assert.ok(toolNames.includes('lsp_definition'), 'should register lsp_definition');
      assert.ok(toolNames.includes('lsp_references'), 'should register lsp_references');

      // Verify LSP server is listed.
      const servers = session.listLspServers();
      assert.equal(servers.length, 1);
      assert.equal(servers[0].language, 'typescript');
      assert.equal(servers[0].running, true);
    } finally {
      await session.close();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('enriches lsp_symbols output with Lens structural context', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-lsp-lens-agent-'));
    const serverScript = path.join(dir, 'mock-lsp-server.mjs');
    const sourceFile = path.join(tmpDir, 'lsp-lens-test.ts');
    await fs.writeFile(
      sourceFile,
      'function hello(name: string) {\n  return `hi ${name}`;\n}\n',
      'utf8'
    );

    const src = `
let buffer = Buffer.alloc(0);
function findHeaderDelimiter(buf) {
  const a = buf.indexOf(Buffer.from('\\r\\n\\r\\n'));
  if (a >= 0) return { index: a, sepLen: 4 };
  return null;
}
function send(msg) {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  process.stdout.write(Buffer.from('Content-Length: ' + payload.length + '\\r\\n\\r\\n', 'utf8'));
  process.stdout.write(payload);
}
function handle(msg) {
  const id = msg?.id;
  const method = msg?.method;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { capabilities: { documentSymbolProvider: true } } });
    return;
  }
  if (method === 'initialized') return;
  if (method === 'textDocument/documentSymbol') {
    send({ jsonrpc: '2.0', id, result: [{ name: 'hello', kind: 12, location: { uri: msg?.params?.textDocument?.uri, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } } } }] });
    return;
  }
  if (method === 'shutdown') { send({ jsonrpc: '2.0', id, result: null }); return; }
  if (method === 'exit') { process.exit(0); }
  if (typeof id === 'number') { send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'not found' } }); }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length > 0) {
    const header = findHeaderDelimiter(buffer);
    if (!header) return;
    const headerText = buffer.subarray(0, header.index).toString('utf8');
    const match = /content-length\\s*:\\s*(\\d+)/i.exec(headerText);
    if (!match) { buffer = buffer.subarray(header.index + header.sepLen); continue; }
    const len = Number(match[1]);
    const start = header.index + header.sepLen;
    if (buffer.length < start + len) return;
    const raw = buffer.subarray(start, start + len).toString('utf8');
    buffer = buffer.subarray(start + len);
    try { handle(JSON.parse(raw)); } catch {}
  }
});
`;
    await fs.writeFile(serverScript, src, 'utf8');

    let turn = 0;
    const fakeClient: any = {
      async models() {
        return [{ id: 'fake-model' }];
      },
      async chatStream() {
        turn++;
        if (turn === 1) {
          return {
            id: 'fake-lsp-1',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_lsp_symbols',
                      function: {
                        name: 'lsp_symbols',
                        arguments: JSON.stringify({ path: sourceFile }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          };
        }
        return {
          id: `fake-lsp-${turn}`,
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        };
      },
    };

    const fakeLens: any = {
      async projectFile() {
        return '# lens:\n- function hello(name: string)';
      },
      async summarizeToolOutput(text: string) {
        return text;
      },
      async summarizeFailureMessage(text: string) {
        return text;
      },
      close() {},
    };

    const session = await createSession({
      config: baseConfig(tmpDir, {
        max_iterations: 3,
        lsp: {
          enabled: true,
          auto_detect: false,
          servers: [{ language: 'typescript', command: process.execPath, args: [serverScript] }],
        },
      }),
      runtime: { client: fakeClient, lens: fakeLens },
    });

    try {
      await session.ask('show me symbols');
      const toolMsgs = session.messages.filter(
        (m: any) => m.role === 'tool' && m.tool_call_id === 'call_lsp_symbols'
      );
      assert.equal(toolMsgs.length, 1, 'expected a single lsp_symbols tool result');

      const toolContent = String((toolMsgs[0] as any).content ?? '');
      assert.ok(toolContent.includes('hello'), 'semantic lsp symbol should be present');
      assert.ok(
        toolContent.includes('[lens] Structural skeleton:'),
        'lens structural context should be appended'
      );
    } finally {
      await session.close();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(sourceFile, { force: true }).catch(() => {});
    }
  });
});

describe('spawn_task tool registration and dispatch', () => {
  it('registers spawn_task tool by default', async () => {
    let toolNames: string[] = [];
    const fakeClient: any = {
      setExchangeHook() {},
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async chatStream(req: any) {
        toolNames = (req?.tools ?? []).map((t: any) => String(t?.function?.name ?? ''));
        return {
          id: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir),
      runtime: { client: fakeClient },
    });

    try {
      await session.ask('hello');
      assert.ok(toolNames.includes('spawn_task'), 'spawn_task should be registered');
    } finally {
      await session.close();
    }
  });

  it('does not register spawn_task when allowSpawnTask=false', async () => {
    let toolNames: string[] = [];
    const fakeClient: any = {
      setExchangeHook() {},
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async chatStream(req: any) {
        toolNames = (req?.tools ?? []).map((t: any) => String(t?.function?.name ?? ''));
        return {
          id: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir),
      runtime: { client: fakeClient },
      allowSpawnTask: false,
    });

    try {
      await session.ask('hello');
      assert.ok(!toolNames.includes('spawn_task'), 'spawn_task should NOT be registered');
    } finally {
      await session.close();
    }
  });

  it('does not register spawn_task when sub_agents.enabled=false', async () => {
    let toolNames: string[] = [];
    const fakeClient: any = {
      setExchangeHook() {},
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async chatStream(req: any) {
        toolNames = (req?.tools ?? []).map((t: any) => String(t?.function?.name ?? ''));
        return {
          id: 'fake',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, { sub_agents: { enabled: false } }),
      runtime: { client: fakeClient },
    });

    try {
      await session.ask('hello');
      assert.ok(
        !toolNames.includes('spawn_task'),
        'spawn_task should NOT be registered when disabled'
      );
    } finally {
      await session.close();
    }
  });

  it('dispatches spawn_task and returns structured result', async () => {
    // Sub-agent uses the same fake client; we track calls to distinguish parent vs child.
    let calls = 0;
    const fakeClient: any = {
      setExchangeHook() {},
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async chatStream() {
        calls++;
        if (calls === 1) {
          // Parent: emit spawn_task tool call
          return {
            id: `fake-${calls}`,
            choices: [
              {
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
                        arguments: JSON.stringify({ task: 'list files in cwd' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 10 },
          };
        }
        // Sub-agent or parent final: return text
        return {
          id: `fake-${calls}`,
          choices: [{ index: 0, message: { role: 'assistant', content: 'sub done' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, {
        max_iterations: 5,
        timeout: 30,
        sub_agents: { enabled: true, max_iterations: 2, timeout_sec: 15 },
      }),
      runtime: { client: fakeClient },
    });

    try {
      await session.ask('delegate something');

      // The parent should have completed (sub-agent ran internally).
      assert.ok(
        calls >= 3,
        `expected at least 3 LLM calls (parent + sub-agent + parent final), got ${calls}`
      );

      // The tool result injected into messages should have sub-agent structured output.
      const toolMsgs = session.messages.filter(
        (m: any) => m.role === 'tool' && m.tool_call_id === 'call_spawn'
      );
      assert.equal(toolMsgs.length, 1, 'should have exactly one spawn_task tool result');
      const toolContent = String((toolMsgs[0] as any).content ?? '');
      assert.ok(
        toolContent.includes('[sub-agent]'),
        'tool result should contain [sub-agent] prefix'
      );
      assert.ok(
        toolContent.includes('status=completed') || toolContent.includes('status=failed'),
        'tool result should contain status'
      );
    } finally {
      await session.close();
    }
  });

  it('caps sub-agent result text to configured token limit', async () => {
    let calls = 0;
    const longText = 'word '.repeat(5000); // ~5000 "tokens"

    const fakeClient: any = {
      setExchangeHook() {},
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async chatStream() {
        calls++;
        if (calls === 1) {
          return {
            id: 'fake-1',
            choices: [
              {
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
                        arguments: JSON.stringify({ task: 'generate a long response' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 10 },
          };
        }
        if (calls === 2) {
          // Sub-agent returns very long text
          return {
            id: 'fake-2',
            choices: [{ index: 0, message: { role: 'assistant', content: longText } }],
            usage: { prompt_tokens: 10, completion_tokens: 5000 },
          };
        }
        return {
          id: `fake-${calls}`,
          choices: [{ index: 0, message: { role: 'assistant', content: 'parent done' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, {
        max_iterations: 5,
        timeout: 30,
        sub_agents: { enabled: true, max_iterations: 2, timeout_sec: 15, result_token_cap: 500 },
      }),
      runtime: { client: fakeClient },
    });

    try {
      await session.ask('delegate long task');

      const toolMsgs = session.messages.filter(
        (m: any) => m.role === 'tool' && m.tool_call_id === 'call_spawn'
      );
      assert.equal(toolMsgs.length, 1);
      const toolContent = String((toolMsgs[0] as any).content ?? '');
      // The result should mention truncation
      assert.ok(
        toolContent.includes('truncated') || toolContent.includes('capped'),
        'long result should be truncated'
      );
      // The raw long text should NOT be fully present
      assert.ok(
        toolContent.length < longText.length,
        'tool content should be shorter than raw long text'
      );
    } finally {
      await session.close();
    }
  });

  it('inherits approval_mode from parent when not overridden', async () => {
    let calls = 0;

    const fakeClient: any = {
      setExchangeHook() {},
      async models() {
        return { data: [{ id: 'fake-model' }] };
      },
      async chatStream() {
        calls++;
        if (calls === 1) {
          return {
            id: 'fake-1',
            choices: [
              {
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
                        arguments: JSON.stringify({ task: 'do something' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 10 },
          };
        }
        return {
          id: `fake-${calls}`,
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      },
    };

    const session = await createSession({
      config: baseConfig(tmpDir, {
        max_iterations: 5,
        timeout: 30,
        approval_mode: 'yolo',
        sub_agents: { enabled: true, max_iterations: 2, timeout_sec: 15 },
      }),
      runtime: { client: fakeClient },
    });

    try {
      await session.ask('delegate');

      // The tool result should show the inherited approval_mode
      const toolMsgs = session.messages.filter(
        (m: any) => m.role === 'tool' && m.tool_call_id === 'call_spawn'
      );
      const toolContent = String((toolMsgs[0] as any).content ?? '');
      assert.ok(
        toolContent.includes('approval_mode: yolo'),
        'sub-agent should inherit parent approval_mode'
      );
    } finally {
      await session.close();
    }
  });
});

// ── parseToolCallsFromContent — XML tool call recovery ────────────────────

describe('parseToolCallsFromContent — XML tool calls', () => {
  it('parses a single XML tool call (write_file)', () => {
    const content = `I will write the file now.

<tool_call>
<function=write_file>
<parameter=path>
/home/user/project/src/service.ts
</parameter>
<parameter=content>
import { spawnSync } from 'node:child_process';

export function restart(): void {
  spawnSync('systemctl', ['--user', 'restart', 'my.service']);
}
</parameter>
</function>
</tool_call>`;

    const result = parseToolCallsFromContent(content);
    assert.ok(result, 'should parse XML tool call');
    assert.equal(result!.length, 1);
    assert.equal(result![0].function.name, 'write_file');
    const args = JSON.parse(result![0].function.arguments);
    assert.equal(args.path, '/home/user/project/src/service.ts');
    assert.ok(args.content.includes('import { spawnSync }'), 'content should contain file text');
    assert.ok(
      args.content.includes('export function restart()'),
      'content should contain function'
    );
  });

  it('parses edit_file with old_text and new_text', () => {
    const content = `<tool_call>
<function=edit_file>
<parameter=path>
src/cli/service.ts
</parameter>
<parameter=old_text>
console.log('starting...');
</parameter>
<parameter=new_text>
console.log('Starting service...');
await healthCheck();
</parameter>
</function>
</tool_call>`;

    const result = parseToolCallsFromContent(content);
    assert.ok(result);
    assert.equal(result!.length, 1);
    assert.equal(result![0].function.name, 'edit_file');
    const args = JSON.parse(result![0].function.arguments);
    assert.equal(args.path, 'src/cli/service.ts');
    assert.ok(args.old_text.includes("console.log('starting...')"));
    assert.ok(args.new_text.includes('healthCheck()'));
  });

  it('parses multiple parallel XML tool calls', () => {
    const content = `<tool_call>
<function=read_file>
<parameter=path>
src/a.ts
</parameter>
</function>
</tool_call>

<tool_call>
<function=read_file>
<parameter=path>
src/b.ts
</parameter>
</function>
</tool_call>`;

    const result = parseToolCallsFromContent(content);
    assert.ok(result);
    assert.equal(result!.length, 2);
    assert.equal(JSON.parse(result![0].function.arguments).path, 'src/a.ts');
    assert.equal(JSON.parse(result![1].function.arguments).path, 'src/b.ts');
  });

  it('handles content with angle brackets in code (TypeScript generics)', () => {
    const content = `<tool_call>
<function=write_file>
<parameter=path>
src/utils.ts
</parameter>
<parameter=content>
function identity<T>(val: T): T {
  return val;
}
const items: Array<string> = [];
if (x < 10 && y > 5) { doStuff(); }
</parameter>
</function>
</tool_call>`;

    const result = parseToolCallsFromContent(content);
    assert.ok(result);
    const args = JSON.parse(result![0].function.arguments);
    assert.ok(args.content.includes('identity<T>'), 'should preserve generics');
    assert.ok(args.content.includes('Array<string>'), 'should preserve generic Array');
    assert.ok(args.content.includes('x < 10 && y > 5'), 'should preserve comparisons');
  });

  it('returns null when no XML tool call markers present', () => {
    const result = parseToolCallsFromContent('Just some regular text response.');
    assert.equal(result, null);
  });

  it('returns null for truncated/incomplete XML tool call', () => {
    const content = `<tool_call>
<function=write_file>
<parameter=path>
src/broken.ts`;
    // No closing tags — parser can't recover partial calls
    const result = parseToolCallsFromContent(content);
    assert.equal(result, null);
  });

  it('preserves existing JSON parsing (Case 1-3 still work)', () => {
    // Case 1: whole content is JSON
    const json1 = JSON.stringify({
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'exec', arguments: '{"command":"ls"}' } },
      ],
    });
    const r1 = parseToolCallsFromContent(json1);
    assert.ok(r1);
    assert.equal(r1![0].function.name, 'exec');

    // Case 3: JSON object in content
    const json3 = `Here is the call: {"name": "read_file", "arguments": {"path": "/tmp/x.ts"}}`;
    const r3 = parseToolCallsFromContent(json3);
    assert.ok(r3);
    assert.equal(r3![0].function.name, 'read_file');
  });

  it('handles parameter values containing literal </parameter> text', () => {
    const content = `<tool_call>
<function=write_file>
<parameter=path>
src/parser.xml
</parameter>
<parameter=content>
<root>
  <parameter=name>value</parameter>
  <item>test</item>
</root>
</parameter>
</function>
</tool_call>`;

    const result = parseToolCallsFromContent(content);
    assert.ok(result, 'should parse despite </parameter> in content');
    assert.equal(result!.length, 1);
    const args = JSON.parse(result![0].function.arguments);
    assert.equal(args.path, 'src/parser.xml');
    assert.ok(
      args.content.includes('<parameter=name>value</parameter>'),
      'should preserve XML-like content'
    );
    assert.ok(args.content.includes('<item>test</item>'), 'should preserve full content');
  });

  it('parses exec tool call in XML format', () => {
    const content = `<tool_call>
<function=exec>
<parameter=command>
npm test -- --grep "service"
</parameter>
</function>
</tool_call>`;

    const result = parseToolCallsFromContent(content);
    assert.ok(result);
    assert.equal(result![0].function.name, 'exec');
    const args = JSON.parse(result![0].function.arguments);
    assert.equal(args.command, 'npm test -- --grep "service"');
  });
});
