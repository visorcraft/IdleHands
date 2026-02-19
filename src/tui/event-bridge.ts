import type { ToolCallEvent, ToolResultEvent } from '../types.js';
import type { TuiEvent } from './events.js';

export type TuiDispatch = (ev: TuiEvent) => void;

export interface AgentBridgeHooks {
  onStreamStart(id: string): void;
  onStreamToken(id: string, token: string): void;
  onStreamDone(id: string): void;
  onToolCall(call: ToolCallEvent): void;
  onToolResult(result: ToolResultEvent): void;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

function summarizeArgs(args: Record<string, unknown>): string {
  try {
    const raw = JSON.stringify(args);
    return raw ? truncate(raw, 140) : '';
  } catch {
    return '';
  }
}

export function createAgentBridge(dispatch: TuiDispatch): AgentBridgeHooks {
  const startTsById = new Map<string, number>();
  return {
    onStreamStart: (id) => dispatch({ type: 'AGENT_STREAM_START', id }),
    onStreamToken: (id, token) => dispatch({ type: 'AGENT_STREAM_TOKEN', id, token }),
    onStreamDone: (id) => dispatch({ type: 'AGENT_STREAM_DONE', id }),
    onToolCall: (call) => {
      startTsById.set(call.id, Date.now());
      dispatch({
        type: 'TOOL_START',
        id: call.id,
        name: call.name,
        summary: `start ${call.name}`,
        detail: summarizeArgs(call.args),
      });
    },
    onToolResult: (result) => {
      const startedAt = startTsById.get(result.id);
      startTsById.delete(result.id);
      const durationMs = startedAt == null ? undefined : Math.max(0, Date.now() - startedAt);
      dispatch({
        type: result.success ? 'TOOL_END' : 'TOOL_ERROR',
        id: result.id,
        name: result.name,
        summary: result.summary,
        detail: result.result ?? result.summary,
        durationMs,
      });
    },
  };
}
