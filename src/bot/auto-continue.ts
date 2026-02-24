/**
 * Auto-continue on tool-loop breaks.
 *
 * When the agent hits a critical tool-loop and throws AgentLoopBreak,
 * this module detects it and automatically retries with a "Continue" prompt,
 * up to a configurable max (default 3). Each retry notifies the user.
 */

/** Check if an error is a tool-loop break that can be auto-continued. */
export function isToolLoopBreak(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: string; message?: string; code?: string };

  if (err.name === 'AgentLoopBreak' || err.code === 'AGENT_LOOP_BREAK') {
    return true;
  }

  const msg = String(err.message ?? '').toLowerCase();
  if (!msg) return false;

  // Canonical loop-break wording.
  if (msg.includes('tool-loop')) return true;

  // Legacy/plain Error wording emitted by loop guards:
  // "tool edit_range: identical call repeated 3x across turns; breaking loop."
  if (msg.includes('identical call repeated') && msg.includes('breaking loop')) return true;

  // Recovery hard-stop wording.
  if (msg.includes('critical') && msg.includes('loop') && msg.includes('stopping')) return true;

  return false;
}

/** Format a user-facing notification for an auto-continue retry. */
export function formatAutoContinueNotice(
  errorMessage: string,
  attempt: number,
  maxRetries: number
): string {
  const truncated = errorMessage.length > 200 ? errorMessage.slice(0, 197) + '...' : errorMessage;
  return (
    `⚠️ Tool loop detected: ${truncated}\n\n` +
    `🔄 Automatically continuing the task. (retry ${attempt} of ${maxRetries})`
  );
}

/** The prompt sent to the agent on auto-continue. */
export const AUTO_CONTINUE_PROMPT =
  'Continue working on the task from where you left off. A tool loop was detected and automatically recovered — do NOT restart from the beginning.';
