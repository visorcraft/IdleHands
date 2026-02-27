import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ResponseCache } from '../dist/agent/response-cache.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let cacheDir: string;
let cache: ResponseCache;

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-cache-test-'));
  cache = new ResponseCache({ cacheDir, ttlMinutes: 60, maxEntries: 10 });
});

afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe('ResponseCache', () => {
  it('returns null on miss', () => {
    assert.strictEqual(cache.get('model', 'system', 'user prompt'), null);
  });

  it('stores and retrieves a response', () => {
    cache.set('model', 'system', 'user prompt', 'response text', 100);
    const result = cache.get('model', 'system', 'user prompt');
    assert.strictEqual(result, 'response text');
  });

  it('different prompts have different keys', () => {
    cache.set('model', 'system', 'prompt A', 'response A');
    cache.set('model', 'system', 'prompt B', 'response B');
    assert.strictEqual(cache.get('model', 'system', 'prompt A'), 'response A');
    assert.strictEqual(cache.get('model', 'system', 'prompt B'), 'response B');
  });

  it('different models have different keys', () => {
    cache.set('gpt-4', 'system', 'prompt', 'gpt4 response');
    cache.set('claude', 'system', 'prompt', 'claude response');
    assert.strictEqual(cache.get('gpt-4', 'system', 'prompt'), 'gpt4 response');
    assert.strictEqual(cache.get('claude', 'system', 'prompt'), 'claude response');
  });

  it('respects TTL (expired entries return null)', async () => {
    // Create a cache with very short TTL
    const shortCache = new ResponseCache({ cacheDir, ttlMinutes: 0.0001, maxEntries: 10 });
    shortCache.set('model', 'sys', 'prompt', 'response');
    // Wait for the entry to expire (>6ms for 0.0001 minutes)
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(shortCache.get('model', 'sys', 'prompt'), null);
  });

  it('evicts oldest entries when over capacity', () => {
    const smallCache = new ResponseCache({ cacheDir, ttlMinutes: 60, maxEntries: 3 });
    smallCache.set('m', 's', 'p1', 'r1');
    smallCache.set('m', 's', 'p2', 'r2');
    smallCache.set('m', 's', 'p3', 'r3');
    smallCache.set('m', 's', 'p4', 'r4'); // Should evict p1
    assert.strictEqual(smallCache.get('m', 's', 'p1'), null);
    assert.strictEqual(smallCache.get('m', 's', 'p4'), 'r4');
  });

  it('reports stats correctly', () => {
    cache.set('m', 's', 'p1', 'r1');
    cache.set('m', 's', 'p2', 'r2');
    cache.get('m', 's', 'p1'); // hit
    cache.get('m', 's', 'p1'); // hit again
    const stats = cache.stats();
    assert.strictEqual(stats.entries, 2);
    assert.strictEqual(stats.totalHits, 2);
  });

  it('clear removes all entries', () => {
    cache.set('m', 's', 'p1', 'r1');
    cache.set('m', 's', 'p2', 'r2');
    cache.clear();
    assert.strictEqual(cache.stats().entries, 0);
    assert.strictEqual(cache.get('m', 's', 'p1'), null);
  });
});

describe('ResponseCache runtime metrics', () => {
  it('tracks lookups, hits, and misses', () => {
    cache.set('m', 's', 'p1', 'r1');
    cache.get('m', 's', 'p1'); // hit
    cache.get('m', 's', 'p2'); // miss
    cache.get('m', 's', 'p1'); // hit
    cache.get('m', 's', 'p3'); // miss

    const stats = cache.stats();
    assert.strictEqual(stats.lookups, 4);
    assert.strictEqual(stats.hits, 2);
    assert.strictEqual(stats.misses, 2);
    assert.strictEqual(stats.hitRate, 0.5);
  });

  it('tracks evictions', () => {
    const smallCache = new ResponseCache({ cacheDir, ttlMinutes: 60, maxEntries: 2 });
    smallCache.set('m', 's', 'p1', 'r1');
    smallCache.set('m', 's', 'p2', 'r2');
    smallCache.set('m', 's', 'p3', 'r3'); // Should evict p1

    const stats = smallCache.stats();
    assert.strictEqual(stats.evictions, 1);
    assert.strictEqual(stats.entries, 2);
  });

  it('returns zero hitRate when no lookups', () => {
    const stats = cache.stats();
    assert.strictEqual(stats.lookups, 0);
    assert.strictEqual(stats.hitRate, 0);
  });
});
