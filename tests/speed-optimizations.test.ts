import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { FilePrefetcher } from '../dist/agent/file-prefetch.js';
import { FastQueryClassifier } from '../dist/agent/query-classifier-fast.js';
import { PredictiveCompactionTracker, calculateCompactionTarget, selectMessagesForCompaction } from '../dist/agent/predictive-compaction.js';
import { slimSchema, selectToolsForContext, optimizeSchemas, SchemaCache } from '../dist/agent/schema-optimizer.js';
import { ReadAheadBuffer, WriteCoalescer } from '../dist/agent/read-ahead-buffer.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-speed-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FilePrefetcher', () => {
  it('prefetches and caches file content', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world');

    const prefetcher = new FilePrefetcher();
    prefetcher.prefetch(filePath);
    
    // Wait for prefetch
    await new Promise(r => setTimeout(r, 50));
    
    const content = await prefetcher.get(filePath);
    assert.strictEqual(content, 'hello world');
    
    const stats = prefetcher.stats();
    assert.strictEqual(stats.prefetches, 1);
    assert.strictEqual(stats.hits, 1);
  });

  it('invalidates on file change', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'original');

    const prefetcher = new FilePrefetcher();
    prefetcher.prefetch(filePath);
    await new Promise(r => setTimeout(r, 50));
    
    // Modify file
    fs.writeFileSync(filePath, 'modified');
    
    const content = await prefetcher.get(filePath);
    assert.strictEqual(content, null); // Should be invalidated
  });

  it('prefetches for tool calls', async () => {
    const filePath = path.join(tmpDir, 'edit-target.ts');
    fs.writeFileSync(filePath, 'const x = 1;');

    const prefetcher = new FilePrefetcher();
    prefetcher.prefetchForToolCalls(
      [{ name: 'edit_file', args: { path: filePath } }],
      tmpDir
    );
    
    await new Promise(r => setTimeout(r, 50));
    
    const content = await prefetcher.get(filePath);
    assert.strictEqual(content, 'const x = 1;');
  });
});

describe('FastQueryClassifier', () => {
  const config = {
    enabled: true,
    rules: [
      { hint: 'code', keywords: ['code', 'function'], patterns: [], priority: 5 },
      { hint: 'fast', keywords: ['hi', 'hello'], patterns: [], priority: 1, maxLength: 50 },
    ],
  };

  it('caches classification results', () => {
    const classifier = new FastQueryClassifier();
    
    classifier.classify(config, 'write some code');
    classifier.classify(config, 'write some code'); // Same query
    
    const stats = classifier.stats();
    assert.strictEqual(stats.totalCalls, 2);
    assert.strictEqual(stats.cacheHits, 1);
  });

  it('early exits for greetings', () => {
    const classifier = new FastQueryClassifier();
    
    const result = classifier.classify(config, 'hi');
    assert.strictEqual(result?.hint, 'fast');
    
    const stats = classifier.stats();
    assert.strictEqual(stats.earlyExits, 1);
  });

  it('early exits for slash commands', () => {
    const classifier = new FastQueryClassifier();
    
    const result = classifier.classify(config, '/status');
    assert.strictEqual(result, null);
    
    const stats = classifier.stats();
    assert.strictEqual(stats.earlyExits, 1);
  });

  it('detects code patterns in prefilter', () => {
    const classifier = new FastQueryClassifier();
    
    const result = classifier.classify(config, 'import { foo } from "bar"');
    assert.strictEqual(result?.hint, 'code');
    assert.strictEqual(result?.priority, 10);
  });
});

