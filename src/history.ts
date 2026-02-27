import type { ChatMessage, UserContentPart } from './types.js';

// Pre-compiled regex for think-block stripping (avoids re-creation per call)
const THINK_RE = /<think>([\s\S]*?)<\/think>/gi;
const THINKING_RE = /<thinking>([\s\S]*?)<\/thinking>/gi;

export function stripThinking(text: string): { visible: string; thinking: string } {
  // Support <think>...</think> and <thinking>...</thinking>
  const thinkBlocks: string[] = [];
  let visible = text;
  for (const re of [THINK_RE, THINKING_RE]) {
    re.lastIndex = 0; // reset stateful global regex
    visible = visible.replace(re, (_m, g1) => {
      thinkBlocks.push(String(g1));
      return '';
    });
  }
  return { visible: visible.trim(), thinking: thinkBlocks.join('\n\n').trim() };
}

function messageContentChars(content: string | UserContentPart[] | undefined): number {
  if (!content) return 0;
  if (typeof content === 'string') return content.length;
  let total = 0;
  for (const part of content) {
    if (part.type === 'text') total += part.text.length;
    else if (part.type === 'image_url') total += (part.image_url?.url?.length ?? 0) + 16;
  }
  return total;
}

export function estimateTokensFromMessages(messages: ChatMessage[]): number {
  // crude: chars/4 + overhead per message + tool_calls JSON estimate
  let chars = 0;
  for (const m of messages) {
    chars += messageContentChars((m as any).content) + 20;
    // Account for tool_calls JSON in assistant messages (function name + arguments)
    const tc = (m as any).tool_calls;
    if (Array.isArray(tc)) {
      for (const t of tc) {
        chars += (t.function?.name?.length ?? 0) + (t.function?.arguments?.length ?? 0) + 30;
      }
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Estimate tokens consumed by tool schemas (JSON.stringify / 4).
 * Callers should pass the actual tool array so the budget reflects the real schema footprint
 * (built-in + MCP + LSP + vault + spawn_task — which varies per session).
 */
export function estimateToolSchemaTokens(tools: unknown[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  // JSON.stringify is a reasonable proxy for what gets sent on the wire.
  let chars = 0;
  for (const t of tools) chars += JSON.stringify(t).length;
  return Math.ceil(chars / 4);
}

export function enforceContextBudget(opts: {
  messages: ChatMessage[];
  contextWindow: number;
  maxTokens: number;
  minTailMessages?: number;
  compactAt?: number;
  toolSchemaTokens?: number;
  force?: boolean;
}): ChatMessage[] {
  const { contextWindow, maxTokens } = opts;
  const minTail = opts.force ? 2 : (opts.minTailMessages ?? 20);

  // Reserve overhead: 2048 safety margin (thinking tokens, tool-call framing)
  // + actual tool schema tokens (caller-supplied) or 800 as a conservative fallback.
  const toolOverhead = opts.toolSchemaTokens ?? 800;
  const safetyMargin = 2048 + toolOverhead;
  const budget = Math.max(1024, contextWindow - maxTokens - safetyMargin);
  // Trigger compaction at configurable threshold (default 80%).
  // Force mode targets 50% to guarantee freeing space.
  const compactAt = opts.force
    ? 0.5
    : Number.isFinite(opts.compactAt)
      ? Math.min(0.95, Math.max(0.5, Number(opts.compactAt)))
      : 0.8;
  const threshold = Math.floor(budget * compactAt);

  let msgs = [...opts.messages];
  const beforeCount = msgs.length;
  const beforeTokens = estimateTokensFromMessages(msgs);

  if (!opts.force && beforeTokens <= threshold) return msgs;

  const sysStart = msgs[0]?.role === 'system' ? 1 : 0;
  let currentTokens = beforeTokens;

  // Find the last assistant message with substantive text (not just tool_calls).
  // This is the model's most recent "real" response and must be protected from compaction
  // to prevent the model from re-doing all its work when the user follows up.
  let protectedIdx = -1;
  for (let i = msgs.length - 1; i >= sysStart; i--) {
    const m = msgs[i];
    if (
      m.role === 'assistant' &&
      !(m as any).tool_calls?.length &&
      messageContentChars((m as any).content) > 50
    ) {
      protectedIdx = i;
      break;
    }
  }

  // Phase 1: drop oldest tool-call exchange groups first (§10 — they're bulky and stale).
  // A "group" = assistant message with tool_calls + all its tool-result messages.
  // Dropping tool results without their paired assistant message breaks the OpenAI
  // protocol contract (orphaned tool_call IDs cause server errors / model confusion).
  while (msgs.length > 2 && currentTokens > threshold) {
    if (msgs.length - sysStart <= minTail) break;
    const groupIdx = findOldestToolCallGroup(msgs, sysStart, msgs.length - minTail, protectedIdx);
    if (groupIdx === -1) break;
    // Remove the group (assistant + following tool results) in one splice.
    // The group may extend past the minTail search boundary — that's correct:
    // we must drop the entire group (assistant + tool results) to keep the
    // protocol valid, and minTail only bounds where we *search* for groups.
    const groupEnd = findGroupEnd(msgs, groupIdx);
    // Adjust protectedIdx if dropping before it
    if (protectedIdx > groupIdx) protectedIdx -= groupEnd - groupIdx;
    const dropped = msgs.splice(groupIdx, groupEnd - groupIdx);
    for (const d of dropped)
      currentTokens -= Math.ceil((messageContentChars((d as any).content) + 20) / 4);
  }

  // Phase 2: drop any oldest messages if still over budget.
  while (msgs.length > 2 && currentTokens > threshold) {
    if (msgs.length - sysStart <= minTail) break;
    // Skip the protected assistant response
    if (sysStart === protectedIdx) {
      // Can't drop — the next droppable message is the protected one, stop
      break;
    }
    const [removed] = msgs.splice(sysStart, 1);
    if (protectedIdx > sysStart) protectedIdx--;
    currentTokens -= Math.ceil((messageContentChars((removed as any).content) + 20) / 4);
  }

  const dropped = beforeCount - msgs.length;
  if (dropped > 0) {
    const freed = beforeTokens - estimateTokensFromMessages(msgs);
    const usedPct = budget > 0 ? ((beforeTokens / budget) * 100).toFixed(1) : '?';
    console.error(
      `[auto-compact] Approaching context limit (${usedPct}%) - compacting ${dropped} old turns, ~${freed} tokens freed`
    );
  }

  return msgs;
}

/**
 * Find the index of the oldest assistant message that has tool_calls in the droppable range.
 * We drop the entire group (assistant + tool results) to keep the protocol valid.
 * Falls back to finding the oldest tool-result message (orphaned) if no group is found.
 */
function findOldestToolCallGroup(
  msgs: ChatMessage[],
  fromIdx: number,
  toIdx: number,
  protectedIdx = -1
): number {
  // First: look for an assistant message with tool_calls (a complete group to drop)
  for (let i = fromIdx; i < toIdx; i++) {
    if (i === protectedIdx) continue;
    const m = msgs[i];
    if (m.role === 'assistant' && (m as any).tool_calls?.length) return i;
  }
  // Fallback: look for orphaned tool-result messages (shouldn't happen, but safe)
  for (let i = fromIdx; i < toIdx; i++) {
    if (i === protectedIdx) continue;
    if (msgs[i].role === 'tool') return i;
  }
  return -1;
}

/**
 * Given an assistant message at `startIdx` with tool_calls, find the exclusive end index
 * of the group: the assistant + all immediately following tool-result messages.
 */
function findGroupEnd(msgs: ChatMessage[], startIdx: number): number {
  let i = startIdx + 1;
  while (i < msgs.length && msgs[i].role === 'tool') {
    i++;
  }
  return i;
}

// ============================================================================
// ENHANCED COMPACTION - Importance Scoring, Compression, Semantic Chunking
// ============================================================================

/**
 * Get text content from a message for analysis.
 */
function getMessageText(msg: ChatMessage): string {
  const content = (msg as any).content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n');
  }
  return '';
}

// Pre-compiled regex patterns for importance scoring (avoid re-creation)
const IMPORTANT_PATTERNS = /\b(important|critical|must|decision|agreed|confirmed|remember|note)\b/i;
const ERROR_PATTERNS = /\b(error|bug|fix|issue|problem|failed|exception|crash)\b/i;
const PLANNING_PATTERNS = /\b(todo|next|plan|will|should|need to|going to)\b/i;
const TRIVIAL_PATTERNS = /^(ok|done|success|completed|yes|no|sure|got it)\.?$/i;
const BULK_TOOL_PATTERNS = /read_file|list_directory|glob|search_files/i;

/**
 * Score a message by importance (higher = more important to keep).
 * Zero LLM cost - pure heuristics.
 */
export function scoreMessageImportance(
  msg: ChatMessage,
  idx: number,
  total: number,
  toolName?: string
): number {
  let score = 0;
  
  // Recency bonus: newer messages score higher (0-50 points)
  score += Math.floor((idx / Math.max(1, total - 1)) * 50);
  
  const text = getMessageText(msg);
  const len = text.length;
  
  // Role-based scoring
  switch (msg.role) {
    case 'user':
      score += 30; // User messages are high-value context
      break;
    case 'assistant':
      if (!(msg as any).tool_calls?.length) {
        score += 25; // Substantive assistant responses
      } else {
        score += 10; // Tool-calling assistant messages
      }
      break;
    case 'tool':
      score -= 5; // Tool results are often bulk data
      break;
    case 'system':
      score += 40; // System messages are critical
      break;
  }
  
  // Content-based scoring (regex, no LLM)
  if (IMPORTANT_PATTERNS.test(text)) score += 25;
  if (ERROR_PATTERNS.test(text)) score += 20;
  if (PLANNING_PATTERNS.test(text)) score += 15;
  
  // Penalize trivial/bulk content
  if (TRIVIAL_PATTERNS.test(text.trim())) score -= 30;
  
  // Penalize very large tool outputs (bulk data)
  if (msg.role === 'tool') {
    if (len > 10000) score -= 25;
    else if (len > 5000) score -= 15;
    else if (len < 50) score -= 10; // Too short = trivial
    
    // Penalize repetitive read operations
    const name = toolName ?? ((msg as any).name || '');
    if (BULK_TOOL_PATTERNS.test(name)) score -= 10;
  }
  
  // Boost messages with code/technical content (likely important)
  if (/```[\s\S]+```/.test(text)) score += 10;
  if (/function |class |const |let |import |export /.test(text)) score += 5;
  
  // Boost messages mentioning files (context about what was worked on)
  if (/\.(ts|js|py|tsx|jsx|json|md|yaml|yml|sh)\b/.test(text)) score += 5;
  
  return score;
}

/**
 * Compress a large tool result to preserve key information while reducing tokens.
 * Zero LLM cost - pure string manipulation.
 */
export function compressToolResult(content: string, maxChars = 1200): string {
  if (content.length <= maxChars) return content;
  
  const lines = content.split('\n');
  const totalLines = lines.length;
  
  // For very long content, extract structure
  if (totalLines > 50) {
    const headLines = 12;
    const tailLines = 8;
    const head = lines.slice(0, headLines).join('\n');
    const tail = lines.slice(-tailLines).join('\n');
    
    // Extract "interesting" lines from middle
    const middle = lines.slice(headLines, -tailLines);
    const interestingPatterns = /error|warn|fail|success|found|match|import|export|function|class|def |async |interface |type |const |TODO|FIXME|BUG/i;
    const interesting = middle
      .filter(line => interestingPatterns.test(line))
      .slice(0, 8);
    
    const omitted = totalLines - headLines - tailLines - interesting.length;
    
    const parts = [head];
    if (interesting.length > 0) {
      parts.push(`\n... [${omitted} lines omitted] ...\n`);
      parts.push('[Key lines from middle:]');
      parts.push(interesting.join('\n'));
    } else {
      parts.push(`\n... [${omitted} lines omitted] ...\n`);
    }
    parts.push(tail);
    
    const result = parts.join('\n');
    
    // If still too long, truncate more aggressively
    if (result.length > maxChars) {
      return result.slice(0, maxChars - 50) + `\n... [truncated, ${content.length} chars total]`;
    }
    
    return result;
  }
  
  // For medium content, just head + tail
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = Math.floor(maxChars * 0.3);
  
  return (
    content.slice(0, headChars) +
    `\n... [${content.length - headChars - tailChars} chars omitted] ...\n` +
    content.slice(-tailChars)
  );
}

/**
 * Apply compression to tool result messages in-place.
 */
export function compressToolMessages(
  messages: ChatMessage[],
  maxChars = 1200
): ChatMessage[] {
  return messages.map(msg => {
    if (msg.role !== 'tool') return msg;
    
    const content = (msg as any).content;
    if (typeof content !== 'string' || content.length <= maxChars) return msg;
    
    return {
      ...msg,
      content: compressToolResult(content, maxChars),
    } as ChatMessage;
  });
}

// ============================================================================
// Semantic Chunking
// ============================================================================

export type MessageChunk = {
  messages: ChatMessage[];
  startIdx: number;
  endIdx: number;
  score: number;
  tokenEstimate: number;
};

/**
 * Build a single chunk with aggregate score and token estimate.
 */
export function buildChunk(
  messages: ChatMessage[],
  startIdx: number,
  endIdx: number,
  totalMessages: number
): MessageChunk {
  let score = 0;
  for (let i = 0; i < messages.length; i++) {
    score += scoreMessageImportance(messages[i], startIdx + i, totalMessages);
  }
  return {
    messages,
    startIdx,
    endIdx,
    score: Math.round(score / Math.max(1, messages.length)), // Average score
    tokenEstimate: estimateTokensFromMessages(messages),
  };
}

/**
 * Group messages into semantic chunks (user request + response + tool calls).
 * This keeps related messages together during compaction.
 */
export function buildSemanticChunks(
  messages: ChatMessage[],
  sysStart: number = 0
): MessageChunk[] {
  const chunks: MessageChunk[] = [];
  let currentChunk: ChatMessage[] = [];
  let chunkStart = sysStart;
  
  // Skip system message
  const startIdx = messages[0]?.role === 'system' ? 1 : 0;
  
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    
    // New user message starts a new chunk (unless current is empty)
    if (msg.role === 'user' && currentChunk.length > 0) {
      chunks.push(buildChunk(currentChunk, chunkStart, i, messages.length));
      currentChunk = [];
      chunkStart = i;
    }
    
    currentChunk.push(msg);
  }
  
  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push(buildChunk(currentChunk, chunkStart, messages.length, messages.length));
  }
  
  return chunks;
}

// ============================================================================
// Key Fact Extraction
// ============================================================================

// Pre-compiled patterns for fact extraction
const DECISION_PATTERNS = /\b(decided|agreed|confirmed|chose|will use|going with|settled on)\b[^.!?\n]{10,100}/gi;
const FILE_OP_PATTERNS = /\b(created|edited|modified|deleted|renamed|moved)\s+[\w./\\-]+\.(ts|js|py|json|md|yaml|yml|sh|tsx|jsx)/gi;
const ERROR_FIX_PATTERNS = /\b(fixed|resolved|solved|patched)\b[^.!?\n]{10,80}/gi;
const TASK_COMPLETE_PATTERNS = /\b(finished|completed|done with|implemented)\b[^.!?\n]{10,80}/gi;

/**
 * Extract key facts from dropped messages for vault archiving.
 * Zero LLM cost - regex-based extraction.
 */
export function extractKeyFacts(messages: ChatMessage[]): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();
  
  for (const msg of messages) {
    if (msg.role !== 'assistant' && msg.role !== 'user') continue;
    
    const text = getMessageText(msg);
    if (!text) continue;
    
    // Extract decisions
    for (const pattern of [DECISION_PATTERNS, FILE_OP_PATTERNS, ERROR_FIX_PATTERNS, TASK_COMPLETE_PATTERNS]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const fact = match[0].trim().replace(/\s+/g, ' ');
        const normalized = fact.toLowerCase();
        if (!seen.has(normalized) && fact.length > 15 && fact.length < 200) {
          seen.add(normalized);
          facts.push(fact);
        }
      }
    }
  }
  
  return facts.slice(0, 10); // Cap at 10 facts
}

