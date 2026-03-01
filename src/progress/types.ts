/**
 * Progress tracking types for IdleHands Discord streaming.
 * Adapted from IdleHands.
 */

export type ToolCallEvent = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
};

export type ToolResultEvent = {
  id: string;
  name: string;
  success: boolean;
  summary: string;
  errorCode?: string;
};

export type TurnEndEvent = {
  turn: number;
  toolCalls: number;
  ttftMs?: number;
  ttcMs?: number;
  ppTps?: number;
  tgTps?: number;
  promptTokensTurn?: number;
  completionTokensTurn?: number;
  /** Current context window usage (for local models) */
  contextTokens?: number;
};

export type ToolStreamEvent = {
  id: string;
  stream: "stdout" | "stderr";
  text: string;
};

export type ProgressPhase = "thinking" | "tool" | "responding" | "done";

export type ProgressSnapshot = {
  phase: ProgressPhase;
  elapsedMs: number;
  statusLine: string;
  toolLines: string[];
  activeTool?: {
    name: string;
    summary: string;
    elapsedMs: number;
  };
  /** Current turn number */
  turnCount: number;
  /** Total tool calls made */
  totalToolCalls: number;
  /** Total prompt tokens used */
  totalPromptTokens: number;
  /** Total completion tokens generated */
  totalCompletionTokens: number;
  /** Current context window size (for local models) */
  contextTokens?: number;
  /** Stats from last turn end event */
  lastTurnStats?: TurnEndEvent;
};

export type ProgressHooks = {
  onToken?: (token: string) => void;
  onFirstDelta?: () => void;
  onToolCall?: (call: ToolCallEvent) => void;
  onToolStream?: (event: ToolStreamEvent) => void;
  onToolResult?: (result: ToolResultEvent) => void;
  onTurnEnd?: (stats: TurnEndEvent) => void;
};
