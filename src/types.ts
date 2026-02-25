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
  diagnostic_severity_threshold?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
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
    stale_policy?: 'warn' | 'block';
    immutable_review_artifacts_per_project?: number;
  };
  lens?: {
    enabled?: boolean;
  };
  replay?: {
    enabled?: boolean;
  };
};

export type HookSystemConfig = {
  enabled?: boolean;
  strict?: boolean;
  plugin_paths?: string[];
  warn_ms?: number;
  allow_capabilities?: Array<
    'observe' | 'read_prompts' | 'read_responses' | 'read_tool_args' | 'read_tool_results'
  >;
};

export type RoutingMode = 'auto' | 'fast' | 'heavy';

export type QueryClassificationRuleConfig = {
  hint?: string;
  keywords?: string[];
  patterns?: string[];
  priority?: number;
  minLength?: number;
  maxLength?: number;
};

export type QueryClassificationConfig = {
  enabled?: boolean;
  rules?: QueryClassificationRuleConfig[];
};

export type RoutingProviderConfig = {
  /** Provider endpoint (OpenAI-compatible /v1 base). */
  endpoint?: string;
  /** Optional provider-specific primary model override. */
  model?: string;
  /** Optional provider-specific model fallback chain. */
  fallbackModels?: string[];
  /** Disable this provider entry without deleting it. */
  enabled?: boolean;
};

/**
 * Routing policy configuration for fast/heavy model selection.
 * Phase 2 - Fast/Heavy/Auto Routing (Latency UX Breakthrough).
 */
export type RoutingConfig = {
  /** Default routing mode when not specified */
  defaultMode: RoutingMode;
  /** Model identifier for fast mode */
  fastModel: string;
  /** Model identifier for heavy mode */
  heavyModel: string;
  /** Optional provider id for fast lane */
  fastProvider?: string;
  /** Optional provider id for heavy lane */
  heavyProvider?: string;
  /** Optional fallback provider ids (tried after the primary provider). */
  fallbackProviders?: string[];
  /** Optional provider registry keyed by provider id. */
  providers?: Record<string, RoutingProviderConfig>;
  /** Optional fallback chain by model id. */
  modelFallbacks?: Record<string, string[]>;
  /** Optional lane-specific fallback chains. */
  fastFallbackModels?: string[];
  heavyFallbackModels?: string[];
  /** Optional explicit hint→lane mapping (e.g. reasoning→heavy). */
  hintModeMap?: Record<string, Exclude<RoutingMode, 'auto'>>;
  /** In auto mode, suppress tool schemas for clearly-fast turns (default: true in runtime logic). */
  fastLaneToolless?: boolean;
  /** In auto mode, use a compact first-turn prelude for fast turns (default: true in runtime logic). */
  fastCompactPrelude?: boolean;
  /** Optional cap for compact prelude length (characters). */
  fastCompactPreludeMaxChars?: number;
  /** Thresholds for auto-selection */
  thresholds: {
    /** Maximum prompt length (chars) to use fast model in auto mode */
    maxPromptLength: number;
    /** Maximum estimated tokens to use fast model in auto mode */
    maxTokens: number;
    /** Maximum word count for fast model in auto mode */
    maxWords: number;
  };
  /** Auto-escalation rules */
  autoEscalationRules: {
    /** Escalate to heavy if code blocks detected */
    codeBlocksThreshold: number;
    /** Escalate to heavy if file references detected */
    fileReferencesThreshold: number;
    /** Escalate to heavy if complex instructions detected */
    complexInstructionsThreshold: number;
  };
};

export type ToolLoopPolicyConfig = {
  warning_threshold?: number;
  critical_threshold?: number;
  global_circuit_breaker_threshold?: number;
  detectors?: {
    generic_repeat?: boolean;
    known_poll_no_progress?: boolean;
    ping_pong?: boolean;
  };
};

