import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MCPManager } from '../dist/mcp.js';

type MockTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

type MockServerOptions = {
  tools?: MockTool[];
  crashOnCallName?: string;
  malformedOnCallName?: string;
  delayOnCallName?: string;
  delayMs?: number;
  jsonRpcErrorOnCallName?: string;
  jsonRpcErrorCode?: number;
  jsonRpcErrorMessage?: string;
  toolResultErrorOnCallName?: string;
};

async function makeMockMcpServerScript(options: MockServerOptions = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-mcp-'));
  const file = path.join(dir, 'mock-mcp-server.mjs');
  const config = {
    tools: options.tools ?? [
      {
        name: 'mcp_echo',
        description: 'Echo text',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
      {
        name: 'mcp_readonly',
        description: 'Read-only sample',
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { key: { type: 'string' } },
          required: ['key'],
        },
      },
    ],
    crashOnCallName: options.crashOnCallName ?? null,
    malformedOnCallName: options.malformedOnCallName ?? null,
    delayOnCallName: options.delayOnCallName ?? null,
    delayMs: options.delayMs ?? 0,
    jsonRpcErrorOnCallName: options.jsonRpcErrorOnCallName ?? null,
    jsonRpcErrorCode: options.jsonRpcErrorCode ?? -32001,
    jsonRpcErrorMessage: options.jsonRpcErrorMessage ?? 'server error',
    toolResultErrorOnCallName: options.toolResultErrorOnCallName ?? null,
  };

  const src = `
const CONFIG = ${JSON.stringify(config)};
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

function delayedSend(obj) {
  if (CONFIG.delayMs > 0) {
    setTimeout(() => send(obj), CONFIG.delayMs);
  } else {
    send(obj);
  }
}

function handle(msg) {
  const id = msg?.id;
  if (msg?.method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: {} } });
    return;
  }

  if (msg?.method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: CONFIG.tools } });
    return;
  }

  if (msg?.method === 'tools/call') {
    const name = String(msg?.params?.name ?? '');
    const args = msg?.params?.arguments ?? {};

    if (name && CONFIG.crashOnCallName === name) {
      process.exit(1);
    }

    if (name && CONFIG.malformedOnCallName === name) {
      process.stdout.write('this is not json-rpc\\n');
      return;
    }

    if (name && CONFIG.jsonRpcErrorOnCallName === name) {
      send({ jsonrpc: '2.0', id, error: { code: CONFIG.jsonRpcErrorCode, message: CONFIG.jsonRpcErrorMessage } });
      return;
    }

    if (name && CONFIG.toolResultErrorOnCallName === name) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: 'tool failed: ' + name }],
        },
      });
      return;
    }

    const known = CONFIG.tools.some((t) => t?.name === name);
    if (!known) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool' } });
      return;
    }

    if (name === CONFIG.delayOnCallName) {
      delayedSend({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: 'delayed:' + String(args?.text ?? '') }],
        },
      });
      return;
    }

    if (name === 'mcp_echo') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'echo:' + String(args?.text ?? '') }] },
      });
      return;
    }

    if (name === 'mcp_readonly') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'value:' + String(args?.key ?? '') }] },
      });
      return;
    }

    if (name === 'mcp_pid') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'pid:' + process.pid }] },
      });
      return;
    }

    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: 'ok:' + name }] },
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

    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }

    handle(msg);
  }
});
`;

  await fs.writeFile(file, src, 'utf8');
  return file;
}