describe('PredictiveCompactionTracker', () => {
  it('tracks token velocity', () => {
    const tracker = new PredictiveCompactionTracker({
      contextWindow: 100000,
      thresholdRatio: 0.75,
    });

    tracker.recordTurn(2000);
    tracker.recordTurn(2500);
    tracker.recordTurn(1500);

    const velocity = tracker.getVelocity();
    assert.strictEqual(velocity, 2000);
  });

  it('recommends compaction when approaching threshold', () => {
    const tracker = new PredictiveCompactionTracker({
      contextWindow: 100000,
      thresholdRatio: 0.75,
      minTurnsHeadroom: 3,
      minVelocityForPrediction: 2000,
    });

    // High velocity
    for (let i = 0; i < 5; i++) {
      tracker.recordTurn(3000);
    }

    // Near threshold
    const stats = tracker.shouldCompact(70000);
    assert.strictEqual(stats.shouldCompact, true);
    assert.ok(stats.reason.includes('predictive'));
  });

  it('does not recommend compaction with sufficient headroom', () => {
    const tracker = new PredictiveCompactionTracker({
      contextWindow: 100000,
    });

    tracker.recordTurn(1000);
    tracker.recordTurn(1000);

    const stats = tracker.shouldCompact(30000);
    assert.strictEqual(stats.shouldCompact, false);
    assert.strictEqual(stats.reason, 'sufficient headroom');
  });
});

describe('calculateCompactionTarget', () => {
  it('calculates target with room for future turns', () => {
    const target = calculateCompactionTarget(100000, 2000, 10);
    // Should be: 75000 (threshold) - 20000 (10 turns * 2000) - 5000 (buffer) = 50000
    assert.strictEqual(target, 50000);
  });

  it('respects minimum target', () => {
    const target = calculateCompactionTarget(100000, 10000, 10);
    // Would be negative, should clamp to 20% of context
    assert.strictEqual(target, 20000);
  });
});

describe('selectMessagesForCompaction', () => {
  it('selects lowest-scored messages first', () => {
    const messages = [
      { index: 0, score: 100, tokens: 500 }, // System, never remove
      { index: 1, score: 30, tokens: 1000 },
      { index: 2, score: 50, tokens: 800 },
      { index: 3, score: 20, tokens: 600 },
    ];

    const toRemove = selectMessagesForCompaction(messages, 1500);
    assert.deepStrictEqual(toRemove, [3, 1]); // Lowest scores first
  });

  it('does not remove high-scored messages', () => {
    const messages = [
      { index: 0, score: 100, tokens: 500 },
      { index: 1, score: 90, tokens: 1000 },
      { index: 2, score: 85, tokens: 800 },
    ];

    const toRemove = selectMessagesForCompaction(messages, 2000);
    assert.deepStrictEqual(toRemove, []); // All too valuable
  });
});

describe('slimSchema', () => {
  const fullSchema = {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a file from disk. This is a very long description that explains all the details about how the file reading works. Example: read_file({ path: "foo.txt" })',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The path to the file to read from the filesystem' },
          offset: { type: 'number', description: 'Line offset to start reading from' },
        },
        required: ['path'],
      },
    },
  };

  it('truncates long descriptions', () => {
    const slim = slimSchema(fullSchema, { maxDescriptionLength: 50 });
    assert.ok(slim.function.description!.length <= 53); // 50 + "..."
  });

  it('removes examples from descriptions', () => {
    const slim = slimSchema(fullSchema, { removeExamples: true });
    assert.ok(!slim.function.description!.includes('Example:'));
  });

  it('removes optional parameters when configured', () => {
    const slim = slimSchema(fullSchema, { removeOptionalParams: true });
    const props = (slim.function.parameters as any).properties;
    assert.ok('path' in props);
    assert.ok(!('offset' in props));
  });
});

