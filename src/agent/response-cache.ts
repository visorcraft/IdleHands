/**
 * Response Cache
 *
 * Avoids burning tokens on repeated identical prompts by caching LLM responses.
 * Keyed by SHA-256 hash of (model, system_prompt_hash, user_prompt).
 * TTL-based expiry (default: 1 hour). Max entries cap with LRU eviction.
 *
 * Uses a separate SQLite database so it can be independently wiped without
 * touching vault/memory data.
 *
 * Inspired by ZeroClaw's response_cache.rs.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface ResponseCacheOptions {
  /** Directory to store the cache database. */
  cacheDir: string;
  /** TTL in minutes (default 60). */
  ttlMinutes?: number;
  /** Maximum cache entries (default 500). */
  maxEntries?: number;
}

export interface ResponseCacheStats {
  /** Number of entries currently in cache */
  entries: number;
  /** Total hits from database (persisted) */
  totalHits: number;
  /** Runtime: total lookups this session */
  lookups: number;
  /** Runtime: cache hits this session */
  hits: number;
  /** Runtime: cache misses this session */
  misses: number;
  /** Runtime: entries evicted this session */
  evictions: number;
  /** Runtime: hit rate (hits/lookups) */
  hitRate: number;
}

export class ResponseCache {
  private db: DatabaseSync;
  private ttlMinutes: number;
  private maxEntries: number;
  
  // Runtime metrics (not persisted, reset on restart)
  private lookups = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: ResponseCacheOptions) {
    this.ttlMinutes = options.ttlMinutes ?? 60;
    this.maxEntries = options.maxEntries ?? 500;

    const dir = options.cacheDir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const dbPath = path.join(dir, 'response_cache.db');
    this.db = new DatabaseSync(dbPath);

    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;

      CREATE TABLE IF NOT EXISTS response_cache (
        prompt_hash TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        response TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        accessed_at TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_cache_accessed ON response_cache(accessed_at);
    `);
  }

  /**
   * Compute the cache key from model + system prompt + user prompt.
   */
  private computeKey(model: string, systemPrompt: string, userPrompt: string): string {
    const systemHash = sha256(systemPrompt);
    return sha256(`${model}|${systemHash}|${userPrompt}`);
  }

  /**
   * Look up a cached response. Returns null on miss or expired entry.
   */
  get(model: string, systemPrompt: string, userPrompt: string): string | null {
    this.lookups++;
    const key = this.computeKey(model, systemPrompt, userPrompt);

    const row = this.db.prepare(
      `SELECT response, created_at FROM response_cache WHERE prompt_hash = ?`
    ).get(key) as { response: string; created_at: string } | undefined;

    if (!row) {
      this.misses++;
      return null;
    }

    // Check TTL
    const createdAt = new Date(row.created_at).getTime();
    const now = Date.now();
    if (now - createdAt > this.ttlMinutes * 60 * 1000) {
      // Expired — delete and return miss
      this.db.prepare('DELETE FROM response_cache WHERE prompt_hash = ?').run(key);
      this.misses++;
      return null;
    }

    // Update access time and hit count
    this.db.prepare(
      `UPDATE response_cache SET accessed_at = ?, hit_count = hit_count + 1 WHERE prompt_hash = ?`
    ).run(nowIso(), key);

    this.hits++;
    return row.response;
  }

  /**
   * Store a response in the cache.
   */
  set(model: string, systemPrompt: string, userPrompt: string, response: string, tokenCount = 0): void {
    const key = this.computeKey(model, systemPrompt, userPrompt);
    const now = nowIso();

    this.db.prepare(`
      INSERT OR REPLACE INTO response_cache (prompt_hash, model, response, token_count, created_at, accessed_at, hit_count)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(key, model, response, tokenCount, now, now);

    // Evict oldest entries if over capacity
    this.evict();
  }

  /**
   * Purge expired entries and enforce max entries cap.
   */
  private evict(): void {
    // Remove expired entries
    const cutoff = new Date(Date.now() - this.ttlMinutes * 60 * 1000).toISOString();
    const expiredResult = this.db.prepare('DELETE FROM response_cache WHERE created_at < ?').run(cutoff);
    this.evictions += Number(expiredResult.changes);

    // Enforce max entries (LRU eviction)
    const count = (this.db.prepare('SELECT COUNT(*) as c FROM response_cache').get() as { c: number }).c;
    if (count > this.maxEntries) {
      const excess = count - this.maxEntries;
      this.db.prepare(
        `DELETE FROM response_cache WHERE prompt_hash IN (
          SELECT prompt_hash FROM response_cache ORDER BY accessed_at ASC LIMIT ?
        )`
      ).run(excess);
      this.evictions += excess;
    }
  }

  /**
   * Get cache statistics including runtime metrics.
   */
  stats(): ResponseCacheStats {
    const row = this.db.prepare(
      'SELECT COUNT(*) as entries, COALESCE(SUM(hit_count), 0) as totalHits FROM response_cache'
    ).get() as { entries: number; totalHits: number };
    return {
      ...row,
      lookups: this.lookups,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: this.lookups > 0 ? this.hits / this.lookups : 0,
    };
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.db.exec('DELETE FROM response_cache');
  }
}
