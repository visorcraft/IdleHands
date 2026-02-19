import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import { createSession } from '../dist/agent.js';

type ReqBody = {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role: string; content?: string; tool_calls?: any[]; tool_call_id?: string }>;
};

function mkSse(chunks: any[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

describe('end-to-end (mock server)', () => {
  it('runs agent session against mock OpenAI server, executes tool, and returns final answer', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-e2e-'));
    await fs.writeFile(path.join(tmpDir, 'hello.txt'), 'hi', 'utf8');

    const requests: ReqBody[] = [];
    let chatCalls = 0;

    const server = http.createServer(async (req, res) => {
      const url = req.url || '';

      if (req.method === 'GET' && url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (req.method === 'GET' && url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
        return;
      }

      if (req.method === 'POST' && url === '/v1/chat/completions') {
        const raw = await new Promise<string>((resolve) => {
          let b = '';
          req.setEncoding('utf8');
          req.on('data', (d) => (b += d));
          req.on('end', () => resolve(b));
        });
        const body = JSON.parse(raw) as ReqBody;
        requests.push(body);
        chatCalls += 1;

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        });

        if (chatCalls === 1) {
          // Turn 1: ask agent to call list_dir
          const sse = mkSse([
            {
              id: 'mock-1',
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_1',
                        type: 'function',
                        function: {
                          name: 'list_dir',
                          arguments: JSON.stringify({ path: '.' })
                        }
                      }
                    ]
                  },
                  finish_reason: 'tool_calls'
                }
              ]
            }
          ]);
          res.end(sse);
          return;
        }

        // Turn 2: final answer
        const sse = mkSse([
          {
            id: 'mock-2',
            choices: [
              {
                index: 0,
                delta: { content: 'done' },
                finish_reason: 'stop'
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2 }
          }
        ]);
        res.end(sse);
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const config: any = {
      endpoint: `http://127.0.0.1:${port}/v1`,
      model: 'mock-model',
      dir: tmpDir,
      max_tokens: 128,
      temperature: 0.2,
      top_p: 0.95,
      timeout: 30,
      max_iterations: 5,
      approval_mode: 'auto-edit',
      no_confirm: true,
      verbose: false,
      dry_run: false,
      context_window: 8192,
      cache_prompt: true,
      i_know_what_im_doing: true,
      harness: '',
      context_file: '',
      context_file_names: ['.idlehands.md', 'AGENTS.md', '.github/AGENTS.md'],
      context_max_tokens: 8192,
      no_context: true,
      trifecta: {
        enabled: false,
        vault: { enabled: false, mode: 'off' },
        lens: { enabled: false },
        replay: { enabled: false }
      }
    };

    try {
      const session = await createSession({ config });
      const out = await session.ask('list files');

      assert.equal(out.text, 'done');
      assert.equal(out.toolCalls, 1);
      assert.equal(chatCalls, 2);

      // Verify tool execution feedback loop: second request should include a tool message
      assert.ok(requests.length >= 2);
      const secondReq = requests[1];
      const hasToolMsg = (secondReq.messages ?? []).some((m) => m.role === 'tool');
      assert.equal(hasToolMsg, true, 'expected tool result message in second request');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
