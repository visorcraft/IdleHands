import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverMcpServers, formatDiscoveredServers } from '../dist/mcp-discovery.js';

describe('MCP discovery', () => {
  it('returns empty array when no config files exist', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-'));
    try {
      const servers = await discoverMcpServers(tmp);
      assert.deepEqual(servers, []);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('discovers servers from .mcp.json', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-'));
    try {
      await fs.writeFile(path.join(tmp, '.mcp.json'), JSON.stringify({
        servers: {
          'echo-server': { command: 'echo-server', args: ['--port', '8080'] },
        }
      }));
      const servers = await discoverMcpServers(tmp);
      assert.equal(servers.length, 1);
      assert.equal(servers[0].name, 'echo-server');
      assert.equal(servers[0].transport, 'stdio');
      assert.equal(servers[0].command, 'echo-server');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('discovers SSE servers with url', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-'));
    try {
      await fs.writeFile(path.join(tmp, '.mcp.json'), JSON.stringify({
        servers: {
          'remote': { transport: 'sse', url: 'http://localhost:9090/sse' },
        }
      }));
      const servers = await discoverMcpServers(tmp);
      assert.equal(servers.length, 1);
      assert.equal(servers[0].name, 'remote');
      assert.equal(servers[0].url, 'http://localhost:9090/sse');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('formats empty servers list', () => {
    const lines = formatDiscoveredServers([]);
    assert.ok(lines[0].includes('No MCP'));
  });

  it('formats discovered servers', () => {
    const lines = formatDiscoveredServers([
      { name: 'echo', transport: 'stdio', command: 'echo', args: [], source: '.mcp.json' }
    ]);
    assert.ok(lines[0].includes('echo'));
    assert.ok(lines[0].includes('stdio'));
  });
});