// ============================================================================
// Enhanced Context Budget Enforcement
// ============================================================================

export type CompactionStats = {
  beforeCount: number;
  afterCount: number;
  beforeTokens: number;
  afterTokens: number;
  freedTokens: number;
  chunksDropped: number;
  messagesCompressed: number;
};

export type CompactionResult = {
  messages: ChatMessage[];
  dropped: ChatMessage[];
  keyFacts: string[];
  stats: CompactionStats;
};

/**
 * Enhanced context budget enforcement with full result details.
 * Returns dropped messages and extracted facts for vault archiving.
 */
export function enforceContextBudgetEnhanced(opts: {
  messages: ChatMessage[];
  contextWindow: number;
  maxTokens: number;
  minTailMessages?: number;
  compactAt?: number;
  toolSchemaTokens?: number;
  force?: boolean;
  /** Enable enhanced compaction (importance scoring, chunking). Default: true */
  enhanced?: boolean;
  /** Max chars for tool result compression. Default: 1200 */
  compressionMaxChars?: number;
}): CompactionResult {
  const { contextWindow, maxTokens } = opts;
  const minTail = opts.force ? 2 : (opts.minTailMessages ?? 20);
  const enhanced = opts.enhanced !== false;
  const compressionMaxChars = opts.compressionMaxChars ?? 1200;

  const toolOverhead = opts.toolSchemaTokens ?? 800;
  const safetyMargin = 2048 + toolOverhead;
  const budget = Math.max(1024, contextWindow - maxTokens - safetyMargin);
  
  const compactAt = opts.force
    ? 0.5
    : Number.isFinite(opts.compactAt)
      ? Math.min(0.95, Math.max(0.5, Number(opts.compactAt)))
      : 0.8;
  const threshold = Math.floor(budget * compactAt);

  let msgs = [...opts.messages];
  const beforeCount = msgs.length;
  const beforeTokens = estimateTokensFromMessages(msgs);
  const allDropped: ChatMessage[] = [];
  let chunksDropped = 0;
  let messagesCompressed = 0;

  // Early exit if under threshold
  if (!opts.force && beforeTokens <= threshold) {
    return {
      messages: msgs,
      dropped: [],
      keyFacts: [],
      stats: {
        beforeCount,
        afterCount: msgs.length,
        beforeTokens,
        afterTokens: beforeTokens,
        freedTokens: 0,
        chunksDropped: 0,
        messagesCompressed: 0,
      },
    };
  }

  const sysStart = msgs[0]?.role === 'system' ? 1 : 0;
  let currentTokens = beforeTokens;

  // Find protected assistant index
  let protectedIdx = -1;
  for (let i = msgs.length - 1; i >= sysStart; i--) {
    const m = msgs[i];
    if (
      m.role === 'assistant' &&
      !(m as any).tool_calls?.length &&
      messageContentChars((m as any).content) > 50
    ) {
      protectedIdx = i;
      break;
    }
  }

  // ENHANCEMENT: Compress tool results first (reduces tokens without losing messages)
  if (enhanced) {
    const beforeCompression = currentTokens;
    msgs = msgs.map((msg, idx) => {
      if (msg.role !== 'tool') return msg;
      if (idx >= msgs.length - minTail) return msg; // Don't compress recent
      
      const content = (msg as any).content;
      if (typeof content !== 'string' || content.length <= compressionMaxChars) return msg;
      
      messagesCompressed++;
      return {
        ...msg,
        content: compressToolResult(content, compressionMaxChars),
      } as ChatMessage;
    });
    currentTokens = estimateTokensFromMessages(msgs);
    
    if (currentTokens <= threshold && !opts.force) {
      return {
        messages: msgs,
        dropped: [],
        keyFacts: [],
        stats: {
          beforeCount,
          afterCount: msgs.length,
          beforeTokens,
          afterTokens: currentTokens,
          freedTokens: beforeCompression - currentTokens,
          chunksDropped: 0,
          messagesCompressed,
        },
      };
    }
  }

  // ENHANCEMENT: Use semantic chunking with importance scoring
  if (enhanced && msgs.length > minTail + 5) {
    const chunks = buildSemanticChunks(msgs, sysStart);
    
    // Sort chunks by score (lowest first = drop first)
    // But protect the last chunk (recent context)
    const droppableChunks = chunks.slice(0, -1).sort((a, b) => a.score - b.score);
    const protectedChunk = chunks[chunks.length - 1];
    
    // Drop lowest-scored chunks until under threshold
    const keptChunks: MessageChunk[] = [];
    let keptTokens = protectedChunk ? protectedChunk.tokenEstimate : 0;
    
    // Add system message tokens
    if (sysStart === 1) {
      keptTokens += estimateTokensFromMessages([msgs[0]]);
    }
    
    // Keep chunks from highest score down until we'd exceed budget
    const sortedByScoreDesc = [...droppableChunks].sort((a, b) => b.score - a.score);
    
    for (const chunk of sortedByScoreDesc) {
      if (keptTokens + chunk.tokenEstimate <= threshold || keptChunks.length < 2) {
        keptChunks.push(chunk);
        keptTokens += chunk.tokenEstimate;
      } else {
        // This chunk will be dropped
        allDropped.push(...chunk.messages);
        chunksDropped++;
      }
    }
    
    // Rebuild messages array in original order
    const keptChunkStarts = new Set(keptChunks.map(c => c.startIdx));
    const newMsgs: ChatMessage[] = [];
    
    // Keep system message
    if (sysStart === 1) {
      newMsgs.push(msgs[0]);
    }
    
    // Add kept chunks in order
    for (const chunk of chunks) {
      if (keptChunkStarts.has(chunk.startIdx) || chunk === protectedChunk) {
        newMsgs.push(...chunk.messages);
      }
    }
    
    if (newMsgs.length < msgs.length) {
      msgs = newMsgs;
      currentTokens = estimateTokensFromMessages(msgs);
    }
  }

  // Fallback: Original algorithm if still over budget
  // Phase 1: drop oldest tool-call exchange groups first
  while (msgs.length > 2 && currentTokens > threshold) {
    if (msgs.length - sysStart <= minTail) break;
    const groupIdx = findOldestToolCallGroup(msgs, sysStart, msgs.length - minTail, protectedIdx);
    if (groupIdx === -1) break;
    
    const groupEnd = findGroupEnd(msgs, groupIdx);
    if (protectedIdx > groupIdx) protectedIdx -= groupEnd - groupIdx;
    
    const dropped = msgs.splice(groupIdx, groupEnd - groupIdx);
    allDropped.push(...dropped);
    
    for (const d of dropped) {
      currentTokens -= Math.ceil((messageContentChars((d as any).content) + 20) / 4);
    }
  }

  // Phase 2: drop any oldest messages if still over budget
  while (msgs.length > 2 && currentTokens > threshold) {
    if (msgs.length - sysStart <= minTail) break;
    if (sysStart === protectedIdx) break;
    
    const [removed] = msgs.splice(sysStart, 1);
    allDropped.push(removed);
    if (protectedIdx > sysStart) protectedIdx--;
    currentTokens -= Math.ceil((messageContentChars((removed as any).content) + 20) / 4);
  }

  // Extract key facts from dropped messages
  const keyFacts = enhanced ? extractKeyFacts(allDropped) : [];

  const afterTokens = estimateTokensFromMessages(msgs);
  const dropped = beforeCount - msgs.length;
  
  if (dropped > 0) {
    const freed = beforeTokens - afterTokens;
    const usedPct = budget > 0 ? ((beforeTokens / budget) * 100).toFixed(1) : '?';
    console.error(
      `[auto-compact] Approaching context limit (${usedPct}%) - compacting ${dropped} old turns, ~${freed} tokens freed` +
      (enhanced ? ` (${chunksDropped} chunks, ${messagesCompressed} compressed, ${keyFacts.length} facts extracted)` : '')
    );
  }

  return {
    messages: msgs,
    dropped: allDropped,
    keyFacts,
    stats: {
      beforeCount,
      afterCount: msgs.length,
      beforeTokens,
      afterTokens,
      freedTokens: beforeTokens - afterTokens,
      chunksDropped,
      messagesCompressed,
    },
  };
}