describe('selectToolsForContext', () => {
  const allTools = [
    { type: 'function' as const, function: { name: 'read_file', description: '', parameters: {} } },
    { type: 'function' as const, function: { name: 'edit_file', description: '', parameters: {} } },
    { type: 'function' as const, function: { name: 'exec', description: '', parameters: {} } },
    { type: 'function' as const, function: { name: 'spawn_task', description: '', parameters: {} } },
    { type: 'function' as const, function: { name: 'vault_store', description: '', parameters: {} } },
  ];

  it('includes only essential tools in fast lane', () => {
    const selected = selectToolsForContext(allTools, { fastLane: true });
    const names = selected.map(t => t.function.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('edit_file'));
    assert.ok(!names.includes('spawn_task'));
    assert.ok(!names.includes('vault_store'));
  });

  it('excludes deferrable tools on first turn', () => {
    const selected = selectToolsForContext(allTools, { firstTurn: true });
    const names = selected.map(t => t.function.name);
    assert.ok(!names.includes('spawn_task'));
    assert.ok(!names.includes('vault_store'));
  });

  it('includes tools mentioned in message', () => {
    const selected = selectToolsForContext(allTools, { 
      message: 'spawn a background task to process this',
    });
    const names = selected.map(t => t.function.name);
    assert.ok(names.includes('spawn_task'));
  });
});

describe('ReadAheadBuffer', () => {
  it('caches full file content', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5');

    const buffer = new ReadAheadBuffer();
    
    // First read loads entire file
    const result1 = await buffer.readLines(filePath, 1, 2);
    assert.deepStrictEqual(result1.lines, ['line1', 'line2']);
    assert.strictEqual(result1.totalLines, 5);
    
    // Second read is from cache
    const result2 = await buffer.readLines(filePath, 3, 2);
    assert.deepStrictEqual(result2.lines, ['line3', 'line4']);
    assert.strictEqual(result2.fromCache, true);
    
    const stats = buffer.stats();
    assert.strictEqual(stats.fullReads, 1);
    assert.strictEqual(stats.hits, 2);
  });

  it('invalidates cache on file change', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'original');

    const buffer = new ReadAheadBuffer();
    await buffer.readLines(filePath);
    
    // Modify file
    await new Promise(r => setTimeout(r, 10));
    fs.writeFileSync(filePath, 'modified');
    
    const result = await buffer.readLines(filePath);
    assert.deepStrictEqual(result.lines, ['modified']);
    
    const stats = buffer.stats();
    assert.strictEqual(stats.fullReads, 2); // Had to re-read
  });
});

describe('WriteCoalescer', () => {
  it('coalesces multiple writes', async () => {
    const coalescer = new WriteCoalescer({ flushDelayMs: 50 });
    
    const file1 = path.join(tmpDir, 'file1.txt');
    const file2 = path.join(tmpDir, 'file2.txt');
    
    coalescer.write(file1, 'content1');
    coalescer.write(file2, 'content2');
    
    assert.strictEqual(coalescer.pendingCount(), 2);
    
    // Flush
    await coalescer.flush();
    
    assert.strictEqual(fs.readFileSync(file1, 'utf8'), 'content1');
    assert.strictEqual(fs.readFileSync(file2, 'utf8'), 'content2');
  });

  it('overwrites pending content', async () => {
    const coalescer = new WriteCoalescer({ flushDelayMs: 100 });
    
    const file = path.join(tmpDir, 'file.txt');
    
    coalescer.write(file, 'first');
    coalescer.write(file, 'second');
    
    assert.strictEqual(coalescer.pendingCount(), 1);
    assert.strictEqual(coalescer.getPending(file), 'second');
    
    await coalescer.flush();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'second');
  });
});

describe('SchemaCache', () => {
  it('deduplicates identical schemas', () => {
    const cache = new SchemaCache();
    
    const schema1 = {
      type: 'function' as const,
      function: { name: 'test', description: 'Test function', parameters: {} },
    };
    const schema2 = {
      type: 'function' as const,
      function: { name: 'test', description: 'Test function', parameters: {} },
    };
    
    const slim1 = cache.getOrCreate(schema1);
    const slim2 = cache.getOrCreate(schema2);
    
    assert.strictEqual(slim1, slim2); // Same reference
    
    const stats = cache.stats();
    assert.strictEqual(stats.uniqueSchemas, 1);
  });
});
