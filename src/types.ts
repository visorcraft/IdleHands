export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type UserContent = string | UserContentPart[];

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: UserContent }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export type ToolSchema = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    // OpenAI style JSON schema
    parameters: Record<string, unknown>;
  };
};

export type ToolCall = {
  id: string;
  index?: number;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
};

export type ChatCompletionResponse = {
  id: string;
  model?: string;
  choices: Array<{
    index: number;
    message?: {
      role: 'assistant';
      content?: string | null;
      tool_calls?: ToolCall[];
    };
    delta?: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: Array<ToolCall>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export type ModelsResponse = {
  object: 'list';
  data: Array<{
    id: string;
    object?: string;
    created?: number;
    owned_by?: string;
    // Some servers add these:
    context_window?: number;
    context_length?: number;
    max_context_length?: number;
  }>;
};

export type TrifectaMode = 'active' | 'passive' | 'off';

export type OutputFormat = 'text' | 'json' | 'stream-json';

export type McpServerConfig = {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
  enabled_tools?: string[];
};

export type McpConfig = {
  servers?: McpServerConfig[];
  enabled_tools?: string[];
  tool_budget?: number;
  call_timeout_sec?: number;
};

export type LspServerEntry = {
  language: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
};

export type LspConfig = {
  enabled?: boolean;
  servers?: LspServerEntry[];
  auto_detect?: boolean;
  proactive_diagnostics?: boolean;
  diagnostic_severity_threshold?: number;  // 1=Error, 2=Warning, 3=Info, 4=Hint
};

export type SubAgentConfig = {
  enabled?: boolean;
  max_iterations?: number;
  max_tokens?: number;
  timeout_sec?: number;
  result_token_cap?: number;
  system_prompt?: string;
  model?: string;
  endpoint?: string;
  approval_mode?: ApprovalMode;
  inherit_context_file?: boolean;
  inherit_vault?: boolean;
};

export type TrifectaConfig = {
  enabled?: boolean;
  vault?: {
    enabled?: boolean;
    mode?: TrifectaMode;
  };
  lens?: {
    enabled?: boolean;
  };
  replay?: {
    enabled?: boolean;
  };
};

export type IdlehandsConfig = {
  endpoint: string;
  model?: string;
  dir?: string;

  // generation
  max_tokens: number;
  temperature: number;
  top_p: number;

  // loop
  timeout: number;
  max_iterations: number;

  // network
  response_timeout: number;  // seconds to wait for model server responses (default 300)

  // safety + UX
  approval_mode: ApprovalMode;
  no_confirm: boolean;       // legacy — maps to approval_mode 'yolo' when true
  verbose: boolean;
  quiet?: boolean;
  dry_run: boolean;
  output_format?: OutputFormat;
  fail_on_error?: boolean;
  diff_only?: boolean;

  // mode (Phase 9)
  mode?: 'code' | 'sys';
  sys_eager?: boolean;

  // local-server / perf
  context_window?: number;
  cache_prompt?: boolean;
  i_know_what_im_doing?: boolean;

  // appearance
  theme?: string;
  vim_mode?: boolean;

  // harness + context bootstrap
  harness?: string;
  context_file?: string;
  no_context?: boolean;
  context_file_names?: string[];
  context_max_tokens?: number;
  compact_at?: number;
  show_change_summary?: boolean;
  step_mode?: boolean;
  editor?: string;

  // Prompt customization
  system_prompt_override?: string;

  // Server observability / resilience (Phase 15)
  show_server_metrics?: boolean;
  auto_detect_model_change?: boolean;
  slow_tg_tps_threshold?: number;

  // Trifecta subsystems
  trifecta?: TrifectaConfig;

  // LSP integration (Phase 17)
  lsp?: LspConfig;

  // Sub-agent delegation (Phase 18)
  sub_agents?: SubAgentConfig;

  // MCP integration
  mcp?: McpConfig;
  mcp_tool_budget?: number;
  mcp_call_timeout_sec?: number;

  // Anton autonomous task runner
  anton?: {
    max_retries?: number;
    max_iterations?: number;
    task_timeout_sec?: number;
    total_timeout_sec?: number;
    max_total_tokens?: number;
    verify_ai?: boolean;
    verify_model?: string;
    decompose?: boolean;
    max_decompose_depth?: number;
    max_total_tasks?: number;
    skip_on_fail?: boolean;
    approval_mode?: string;
    verbose?: boolean;
    auto_commit?: boolean;
  };

  // Bot frontends
  bot?: BotConfig;

  // Upgrade / connectivity
  install_source?: 'github' | 'npm' | 'unknown';
  auto_update_check?: boolean;
  offline?: boolean;
};

// --- Approval modes (Phase 8) ---

export type ApprovalMode = 'plan' | 'reject' | 'default' | 'auto-edit' | 'yolo';

/**
 * Frontend-agnostic confirmation interface (§8e).
 * Implementations: TerminalConfirmProvider, AutoApproveProvider,
 * HeadlessConfirmProvider, bot/confirm-telegram, bot/confirm-discord.
 */
export interface ConfirmationProvider {
  /** Confirm a single action. Returns true to approve, false to reject. */
  confirm(opts: ConfirmRequest): Promise<boolean>;
  /** Confirm a batch of actions (plan mode). Returns per-action decisions. */
  confirmPlan?(opts: ConfirmPlanRequest): Promise<PlanDecision[]>;
  /** Called when an action is blocked (informational). */
  showBlocked?(opts: BlockedNotice): Promise<void>;
}

export type ConfirmRequest = {
  tool: string;
  args: Record<string, unknown>;
  summary: string;         // human-readable one-liner
  diff?: string;           // for edit_file: unified diff preview
  mode: ApprovalMode;
};

export type ConfirmPlanRequest = {
  steps: ConfirmRequest[];
  summary: string;         // overall plan summary
};

export type PlanDecision = {
  index: number;
  approved: boolean;
};

export type BlockedNotice = {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
};

// --- Plan mode (Phase 8) ---

export type PlanStep = {
  index: number;
  tool: string;
  args: Record<string, unknown>;
  blocked: boolean;
  summary: string;       // human-readable description
  executed?: boolean;     // set after /approve executes it
  result?: string;        // tool result after execution
};

export type ExecResult = {
  rc: number;
  out: string;
  err: string;
  truncated?: boolean;
};

// --- Bot config (Phase 8.5) ---

// --- Multi-agent routing (Phase 19) ---

/**
 * Model escalation configuration for automatic or explicit model upgrades.
 * Allows a lightweight model to delegate complex tasks to more capable models.
 */
export type ModelEscalation = {
  /** Ordered list of models to escalate to (first = preferred) */
  models: string[];
  /** Enable auto-escalation by the model (default: true) */
  auto?: boolean;
  /** Maximum escalations per request to prevent loops (default: 1) */
  max_escalations?: number;
};

/**
 * Agent persona definition for multi-agent Discord bot routing.
 * Each persona can have its own model, system prompt, and restrictions.
 */
export type AgentPersona = {
  /** Unique identifier for this agent (used in routing) */
  id: string;
  /** Display name shown in /agent and /status commands */
  display_name?: string;
  /** Model override (e.g., "qwen3-coder-next"). Falls back to global config.model */
  model?: string;
  /** Endpoint override. Falls back to global config.endpoint */
  endpoint?: string;
  /** Custom system prompt for this agent's personality */
  system_prompt?: string;
  /** Per-agent approval mode */
  approval_mode?: ApprovalMode;
  /** Restrict this agent to specific directories */
  allowed_dirs?: string[];
  /** Default working directory for this agent */
  default_dir?: string;
  /** Per-agent max tokens override */
  max_tokens?: number;
  /** Per-agent temperature override */
  temperature?: number;
  /** Per-agent top_p override */
  top_p?: number;
  /** Model escalation configuration for delegating to larger models */
  escalation?: ModelEscalation;
};

/**
 * Routing rules for multi-agent Discord bot.
 * Priority: user > channel > guild > default
 */
export type AgentRouting = {
  /** Default agent id when no other rule matches */
  default?: string;
  /** Map of Discord user id → agent id */
  users?: Record<string, string>;
  /** Map of Discord channel id → agent id */
  channels?: Record<string, string>;
  /** Map of Discord guild id → agent id */
  guilds?: Record<string, string>;
};

export type BotTelegramConfig = {
  token?: string;
  allowed_users?: number[];
  allowed_dirs?: string[];
  default_dir?: string;
  session_timeout_min?: number;
  max_sessions?: number;
  max_queue?: number;
  confirm_timeout_sec?: number;
  edit_interval_ms?: number;
  max_response_messages?: number;
  file_threshold_chars?: number;
  send_tool_summaries?: boolean;
  approval_mode?: string;
  allow_groups?: boolean;
  /** When true, bot replies are sent as Telegram native replies to the triggering message. Default: false. */
  reply_to_user_messages?: boolean;
};

export type BotDiscordConfig = {
  token?: string;
  allowed_users?: Array<string | number>;
  allowed_dirs?: string[];
  default_dir?: string;
  session_timeout_min?: number;
  max_sessions?: number;
  max_queue?: number;
  confirm_timeout_sec?: number;
  approval_mode?: string;
  allow_guilds?: boolean;
  guild_id?: string;
  /** When true, bot replies use Discord native reply threading to the triggering message. Default: false. */
  reply_to_user_messages?: boolean;
  /** Multi-agent personas. Key is agent id. */
  agents?: Record<string, AgentPersona>;
  /** Routing rules for multi-agent mode. */
  routing?: AgentRouting;
};

export type BotConfig = {
  telegram?: BotTelegramConfig;
  discord?: BotDiscordConfig;
};

// --- Agent hooks (Phase 8.5) ---

export type ToolCallEvent = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ToolResultEvent = {
  id: string;
  name: string;
  success: boolean;
  summary: string;
  /** Raw tool result content (possibly truncated by tool runtime). */
  result?: string;
  /** Unified diff text for edit_file/write_file (Phase 7 rich display) */
  diff?: string;
  /** Exec stdout lines for streaming display (Phase 7) */
  execOutput?: string;
  /** Search match lines for highlight display (Phase 7) */
  searchMatches?: string[];
};

export type TurnEndEvent = {
  turn: number;
  toolCalls: number;
  promptTokens: number;          // cumulative
  completionTokens: number;      // cumulative
  promptTokensTurn?: number;     // per-response delta
  completionTokensTurn?: number; // per-response delta
  ttftMs?: number;
  ttcMs?: number;
  ppTps?: number;
  tgTps?: number;
};
