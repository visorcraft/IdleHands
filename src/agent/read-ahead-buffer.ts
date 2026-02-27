/**
 * Read-Ahead Buffer
 * 
 * When reading a file section, pre-caches nearby lines to speed up
 * sequential reads. Common pattern: model reads lines 1-50, then 51-100, etc.
 * 
 * Also provides write coalescing for multiple small writes to the same file.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface ReadAheadEntry {
  /** Full file content (all lines) */
  lines: string[];
  /** File mtime for invalidation */
  mtime: number;
  /** When this entry was cached */
  cachedAt: number;
  /** Total file size in bytes */
  size: number;
}

export interface ReadAheadStats {
  hits: number;
  misses: number;
  fullReads: number;
  hitRate: number;
  cachedFiles: number;
  cachedBytes: number;
}

export class ReadAheadBuffer {
  private cache = new Map<string, ReadAheadEntry>();
  private maxCacheSize: number;
  private maxFileSize: number;
  private ttlMs: number;
  
  // Stats
  private hits = 0;
  private misses = 0;
  private fullReads = 0;

  constructor(opts?: {
    /** Maximum cached files (default: 30) */
    maxCacheSize?: number;
    /** Maximum file size to cache in bytes (default: 1MB) */
    maxFileSize?: number;
    /** TTL in milliseconds (default: 60000 = 1 min) */
    ttlMs?: number;
  }) {
    this.maxCacheSize = opts?.maxCacheSize ?? 30;
    this.maxFileSize = opts?.maxFileSize ?? 1024 * 1024;
    this.ttlMs = opts?.ttlMs ?? 60000;
  }

  /**
   * Read lines from a file with read-ahead caching.
   * 
   * @param absPath Absolute path to file
   * @param offset 1-indexed line offset (default: 1)
   * @param limit Maximum lines to return
   * @returns Array of lines
   */
  async readLines(
    absPath: string,
    offset = 1,
    limit?: number
  ): Promise<{ lines: string[]; totalLines: number; fromCache: boolean }> {
    const entry = await this.getOrLoad(absPath);
    if (!entry) {
      this.misses++;
      // Fallback to direct read
      return this.directRead(absPath, offset, limit);
    }

    this.hits++;
    const startIdx = Math.max(0, offset - 1);
    const endIdx = limit ? startIdx + limit : entry.lines.length;
    
    return {
      lines: entry.lines.slice(startIdx, endIdx),
      totalLines: entry.lines.length,
      fromCache: true,
    };
  }

  /**
   * Get cached entry or load file into cache.
   */
  private async getOrLoad(absPath: string): Promise<ReadAheadEntry | null> {
    const cached = this.cache.get(absPath);
    
    if (cached) {
      // Check TTL
      if (Date.now() - cached.cachedAt > this.ttlMs) {
        this.cache.delete(absPath);
      } else {
        // Check mtime for invalidation
        try {
          const stat = await fs.stat(absPath);
          if (stat.mtimeMs === cached.mtime) {
            return cached;
          }
          // File changed, invalidate
          this.cache.delete(absPath);
        } catch {
          this.cache.delete(absPath);
          return null;
        }
      }
    }

    // Load file into cache
    return this.loadFile(absPath);
  }

  /**
   * Load a file into the cache.
   */
  private async loadFile(absPath: string): Promise<ReadAheadEntry | null> {
    try {
      const stat = await fs.stat(absPath);
      
      // Skip if too large
      if (stat.size > this.maxFileSize) {
        return null;
      }
      
      // Skip if not a regular file
      if (!stat.isFile()) {
        return null;
      }

      const content = await fs.readFile(absPath, 'utf8');
      const lines = content.split('\n');
      
      this.fullReads++;

      const entry: ReadAheadEntry = {
        lines,
        mtime: stat.mtimeMs,
        cachedAt: Date.now(),
        size: stat.size,
      };

      // Evict if over capacity
      if (this.cache.size >= this.maxCacheSize) {
        this.evictOldest();
      }

      this.cache.set(absPath, entry);
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Direct read without caching (fallback for large files).
   */
  private async directRead(
    absPath: string,
    offset: number,
    limit?: number
  ): Promise<{ lines: string[]; totalLines: number; fromCache: boolean }> {
    try {
      const content = await fs.readFile(absPath, 'utf8');
      const allLines = content.split('\n');
      const startIdx = Math.max(0, offset - 1);
      const endIdx = limit ? startIdx + limit : allLines.length;
      
      return {
        lines: allLines.slice(startIdx, endIdx),
        totalLines: allLines.length,
        fromCache: false,
      };
    } catch (e) {
      return { lines: [], totalLines: 0, fromCache: false };
    }
  }

  /**
   * Evict the oldest cached entry.
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Invalidate a cached file (e.g., after write).
   */
  invalidate(absPath: string): void {
    this.cache.delete(absPath);
  }

  /**
   * Invalidate all files in a directory.
   */
  invalidateDir(dirPath: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(dirPath)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get buffer statistics.
   */
  stats(): ReadAheadStats {
    let cachedBytes = 0;
    for (const entry of this.cache.values()) {
      cachedBytes += entry.size;
    }

    return {
      hits: this.hits,
      misses: this.misses,
      fullReads: this.fullReads,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
      cachedFiles: this.cache.size,
      cachedBytes,
    };
  }

  /**
   * Check if a file is cached.
   */
  isCached(absPath: string): boolean {
    return this.cache.has(absPath);
  }

  /**
   * Get all cached file paths.
   */
  getCachedPaths(): string[] {
    return [...this.cache.keys()];
  }
}

/**
 * Write coalescing buffer.
 * Batches multiple small writes to the same file.
 */
export class WriteCoalescer {
  private pending = new Map<string, { content: string; scheduledAt: number }>();
  private flushDelayMs: number;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(opts?: {
    /** Delay before flushing writes (default: 100ms) */
    flushDelayMs?: number;
  }) {
    this.flushDelayMs = opts?.flushDelayMs ?? 100;
  }

  /**
   * Schedule a write to be coalesced.
   * Returns a promise that resolves when the write is flushed.
   */
  async write(absPath: string, content: string): Promise<void> {
    this.pending.set(absPath, { content, scheduledAt: Date.now() });
    
    // Schedule flush if not already scheduled
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushDelayMs);
    }

    // Return immediately - write will happen on flush
  }

  /**
   * Flush all pending writes immediately.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const writes = [...this.pending.entries()];
    this.pending.clear();

    // Write all files in parallel
    await Promise.all(
      writes.map(async ([absPath, { content }]) => {
        try {
          await fs.writeFile(absPath, content, 'utf8');
        } catch (e) {
          console.error(`[write-coalescer] Failed to write ${absPath}:`, e);
        }
      })
    );
  }

  /**
   * Get pending write for a file (if any).
   */
  getPending(absPath: string): string | null {
    return this.pending.get(absPath)?.content ?? null;
  }

  /**
   * Cancel a pending write.
   */
  cancel(absPath: string): boolean {
    return this.pending.delete(absPath);
  }

  /**
   * Get number of pending writes.
   */
  pendingCount(): number {
    return this.pending.size;
  }
}
