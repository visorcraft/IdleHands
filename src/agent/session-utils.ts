import type { ApprovalMode, UserContent } from '../types.js';

/** Node 24: AbortController is global. Wrapped for future portability. */
export function makeAbortController(): AbortController {
  return new AbortController();
}

/** Ensure assistant always emits user-visible text for a turn. */
export function ensureInformativeAssistantText(
  text: string,
  ctx: { toolCalls: number; turns: number }
): string {
  if (String(text ?? '').trim()) return text;

  if (ctx.toolCalls > 0) {
    return 'I completed the requested tool work, but I have no user-visible response text yet. Ask me to summarize what was done.';
  }

  return `I have no user-visible response text for this turn (turn=${ctx.turns}). Please try again or rephrase your request.`;
}

/** Detect context-window/token-limit style errors from provider responses. */
export function isContextWindowExceededError(err: unknown): boolean {
  const status = Number((err as any)?.status ?? NaN);
  const msg = String((err as any)?.message ?? err ?? '');

  if (status === 413) return true;
  if (!msg) return false;

  return /(exceeds?\s+the\s+available\s+context\s+size|exceed_context|context\s+size|context\s+window|maximum\s+context\s+length|too\s+many\s+tokens|request\s*\(\d+\s*tokens\))/i.test(
    msg
  );
}

/** Approval mode permissiveness ranking (lower = more restrictive). */
const APPROVAL_MODE_RANK: Record<ApprovalMode, number> = {
  plan: 0,
  reject: 1,
  default: 2,
  'auto-edit': 3,
  yolo: 4,
};

/** Cap a sub-agent's approval mode at the parent's level. */
export function capApprovalMode(requested: ApprovalMode, parentMode: ApprovalMode): ApprovalMode {
  return APPROVAL_MODE_RANK[requested] <= APPROVAL_MODE_RANK[parentMode] ? requested : parentMode;
}

/** Flatten user content (text or rich parts) into plain text. */
export function userContentToText(content: UserContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p: any) => p.text)
    .join('\n')
    .trim();
}

const DELEGATION_MENTION_RE = /\b(?:spawn[_\-\s]?task|sub[\-\s]?agents?|delegate|delegation)\b/;
const NEGATION_BEFORE_DELEGATION_RE =
  /\b(?:do not|don't|dont|no|without|avoid|skip|never)\b[^\n.]{0,90}\b(?:spawn[_\-\s]?task|sub[\-\s]?agents?|delegate|delegation)\b/;
const NEGATION_AFTER_DELEGATION_RE =
  /\b(?:spawn[_\-\s]?task|sub[\-\s]?agents?|delegate|delegation)\b[^\n.]{0,50}\b(?:do not|don't|dont|not allowed|forbidden|no)\b/;

/** Honor explicit anti-delegation instructions in user prompt. */
export function userDisallowsDelegation(content: UserContent): boolean {
  const text = userContentToText(content).toLowerCase();
  if (!text) return false;

  if (!DELEGATION_MENTION_RE.test(text)) return false;
  return NEGATION_BEFORE_DELEGATION_RE.test(text) || NEGATION_AFTER_DELEGATION_RE.test(text);
}
