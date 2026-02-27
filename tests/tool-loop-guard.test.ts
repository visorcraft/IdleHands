import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ToolLoopGuard } from '../dist/agent/tool-loop-guard.js';
import type { ToolCall } from '../dist/types.js';

describe('tool-loop-guard', () => {
  it('dedupes identical tool calls within a turn', () => {
    const guard = new ToolLoopGuard();

    const calls: ToolCall[] = [
      {
        id: 'a',
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'x.ts', limit: 20 }) },
      },
      {
        id: 'b',
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ limit: 20, path: 'x.ts' }) },
      },
      {
        id: 'c',
        type: 'function',
        function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
      },
    ];

    const prepared = guard.prepareTurn(calls);

    assert.equal(prepared.uniqueCalls.length, 2);
    assert.equal(prepared.replayByCallId.size, 1);
    assert.equal(prepared.replayByCallId.get('b'), 'a');
  });

  it('treats near-identical search_files patterns as duplicates in a turn', () => {
    const guard = new ToolLoopGuard();

    const calls: ToolCall[] = [
      {
        id: 's1',
        type: 'function',
        function: {
          name: 'search_files',
          arguments: JSON.stringify({
            pattern: 'retry_fast|retry_heavy|cancel',
            path: 'src',
            include: '*.ts',
            max_results: 20,
          }),
        },
      },
      {
        id: 's2',
        type: 'function',
        function: {
          name: 'search_files',
          arguments: JSON.stringify({
            pattern: 'cancel|retry_heavy|retry_fast',
            path: 'src',
            include: '*.ts',
            max_results: 50,
          }),
        },
      },
    ];

    const prepared = guard.prepareTurn(calls);
    assert.equal(prepared.uniqueCalls.length, 1);
    assert.equal(prepared.replayByCallId.get('s2'), 's1');
  });

  it('invalidates read cache when file mtime/size changes', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-loop-guard-'));
    const filePath = path.join(tmp, 'sample.txt');

    try {
      await fs.writeFile(filePath, 'hello\n', 'utf8');

      const guard = new ToolLoopGuard();
      const args = { path: 'sample.txt', limit: 50 };

      await guard.storeReadCache('read_file', args, tmp, 'file-content');
      const replay1 = await guard.getReadCacheReplay('read_file', args, tmp);
      assert.ok(typeof replay1 === 'string' && replay1.includes('[CACHE HIT]'));

      // Ensure mtime tick changes on filesystems with coarse resolution
      await new Promise((r) => setTimeout(r, 20));
      await fs.writeFile(filePath, 'hello\nworld\n', 'utf8');

      const replay2 = await guard.getReadCacheReplay('read_file', args, tmp);
      assert.equal(replay2, null);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('expires read cache entries via ttl', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-loop-guard-ttl-'));
    const filePath = path.join(tmp, 'ttl.txt');
    try {
      await fs.writeFile(filePath, 'ttl\n', 'utf8');
      const guard = new ToolLoopGuard({ readCacheTtlMs: 5 });
      const args = { path: 'ttl.txt' };
      await guard.storeReadCache('read_file', args, tmp, 'cached');

      await new Promise((r) => setTimeout(r, 12));
      const replay = await guard.getReadCacheReplay('read_file', args, tmp);
      assert.equal(replay, null);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('exposes telemetry counters in stats', async () => {
    const guard = new ToolLoopGuard();
    const calls: ToolCall[] = [
      {
        id: 'a',
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'x.ts' }) },
      },
      {
        id: 'b',
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'x.ts' }) },
      },
    ];
    guard.prepareTurn(calls);
    guard.registerCall('read_file', { path: 'x.ts' }, 'a');
    guard.registerOutcome('read_file', { path: 'x.ts' }, { toolCallId: 'a', result: 'ok' });
    const stats: any = guard.getStats();
    assert.ok(stats?.telemetry);
    assert.equal(stats.telemetry.callsRegistered, 1);
    assert.equal(stats.telemetry.dedupedReplays, 1);
  });

  it('cache hit messages include read loop hints for read_file', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-hints-'));
    const filePath = path.join(tmp, 'test.ts');

    try {
      await fs.writeFile(filePath, 'hello world\n', 'utf8');

      const guard = new ToolLoopGuard();
      const args = { path: filePath, limit: 50 };

      // Store content in file content cache
      await guard.storeFileContentCache('read_file', args, tmp, 'hello world\n');

      // Get cached result -- should include hints
      const cached = await guard.getFileContentCache('read_file', args, tmp);
      assert.ok(cached, 'expected a cache hit');
      assert.ok(cached.includes('[CACHE HIT]'), 'should have CACHE HIT prefix');
      assert.ok(
        cached.includes('offset=') || cached.includes('search='),
        'should include navigation hints'
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('cache replay includes read loop hints for read_file', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-replay-hints-'));
    const filePath = path.join(tmp, 'replay.ts');

    try {
      await fs.writeFile(filePath, 'some content\n', 'utf8');

      const guard = new ToolLoopGuard();
      const args = { path: filePath, limit: 100 };

      // Store in read cache
      await guard.storeReadCache('read_file', args, tmp, 'some content\n');

      // Get replay -- should include hints
      const replay = await guard.getReadCacheReplay('read_file', args, tmp);
      assert.ok(replay, 'expected a cache replay');
      assert.ok(replay.includes('[CACHE HIT]'), 'should have CACHE HIT prefix');
      assert.ok(
        replay.includes('offset=') || replay.includes('search='),
        'should include navigation hints in replay'
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});