export type ToolLoopDetectionConfig = {
  enabled?: boolean;
  history_size?: number;
  warning_threshold?: number;
  critical_threshold?: number;
  global_circuit_breaker_threshold?: number;
  read_cache_ttl_ms?: number;
  detectors?: {
    generic_repeat?: boolean;
    known_poll_no_progress?: boolean;
    ping_pong?: boolean;
  };
  per_tool?: Record<string, ToolLoopPolicyConfig>;
};

export type IdlehandsConfig = {
  endpoint: string;
  model?: string;
  dir?: string;

  // generation
  max_tokens: number;
  temperature: number;
  top_p: number;
  frequency_penalty?: number;
  presence_penalty?: number;

  // loop
  timeout: number;
  max_iterations: number;
  tool_loop_detection?: ToolLoopDetectionConfig;
  tool_loop_auto_continue?: {
    enabled?: boolean;
    max_retries?: number; // default 3
  };

  // network
  response_timeout: number; // seconds to wait for model server responses (default 600)
  connection_timeout?: number; // seconds to wait for initial HTTP connection/headers (default follows response_timeout)
  initial_connection_check?: boolean; // run one-time fast probe before first ask (default true)
  initial_connection_timeout?: number; // seconds for initial probe timeout (default 10)

  // safety + UX
  approval_mode: ApprovalMode;
  no_confirm: boolean; // legacy — maps to approval_mode 'yolo' when true
  verbose: boolean;
  quiet?: boolean;
  dry_run: boolean;
  output_format?: OutputFormat;
  fail_on_error?: boolean;
  diff_only?: boolean;

  // mode (Phase 9)
  mode?: 'code' | 'sys';
  /** Per-turn model routing override. */
  routing_mode?: RoutingMode;
  sys_eager?: boolean;

  // bot dir-guard controls (session-scoped)
  allowed_write_roots?: string[];
  require_dir_pin_for_mutations?: boolean;
  dir_pinned?: boolean;
  repo_candidates?: string[];

  // local-server / perf
  context_window?: number;
  cache_prompt?: boolean;
  /** Draft model for speculative decoding (llama-server --model-draft). Boosts tg/s 2-4x. */
  draft_model?: string;
  /** Number of speculative tokens to propose per step (default: 5). */
  draft_n?: number;
  /** Minimum probability for draft acceptance (default: 0.5). */
  draft_p_min?: number;
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
  context_summarize?: boolean;
  context_summary_max_tokens?: number;
  compact_at?: number;
  compact_summary?: boolean; // LLM-based summarization on compaction (default: true)
  compact_summary_max_tokens?: number; // Max tokens for summary (default 300)
  compact_min_tail?: number; // Override minTailMessages (default 12)
  show_change_summary?: boolean;
  step_mode?: boolean;
  editor?: string;

  // Prompt customization
  system_prompt_override?: string;

  // Server observability / resilience (Phase 15)
  show_server_metrics?: boolean;
  auto_detect_model_change?: boolean;
  slow_tg_tps_threshold?: number;

  // Watchdog / cancellation diagnostics
  watchdog_timeout_ms?: number;
  watchdog_max_compactions?: number;
  watchdog_idle_grace_timeouts?: number;
  debug_abort_reason?: boolean;

  // Trifecta subsystems
  trifecta?: TrifectaConfig;

  // Hook/plugin extension system
  hooks?: HookSystemConfig;


  // Query classification and routing (Phase 2)
  query_classification?: QueryClassificationConfig;
  routing?: RoutingConfig;
  // LSP integration (Phase 17)
  lsp?: LspConfig;

  // Sub-agent delegation (Phase 18)
  sub_agents?: SubAgentConfig;

  // MCP integration
  mcp?: McpConfig;
  mcp_tool_budget?: number;
  mcp_call_timeout_sec?: number;

  // Per-tool caps
  max_read_lines?: number;

  // When true, the agent session has no tool access (text-only responses).
  no_tools?: boolean;

  // Anton autonomous task runner
  anton?: {
    max_retries?: number;
    max_iterations?: number;
    task_max_iterations?: number;
    task_timeout_sec?: number;
    total_timeout_sec?: number;
    max_total_tokens?: number;
    max_prompt_tokens_per_attempt?: number;
    verify_ai?: boolean;
    verify_model?: string;
    decompose?: boolean;
    max_decompose_depth?: number;
    max_total_tasks?: number;
    skip_on_fail?: boolean;
    skip_on_blocked?: boolean;
    rollback_on_fail?: boolean;
    scope_guard?: 'off' | 'lax' | 'strict';
    max_identical_failures?: number;
    approval_mode?: string;
    verbose?: boolean;
    auto_commit?: boolean;
    /** Send Discord/Telegram messages for mid-task events (tool loops, compaction, verification). Default: true. */
    progress_events?: boolean;
    /** Seconds between periodic "still working" updates while a task attempt is running. Default: 30. */
    progress_heartbeat_sec?: number;
    /** Auto-pin the session's current working directory before /anton start when not already pinned. Default: false. */
    auto_pin_current_dir?: boolean;
    preflight?: {
      enabled?: boolean;
      requirements_review?: boolean;
      discovery_timeout_sec?: number;
      review_timeout_sec?: number;
      max_retries?: number;
      /** Max inner turns for discovery/review sessions. Default: 500. */
      session_max_iterations?: number;
      /** Hard timeout cap (seconds) for each discovery/review session. Default: 120. */
      session_timeout_sec?: number;
    };
  };

  // Bot frontends
  bot?: BotConfig;

  // Upgrade / connectivity
  // Run-as user (Linux user switching)
  run_as_user?: string;
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
  summary: string; // human-readable one-liner
  diff?: string; // for edit_file: unified diff preview
  mode: ApprovalMode;
};

