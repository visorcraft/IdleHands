/**
 * Information density scoring for smart compaction.
 *
 * Scores messages by how valuable they are to keep in context,
 * so compaction can prioritize dropping low-value messages first.
 *
 * Higher score = more valuable = keep longer.
 */

export type ScoredMessage = {
  index: number;
  score: number;
  reason: string;
};

/**
 * Score a conversation message for compaction priority.
 * Returns 0-100 where higher = more important to keep.
 */
export function scoreMessage(
  msg: { role: string; content?: any; tool_calls?: any[] },
  index: number,
  totalMessages: number,
  opts?: {
    /** Set of file paths currently being edited in the session. */
    activeFiles?: Set<string>;
    /** Most recent user instruction text. */
    lastInstruction?: string;
  }
): ScoredMessage {
  let score = 50; // baseline
  const reasons: string[] = [];
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
  const contentLen = content.length;

  // ── Role-based scoring ──

  if (msg.role === 'system') {
    return { index, score: 100, reason: 'system prompt (never drop)' };
  }

  if (msg.role === 'user') {
    score += 15; // User messages are important context
    reasons.push('user');

    // Last user message is critical
    if (index >= totalMessages - 3) {
      score += 30;
      reasons.push('recent');
    }
  }

  if (msg.role === 'assistant') {
    // Assistant messages with code are high-value
    if (content.includes('```')) {
      score += 20;
      reasons.push('has_code');
    }

    // Assistant messages with substantive text (not just tool calls)
    if (contentLen > 200 && !msg.tool_calls?.length) {
      score += 10;
      reasons.push('substantive');
    }

    // Planning/thinking text is lower value once executed
    if (msg.tool_calls?.length && contentLen < 100) {
      score -= 15;
      reasons.push('thin_planning');
    }
  }

  if (msg.role === 'tool') {
    // Tool results for read operations are generally low-value (can be re-read)
    if (content.includes('[read_file]') || content.includes('[list_dir]')) {
      score -= 20;
      reasons.push('read_result');
    }

    // Error messages are important (prevent re-attempting)
    if (content.includes('ERROR') || content.includes('error:') || content.includes('failed')) {
      score += 15;
      reasons.push('has_error');
    }

    // Very long tool results are candidates for dropping (bulky)
    if (contentLen > 3000) {
      score -= 10;
      reasons.push('bulky');
    }
  }

  // ── Recency bonus ──
  // Messages near the end of the conversation are more valuable
  const recencyRatio = index / totalMessages;
  if (recencyRatio > 0.8) {
    score += 25;
    reasons.push('very_recent');
  } else if (recencyRatio > 0.5) {
    score += 10;
    reasons.push('recent_half');
  }

  // ── Active file relevance ──
  if (opts?.activeFiles?.size) {
    for (const file of opts.activeFiles) {
      const basename = file.split('/').pop() ?? '';
      if (content.includes(basename)) {
        score += 15;
        reasons.push('active_file');
        break;
      }
    }
  }

  // ── Instruction relevance ──
  if (opts?.lastInstruction) {
    const keywords = opts.lastInstruction.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const contentLower = content.toLowerCase();
    const hits = keywords.filter(k => contentLower.includes(k)).length;
    if (hits > 2) {
      score += 10;
      reasons.push('relevant');
    }
  }

  return {
    index,
    score: Math.max(0, Math.min(100, score)),
    reason: reasons.join(', ') || 'baseline',
  };
}

/**
 * Given scored messages, return indices to drop (sorted lowest score first)
 * until the token budget target is met.
 */
export function selectDropCandidates(
  scored: ScoredMessage[],
  opts: {
    /** Minimum index to consider dropping (protect system prompt). */
    minIndex: number;
    /** Maximum index to consider (protect tail). */
    maxIndex: number;
    /** Number of messages to drop. */
    targetDrop: number;
  }
): number[] {
  const candidates = scored
    .filter(s => s.index >= opts.minIndex && s.index <= opts.maxIndex && s.score < 100)
    .sort((a, b) => a.score - b.score); // lowest score first

  return candidates.slice(0, opts.targetDrop).map(c => c.index);
}
