/**
 * Context-aware tool result truncation.
 * 
 * Prevents oversized tool results from blowing out the context window
 * by pre-truncating before they enter history.
 */

import type { ChatMessage } from '../types.js';

// Constants
const DEFAULT_MAX_SINGLE_RESULT_SHARE = 0.4; // 40% of context max
const MIN_KEEP_CHARS = 1000;
const CHARS_PER_TOKEN = 4;

// Use same format as lens.compactRaw for consistency
const TRUNCATION_NOTICE_PREFIX = '\n[truncated, ';
const TRUNCATION_NOTICE_SUFFIX = ' chars total]';

export type ContextBudgetConfig = {
  /** Context window size in tokens */
  contextWindow: number;
  /** Max share of context for a single result (default: 0.4 = 40%) */
  maxSingleResultShare?: number;
  /** Minimum chars to keep when truncating (default: 1000) */
  minKeepChars?: number;
};

/**
 * Build truncation notice with total char count (matches lens.compactRaw format).
 */
function makeTruncationNotice(totalChars: number): string {
  return `${TRUNCATION_NOTICE_PREFIX}${totalChars}${TRUNCATION_NOTICE_SUFFIX}`;
}

/**
 * Truncate text to a target length, trying to break at newlines.
 */
function truncateText(text: string, maxChars: number, originalLength: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  
  const notice = makeTruncationNotice(originalLength);
  
  if (maxChars <= notice.length) {
    return notice;
  }
  
  const bodyBudget = maxChars - notice.length;
  if (bodyBudget <= MIN_KEEP_CHARS) {
    return text.slice(0, MIN_KEEP_CHARS) + notice;
  }
  
  // Try to break at a newline
  let cutPoint = bodyBudget;
  const newlinePos = text.lastIndexOf('\n', bodyBudget);
  if (newlinePos > bodyBudget * 0.7) {
    cutPoint = newlinePos;
  }
  
  return text.slice(0, cutPoint) + notice;
}

/**
 * Calculate max chars for a single tool result based on context window.
 */
function calculateMaxChars(
  contextWindow: number,
  config?: Partial<ContextBudgetConfig>
): number {
  const share = config?.maxSingleResultShare ?? DEFAULT_MAX_SINGLE_RESULT_SHARE;
  const maxTokens = Math.floor(contextWindow * share);
  return maxTokens * CHARS_PER_TOKEN;
}

/**
 * Truncate a tool result if it exceeds the context budget.
 * 
 * @param content - The tool result content
 * @param contextWindow - Context window size in tokens
 * @param config - Optional configuration overrides
 * @returns Object with truncated content and metadata
 */
export function truncateToolResultContent(
  content: string,
  contextWindow: number,
  config?: Partial<ContextBudgetConfig>
): { content: string; truncated: boolean; originalLength: number } {
  const originalLength = content.length;
  const maxChars = calculateMaxChars(contextWindow, config);
  
  if (originalLength <= maxChars) {
    return { content, truncated: false, originalLength };
  }
  
  const truncated = truncateText(content, maxChars, originalLength);
  return {
    content: truncated,
    truncated: true,
    originalLength,
  };
}

/**
 * Get content from a tool message.
 */
function getToolResultContent(msg: ChatMessage): string {
  const content = (msg as any).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n');
  }
  return '';
}

/**
 * Enforce context budget on tool result messages.
 * Returns messages with oversized tool results truncated.
 */
export function enforceToolResultBudget(
  messages: ChatMessage[],
  contextWindow: number,
  config?: Partial<ContextBudgetConfig>
): ChatMessage[] {
  const maxChars = calculateMaxChars(contextWindow, config);
  
  return messages.map(msg => {
    if (msg.role !== 'tool') return msg;
    
    const content = getToolResultContent(msg);
    if (content.length <= maxChars) return msg;
    
    const truncated = truncateText(content, maxChars, content.length);
    return { ...msg, content: truncated } as ChatMessage;
  });
}