describe('MCPManager', () => {
  it('connects stdio server, discovers tools, and executes tool calls', async () => {
    const serverScript = await makeMockMcpServerScript();

    const manager = new MCPManager({
      servers: [
        { name: 'mock', transport: 'stdio', command: process.execPath, args: [serverScript] },
      ],
      toolBudgetTokens: 1000,
      callTimeoutMs: 5000,
      builtInToolNames: ['read_file', 'exec'],
    });

    try {
      await manager.init();

      const servers = manager.listServers();
      assert.equal(servers.length, 1);
      assert.equal(servers[0].connected, true);
      assert.equal(servers[0].toolsTotal, 2);
      assert.equal(servers[0].toolsEnabled, 2);

      const schemas = manager.getEnabledToolSchemas();
      assert.equal(schemas.length, 2);
      assert.ok(schemas.some((s) => s.function.name === 'mcp_echo'));

      const callOut = await manager.callTool('mcp_echo', { text: 'hello' });
      assert.equal(callOut, 'echo:hello');
      assert.equal(manager.isToolReadOnly('mcp_readonly'), true);
    } finally {
      await manager.close();
      await fs.rm(path.dirname(serverScript), { recursive: true, force: true });
    }
  });

  it('applies MCP tool schema budget and allows runtime enable/disable', async () => {
    const serverScript = await makeMockMcpServerScript();

    const manager = new MCPManager({
      servers: [
        {
          name: 'mock-budget',
          transport: 'stdio',
          command: process.execPath,
          args: [serverScript],
        },
      ],
      toolBudgetTokens: 1,
      callTimeoutMs: 5000,
    });

    try {
      await manager.init();

      const allTools = manager.listTools({ includeDisabled: true });
      assert.equal(allTools.length, 2);
      assert.equal(manager.listTools().length, 0);
      assert.match(manager.getWarnings().join('\n'), /budget exceeded/i);
      assert.equal(manager.enableTool('mcp_echo'), false);
    } finally {
      await manager.close();
      await fs.rm(path.dirname(serverScript), { recursive: true, force: true });
    }
  });

  it('skips HTTP MCP servers when offline mode is enabled', async () => {
    const manager = new MCPManager({
      servers: [{ name: 'http-server', transport: 'http', url: 'http://127.0.0.1:65535/mcp' }],
      offline: true,
    });

    try {
      await manager.init();
      const servers = manager.listServers();
      assert.equal(servers.length, 1);
      assert.equal(servers[0].connected, false);
      assert.match(String(servers[0].error ?? ''), /offline/i);
    } finally {
      await manager.close();
    }
  });

  it('handles server crash, malformed responses, timeout, and JSON-RPC errors during call', async () => {
    const crashScript = await makeMockMcpServerScript({ crashOnCallName: 'mcp_echo' });
    const malformedScript = await makeMockMcpServerScript({ malformedOnCallName: 'mcp_echo' });
    const timeoutScript = await makeMockMcpServerScript({
      delayOnCallName: 'mcp_echo',
      delayMs: 2000,
    });
    const errorScript = await makeMockMcpServerScript({
      jsonRpcErrorOnCallName: 'mcp_echo',
      jsonRpcErrorCode: -32050,
      jsonRpcErrorMessage: 'upstream unavailable',
    });

    const managers = [
      new MCPManager({
        servers: [
          { name: 'crash', transport: 'stdio', command: process.execPath, args: [crashScript] },
        ],
        callTimeoutMs: 300,
        toolBudgetTokens: 1000,
      }),
      new MCPManager({
        servers: [
          {
            name: 'malformed',
            transport: 'stdio',
            command: process.execPath,
            args: [malformedScript],
          },
        ],
        callTimeoutMs: 200,
        toolBudgetTokens: 1000,
      }),
      new MCPManager({
        servers: [
          { name: 'timeout', transport: 'stdio', command: process.execPath, args: [timeoutScript] },
        ],
        callTimeoutMs: 300,
        toolBudgetTokens: 1000,
      }),
      new MCPManager({
        servers: [
          { name: 'rpc-error', transport: 'stdio', command: process.execPath, args: [errorScript] },
        ],
        callTimeoutMs: 300,
        toolBudgetTokens: 1000,
      }),
    ];

    try {
      for (const manager of managers) await manager.init();

      await assert.rejects(managers[0].callTool('mcp_echo', { text: 'x' }), /transport closed/i);
      await assert.rejects(
        managers[1].callTool('mcp_echo', { text: 'x' }),
        /(timed out|transport closed)/i
      );
      await assert.rejects(managers[2].callTool('mcp_echo', { text: 'x' }), /timed out/i);
      await assert.rejects(
        managers[3].callTool('mcp_echo', { text: 'x' }),
        /upstream unavailable/i
      );
    } finally {
      for (const manager of managers) await manager.close();
      await Promise.all(
        [crashScript, malformedScript, timeoutScript, errorScript].map((s) =>
          fs.rm(path.dirname(s), { recursive: true, force: true })
        )
      );
    }
  });

  it('handles tool result error payloads', async () => {
    const serverScript = await makeMockMcpServerScript({ toolResultErrorOnCallName: 'mcp_echo' });
    const manager = new MCPManager({
      servers: [
        {
          name: 'result-error',
          transport: 'stdio',
          command: process.execPath,
          args: [serverScript],
        },
      ],
      callTimeoutMs: 300,
      toolBudgetTokens: 1000,
    });

    try {
      await manager.init();
      await assert.rejects(
        manager.callTool('mcp_echo', { text: 'nope' }),
        /tool failed: mcp_echo/i
      );
    } finally {
      await manager.close();
      await fs.rm(path.dirname(serverScript), { recursive: true, force: true });
    }
  });

  it('handles discovery edge cases: zero tools, duplicates, and oversized schema budget', async () => {
    const zeroScript = await makeMockMcpServerScript({ tools: [] });
    const dupScript = await makeMockMcpServerScript({
      tools: [
        {
          name: 'dup_tool',
          description: 'first',
          inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
        },
        {
          name: 'dup_tool',
          description: 'second',
          inputSchema: { type: 'object', properties: { b: { type: 'string' } } },
        },
      ],
    });
    const hugeScript = await makeMockMcpServerScript({
      tools: [
        {
          name: 'huge_schema_tool',
          description: 'huge',
          inputSchema: {
            type: 'object',
            properties: Object.fromEntries(
              Array.from({ length: 300 }, (_, i) => [
                `field_${i}`,
                { type: 'string', description: 'x'.repeat(40) },
              ])
            ),
            required: [],
          },
        },
      ],
    });

    const zeroManager = new MCPManager({
      servers: [
        { name: 'zero', transport: 'stdio', command: process.execPath, args: [zeroScript] },
      ],
      toolBudgetTokens: 1000,
    });
    const dupManager = new MCPManager({
      servers: [{ name: 'dup', transport: 'stdio', command: process.execPath, args: [dupScript] }],
      toolBudgetTokens: 1000,
    });
    const hugeManager = new MCPManager({
      servers: [
        { name: 'huge', transport: 'stdio', command: process.execPath, args: [hugeScript] },
      ],
      toolBudgetTokens: 25,
    });

    try {
      await zeroManager.init();
      assert.equal(zeroManager.listServers()[0].toolsTotal, 0);
      assert.equal(zeroManager.getEnabledToolSchemas().length, 0);

      await dupManager.init();
      assert.equal(dupManager.listTools({ includeDisabled: true }).length, 1);
      assert.match(dupManager.getWarnings().join('\n'), /duplicate mcp tool name/i);

      await hugeManager.init();
      const hugeTool = hugeManager.listTools({ includeDisabled: true })[0];
      assert.equal(hugeTool.name, 'huge_schema_tool');
      assert.equal(hugeTool.enabled, false);
      assert.match(hugeManager.getWarnings().join('\n'), /budget exceeded/i);
    } finally {
      await Promise.all([zeroManager.close(), dupManager.close(), hugeManager.close()]);
      await Promise.all(
        [zeroScript, dupScript, hugeScript].map((s) =>
          fs.rm(path.dirname(s), { recursive: true, force: true })
        )
      );
    }
  });

  it('supports disable/re-enable lifecycle and excludes disabled tools from schema', async () => {
    const serverScript = await makeMockMcpServerScript();
    const manager = new MCPManager({
      servers: [
        { name: 'lifecycle', transport: 'stdio', command: process.execPath, args: [serverScript] },
      ],
      toolBudgetTokens: 1000,
      callTimeoutMs: 500,
    });

    try {
      await manager.init();
      assert.equal(manager.disableTool('mcp_echo'), true);
      assert.equal(
        manager.getEnabledToolSchemas().some((s) => s.function.name === 'mcp_echo'),
        false
      );
      await assert.rejects(manager.callTool('mcp_echo', { text: 'off' }), /disabled/i);

      assert.equal(manager.enableTool('mcp_echo'), true);
      assert.equal(
        manager.getEnabledToolSchemas().some((s) => s.function.name === 'mcp_echo'),
        true
      );
      assert.equal(await manager.callTool('mcp_echo', { text: 'on' }), 'echo:on');
    } finally {
      await manager.close();
      await fs.rm(path.dirname(serverScript), { recursive: true, force: true });
    }
  });

  it('restarts server and re-discovers tools', async () => {
    const serverScript = await makeMockMcpServerScript({
      tools: [
        {
          name: 'mcp_pid',
          description: 'returns pid',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
            required: [],
          },
        },
      ],
    });

    const manager = new MCPManager({
      servers: [
        {
          name: 'restartable',
          transport: 'stdio',
          command: process.execPath,
          args: [serverScript],
        },
      ],
      toolBudgetTokens: 1000,
      callTimeoutMs: 500,
    });

    try {
      await manager.init();
      const before = await manager.callTool('mcp_pid', {});
      assert.match(before, /^pid:\d+$/);

      const restarted = await manager.restartServer('restartable');
      assert.equal(restarted.ok, true);
      assert.ok(manager.hasTool('mcp_pid'));

      const after = await manager.callTool('mcp_pid', {});
      assert.match(after, /^pid:\d+$/);
      assert.notEqual(after, before);
    } finally {
      await manager.close();
      await fs.rm(path.dirname(serverScript), { recursive: true, force: true });
    }
  });

  it('supports multiple servers and isolates failures to the crashed server', async () => {
    const healthyScript = await makeMockMcpServerScript({
      tools: [
        {
          name: 'healthy_tool',
          description: 'healthy',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
      ],
    });
    const flakyScript = await makeMockMcpServerScript({
      tools: [
        {
          name: 'flaky_tool',
          description: 'flaky',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
      ],
      crashOnCallName: 'flaky_tool',
    });

    const manager = new MCPManager({
      servers: [
        { name: 'healthy', transport: 'stdio', command: process.execPath, args: [healthyScript] },
        { name: 'flaky', transport: 'stdio', command: process.execPath, args: [flakyScript] },
      ],
      toolBudgetTokens: 1000,
      callTimeoutMs: 500,
    });

    try {
      await manager.init();
      const names = manager.listTools().map((t) => t.name);
      assert.deepEqual(names, ['healthy_tool', 'flaky_tool']);

      assert.equal(await manager.callTool('healthy_tool', { text: 'a' }), 'ok:healthy_tool');
      await assert.rejects(manager.callTool('flaky_tool', { text: 'b' }), /transport closed/i);
      assert.equal(await manager.callTool('healthy_tool', { text: 'c' }), 'ok:healthy_tool');
    } finally {
      await manager.close();
      await Promise.all(
        [healthyScript, flakyScript].map((s) =>
          fs.rm(path.dirname(s), { recursive: true, force: true })
        )
      );
    }
  });
});