export type ConfirmPlanRequest = {
  steps: ConfirmRequest[];
  summary: string; // overall plan summary
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
  summary: string; // human-readable description
  executed?: boolean; // set after /approve executes it
  result?: string; // tool result after execution
};

export type ExecResult = {
  rc: number;
  out: string;
  err: string;
  truncated?: boolean;
  warnings?: string[]; // Non-fatal warnings (e.g., path outside cwd)
};

// --- Bot config (Phase 8.5) ---

// --- Multi-agent routing (Phase 19) ---

/**
 * Model escalation configuration for automatic or explicit model upgrades.
 * Allows a lightweight model to delegate complex tasks to more capable models.
 */
/**
 * Keyword tier configuration for tiered model escalation.
 * Each tier maps to the corresponding model in the escalation chain.
 */
export type KeywordTier = {
  /**
   * Keyword patterns for this tier.
   * Can be strings (case-insensitive word match) or regex patterns (prefix with "re:").
   */
  keywords?: string[];
  /**
   * Preset keyword groups for this tier.
   * "coding" = build, implement, create, develop, architect, refactor, debug, fix
   * "planning" = plan, design, roadmap, strategy, analyze, research
   * "complex" = full, complete, comprehensive, multi-step, integrate
   */
  keyword_presets?: Array<'coding' | 'planning' | 'complex'>;
  /**
   * Endpoint override for this tier. Falls back to global config.endpoint.
   */
  endpoint?: string;
};

