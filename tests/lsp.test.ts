import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LspClient, LspManager, detectInstalledLspServers } from '../dist/lsp.js';

async function makeMockLspServerScript(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-lsp-'));
  const file = path.join(dir, 'mock-lsp-server.mjs');

  const src = `
let buffer = Buffer.alloc(0);
let seenNotifications = [];
let lastInitializeParams = null;

function findHeaderDelimiter(buf) {
  const a = buf.indexOf(Buffer.from('\\r\\n\\r\\n'));
  if (a >= 0) return { index: a, sepLen: 4 };
  const b = buf.indexOf(Buffer.from('\\n\\n'));
  if (b >= 0) return { index: b, sepLen: 2 };
  return null;
}

function sendRaw(raw) {
  process.stdout.write(raw);
}

function send(msg) {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.from('Content-Length: ' + payload.length + '\\r\\n\\r\\n', 'utf8');
  process.stdout.write(Buffer.concat([header, payload]));
}

function sendMalformedInitialize(id, kind) {
  if (kind === 'invalid-json') {
    const payload = Buffer.from('{"jsonrpc":"2.0","id":' + id + ',"result":', 'utf8');
    const header = Buffer.from('Content-Length: ' + payload.length + '\\r\\n\\r\\n', 'utf8');
    sendRaw(Buffer.concat([header, payload]));
    return;
  }

  if (kind === 'bad-header') {
    sendRaw(Buffer.from('Content-Length: nope\\r\\n\\r\\n{}', 'utf8'));
    return;
  }

  if (kind === 'truncated') {
    const payload = Buffer.from('{"jsonrpc":"2.0","id":' + id + ',"result":{"capabilities":{}}}', 'utf8');
    const header = Buffer.from('Content-Length: ' + (payload.length + 25) + '\\r\\n\\r\\n', 'utf8');
    sendRaw(Buffer.concat([header, payload.subarray(0, Math.max(1, payload.length - 10))]));
    return;
  }
}

function handle(msg) {
  const mode = process.env.MOCK_MODE || 'normal';
  const id = msg?.id;
  const method = msg?.method;

  if (method === 'initialize') {
    lastInitializeParams = msg?.params ?? null;

    if (mode === 'never-respond-init') {
      return;
    }

    if (mode === 'malformed') {
      sendMalformedInitialize(id, process.env.MALFORMED_KIND || 'invalid-json');
      return;
    }

    send({
      jsonrpc: '2.0',
      id,
      result: {
        capabilities: {
          hoverProvider: true,
          documentSymbolProvider: true,
          textDocumentSync: 1
        }
      }
    });
    return;
  }

  if (method === 'initialized') {
    return;
  }

  if (method === 'textDocument/documentSymbol') {
    if (mode === 'crash-on-symbol') {
      process.exit(42);
      return;
    }

    send({
      jsonrpc: '2.0',
      id,
      result: [
        {
          name: 'main',
          kind: 12,
          location: {
            uri: msg?.params?.textDocument?.uri,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 10 }
            }
          }
        }
      ]
    });
    return;
  }

  if (method === 'textDocument/didOpen') {
    seenNotifications.push({ method, params: msg?.params ?? null });
    const uri = msg?.params?.textDocument?.uri;

    if (mode === 'diag-severity') {
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          diagnostics: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'severity 1' },
            { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, severity: 2, message: 'severity 2' },
            { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }, severity: 3, message: 'severity 3' },
            { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } }, severity: 4, message: 'severity 4' }
          ]
        }
      });
      return;
    }

    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 4 }
            },
            severity: 1,
            message: 'mock diagnostic'
          }
        ]
      }
    });
    return;
  }

  if (method === 'textDocument/didChange') {
    seenNotifications.push({ method, params: msg?.params ?? null });
    return;
  }

  if (method === 'test/getSeenNotifications') {
    send({ jsonrpc: '2.0', id, result: seenNotifications });
    return;
  }

  if (method === 'test/getInitializeParams') {
    send({ jsonrpc: '2.0', id, result: lastInitializeParams });
    return;
  }

  if (method === 'shutdown') {
    send({ jsonrpc: '2.0', id, result: null });
    return;
  }

  if (method === 'exit') {
    process.exit(0);
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

    const raw = buffer.subarray(start, start + len).toString('utf8');
    buffer = buffer.subarray(start + len);

    try {
      handle(JSON.parse(raw));
    } catch {
      // ignore malformed payloads in tests
    }
  }
});
`;

  await fs.writeFile(file, src, 'utf8');
  return file;
}

