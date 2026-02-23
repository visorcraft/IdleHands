import type { AgentHooks } from '../agent.js';

/**
 * Chain multiple AgentHooks into one, calling each handler in order.
 * Frontends can keep their existing hook logic and just add progress hooks.
 */
export function chainAgentHooks(...items: Array<AgentHooks | undefined | null>): AgentHooks {
  const hooks = items.filter(Boolean) as AgentHooks[];
  if (hooks.length === 0) return {};

  const chain = <K extends keyof AgentHooks>(key: K) => {
    const fns = hooks.map((h) => h[key]).filter(Boolean) as Array<(...args: any[]) => any>;
    if (!fns.length) return undefined;

    return (...args: any[]) => {
      for (const fn of fns) {
        try {
          fn(...args);
        } catch (e) {
          // Never let UI progress crash the agent turn.
          if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
            console.warn(`[progress] chained hook ${String(key)} threw:`, e);
          }
        }
      }
    };
  };

  return {
    signal: hooks.find((h) => h.signal)?.signal,
    onToken: chain('onToken'),
    onFirstDelta: chain('onFirstDelta'),
    onToolCall: chain('onToolCall'),
    onToolStream: chain('onToolStream'),
    onToolResult: chain('onToolResult'),
    onTurnEnd: chain('onTurnEnd'),
  };
}