export type ModelEscalation = {
  /** Ordered list of models to escalate to (first = preferred) */
  models: string[];
  /** Enable auto-escalation by the model (default: true) */
  auto?: boolean;
  /** Maximum escalations per request to prevent loops (default: 1) */
  max_escalations?: number;
  /**
   * Keyword patterns that trigger automatic escalation before the base model runs.
   * Can be strings (case-insensitive word match) or regex patterns (prefix with "re:").
   * Examples: ["build", "implement", "re:\\b(create|design)\\s+\\w+\\s+(app|system)"]
   * @deprecated Use `tiers` for multi-tier escalation. This is treated as tier 0.
   */
  keywords?: string[];
  /**
   * Preset keyword groups for common escalation triggers.
   * "coding" = build, implement, create, develop, architect, refactor, debug, fix
   * "planning" = plan, design, roadmap, strategy, analyze, research
   * "complex" = full, complete, comprehensive, multi-step, integrate
   * Can combine multiple: ["coding", "planning"]
   * @deprecated Use `tiers` for multi-tier escalation. This is treated as tier 0.
   */
  keyword_presets?: Array<'coding' | 'planning' | 'complex'>;
  /**
   * Tiered keyword escalation. Each tier maps to the corresponding model in `models`.
   * Tier 0 keywords → models[0], Tier 1 → models[1], etc.
   * Highest matching tier wins. If defined, overrides root-level keywords/keyword_presets.
   *
   * Example:
   * ```json
   * "tiers": [
   *   { "keyword_presets": ["coding"] },
   *   { "keyword_presets": ["complex", "planning"], "keywords": ["architect"] }
   * ]
   * ```
   */
  tiers?: KeywordTier[];
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
  /** Channel IDs that require @mention to trigger a response */
  require_mention_channels?: string[];
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
  /** Watchdog inactivity timeout before intervention (ms). Default: 120000. */
  watchdog_timeout_ms?: number;
  /** Max watchdog compaction retries before hard cancel. Default: 3. */
  watchdog_max_compactions?: number;
  /** Number of inactivity grace cycles before first compaction attempt. Default: 1. */
  watchdog_idle_grace_timeouts?: number;
  /** Override debug abort reason reporting for Telegram bot. */
  debug_abort_reason?: boolean;
  /** Multi-agent personas. Key is agent id. */
  agents?: Record<string, AgentPersona>;
  /** Routing rules for multi-agent mode. */
  routing?: TelegramAgentRouting;
};

/**
 * Routing rules for multi-agent Telegram bot.
 * Priority: user > chat > default
 */
export type TelegramAgentRouting = {
  /** Default agent id when no other rule matches */
  default?: string;
  /** Map of Telegram user id → agent id */
  users?: Record<string, string>;
  /** Map of Telegram chat id → agent id */
  chats?: Record<string, string>;
  /** Chat IDs that require @mention to trigger a response */
  require_mention_chats?: string[];
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
  /** Watchdog inactivity timeout before intervention (ms). Default: 120000. */
  watchdog_timeout_ms?: number;
  /** Max watchdog compaction retries before hard cancel. Default: 3. */
  watchdog_max_compactions?: number;
  /** Number of inactivity grace cycles before first compaction attempt. Default: 1. */
  watchdog_idle_grace_timeouts?: number;
  /** Override debug abort reason reporting for Discord bot. */
  debug_abort_reason?: boolean;
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
  /** Structured error code when success=false. */
  errorCode?: string;
  /** Whether the tool failure is retryable. */
  retryable?: boolean;
  /** Exec exit code when name==='exec'. */
  execRc?: number;
  /** Raw tool result content (possibly truncated by tool runtime). */
  result?: string;
  /** Unified diff text for edit_file/write_file (Phase 7 rich display) */
  diff?: string;
  /** Exec stdout lines for streaming display (Phase 7) */
  execOutput?: string;
  /** Search match lines for highlight display (Phase 7) */
  searchMatches?: string[];
};

export type ToolStreamEvent = {
  /** tool call id (same as ToolCallEvent.id / ToolResultEvent.id) */
  id: string;
  /** tool name (e.g. "exec") */
  name: string;
  /** where the chunk came from */
  stream: 'stdout' | 'stderr';
  /** text chunk (UTF-8, safe for display) */
  chunk: string;
};

export type ToolLoopEvent = {
  level: 'warning' | 'critical';
  detector: string;
  toolName: string;
  count: number;
  message: string;
};

export type TurnEndEvent = {
  turn: number;
  toolCalls: number;
  promptTokens: number; // cumulative
  completionTokens: number; // cumulative
  promptTokensTurn?: number; // per-response delta
  completionTokensTurn?: number; // per-response delta
  ttftMs?: number;
  ttcMs?: number;
  ppTps?: number;
  tgTps?: number;
};