async function cleanup(paths: string[]) {
  await Promise.all(paths.map((p) => fs.rm(p, { recursive: true, force: true }).catch(() => {})));
}

describe('LspClient', () => {
  it('starts via stdio, initializes, and handles requests', async () => {
    const serverScript = await makeMockLspServerScript();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-lsp-root-'));

    const client = new LspClient({
      command: process.execPath,
      args: [serverScript],
      cwd: root,
      rootPath: root,
      requestTimeoutMs: 5000,
    });

    try {
      await client.start();
      assert.equal(client.isRunning(), true);

      const caps = client.getCapabilities();
      assert.equal(Boolean(caps.hoverProvider), true);
      assert.equal(Boolean(caps.documentSymbolProvider), true);

      const uri = LspClient.filePathToUri(path.join(root, 'main.ts'));
      const symbols = await client.request('textDocument/documentSymbol', {
        textDocument: { uri },
      });

      assert.ok(Array.isArray(symbols));
      assert.equal(symbols.length, 1);
      assert.equal(symbols[0].name, 'main');
    } finally {
      await client.stop();
      await cleanup([path.dirname(serverScript), root]);
    }
  });

  it('tracks diagnostics published by the server', async () => {
    const serverScript = await makeMockLspServerScript();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-lsp-root-'));
    const filePath = path.join(root, 'a.ts');
    await fs.writeFile(filePath, 'const x = 1;\n', 'utf8');

    const client = new LspClient({
      command: process.execPath,
      args: [serverScript],
      cwd: root,
      rootPath: root,
      requestTimeoutMs: 5000,
    });

    const diagPromise = new Promise<void>((resolve) => {
      client.onDiagnostics = () => resolve();
    });

    try {
      await client.start();
      await client.didOpen(filePath, await fs.readFile(filePath, 'utf8'), 'typescript', 1);
      await diagPromise;

      const diagnostics = client.getDiagnostics(filePath);
      assert.equal(diagnostics.length, 1);
      assert.match(String(diagnostics[0].message), /mock diagnostic/i);
    } finally {
      await client.stop();
      await cleanup([path.dirname(serverScript), root]);
    }
  });

  it('handles server crash during request without uncaught exceptions', async () => {
    const serverScript = await makeMockLspServerScript();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-lsp-root-'));

    const client = new LspClient({
      command: process.execPath,
      args: [serverScript],
      cwd: root,
      rootPath: root,
      env: { MOCK_MODE: 'crash-on-symbol' },
      requestTimeoutMs: 1000,
    });

    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.once('uncaughtException', onUncaught);

    try {
      await client.start();
      await assert.rejects(
        () => client.request('textDocument/documentSymbol', { textDocument: { uri: LspClient.filePathToUri(path.join(root, 'x.ts')) } }),
        /process closed|request timed out|client is not running/i
      );

      await assert.rejects(
        () => client.request('textDocument/documentSymbol', { textDocument: { uri: LspClient.filePathToUri(path.join(root, 'y.ts')) } }),
        /not running|closed|process/i
      );

      await new Promise((r) => setTimeout(r, 30));
      assert.equal(uncaught.length, 0);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      await client.stop();
      await cleanup([path.dirname(serverScript), root]);
    }
  });

  it('times out cleanly for malformed initialize responses', async () => {
    const kinds = ['invalid-json', 'bad-header', 'truncated'];

    for (const kind of kinds) {
      const serverScript = await makeMockLspServerScript();
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-lsp-root-'));

      const client = new LspClient({
        command: process.execPath,
        args: [serverScript],
        cwd: root,
        rootPath: root,
        env: { MOCK_MODE: 'malformed', MALFORMED_KIND: kind },
        requestTimeoutMs: 250,
      });

      try {
        await assert.rejects(() => client.start(), /timed out \(initialize, 250ms\)/i);
        assert.equal(client.isRunning(), true);
      } finally {
        await client.stop();
        await cleanup([path.dirname(serverScript), root]);
      }
    }
  });

  it('sends initialize metadata for distinct roots (multi-root scenario)', async () => {
    const serverScript = await makeMockLspServerScript();
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-lsp-root-a-'));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-lsp-root-b-'));

    const clientA = new LspClient({ command: process.execPath, args: [serverScript], cwd: rootA, rootPath: rootA, requestTimeoutMs: 1000 });
    const clientB = new LspClient({ command: process.execPath, args: [serverScript], cwd: rootB, rootPath: rootB, requestTimeoutMs: 1000 });

    try {
      await clientA.start();
      await clientB.start();

      const initA = await clientA.request('test/getInitializeParams', {});
      const initB = await clientB.request('test/getInitializeParams', {});

      assert.ok(Array.isArray(initA.workspaceFolders));
      assert.ok(Array.isArray(initB.workspaceFolders));
      assert.equal(initA.workspaceFolders.length, 1);
      assert.equal(initB.workspaceFolders.length, 1);
      assert.notEqual(initA.workspaceFolders[0].uri, initB.workspaceFolders[0].uri);
    } finally {
      await clientA.stop();
      await clientB.stop();
      await cleanup([path.dirname(serverScript), rootA, rootB]);
    }
  });

  it('sends textDocument/didOpen and didChange notifications correctly', async () => {
    const serverScript = await makeMockLspServerScript();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-lsp-root-'));
    const filePath = path.join(root, 'edit.ts');

    const client = new LspClient({
      command: process.execPath,
      args: [serverScript],
      cwd: root,
      rootPath: root,
      requestTimeoutMs: 1000,
    });

    try {
      await client.start();
      await client.didOpen(filePath, 'const n = 1;\n', 'typescript', 1);
      await client.didChange(filePath, 'const n = 2;\n', 2);

      const seen = await client.request('test/getSeenNotifications', {});
      assert.equal(seen.length >= 2, true);
      assert.equal(seen[0].method, 'textDocument/didOpen');
      assert.equal(seen[0].params.textDocument.languageId, 'typescript');
      assert.equal(seen[0].params.textDocument.version, 1);
      assert.match(seen[0].params.textDocument.text, /const n = 1/);

      assert.equal(seen[1].method, 'textDocument/didChange');
      assert.equal(seen[1].params.textDocument.version, 2);
      assert.equal(seen[1].params.contentChanges[0].text, 'const n = 2;\n');
    } finally {
      await client.stop();
      await cleanup([path.dirname(serverScript), root]);
    }
  });

  it('times out when server never responds to initialize', async () => {
    const serverScript = await makeMockLspServerScript();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-lsp-root-'));

    const client = new LspClient({
      command: process.execPath,
      args: [serverScript],
      cwd: root,
      rootPath: root,
      env: { MOCK_MODE: 'never-respond-init' },
      requestTimeoutMs: 200,
    });

    try {
      await assert.rejects(() => client.start(), /timed out \(initialize, 200ms\)/i);
      assert.equal(client.isRunning(), true);
    } finally {
      await client.stop();
      await cleanup([path.dirname(serverScript), root]);
    }
  });

  it('auto-detects installed language servers and picks first candidate per language', () => {
    const installed = new Set(['gopls', 'pyright-langserver', 'typescript-language-server', 'clangd']);

    const found = detectInstalledLspServers({
      hasCommand: (cmd) => installed.has(cmd),
    });

    assert.ok(found.some((s) => s.language === 'go' && s.command === 'gopls'));
    assert.ok(found.some((s) => s.language === 'python' && s.command === 'pyright-langserver'));
    assert.ok(found.some((s) => s.language === 'typescript' && s.command === 'typescript-language-server'));

    // First-candidate wins for duplicated language entries.
    assert.equal(found.some((s) => s.language === 'typescript' && s.command === 'tsserver'), false);
  });
});

