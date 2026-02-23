/**
 * Auto-continue on tool-loop breaks.
 *
 * When the agent hits a critical tool-loop and throws AgentLoopBreak,
 * this module detects it and automatically retries with a "Continue" prompt,
 * up to a configurable max (default 5). Each retry notifies the user.
 */

/** Check if an error is an AgentLoopBreak (tool-loop critical failure). */
export function isToolLoopBreak(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as Error;
  return (
    err.name === 'AgentLoopBreak' ||
    (typeof err.message === 'string' && err.message.includes('tool-loop'))
  );
}

/** Format a user-facing notification for an auto-continue retry. */
export function formatAutoContinueNotice(
  errorMessage: string,
  attempt: number,
  maxRetries: number,
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