// ============================================================================
// Test Output Compression (#6)
// ============================================================================

const TEST_OUTPUT_RE = /(FAIL|PASS|Tests?:|\u2713|\u2717|\u2714|\u2718|\d+ passing|\d+ failing)/;

/** Detect if output looks like test runner output. */
export function looksLikeTestOutput(output: string): boolean {
  return TEST_OUTPUT_RE.test(output);
}

const PASSING_LINE_RE = /^\s*(\u2713|\u2714|ok \d+|PASS\s)/;
const SUMMARY_LINE_RE = /^\s*(\d+ (passing|failing|pending|skipped|Tests?|test suites?)|Tests?:|Test Suites?:)/i;
const FAILING_LINE_RE = /^\s*(\u2717|\u2718|not ok|FAIL\s|AssertionError|Error:|at\s)/;
const ERROR_TRACE_RE = /^\s+(at |Error:|Caused by:|\^)/;

/**
 * Compress test output by stripping passing test lines while keeping
 * failures, error traces, and summary lines. Prepends count of omitted lines.
 */
export function compressTestOutput(output: string, maxChars = 1500): string {
  const lines = output.split('\n');
  const kept: string[] = [];
  let omittedPassing = 0;

  for (const line of lines) {
    if (PASSING_LINE_RE.test(line)) {
      omittedPassing++;
      continue;
    }
    if (FAILING_LINE_RE.test(line) || ERROR_TRACE_RE.test(line) || SUMMARY_LINE_RE.test(line)) {
      kept.push(line);
      continue;
    }
    // Skip consecutive blank lines
    if (line.trim() === '' && kept.length > 0 && kept[kept.length - 1]?.trim() === '') {
      continue;
    }
    kept.push(line);
  }

  let result = kept.join('\n');
  if (omittedPassing > 0) {
    result = `[${omittedPassing} passing tests omitted]\n` + result;
  }

  // Final truncation if still too large
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 60) + `\n... [truncated, ${output.length} chars total]`;
  }

  return result;
}

