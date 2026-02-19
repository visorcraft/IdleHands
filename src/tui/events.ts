import type { ActiveRuntimeView, PanelId } from "./types.js";

export type TuiEvent =
  | { type: "USER_INPUT_CHANGE"; text: string }
  | { type: "USER_INPUT_INSERT"; text: string }
  | { type: "USER_INPUT_BACKSPACE" }
  | { type: "USER_INPUT_DELETE_FORWARD" }
  | { type: "USER_INPUT_CURSOR_MOVE"; delta: number }
  | { type: "USER_INPUT_CURSOR_HOME" }
  | { type: "USER_INPUT_CURSOR_END" }
  | { type: "USER_INPUT_HISTORY_PREV" }
  | { type: "USER_INPUT_HISTORY_NEXT" }
  | { type: "USER_INPUT_SUBMIT"; text: string }
  | { type: "AGENT_STREAM_START"; id: string }
  | { type: "AGENT_STREAM_TOKEN"; id: string; token: string }
  | { type: "AGENT_STREAM_DONE"; id: string }
  | { type: "TOOL_START"; id: string; name: string; summary?: string; detail?: string; durationMs?: number }
  | { type: "TOOL_END"; id: string; name: string; summary?: string; detail?: string; durationMs?: number }
  | { type: "TOOL_ERROR"; id: string; name: string; summary?: string; detail?: string; durationMs?: number }
  | { type: "RUNTIME_STATE_UPDATE"; runtime: ActiveRuntimeView | null }
  | { type: "ALERT_PUSH"; id: string; level: "info" | "warn" | "error"; text: string }
  | { type: "ALERT_CLEAR"; id?: string }
  | { type: "CONFIRM_SHOW"; tool: string; summary: string; args?: Record<string, unknown>; diff?: string }
  | { type: "CONFIRM_TOGGLE_DIFF" }
  | { type: "CONFIRM_DISMISS" }
  | { type: "FOCUS_SET"; panel: PanelId }
  | { type: "SCROLL"; panel: PanelId; delta: number }
  | { type: "BRANCH_PICKER_OPEN"; branches: import('./types.js').BranchPickerItem[]; action: 'checkout' | 'merge' | 'browse' }
  | { type: "BRANCH_PICKER_MOVE"; delta: number }
  | { type: "BRANCH_PICKER_CLOSE" };
