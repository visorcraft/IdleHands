/**
 * Fast Query Classifier
 * 
 * Wraps the standard query classifier with:
 * - LRU caching for repeated/similar queries
 * - Early exit for trivial cases (commands, very short messages)
 * - Lightweight pre-filter before full classification
 */

import {
  ClassificationDecision,
  ClassificationRule,
  QueryClassificationConfig,
  classifyWithDecision,
} from './query-classifier.js';

export interface FastClassifierStats {
  totalCalls: number;
  cacheHits: number;
  earlyExits: number;
  fullClassifications: number;
  hitRate: number;
}

interface CacheEntry {
  decision: ClassificationDecision | null;
  accessedAt: number;
}

/**
 * Fast classifier with caching and early-exit optimizations.
 */
export class FastQueryClassifier {
  private cache = new Map<string, CacheEntry>();
  private maxCacheSize: number;
  
  // Stats
  private totalCalls = 0;
  private cacheHits = 0;
  private earlyExits = 0;
  private fullClassifications = 0;

  constructor(opts?: {
    /** Maximum cache entries (default: 200) */
    maxCacheSize?: number;
  }) {
    this.maxCacheSize = opts?.maxCacheSize ?? 200;
  }

  /**
   * Classify a message with caching and early-exit optimizations.
   */
  classify(config: QueryClassificationConfig, message: string): ClassificationDecision | null {
    this.totalCalls++;

    // Early exit: disabled or no rules
    if (!config.enabled || config.rules.length === 0) {
      this.earlyExits++;
      return null;
    }

    // Early exit: empty or whitespace-only
    const trimmed = message.trim();
    if (!trimmed) {
      this.earlyExits++;
      return null;
    }

    // Early exit: slash commands (handled elsewhere)
    if (trimmed.startsWith('/')) {
      this.earlyExits++;
      return null;
    }

    // Early exit: very short greetings → fast hint
    if (trimmed.length <= 10 && /^(hi|hey|hello|yo|sup|thanks|thx|ok|yes|no|k|y|n)$/i.test(trimmed)) {
      this.earlyExits++;
      return { hint: 'fast', priority: 1 };
    }

    // Check cache
    const cacheKey = this.computeCacheKey(message);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      cached.accessedAt = Date.now();
      this.cacheHits++;
      return cached.decision;
    }

    // Fast pre-filter: check for code patterns before full classification
    const prefilterResult = this.prefilter(trimmed);
    if (prefilterResult) {
      this.cacheResult(cacheKey, prefilterResult);
      this.earlyExits++;
      return prefilterResult;
    }

    // Full classification
    const decision = classifyWithDecision(config, message);
    this.cacheResult(cacheKey, decision);
    this.fullClassifications++;
    return decision;
  }

  /**
   * Lightweight pre-filter for obvious cases.
   * Returns a decision if matched, null to proceed to full classification.
   */
  private prefilter(message: string): ClassificationDecision | null {
    // Code patterns: high confidence code hint
    const codePatterns = [
      /^```\w*/,                    // Code block start
      /^(import|export|from)\s/,    // JS/TS imports
      /^(def|class|async def)\s/,   // Python
      /^(fn|pub fn|impl|struct)\s/, // Rust
      /^(func|type|package)\s/,     // Go
      /^(public|private|protected)\s/, // Java/C#
    ];
    
    for (const pattern of codePatterns) {
      if (pattern.test(message)) {
        return { hint: 'code', priority: 10 };
      }
    }

    // Question patterns: reasoning hint
    if (message.length > 50 && /^(why|how|what|explain|compare|analyze)\s/i.test(message)) {
      return { hint: 'reasoning', priority: 3 };
    }

    // Single word or very short → fast
    if (message.length < 20 && !/\s/.test(message.trim())) {
      return { hint: 'fast', priority: 1 };
    }

    return null;
  }

  /**
   * Compute cache key from message.
   * Normalizes whitespace and truncates for memory efficiency.
   */
  private computeCacheKey(message: string): string {
    // Normalize whitespace and truncate to first 500 chars
    const normalized = message.trim().replace(/\s+/g, ' ').slice(0, 500);
    return normalized.toLowerCase();
  }

  /**
   * Cache a classification result.
   */
  private cacheResult(key: string, decision: ClassificationDecision | null): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxCacheSize) {
      this.evictOldest();
    }

    this.cache.set(key, {
      decision,
      accessedAt: Date.now(),
    });
  }

  /**
   * Evict the least recently accessed entry.
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.accessedAt < oldestTime) {
        oldestTime = entry.accessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Clear the classification cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get classifier statistics.
   */
  stats(): FastClassifierStats {
    const total = this.totalCalls || 1;
    return {
      totalCalls: this.totalCalls,
      cacheHits: this.cacheHits,
      earlyExits: this.earlyExits,
      fullClassifications: this.fullClassifications,
      hitRate: this.cacheHits / total,
    };
  }
}

/**
 * Singleton instance for shared use.
 */
let defaultInstance: FastQueryClassifier | null = null;

export function getDefaultFastClassifier(): FastQueryClassifier {
  if (!defaultInstance) {
    defaultInstance = new FastQueryClassifier();
  }
  return defaultInstance;
}

/**
 * Convenience function: classify with the default fast classifier.
 */
export function fastClassify(
  config: QueryClassificationConfig,
  message: string
): ClassificationDecision | null {
  return getDefaultFastClassifier().classify(config, message);
}
