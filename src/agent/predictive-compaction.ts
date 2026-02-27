/**
 * Predictive Compaction Module
 * 
 * Triggers compaction earlier based on token velocity (tokens consumed per turn)
 * rather than waiting until the context window is nearly full.
 * 
 * Benefits:
 * - Smoother context management (avoid sudden large compactions)
 * - Better latency (compact during idle periods)
 * - More headroom for tool outputs
 */

export interface TokenVelocityStats {
  /** Average tokens per turn */
  avgTokensPerTurn: number;
  /** Estimated turns until context threshold */
  turnsUntilThreshold: number;
  /** Whether predictive compaction is recommended */
  shouldCompact: boolean;
  /** Reason for recommendation */
  reason: string;
}

export interface CompactionTriggerConfig {
  /** Context window size in tokens */
  contextWindow: number;
  /** Threshold ratio to trigger compaction (default: 0.75 = 75%) */
  thresholdRatio?: number;
  /** Minimum turns of headroom to maintain (default: 3) */
  minTurnsHeadroom?: number;
  /** Minimum token velocity to trigger predictive compaction (default: 2000) */
  minVelocityForPrediction?: number;
  /** Sample size for velocity calculation (default: 5 turns) */
  velocitySampleSize?: number;
}

export class PredictiveCompactionTracker {
  private turnTokenCounts: number[] = [];
  private config: Required<CompactionTriggerConfig>;

  constructor(config: CompactionTriggerConfig) {
    this.config = {
      contextWindow: config.contextWindow,
      thresholdRatio: config.thresholdRatio ?? 0.75,
      minTurnsHeadroom: config.minTurnsHeadroom ?? 3,
      minVelocityForPrediction: config.minVelocityForPrediction ?? 2000,
      velocitySampleSize: config.velocitySampleSize ?? 5,
    };
  }

  /**
   * Record tokens consumed in a turn.
   */
  recordTurn(tokensConsumed: number): void {
    this.turnTokenCounts.push(tokensConsumed);
    
    // Keep only recent samples
    if (this.turnTokenCounts.length > this.config.velocitySampleSize * 2) {
      this.turnTokenCounts = this.turnTokenCounts.slice(-this.config.velocitySampleSize);
    }
  }

  /**
   * Calculate current token velocity (avg tokens per turn).
   */
  getVelocity(): number {
    if (this.turnTokenCounts.length === 0) return 0;
    
    const recentSamples = this.turnTokenCounts.slice(-this.config.velocitySampleSize);
    const sum = recentSamples.reduce((a, b) => a + b, 0);
    return sum / recentSamples.length;
  }

  /**
   * Check if predictive compaction should trigger.
   * 
   * @param currentTokens Current context size in tokens
   * @returns Stats and recommendation
   */
  shouldCompact(currentTokens: number): TokenVelocityStats {
    const velocity = this.getVelocity();
    const threshold = this.config.contextWindow * this.config.thresholdRatio;
    const headroom = threshold - currentTokens;
    
    // Estimate turns until threshold
    const turnsUntilThreshold = velocity > 0 ? Math.floor(headroom / velocity) : Infinity;
    
    // Default: no compaction needed
    let shouldCompact = false;
    let reason = 'sufficient headroom';

    // Already over threshold: definitely compact
    if (currentTokens >= threshold) {
      shouldCompact = true;
      reason = 'over threshold';
    }
    // Predictive: compact if we'll hit threshold within minTurnsHeadroom turns
    else if (
      velocity >= this.config.minVelocityForPrediction &&
      turnsUntilThreshold <= this.config.minTurnsHeadroom
    ) {
      shouldCompact = true;
      reason = `predictive: ${turnsUntilThreshold} turns until threshold at ${Math.round(velocity)} tokens/turn`;
    }
    // High velocity warning zone
    else if (velocity >= this.config.minVelocityForPrediction * 2 && turnsUntilThreshold <= 5) {
      shouldCompact = true;
      reason = `high velocity warning: ${Math.round(velocity)} tokens/turn`;
    }

    return {
      avgTokensPerTurn: Math.round(velocity),
      turnsUntilThreshold: turnsUntilThreshold === Infinity ? -1 : turnsUntilThreshold,
      shouldCompact,
      reason,
    };
  }

  /**
   * Reset tracking (e.g., after compaction or session reset).
   */
  reset(): void {
    this.turnTokenCounts = [];
  }

  /**
   * Get raw turn history for debugging.
   */
  getTurnHistory(): number[] {
    return [...this.turnTokenCounts];
  }
}

/**
 * Calculate optimal compaction target size based on velocity.
 * 
 * When compacting, we want to leave enough room for several turns
 * at the current velocity, plus some buffer for tool outputs.
 * 
 * @param contextWindow Context window size
 * @param velocity Current token velocity
 * @param targetTurns Target turns of headroom (default: 10)
 * @returns Target token count after compaction
 */
export function calculateCompactionTarget(
  contextWindow: number,
  velocity: number,
  targetTurns = 10
): number {
  const threshold = contextWindow * 0.75;
  const headroomNeeded = velocity * targetTurns;
  const toolBuffer = 5000; // Reserve for tool outputs
  
  // Target: enough room for targetTurns + tool buffer
  const target = threshold - headroomNeeded - toolBuffer;
  
  // Don't compact below 20% of context (preserve important history)
  const minTarget = contextWindow * 0.2;
  
  return Math.max(target, minTarget);
}

/**
 * Estimate compaction savings based on message scores.
 * 
 * @param messages Messages with scores
 * @param targetReduction Target tokens to remove
 * @returns Indices of messages to drop
 */
export function selectMessagesForCompaction(
  messages: Array<{ index: number; score: number; tokens: number }>,
  targetReduction: number
): number[] {
  // Sort by score ascending (lowest value first)
  const sorted = [...messages].sort((a, b) => a.score - b.score);
  
  const toRemove: number[] = [];
  let removed = 0;
  
  for (const msg of sorted) {
    if (removed >= targetReduction) break;
    
    // Never remove system messages (score 100) or very recent messages (score > 80)
    if (msg.score >= 80) continue;
    
    toRemove.push(msg.index);
    removed += msg.tokens;
  }
  
  return toRemove;
}
