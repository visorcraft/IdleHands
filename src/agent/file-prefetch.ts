/**
 * File Prefetch Module
 * 
 * Speculatively pre-fetches files that are likely to be needed in upcoming
 * tool calls, reducing latency by overlapping I/O with computation.
 * 
 * Use cases:
 * - When edit_file is called, prefetch the file content
 * - When multiple read_file calls are pending, batch-prefetch them
 * - When list_dir returns files, prefetch likely-to-be-read files
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface PrefetchEntry {
  content: string;
  mtime: number;
  fetchedAt: number;
  size: number;
}

export interface PrefetchStats {
  hits: number;
  misses: number;
  prefetches: number;
  evictions: number;
  hitRate: number;
}

export class FilePrefetcher {
  private cache = new Map<string, PrefetchEntry>();
  private pending = new Map<string, Promise<PrefetchEntry | null>>();
  private maxEntries: number;
  private maxFileSize: number;
  private ttlMs: number;
  
  // Runtime stats
  private hits = 0;
  private misses = 0;
  private prefetches = 0;
  private evictions = 0;

  constructor(opts?: {
    /** Maximum cached entries (default: 50) */
    maxEntries?: number;
    /** Maximum file size to cache in bytes (default: 512KB) */
    maxFileSize?: number;
    /** TTL in milliseconds (default: 30000 = 30s) */
    ttlMs?: number;
  }) {
    this.maxEntries = opts?.maxEntries ?? 50;
    this.maxFileSize = opts?.maxFileSize ?? 512 * 1024;
    this.ttlMs = opts?.ttlMs ?? 30000;
  }

  /**
   * Get cached file content if available and fresh.
   * Returns null on miss or stale entry.
   */
  async get(absPath: string): Promise<string | null> {
    const entry = this.cache.get(absPath);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.cache.delete(absPath);
      this.misses++;
      return null;
    }

    // Check mtime for invalidation
    try {
      const stat = await fs.stat(absPath);
      if (stat.mtimeMs !== entry.mtime) {
        this.cache.delete(absPath);
        this.misses++;
        return null;
      }
    } catch {
      this.cache.delete(absPath);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.content;
  }

  /**
   * Trigger prefetch for a file path. Non-blocking.
   * Returns immediately, fetches in background.
   */
  prefetch(absPath: string): void {
    // Skip if already cached or pending
    if (this.cache.has(absPath) || this.pending.has(absPath)) return;

    const fetchPromise = this.fetchAndCache(absPath);
    this.pending.set(absPath, fetchPromise);
    fetchPromise.finally(() => this.pending.delete(absPath));
  }

  /**
   * Prefetch multiple files in parallel.
   */
  prefetchMany(paths: string[]): void {
    for (const p of paths) {
      this.prefetch(p);
    }
  }

  /**
   * Prefetch files likely to be edited based on tool calls.
   * Analyzes pending tool calls and prefetches relevant files.
   */
  prefetchForToolCalls(
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
    cwd: string
  ): void {
    const pathsToFetch = new Set<string>();

    for (const tc of toolCalls) {
      const { name, args } = tc;

      // Edit tools: prefetch the file being edited
      if (
        (name === 'edit_file' || name === 'write_file' || name === 'insert_file') &&
        typeof args.path === 'string'
      ) {
        const absPath = path.isAbsolute(args.path) ? args.path : path.join(cwd, args.path);
        pathsToFetch.add(absPath);
      }

      // read_files: prefetch all paths
      if (name === 'read_files' && Array.isArray(args.paths)) {
        for (const p of args.paths) {
          if (typeof p === 'string') {
            const absPath = path.isAbsolute(p) ? p : path.join(cwd, p);
            pathsToFetch.add(absPath);
          }
        }
      }

      // apply_patch: prefetch all files in the patch
      if (name === 'apply_patch' && Array.isArray(args.files)) {
        for (const f of args.files) {
          if (typeof f === 'string') {
            const absPath = path.isAbsolute(f) ? f : path.join(cwd, f);
            pathsToFetch.add(absPath);
          }
        }
      }
    }

    this.prefetchMany([...pathsToFetch]);
  }

  /**
   * Wait for a pending prefetch to complete.
   */
  async waitFor(absPath: string): Promise<string | null> {
    const pending = this.pending.get(absPath);
    if (pending) {
      const entry = await pending;
      return entry?.content ?? null;
    }
    return this.get(absPath);
  }

  private async fetchAndCache(absPath: string): Promise<PrefetchEntry | null> {
    try {
      const stat = await fs.stat(absPath);
      
      // Skip if too large
      if (stat.size > this.maxFileSize) return null;
      
      // Skip if not a regular file
      if (!stat.isFile()) return null;

      const content = await fs.readFile(absPath, 'utf8');
      
      const entry: PrefetchEntry = {
        content,
        mtime: stat.mtimeMs,
        fetchedAt: Date.now(),
        size: stat.size,
      };

      // Evict if over capacity
      if (this.cache.size >= this.maxEntries) {
        this.evictOldest();
      }

      this.cache.set(absPath, entry);
      this.prefetches++;
      return entry;
    } catch {
      return null;
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.fetchedAt < oldestTime) {
        oldestTime = entry.fetchedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.evictions++;
    }
  }

  /**
   * Invalidate a cached entry (e.g., after write).
   */
  invalidate(absPath: string): void {
    this.cache.delete(absPath);
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get prefetch statistics.
   */
  stats(): PrefetchStats {
    return {
      hits: this.hits,
      misses: this.misses,
      prefetches: this.prefetches,
      evictions: this.evictions,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
    };
  }
}
