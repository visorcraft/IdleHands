import type { ToolCallEvent, ToolResultEvent, TurnEndEvent, ToolStreamEvent, ToolLoopEvent } from '../types.js';

export const HOOK_CAPABILITIES = [
  'observe',
  'read_prompts',
  'read_responses',
  'read_tool_args',
  'read_tool_results',
] as const;

export type HookCapability = (typeof HOOK_CAPABILITIES)[number];

export type HookEventMap = {
  session_start: {
    model: string;
    harness: string;
    endpoint: string;
    cwd: string;
  };
  model_changed: {
    previousModel: string;
    nextModel: string;
    harness: string;
  };
  ask_start: {
    askId: string;
    instruction: string;
  };
  ask_end: {
    askId: string;
    text: string;
    turns: number;
    toolCalls: number;
  };
  ask_error: {
    askId: string;
    error: string;
    turns: number;
    toolCalls: number;
  };
  turn_start: {
    askId: string;
    turn: number;
  };
  turn_end: {
    askId: string;
    stats: TurnEndEvent;
  };
  tool_call: {
    askId: string;
    turn: number;
    call: ToolCallEvent;
  };
  tool_result: {
    askId: string;
    turn: number;
    result: ToolResultEvent;
  };
  tool_stream: {
    askId: string;
    turn: number;
    stream: ToolStreamEvent;
  };
  tool_loop: {
    askId: string;
    turn: number;
    loop: ToolLoopEvent;
  };
};

export type HookEventName = keyof HookEventMap;

export type HookDispatchContext = {
  sessionId: string;
  cwd: string;
  model: string;
  harness: string;
  endpoint: string;
};

export type HookHandler<E extends HookEventName = HookEventName> = (
  payload: HookEventMap[E],
  context: HookDispatchContext
) => void | Promise<void>;

export type HookPlugin = {
  name?: string;
  /** Requested capabilities. Default: ['observe'] */
  capabilities?: HookCapability[];
  hooks?: Partial<{ [K in HookEventName]: HookHandler<K> | HookHandler<K>[] }>;
  setup?: (api: HookRegistrationApi) => void | Promise<void>;
};

export type HookRegistrationApi = {
  on: <E extends HookEventName>(event: E, handler: HookHandler<E>) => void;
  context: HookDispatchContext;
};

export type HookSystemConfig = {
  enabled?: boolean;
  strict?: boolean;
  plugin_paths?: string[];
  warn_ms?: number;
  /** Allowed plugin capabilities. Default: ['observe'] */
  allow_capabilities?: HookCapability[];
};

export type HookLog = (message: string) => void;

export type HookPluginInfo = {
  source: string;
  name: string;
  requestedCapabilities: HookCapability[];
  grantedCapabilities: HookCapability[];
  deniedCapabilities: HookCapability[];
};

export type HookHandlerInfo = {
  source: string;
  event: HookEventName;
};

export type HookStatsSnapshot = {
  enabled: boolean;
  strict: boolean;
  allowedCapabilities: HookCapability[];
  plugins: HookPluginInfo[];
  handlers: HookHandlerInfo[];
  eventCounts: Partial<Record<HookEventName, number>>;
  recentErrors: string[];
  recentSlowHandlers: string[];
};