describe('LspManager', () => {
  it('filters diagnostics by severity threshold', async () => {
    const serverScript = await makeMockLspServerScript();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-lsp-root-'));
    const filePath = path.join(root, 'sev.ts');
    await fs.writeFile(filePath, 'const sev = true;\n', 'utf8');

    const manager = new LspManager({ rootPath: root, severityThreshold: 2, quiet: true });

    try {
      await manager.addServer({
        language: 'typescript',
        command: process.execPath,
        args: [serverScript],
        env: { MOCK_MODE: 'diag-severity' },
      });

      await manager.ensureOpen(filePath, await fs.readFile(filePath, 'utf8'));
      await new Promise((r) => setTimeout(r, 40));

      const threshold2 = await manager.getDiagnostics(filePath);
      assert.match(threshold2, /severity 1/);
      assert.match(threshold2, /severity 2/);
      assert.doesNotMatch(threshold2, /severity 3/);
      assert.doesNotMatch(threshold2, /severity 4/);

      const threshold4 = await manager.getDiagnostics(filePath, 4);
      assert.match(threshold4, /severity 1/);
      assert.match(threshold4, /severity 2/);
      assert.match(threshold4, /severity 3/);
      assert.match(threshold4, /severity 4/);
    } finally {
      await manager.close();
      await cleanup([path.dirname(serverScript), root]);
    }
  });
});
