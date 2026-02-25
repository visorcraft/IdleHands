import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ResponseCache } from '../src/agent/response-cache.js';
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
    expect(cache.get('model', 'system', 'user prompt')).toBeNull();
  });

  it('stores and retrieves a response', () => {
    cache.set('model', 'system', 'user prompt', 'response text', 100);
    const result = cache.get('model', 'system', 'user prompt');
    expect(result).toBe('response text');
  });

  it('different prompts have different keys', () => {
    cache.set('model', 'system', 'prompt A', 'response A');
    cache.set('model', 'system', 'prompt B', 'response B');
    expect(cache.get('model', 'system', 'prompt A')).toBe('response A');
    expect(cache.get('model', 'system', 'prompt B')).toBe('response B');
  });

  it('different models have different keys', () => {
    cache.set('gpt-4', 'system', 'prompt', 'gpt4 response');
    cache.set('claude', 'system', 'prompt', 'claude response');
    expect(cache.get('gpt-4', 'system', 'prompt')).toBe('gpt4 response');
    expect(cache.get('claude', 'system', 'prompt')).toBe('claude response');
  });

  it('respects TTL (expired entries return null)', async () => {
    // Create a cache with very short TTL
    const shortCache = new ResponseCache({ cacheDir, ttlMinutes: 0.0001, maxEntries: 10 });
    shortCache.set('model', 'sys', 'prompt', 'response');
    // Wait for the entry to expire (>6ms for 0.0001 minutes)
    await new Promise((r) => setTimeout(r, 20));
    expect(shortCache.get('model', 'sys', 'prompt')).toBeNull();
  });

  it('evicts oldest entries when over capacity', () => {
    const smallCache = new ResponseCache({ cacheDir, ttlMinutes: 60, maxEntries: 3 });
    smallCache.set('m', 's', 'p1', 'r1');
    smallCache.set('m', 's', 'p2', 'r2');
    smallCache.set('m', 's', 'p3', 'r3');
    smallCache.set('m', 's', 'p4', 'r4'); // Should evict p1
    expect(smallCache.get('m', 's', 'p1')).toBeNull();
    expect(smallCache.get('m', 's', 'p4')).toBe('r4');
  });

  it('reports stats correctly', () => {
    cache.set('m', 's', 'p1', 'r1');
    cache.set('m', 's', 'p2', 'r2');
    cache.get('m', 's', 'p1'); // hit
    cache.get('m', 's', 'p1'); // hit again
    const stats = cache.stats();
    expect(stats.entries).toBe(2);
    expect(stats.totalHits).toBe(2);
  });

  it('clear removes all entries', () => {
    cache.set('m', 's', 'p1', 'r1');
    cache.set('m', 's', 'p2', 'r2');
    cache.clear();
    expect(cache.stats().entries).toBe(0);
    expect(cache.get('m', 's', 'p1')).toBeNull();
  });
});
