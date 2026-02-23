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