// ============================================================================
// Rolling Compression of Old Tool Results
// ============================================================================

/**
 * Compress an exec tool result, preserving rc and err fields intact.
 * Only the `out` field is compressed via compressToolResult.
 * Falls back to generic compression if content is not valid exec JSON.
 */
export function compressExecResult(content: string, maxChars = 1500): string {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && 'rc' in parsed) {
      const compressed = {
        rc: parsed.rc,
        out: typeof parsed.out === 'string'
          ? (looksLikeTestOutput(parsed.out)
              ? compressTestOutput(parsed.out, maxChars - 200)
              : compressToolResult(parsed.out, maxChars - 200))
          : parsed.out,
        err: parsed.err,
      };
      return JSON.stringify(compressed);
    }
  } catch {
    // Not valid JSON — fall through to generic compression
  }
  return compressToolResult(content, maxChars);
}

const ROLLING_TARGET_TOOLS = new Set(['read_file', 'read_files', 'exec']);
const ROLLING_MARKER = '\n[rolling-compressed]';

/**
 * Rolling compression: shrink old read_file/read_files/exec tool results
 * beyond a "fresh window" of recent messages. Runs every turn before
 * enforceContextBudget to slow context growth.
 *
 * Pure string manipulation — zero LLM cost.
 */
export function rollingCompressToolResults(opts: {
  messages: ChatMessage[];
  freshCount: number;
  maxChars: number;
  toolNameByCallId: Map<string, string>;
  toolArgsByCallId?: Map<string, Record<string, unknown>>;
  editedPaths?: Set<string>;
}): { messages: ChatMessage[]; compressedCount: number; charsSaved: number } {
  const { freshCount, maxChars, toolNameByCallId, toolArgsByCallId, editedPaths } = opts;
  const messages = [...opts.messages];
  const cutoff = messages.length - freshCount;
  let compressedCount = 0;
  let charsSaved = 0;

  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool') continue;

    const content = (msg as any).content;
    if (typeof content !== 'string') continue;

    // Skip already-compressed results
    if (content.endsWith('[rolling-compressed]')) continue;

    // Skip if already small enough
    if (content.length <= maxChars) continue;

    // Only target the exempted tools
    const toolName = toolNameByCallId.get((msg as any).tool_call_id ?? '') ?? '';
    if (!ROLLING_TARGET_TOOLS.has(toolName)) continue;

    const before = content.length;
    const compressed = toolName === 'exec'
      ? compressExecResult(content, maxChars)
      : compressToolResult(content, maxChars);

    messages[i] = {
      ...msg,
      content: compressed + ROLLING_MARKER,
    } as ChatMessage;

    charsSaved += before - (compressed.length + ROLLING_MARKER.length);
    compressedCount++;
  }

  // ── Second pass: deduplicate repeated file reads (#5) ──
  // Group read_file tool messages (outside fresh window) by file path.
  // Keep only the latest read per file; replace earlier reads with stubs.
  if (toolArgsByCallId) {
    // Collect read_file messages by path
    const readsByPath = new Map<string, number[]>(); // path -> message indices
    for (let i = 0; i < cutoff; i++) {
      const msg = messages[i];
      if (msg.role !== 'tool') continue;
      const callId = (msg as any).tool_call_id ?? '';
      const toolName = toolNameByCallId.get(callId) ?? '';
      if (toolName !== 'read_file') continue;
      const args = toolArgsByCallId.get(callId);
      const filePath = typeof args?.path === 'string' ? args.path : '';
      if (!filePath) continue;
      const indices = readsByPath.get(filePath) ?? [];
      indices.push(i);
      readsByPath.set(filePath, indices);
    }

    // For each file with multiple reads, keep only the latest
    for (const [filePath, indices] of readsByPath) {
      if (indices.length <= 1) continue;
      // Keep the last one, stub the rest
      const toStub = indices.slice(0, -1);
      for (const idx of toStub) {
        const msg = messages[idx];
        const oldContent = (msg as any).content;
        if (typeof oldContent !== 'string') continue;
        // Skip already-compressed, cache-hit, or short messages
        if (oldContent.startsWith('[CACHE HIT]') || oldContent.startsWith('[previously read') || oldContent.startsWith('Error:')) continue;
        const stub = `[previously read ${filePath} — see latest version in conversation]`;
        if (oldContent.length > stub.length) {
          charsSaved += oldContent.length - stub.length;
          compressedCount++;
          messages[idx] = { ...msg, content: stub } as ChatMessage;
        }
      }
    }
  }

  // ── Third pass: compress acted-on reads (#4) ──
  // If a file was subsequently edited, its prior read content is less valuable.
  // Compress it to a short stub.
  if (editedPaths && editedPaths.size > 0 && toolArgsByCallId) {
    for (let i = 0; i < cutoff; i++) {
      const msg = messages[i];
      if (msg.role !== 'tool') continue;
      const callId = (msg as any).tool_call_id ?? '';
      const toolName = toolNameByCallId.get(callId) ?? '';
      if (toolName !== 'read_file') continue;
      const args = toolArgsByCallId.get(callId);
      const filePath = typeof args?.path === 'string' ? args.path : '';
      if (!filePath || !editedPaths.has(filePath)) continue;

      const oldContent = (msg as any).content;
      if (typeof oldContent !== 'string') continue;
      // Skip if already stubbed by dedup pass
      if (oldContent.startsWith('[previously read')) continue;
      // Extract first line as header
      const firstLine = oldContent.split('\n')[0]?.slice(0, 80) ?? filePath;
      const stub = `${firstLine}\n[acted-on: file was subsequently edited]`;
      if (oldContent.length > stub.length + 50) {
        charsSaved += oldContent.length - stub.length;
        compressedCount++;
        messages[i] = { ...msg, content: stub } as ChatMessage;
      }
    }
  }

  return { messages, compressedCount, charsSaved };
}
