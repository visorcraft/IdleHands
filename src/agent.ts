import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_SUB_AGENT_RESULT_TOKEN_CAP,
  DEFAULT_SUB_AGENT_SYSTEM_PROMPT,
  MCP_TOOLS_REQUEST_TOKEN,
} from './agent/constants.js';
import { AgentLoopBreak } from './agent/errors.js';
import {
  execRcShouldSignalFailure,
  looksLikeReadOnlyExecCommand,
  readOnlyExecCacheable,
  withCachedExecObservationHint,
  withReplayedExecHint,
} from './agent/exec-helpers.js';
import {
  generateMinimalDiff,
  toolResultSummary,
  execCommandFromSig,
  formatDurationMs,
  looksLikePlanningNarration,
  capTextByApproxTokens,
  sanitizePathsInMessage,
  digestToolResult,
} from './agent/formatting.js';
import { autoPickModel } from './agent/model-pick.js';
import {
  reviewArtifactKeys,
  looksLikeCodeReviewRequest,
  looksLikeReviewRetrievalRequest,
  retrievalAllowsStaleArtifact,
  parseReviewArtifactStalePolicy,
  parseReviewArtifact,
  reviewArtifactStaleReason,
  gitHead,
  normalizeModelsResponse,
} from './agent/review-artifact.js';
import type { ReviewArtifact } from './agent/review-artifact.js';
import {
  capApprovalMode,
  ensureInformativeAssistantText,
  isContextWindowExceededError,
  makeAbortController,
  userContentToText,
  userDisallowsDelegation,
} from './agent/session-utils.js';
import { buildSubAgentContextBlock, extractLensBody } from './agent/subagent-context.js';
import {
  parseToolCallsFromContent,
  getMissingRequiredParams,
  getArgValidationIssues,
  stripMarkdownFences,
  parseJsonArgs,
} from './agent/tool-calls.js';
import { resolveToolAlias } from './agent/tool-name-alias.js';
import { buildDefaultSystemPrompt, SystemPromptBuilder, VaultContextSection } from './agent/prompt-builder.js';
import type { PromptContext } from './agent/prompt-builder.js';
import { LeakDetector } from './security/leak-detector.js';
import { PromptGuard } from './security/prompt-guard.js';
import { ResponseCache } from './agent/response-cache.js';
import { resilientCall } from './agent/resilient-provider.js';
import { ToolLoopGuard } from './agent/tool-loop-guard.js';
import { CaptureManager } from './agent/capture.js';
import { ClientPool } from './agent/client-pool.js';
import { ConversationBranch } from './agent/conversation-branch.js';
import { isLspTool, isMutationTool, isReadOnlyTool, planModeSummary } from './agent/tool-policy.js';
import { applyContextAwareToolDescriptions, buildToolsSchema } from './agent/tools-schema.js';
import { OpenAIClient } from './client.js';
import { loadProjectContext } from './context.js';
import { loadGitContext, isGitDirty, stashWorkingTree } from './git.js';
import { selectHarness } from './harnesses.js';
import {
  enforceContextBudget,
  stripThinking,
  estimateTokensFromMessages,
  estimateToolSchemaTokens,
} from './history.js';
import { truncateToolResultContent } from './agent/context-budget.js';
import { HookManager, loadHookPlugins } from './hooks/index.js';
import type { HookSystemConfig } from './hooks/index.js';
import { projectIndexKeys, parseIndexMeta, isFreshIndex, indexSummaryLine } from './indexer.js';
import { LensStore } from './lens.js';
import { LspManager, detectInstalledLspServers } from './lsp.js';
import { MCPManager } from './mcp.js';
import type { McpServerStatus, McpToolStatus } from './mcp.js';
import {
  BASE_MAX_TOKENS,
  deriveContextWindow,
  deriveGenerationParams,
  supportsVisionModel,
} from './model-customization.js';
import { ReplayStore } from './replay.js';
import { checkExecSafety, checkPathSafety } from './safety.js';
import { decideTurnRoute } from './routing/turn-router.js';
import { RouteHysteresis } from './routing/hysteresis.js';
import { normalizeApprovalMode } from './shared/config-utils.js';
import { collectSnapshot } from './sys/context.js';
import { ToolError, ValidationError } from './tools/tool-error.js';
import * as tools from './tools.js';
import { EditTransaction } from './tools/transaction.js';
import type {
  ChatMessage,
  ConfirmationProvider,
  IdlehandsConfig,
  PlanStep,
  ToolCall,
  ToolCallEvent,
  ToolLoopEvent,
  ToolResultEvent,
  ToolStreamEvent,
  TrifectaMode,
  TurnEndEvent,
  UserContent,
} from './types.js';
import { stateDir, timestampedId } from './utils.js';
import { VaultStore } from './vault.js';

export { parseToolCallsFromContent };

export type AgentResult = {
  text: string;
  turns: number;
  toolCalls: number;
};

type CompactionOutcome = {
  beforeMessages: number;
  afterMessages: number;
  freedTokens: number;
  archivedToolMessages: number;
  droppedMessages: number;
  dryRun: boolean;
};

type CompactionStats = CompactionOutcome & {
  inProgress: boolean;
  lockHeld: boolean;
  runs: number;
  failedRuns: number;
  lastReason?: string;
  lastError?: string;
  updatedAt?: string;
};

// System prompt is now built dynamically by the modular prompt builder.
// See src/agent/prompt-builder.ts for section definitions.
// The old monolithic SYSTEM_PROMPT is replaced by buildDefaultSystemPrompt().
const SYSTEM_PROMPT = buildDefaultSystemPrompt();

export type AgentRuntime = {
  client?: OpenAIClient;
  vault?: VaultStore;
  replay?: ReplayStore;
  lens?: LensStore;
  hookManager?: HookManager;
};

export type AgentHooks = {
  signal?: AbortSignal;
  onToken?: (t: string) => void;
  onFirstDelta?: () => void;
  onToolCall?: (call: ToolCallEvent) => void;
  onToolStream?: (ev: ToolStreamEvent) => void | Promise<void>;
  onToolResult?: (result: ToolResultEvent) => void | Promise<void>;
  onToolLoop?: (event: ToolLoopEvent) => void | Promise<void>;
  onCompaction?: (event: {
    droppedMessages: number;
    freedTokens: number;
    summaryUsed: boolean;
  }) => void | Promise<void>;
  onTurnEnd?: (stats: TurnEndEvent) => void | Promise<void>;
};

export type ServerHealthSnapshot = {
  ok: boolean;
  checkedAt: string;
  model?: string;
  status?: string;
  contextUsedTokens?: number;
  contextTotalTokens?: number;
  kvPct?: number;
  pendingRequests?: number;
  ppTokensPerSec?: number;
  tgTokensPerSec?: number;
  slotCount?: number;
  error?: string;
  raw?: any;
};

export type TurnPerformance = {
  totalMs: number;
  ttftMs?: number;
  promptTokens: number;
  completionTokens: number;
  ppTokensPerSec?: number;
  tgTokensPerSec?: number;
  health?: ServerHealthSnapshot;
};

export type TurnRoutingDebug = {
  requestedMode: string;
  selectedMode: string;
  selectedModeSource: string;
  classificationHint: string | null;
  provider: string;
  model: string;
  runtimeRoute: boolean;
  compactPrelude: boolean;
  fastLaneToolless: boolean;
  fastLaneSlimTools?: boolean;
  promptBytes?: number;
  toolSchemaBytes?: number;
  toolSchemaTokens?: number;
  toolCount?: number;
  streamFallback?: string;
};

export type PerfSummary = {
  turns: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  avgTtftMs?: number;
  avgTtcMs: number;
  p50TtcMs: number;
  p95TtcMs: number;
  avgPpTokensPerSec?: number;
  avgTgTokensPerSec?: number;
};

export type AgentSession = {
  model: string;
  harness: string;
  endpoint: string;
  contextWindow: number;
  supportsVision: boolean;
  messages: ChatMessage[];
  usage: { prompt: number; completion: number };
  currentContextTokens: number;
  ask: (
    instruction: UserContent,
    hooks?: ((t: string) => void) | AgentHooks
  ) => Promise<AgentResult>;
  rollbackLastTurnEdits: () => Promise<{
    ok: boolean;
    error?: string;
    results?: Array<{ path: string; ok: boolean; error?: string }>;
  }>;
  rollback: () => { preview: string; removedMessages: number } | null;
  listCheckpoints: () => Array<{ messageCount: number; createdAt: number; preview: string }>;
  setModel: (name: string) => void;
  setEndpoint: (endpoint: string, modelName?: string) => Promise<void>;
  listModels: () => Promise<string[]>;
  refreshServerHealth: () => Promise<ServerHealthSnapshot | null>;
  getPerfSummary: () => PerfSummary;
  getToolLoopStats: () => {
    totalHistory: number;
    signatures: Array<{ signature: string; count: number }>;
    outcomes: Array<{ key: string; count: number }>;
    telemetry?: {
      callsRegistered: number;
      dedupedReplays: number;
      readCacheLookups: number;
      readCacheHits: number;
      warnings: number;
      criticals: number;
      recoveryRecommended: number;
      readCacheHitRate: number;
      dedupeRate: number;
    };
  };
  lastAskInstructionText?: string;
  captureOn: (filePath?: string) => Promise<string>;
  captureOff: () => void;
  captureLast: (filePath?: string) => Promise<string>;
  captureSetRedact: (enabled: boolean) => void;
  captureGetRedact: () => boolean;
  captureOpen: () => string | null;
  capturePath?: string;
  getSystemPrompt: () => string;
  setSystemPrompt: (prompt: string) => void;
  resetSystemPrompt: () => void;
  listMcpServers: () => McpServerStatus[];
  listMcpTools: (opts?: { includeDisabled?: boolean }) => McpToolStatus[];
  restartMcpServer: (name: string) => Promise<{ ok: boolean; message: string }>;
  enableMcpTool: (name: string) => boolean;
  disableMcpTool: (name: string) => boolean;
  mcpWarnings: () => string[];
  listLspServers: () => { language: string; command: string; running: boolean }[];
  setVerbose: (on: boolean) => void;
  close: () => Promise<void>;
  reset: () => void;
  cancel: () => void;
  restore: (messages: ChatMessage[]) => void;
  replay?: ReplayStore;
  vault?: VaultStore;
  lens?: LensStore;
  hookManager?: HookManager;
  lastEditedPath?: string;
  lastTurnMetrics?: TurnPerformance;
  lastTurnDebug?: TurnRoutingDebug;
  lastServerHealth?: ServerHealthSnapshot;
  /** Plan mode: accumulated steps from the last ask() in plan mode */
  planSteps: PlanStep[];
  /** Execute a specific plan step (or all if no index given). Returns results. */
  executePlanStep: (index?: number) => Promise<string[]>;
  /** Clear accumulated plan steps */
  clearPlan: () => void;
  /** Current compaction telemetry/state for this session. */
  compactionStats: CompactionStats;
  /** Manual context compaction. */
  compactHistory: (opts?: {
    topic?: string;
    hard?: boolean;
    force?: boolean;
    dry?: boolean;
    reason?: string;
  }) => Promise<{
    beforeMessages: number;
    afterMessages: number;
    freedTokens: number;
    archivedToolMessages: number;
    droppedMessages: number;
    dryRun: boolean;
  }>;
};

export async function createSession(opts: {
  config: IdlehandsConfig;
  apiKey?: string;
  confirm?: (prompt: string) => Promise<boolean>; // legacy — use confirmProvider instead
  confirmProvider?: ConfirmationProvider;
  runtime?: AgentRuntime;
  allowSpawnTask?: boolean;
}): Promise<AgentSession> {
  const cfg = opts.config;
  const projectDir = cfg.dir ?? process.cwd();
  let client = opts.runtime?.client ?? new OpenAIClient(cfg.endpoint, opts.apiKey, cfg.verbose);
  if (typeof (client as any).setVerbose === 'function') {
    (client as any).setVerbose(cfg.verbose);
  }
  if (typeof cfg.response_timeout === 'number' && cfg.response_timeout > 0) {
    client.setResponseTimeout(cfg.response_timeout);
  }
  if (
    typeof (client as any).setConnectionTimeout === 'function' &&
    typeof cfg.connection_timeout === 'number' &&
    cfg.connection_timeout > 0
  ) {
    (client as any).setConnectionTimeout(cfg.connection_timeout);
  }
  if (
    typeof (client as any).setInitialConnectionCheck === 'function' &&
    typeof cfg.initial_connection_check === 'boolean'
  ) {
    (client as any).setInitialConnectionCheck(cfg.initial_connection_check);
  }
  if (
    typeof (client as any).setInitialConnectionProbeTimeout === 'function' &&
    typeof cfg.initial_connection_timeout === 'number' &&
    cfg.initial_connection_timeout > 0
  ) {
    (client as any).setInitialConnectionProbeTimeout(cfg.initial_connection_timeout);
  }

  // Health check + model list (cheap, avoids wasting GPU on chat warmups if unreachable)
  let modelsList = normalizeModelsResponse(await client.models().catch(() => null));

  let model =
    cfg.model && cfg.model.trim().length ? cfg.model : await autoPickModel(client, modelsList);

  let harness = selectHarness(
    model,
    cfg.harness && cfg.harness.trim() ? cfg.harness.trim() : undefined
  );

  // Try to derive context window from /v1/models (if provided by server).
  const explicitContextWindow = cfg.context_window != null;
  const modelMeta = modelsList?.data?.find((m: any) => m.id === model);
  let contextWindow = deriveContextWindow({
    explicitContextWindow,
    configuredContextWindow: cfg.context_window,
    modelMeta,
  });
  let supportsVision = supportsVisionModel(model, modelMeta, harness);

  const sessionId = `session-${timestampedId()}`;
  const hookCfg: HookSystemConfig = cfg.hooks ?? {};
  const hookManager =
    opts.runtime?.hookManager ??
    new HookManager({
      enabled: hookCfg.enabled !== false,
      strict: hookCfg.strict === true,
      warnMs: hookCfg.warn_ms,
      allowedCapabilities: Array.isArray(hookCfg.allow_capabilities)
        ? (hookCfg.allow_capabilities as any)
        : undefined,
      context: () => ({
        sessionId,
        cwd: projectDir,
        model,
        harness: harness.id,
        endpoint: cfg.endpoint,
      }),
    });

  const emitDetached = (promise: Promise<void>, eventName: string) => {
    void promise.catch((error: any) => {
      if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
        console.warn(
          `[hooks] async ${eventName} dispatch failed: ${error?.message ?? String(error)}`
        );
      }
    });
  };

  if (!opts.runtime?.hookManager && hookManager.isEnabled()) {
    const loadedPlugins = await loadHookPlugins({
      pluginPaths: Array.isArray(hookCfg.plugin_paths) ? hookCfg.plugin_paths : [],
      cwd: projectDir,
      strict: hookCfg.strict === true,
    });
    for (const loaded of loadedPlugins) {
      await hookManager.registerPlugin(loaded.plugin, loaded.path);
    }
  }

  await hookManager.emit('session_start', {
    model,
    harness: harness.id,
    endpoint: cfg.endpoint,
    cwd: projectDir,
  });

  if (!cfg.i_know_what_im_doing && contextWindow > 131072) {
    console.warn(
      '[warn] context_window is above 131072; this can increase memory usage and hurt throughput. Use --i-know-what-im-doing to proceed.'
    );
  }

  // Apply harness defaults for values the user didn't explicitly override.
  // Config always fills max_tokens from DEFAULTS (16384), so we need to check
  // whether the harness wants a higher value — harness.defaults.max_tokens wins
  // when it's larger than the base default (16384), unless the user explicitly
  // configured a value in their config file or CLI.
  let { maxTokens, temperature, topP, frequencyPenalty, presencePenalty } = deriveGenerationParams({
    harness,
    configuredMaxTokens: cfg.max_tokens,
    configuredTemperature: cfg.temperature,
    configuredTopP: cfg.top_p,
    configuredFrequencyPenalty: cfg.frequency_penalty,
    configuredPresencePenalty: cfg.presence_penalty,
    baseMaxTokens: BASE_MAX_TOKENS,
  });

  const harnessVaultMode: TrifectaMode = harness.defaults?.trifecta?.vaultMode || 'off';
  const vaultMode = (cfg.trifecta?.vault?.mode || harnessVaultMode) as TrifectaMode;
  const vaultEnabled = cfg.trifecta?.enabled !== false && cfg.trifecta?.vault?.enabled !== false;
  let activeVaultTools = vaultEnabled && vaultMode === 'active';

  const lensEnabled = cfg.trifecta?.enabled !== false && cfg.trifecta?.lens?.enabled !== false;

  const spawnTaskEnabled = opts.allowSpawnTask !== false && cfg.sub_agents?.enabled !== false;

  const mcpServers = Array.isArray(cfg.mcp?.servers) ? cfg.mcp!.servers : [];
  const mcpEnabledTools = Array.isArray(cfg.mcp?.enabled_tools)
    ? cfg.mcp?.enabled_tools
    : undefined;
  const mcpToolBudget = Number.isFinite(cfg.mcp_tool_budget)
    ? Number(cfg.mcp_tool_budget)
    : Number.isFinite(cfg.mcp?.tool_budget)
      ? Number(cfg.mcp?.tool_budget)
      : 1000;
  const mcpCallTimeoutSec = Number.isFinite(cfg.mcp_call_timeout_sec)
    ? Number(cfg.mcp_call_timeout_sec)
    : Number.isFinite(cfg.mcp?.call_timeout_sec)
      ? Number(cfg.mcp?.call_timeout_sec)
      : 30;

  const builtInToolNames = [
    'read_file',
    'read_files',
    'write_file',
    'apply_patch',
    'edit_range',
    'edit_file',
    'insert_file',
    'list_dir',
    'search_files',
    'exec',
    'vault_search',
    'vault_note',
    'sys_context',
    ...(spawnTaskEnabled ? ['spawn_task'] : []),
  ];

  const mcpManager = mcpServers.length
    ? new MCPManager({
        servers: mcpServers,
        toolBudgetTokens: mcpToolBudget,
        callTimeoutMs: Math.max(1000, Math.floor(mcpCallTimeoutSec * 1000)),
        offline: cfg.offline === true,
        builtInToolNames,
        enabledTools: mcpEnabledTools,
      })
    : null;

  if (mcpManager) {
    await mcpManager.init();
  }

  // LSP integration (Phase 17)
  const lspCfg = cfg.lsp;
  const lspEnabled = lspCfg?.enabled === true;
  let lspManager: LspManager | null = null;

  if (lspEnabled) {
    lspManager = new LspManager({
      rootPath: projectDir,
      severityThreshold: lspCfg?.diagnostic_severity_threshold ?? 1,
      quiet: Boolean(process.env.IDLEHANDS_QUIET_WARNINGS),
    });

    // Add explicitly configured servers.
    if (Array.isArray(lspCfg?.servers)) {
      for (const srv of lspCfg.servers) {
        await lspManager.addServer(srv);
      }
    }

    // Auto-detect servers on PATH if configured.
    if (lspCfg?.auto_detect !== false) {
      const detected = detectInstalledLspServers();
      for (const d of detected) {
        await lspManager.addServer({
          language: d.language,
          command: d.command,
          args: d.args,
        });
      }
    }
  }

  const mcpHasEnabledTools = (mcpManager?.listTools().length ?? 0) > 0;
  const mcpLazySchemaMode = Boolean(mcpManager && mcpHasEnabledTools);
  let mcpToolsLoaded = !mcpLazySchemaMode;

  const routeHysteresis = new RouteHysteresis({
    minDwell: (cfg.routing as any)?.hysteresisMinDwell ?? 2,
    enabled: (cfg.routing as any)?.hysteresis !== false,
  });

  const conversationBranch = new ConversationBranch();

  const getToolsSchema = (slimFast?: boolean) =>
    buildToolsSchema({
      activeVaultTools,
      passiveVault: !activeVaultTools && vaultEnabled && vaultMode === 'passive',
      sysMode: cfg.mode === 'sys',
      lspTools: lspManager?.hasServers() === true,
      mcpTools: mcpToolsLoaded ? (mcpManager?.getEnabledToolSchemas() ?? []) : [],
      allowSpawnTask: spawnTaskEnabled,
      slimFast,
    });

  const collectToolContext = () => {
    const recentTools = recentToolUsage.map((row) => row.tool);
    const recentPaths = recentToolUsage.flatMap((row) => row.paths);

    const dedupeRecent = (items: string[], max: number) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (seen.has(item)) continue;
        seen.add(item);
        out.push(item);
        if (out.length >= max) break;
      }
      return out.reverse();
    };

    return {
      lastTool: recentTools[recentTools.length - 1],
      recentTools: dedupeRecent(recentTools, 12),
      recentPaths: dedupeRecent(recentPaths, 8),
    };
  };

  const extractToolPaths = (toolName: string, args: Record<string, unknown>) => {
    const out: string[] = [];
    const add = (value: unknown) => {
      if (typeof value !== 'string') return;
      const v = value.trim();
      if (!v) return;
      out.push(v);
    };

    if (!args || typeof args !== 'object') return out;

    if (toolName === 'read_files') {
      const reqs = args.requests;
      if (Array.isArray(reqs)) {
        for (const r of reqs) {
          if (r && typeof r === 'object' && 'path' in (r as any)) {
            add((r as any).path);
          }
        }
      }
    }

    if (toolName === 'search_files' || toolName === 'list_dir' || toolName === 'read_file') {
      add(args.path);
    }

    if (toolName === 'exec' && typeof args.cwd === 'string') {
      add(args.cwd);
    }

    if (
      (toolName === 'edit_range' ||
        toolName === 'write_file' ||
        toolName === 'edit_file' ||
        toolName === 'insert_file' ||
        toolName === 'lsp_diagnostics' ||
        toolName === 'lsp_symbols' ||
        toolName === 'lsp_hover' ||
        toolName === 'lsp_definition' ||
        toolName === 'lsp_references') &&
      typeof args.path === 'string'
    ) {
      add(args.path);
    }

    return out;
  };

  const recordToolUsageForHints = (toolName: string, args: Record<string, unknown>) => {
    const paths = extractToolPaths(toolName, args);
    recentToolUsage.push({
      tool: toolName,
      paths,
    });
    if (recentToolUsage.length > 60) recentToolUsage.shift();
  };

  const extractPartialToolArgsPreview = (
    toolName: string,
    rawArgs: string
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const text = String(rawArgs ?? '');
    if (!text.trim()) return out;

    const pickString = (key: string): string | undefined => {
      const m = text.match(new RegExp(`"${key}"\\s*:\\s*"([^\\n\"]*)`));
      return m?.[1];
    };

    const pickNumber = (key: string): number | undefined => {
      const m = text.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`));
      if (!m) return undefined;
      const n = Number.parseInt(m[1], 10);
      return Number.isFinite(n) ? n : undefined;
    };

    const pathLikeTools = new Set([
      'read_file',
      'write_file',
      'edit_range',
      'edit_file',
      'insert_file',
      'list_dir',
      'lsp_diagnostics',
      'lsp_symbols',
      'lsp_hover',
      'lsp_definition',
      'lsp_references',
    ]);

    if (pathLikeTools.has(toolName)) {
      const path = pickString('path');
      if (path) out.path = path;
    }

    if (toolName === 'search_files') {
      const pattern = pickString('pattern');
      const path = pickString('path');
      if (pattern) out.pattern = pattern;
      if (path) out.path = path;
    }

    if (toolName === 'exec') {
      const command = pickString('command');
      const cwd = pickString('cwd');
      if (command) out.command = command;
      if (cwd) out.cwd = cwd;
    }

    if (toolName === 'vault_search') {
      const query = pickString('query');
      if (query) out.query = query;
    }

    if (toolName === 'edit_range') {
      const start = pickNumber('start_line');
      const end = pickNumber('end_line');
      if (start != null) out.start_line = start;
      if (end != null) out.end_line = end;
    }

    return out;
  };
  const vault = vaultEnabled
    ? (opts.runtime?.vault ??
      new VaultStore({
        immutableReviewArtifactsPerProject: (cfg as any)?.trifecta?.vault
          ?.immutable_review_artifacts_per_project,
      }))
    : undefined;
  if (vault) {
    // Scope vault entries by project directory to prevent cross-project context leaks
    vault.setProjectDir(projectDir);
  }
  if (vaultEnabled && !opts.runtime?.vault) {
    await vault?.init().catch((e: any) => {
      // If vault storage is unavailable (e.g., sandboxed FS / disk I/O),
      // degrade gracefully by disabling active vault tools for this run.
      activeVaultTools = false;
      const msg = String(e?.message ?? e ?? 'unknown error');
      const isDiskLike = /disk i\/o|sqlite|readonly|read-only|permission denied/i.test(msg);
      if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
        if (isDiskLike) {
          console.warn('[warn] vault disabled for this session (storage unavailable).');
        } else {
          console.warn(`[warn] vault init failed: ${msg}`);
        }
      }
    });
  }

  const lens = lensEnabled ? (opts.runtime?.lens ?? new LensStore()) : undefined;
  if (!opts.runtime?.lens && lens) {
    await lens.init().catch((e: any) => {
      console.warn(`[warn] lens init failed: ${e?.message ?? e}`);
    });
  }

  const projectCtx = await loadProjectContext(cfg).catch((e: any) => {
    console.warn(`[warn] project context disabled for startup: ${e?.message ?? e}`);
    return '';
  });
  const gitCtx = await loadGitContext(projectDir).catch((e: any) => {
    console.warn(`[warn] git context disabled for startup: ${e?.message ?? e}`);
    return '';
  });

  let freshIndexSummary = '';
  if (vault) {
    try {
      const keys = projectIndexKeys(projectDir);
      const metaRow = await vault.getLatestByKey(keys.metaKey, 'system');
      if (metaRow?.value) {
        const meta = parseIndexMeta(metaRow.value);
        if (meta && isFreshIndex(meta, 24 * 60 * 60 * 1000)) {
          const summaryRow = await vault.getLatestByKey(keys.summaryKey, 'system');
          freshIndexSummary = summaryRow?.value || indexSummaryLine(meta);
        }
      }
    } catch {
      // best effort only
    }
  }

  let sessionMeta =
    `[cwd: ${cfg.dir}]\n[harness: ${harness.id}]` +
    (gitCtx ? `\n\n${gitCtx}` : '') +
    (projectCtx ? `\n\n${projectCtx}` : '') +
    (freshIndexSummary ? `\n\n${freshIndexSummary}` : '');

  if (vaultEnabled && vaultMode === 'active') {
    sessionMeta +=
      '\n\n[Trifecta Vault] Active vault mode is enabled. Record high-signal decisions and reuse them with vault tools when needed.';
  }

  if (lensEnabled) {
    sessionMeta += '\n\n[Trifecta Lens] Structural projection is enabled where available.';
  }

  if (lspManager?.hasServers()) {
    const lspServers = lspManager.listServers();
    const running = lspServers.filter((s) => s.running).length;
    sessionMeta += `\n\n[LSP] ${running} language server(s) active: ${lspServers.map((s) => `${s.language} (${s.command})`).join(', ')}.`;
    sessionMeta +=
      '\n[LSP] Use lsp_diagnostics, lsp_symbols, lsp_hover, lsp_definition, lsp_references tools for semantic code intelligence.';
    if (lensEnabled) {
      sessionMeta +=
        '\n[LSP+Lens] lsp_symbols combines semantic symbol data with structural Lens context when available.';
    }
    if (lspCfg?.proactive_diagnostics !== false) {
      sessionMeta +=
        '\n[LSP] Proactive diagnostics enabled: errors will be reported automatically after file edits.';
    }
  }

  if (mcpManager) {
    const mcpServers = mcpManager.listServers();
    const connected = mcpServers.filter((s) => s.connected).length;
    const enabledTools = mcpManager.listTools().length;
    sessionMeta += `\n\n[MCP] ${connected}/${mcpServers.length} servers connected; ${enabledTools} tools enabled.`;
    if (mcpLazySchemaMode) {
      sessionMeta += `\n[MCP] Lazy schema mode on. MCP tools are hidden until requested.`;
      sessionMeta += `\n[MCP] If external tools are needed, reply exactly with ${MCP_TOOLS_REQUEST_TOKEN}.`;
    }
    for (const w of mcpManager.getWarnings()) {
      sessionMeta += `\n[MCP warning] ${w}`;
    }
  }

  if (spawnTaskEnabled) {
    const subDefaults = cfg.sub_agents ?? {};
    const subMaxIter = Number.isFinite(subDefaults.max_iterations)
      ? Math.max(1, Math.floor(Number(subDefaults.max_iterations)))
      : 50;
    sessionMeta += `\n\n[Sub-agents] spawn_task is available (isolated context, sequential queue, default max_iterations=${subMaxIter}).`;
  }

  // Harness-driven suffix: append to first user message (NOT system prompt — §9b KV cache rule)
  // Check if model needs content-mode tool calls (known incompatible templates)
  // This runs before harness checks so it works regardless of quirk flags.
  {
    const modelName = cfg.model ?? '';
    const { OpenAIClient: OAIClient } = await import('./client.js');
    if (!client.contentModeToolCalls && OAIClient.needsContentMode(modelName)) {
      client.contentModeToolCalls = true;
      client.recordKnownPatternMatch();
      if (cfg.verbose) {
        console.warn(
          `[info] Model "${modelName}" matched known content-mode pattern — using content-based tool calls`
        );
      }
    }
  }

  if (harness.quirks.needsExplicitToolCallFormatReminder) {
    if (client.contentModeToolCalls) {
      // In content mode, tell the model to use JSON tool calls in its output
      sessionMeta +=
        '\n\nYou have access to the following tools. To call a tool, output a JSON block in your response like this:\n```json\n{"name": "tool_name", "arguments": {"param": "value"}}\n```\nAvailable tools:\n';
      const toolSchemas = getToolsSchema();
      for (const t of toolSchemas) {
        const fn = (t as any).function;
        if (fn) {
          const params = fn.parameters?.properties
            ? Object.entries(fn.parameters.properties)
                .map(([k, v]: [string, any]) => `${k}: ${v.type ?? 'any'}`)
                .join(', ')
            : '';
          sessionMeta += `- ${fn.name}(${params}): ${fn.description ?? ''}\n`;
        }
      }
      sessionMeta +=
        '\nIMPORTANT: Output tool calls as JSON blocks in your message. Do NOT use the tool_calls API mechanism.\nIf you use XML/function tags (e.g. <function=name>), include a full JSON object of arguments between braces.';
    } else {
      sessionMeta +=
        '\n\nIMPORTANT: Use the tool_calls mechanism to invoke tools. Do NOT write JSON tool invocations in your message text.';
    }

    // One-time tool-call template smoke test (first ask() call only, skip in content mode)
    if (!client.contentModeToolCalls && !(client as any).__toolCallSmokeTested) {
      (client as any).__toolCallSmokeTested = true;
      try {
        const smokeErr = await client.smokeTestToolCalls(cfg.model ?? 'default');
        if (smokeErr) {
          console.error(`\x1b[33m[warn] Tool-call smoke test failed: ${smokeErr}\x1b[0m`);
          console.error(
            `\x1b[33m  This model/server may not support tool-call replay correctly.\x1b[0m`
          );
          console.error(`\x1b[33m  Consider using a different model or updating llama.cpp.\x1b[0m`);
        }
      } catch {}
    }
  }
  // Phase 9: sys-eager — inject full system snapshot into first message
  if (cfg.sys_eager && cfg.mode === 'sys') {
    try {
      const snapshot = await collectSnapshot('all');
      sessionMeta += '\n\n' + snapshot;
    } catch (e: any) {
      console.warn(`[warn] sys-eager snapshot failed: ${e?.message ?? e}`);
    }
  }

  const buildCompactSessionMeta = (): string => {
    const caps: string[] = [];
    if (vaultEnabled) caps.push('vault');
    if (lspManager?.hasServers()) caps.push('lsp');
    if (mcpManager) caps.push('mcp');
    if (spawnTaskEnabled) caps.push('subagents');

    const lines = [
      `[cwd: ${cfg.dir}]`,
      `[harness: ${harness.id}]`,
      '[fast-lane prelude: concise response by default; ask for details if needed.]',
      caps.length ? `[optional capabilities: ${caps.join(', ')}]` : '',
    ].filter(Boolean);

    const maxChars = (cfg.routing as any)?.fastCompactPreludeMaxChars ?? 320;
    const joined = lines.join('\n');
    return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
  };

  const compactSessionMeta = buildCompactSessionMeta();

  const defaultSystemPromptBase = SYSTEM_PROMPT;
  let activeSystemPromptBase = (cfg.system_prompt_override ?? '').trim() || defaultSystemPromptBase;
  let systemPromptOverridden = (cfg.system_prompt_override ?? '').trim().length > 0;

  const buildEffectiveSystemPrompt = () => {
    let p = activeSystemPromptBase;
    if (harness.systemPromptSuffix && !systemPromptOverridden) {
      p += '\n\n' + harness.systemPromptSuffix;
    }
    return p;
  };

  let messages: ChatMessage[] = [{ role: 'system', content: buildEffectiveSystemPrompt() }];
  let sessionMetaPending: string | null = sessionMeta;

  const setSystemPrompt = (prompt: string) => {
    const next = String(prompt ?? '').trim();
    if (!next) throw new Error('system prompt cannot be empty');
    activeSystemPromptBase = next;
    systemPromptOverridden = true;
    const effective = buildEffectiveSystemPrompt();
    if (messages.length > 0 && messages[0].role === 'system') {
      messages[0] = { role: 'system', content: effective };
    } else {
      messages.unshift({ role: 'system', content: effective });
    }
  };

  const resetSystemPrompt = () => {
    systemPromptOverridden = false;
    setSystemPrompt(defaultSystemPromptBase);
  };

  const reset = () => {
    const effective = buildEffectiveSystemPrompt();
    messages = [{ role: 'system', content: effective }];
    sessionMetaPending = sessionMeta;
    lastEditedPath = undefined;
    recentToolUsage.length = 0;
    initialConnectionProbeDone = false;
    mcpToolsLoaded = !mcpLazySchemaMode;
    routeHysteresis.reset();
    conversationBranch.reset();
  };

  const restore = (next: ChatMessage[]) => {
    if (!Array.isArray(next) || next.length < 2) {
      throw new Error('restore: invalid messages array');
    }
    if (next[0].role !== 'system') {
      throw new Error('restore: first message must be system');
    }
    messages = next;
    activeSystemPromptBase = String(next[0].content ?? defaultSystemPromptBase);
    // Note: we don't force buildEffectiveSystemPrompt() here because the restore
    // data might already have a customized system prompt we want to respect.

    if (mcpManager) {
      const usedMcpTool = next.some((msg: any) => {
        if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) return false;
        return msg.tool_calls.some((tc: any) =>
          mcpManager.hasTool(String(tc?.function?.name ?? ''))
        );
      });
      mcpToolsLoaded = usedMcpTool || !mcpLazySchemaMode;
    }
  };

  let reqCounter = 0;
  let inFlight: AbortController | null = null;
  let initialConnectionProbeDone = false;
  let lastEditedPath: string | undefined;
  let lastTurnTransaction: EditTransaction | undefined;

  // Context for adaptive tool schema hints (recent tool actions and paths).
  const recentToolUsage: Array<{ tool: string; paths: string[] }> = [];

  // Plan mode state (Phase 8)
  let planSteps: PlanStep[] = [];

  // Sub-agent queue state (Phase 18): enforce sequential execution on single-GPU setups.
  let subTaskSeq = 0;
  let subTaskQueuePending = 0;
  let subTaskQueueTail: Promise<void> = Promise.resolve();

  const enqueueSubTask = async <T>(runner: (queuePosition: number) => Promise<T>): Promise<T> => {
    const queuePosition = subTaskQueuePending + 1;
    subTaskQueuePending += 1;

    const waitFor = subTaskQueueTail;
    let release!: () => void;
    subTaskQueueTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await waitFor;
      return await runner(queuePosition);
    } finally {
      subTaskQueuePending = Math.max(0, subTaskQueuePending - 1);
      release();
    }
  };

  const summarizeReplayDelta = async (beforeIds: Set<string> | null): Promise<string[]> => {
    if (!replay || !beforeIds) return [];
    const rows = await replay.list(10000);
    const byFile = new Map<string, number>();
    for (const row of rows) {
      if (beforeIds.has(row.id)) continue;
      byFile.set(row.filePath, (byFile.get(row.filePath) ?? 0) + 1);
    }
    return [...byFile.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([filePath, edits]) => `${filePath}${edits > 1 ? ` (${edits} edits)` : ''}`);
  };

  const runSpawnTaskCore = async (
    args: any,
    options?: {
      signal?: AbortSignal;
      emitStatus?: (
        taskId: number,
        status: 'queued' | 'running' | 'completed' | 'failed',
        detail?: string
      ) => void;
    }
  ): Promise<string> => {
    if (!spawnTaskEnabled) {
      throw new Error('spawn_task: disabled in this session');
    }

    const task = typeof args?.task === 'string' ? args.task.trim() : '';
    if (!task) {
      throw new Error('spawn_task: missing task');
    }

    // Prevent using delegation to bypass package-install confirmation restrictions.
    const taskSafety = checkExecSafety(task);
    if (
      !cfg.no_confirm &&
      taskSafety.tier === 'cautious' &&
      taskSafety.reason === 'package install/remove'
    ) {
      throw new Error(
        'spawn_task: blocked — package install/remove is restricted in the current approval mode. ' +
          'Do not delegate this to bypass confirmation requirements; ask the user to run with --no-confirm/--yolo instead.'
      );
    }

    const defaults = cfg.sub_agents ?? {};
    const taskId = ++subTaskSeq;
    const emitStatus = options?.emitStatus ?? (() => {});

    const maxIterations = Number.isFinite(args?.max_iterations)
      ? Math.max(1, Math.floor(Number(args.max_iterations)))
      : Number.isFinite(defaults.max_iterations)
        ? Math.max(1, Math.floor(Number(defaults.max_iterations)))
        : 50;

    const timeoutSec = Number.isFinite(args?.timeout_sec)
      ? Math.max(1, Math.floor(Number(args.timeout_sec)))
      : Number.isFinite(defaults.timeout_sec)
        ? Math.max(1, Math.floor(Number(defaults.timeout_sec)))
        : Math.max(60, cfg.timeout);

    const subMaxTokens = Number.isFinite(args?.max_tokens)
      ? Math.max(128, Math.floor(Number(args.max_tokens)))
      : Number.isFinite(defaults.max_tokens)
        ? Math.max(128, Math.floor(Number(defaults.max_tokens)))
        : maxTokens;

    const resultTokenCap = Number.isFinite(defaults.result_token_cap)
      ? Math.max(256, Math.floor(Number(defaults.result_token_cap)))
      : DEFAULT_SUB_AGENT_RESULT_TOKEN_CAP;

    const parentApproval = cfg.approval_mode ?? 'default';
    const rawApproval =
      normalizeApprovalMode(args?.approval_mode) ??
      normalizeApprovalMode(defaults.approval_mode) ??
      parentApproval;
    // Sub-agents cannot escalate beyond the parent's approval mode.
    const approvalMode = capApprovalMode(rawApproval, parentApproval);

    const requestedModel =
      typeof args?.model === 'string' && args.model.trim()
        ? args.model.trim()
        : typeof defaults.model === 'string' && defaults.model.trim()
          ? defaults.model.trim()
          : model;

    const requestedEndpoint =
      typeof args?.endpoint === 'string' && args.endpoint.trim()
        ? args.endpoint.trim()
        : typeof defaults.endpoint === 'string' && defaults.endpoint.trim()
          ? defaults.endpoint.trim()
          : cfg.endpoint;

    const requestedSystemPrompt =
      typeof args?.system_prompt === 'string' && args.system_prompt.trim()
        ? args.system_prompt.trim()
        : typeof defaults.system_prompt === 'string' && defaults.system_prompt.trim()
          ? defaults.system_prompt.trim()
          : DEFAULT_SUB_AGENT_SYSTEM_PROMPT;

    const cwd = projectDir;
    const ctxFiles = await buildSubAgentContextBlock(cwd, args?.context_files);

    let delegatedInstruction = task;
    // Explicitly inject cwd into the delegated task so the sub-agent knows where to work.
    delegatedInstruction += `\n\nIMPORTANT: Your working directory is "${cwd}". Create ALL files inside this directory using relative paths. Do NOT create files or directories outside this path.`;
    if (ctxFiles.block) {
      delegatedInstruction += `\n\n[Delegated context files]\n${ctxFiles.block}`;
    }
    if (ctxFiles.skipped.length) {
      delegatedInstruction += `\n\n[context skipped]\n- ${ctxFiles.skipped.join('\n- ')}`;
    }

    return await enqueueSubTask(async (queuePosition) => {
      if (queuePosition > 1) {
        emitStatus(taskId, 'queued', `position ${queuePosition}`);
      }

      const startedAt = Date.now();
      emitStatus(taskId, 'running', `${task.slice(0, 80)}${task.length > 80 ? '…' : ''}`);

      const replayBeforeIds = replay
        ? new Set((await replay.list(10000)).map((row) => row.id))
        : null;

      const subConfig: IdlehandsConfig = {
        ...cfg,
        endpoint: requestedEndpoint,
        model: requestedModel,
        max_iterations: maxIterations,
        max_tokens: subMaxTokens,
        timeout: timeoutSec,
        approval_mode: approvalMode,
        // Sub-agent inherits parent's no_confirm. If parent runs --no-confirm,
        // sub-agent also auto-confirms. Don't override based on approval_mode alone
        // (that made auto-edit behave like yolo only for sub-agents).
        no_confirm: cfg.no_confirm || approvalMode === 'yolo',
        system_prompt_override: requestedSystemPrompt,
      };

      if (defaults.inherit_context_file === false) {
        subConfig.no_context = true;
      }

      const subRuntime: AgentRuntime = {
        replay,
        lens,
        vault: defaults.inherit_vault === false ? undefined : vault,
      };

      const sameEndpoint =
        requestedEndpoint.replace(/\/+$/, '') === cfg.endpoint.replace(/\/+$/, '');
      if (sameEndpoint && opts.runtime?.client) {
        subRuntime.client = opts.runtime.client;
      }

      const subSession = await createSession({
        config: subConfig,
        apiKey: opts.apiKey,
        confirm: opts.confirm,
        confirmProvider: opts.confirmProvider,
        runtime: subRuntime,
        allowSpawnTask: false,
      });

      let subTurns = 0;
      let subToolCalls = 0;
      let failedMessage = '';
      let resultText = '';

      try {
        const subResult = await subSession.ask(delegatedInstruction, {
          signal: options?.signal,
          onTurnEnd: (ev) => {
            subTurns = ev.turn;
            subToolCalls = ev.toolCalls;
            emitStatus(taskId, 'running', `turn ${ev.turn}/${maxIterations}`);
          },
        });
        subTurns = subResult.turns;
        subToolCalls = subResult.toolCalls;
        resultText = subResult.text;
      } catch (e: any) {
        failedMessage = e?.message ?? String(e);
      } finally {
        await subSession.close().catch(() => {});
      }

      const duration = Date.now() - startedAt;
      const filesChanged = await summarizeReplayDelta(replayBeforeIds);

      if (failedMessage) {
        emitStatus(taskId, 'failed', failedMessage.slice(0, 120));
        return [
          `[sub-agent] status=failed`,
          `task: ${task}`,
          `duration: ${formatDurationMs(duration)}`,
          `model: ${requestedModel}`,
          `endpoint: ${requestedEndpoint}`,
          `approval_mode: ${approvalMode}`,
          `error: ${failedMessage}`,
          filesChanged.length ? `files_changed: ${filesChanged.join(', ')}` : 'files_changed: none',
        ].join('\n');
      }

      const capped = capTextByApproxTokens(resultText, resultTokenCap);
      emitStatus(taskId, 'completed', `${subTurns} turns, ${subToolCalls} tool calls`);

      return [
        `[sub-agent] status=completed`,
        `task: ${task}`,
        `duration: ${formatDurationMs(duration)}`,
        `model: ${requestedModel}`,
        `endpoint: ${requestedEndpoint}`,
        `approval_mode: ${approvalMode}`,
        `turns: ${subTurns}`,
        `tool_calls: ${subToolCalls}`,
        `files_changed: ${filesChanged.length ? filesChanged.join(', ') : 'none'}`,
        capped.truncated
          ? `[sub-agent] summarized result capped to ~${resultTokenCap} tokens`
          : `[sub-agent] summarized result within cap`,
        `result:\n${capped.text}`,
      ].join('\n');
    });
  };

  // Build a ToolContext — shared between plan-step execution and the agent loop.
  const buildToolCtx = (overrides?: {
    signal?: AbortSignal;
    onMutation?: (absPath: string) => void;
    confirmBridge?: (
      prompt: string,
      bridgeCtx?: { tool?: string; args?: Record<string, unknown>; diff?: string }
    ) => Promise<boolean>;
  }) => {
    const defaultConfirmBridge = opts.confirmProvider
      ? async (prompt: string) =>
          opts.confirmProvider!.confirm({
            tool: '',
            args: {},
            summary: prompt,
            mode: cfg.approval_mode,
          })
      : opts.confirm;
    return {
      cwd: projectDir,
      noConfirm: cfg.no_confirm || cfg.approval_mode === 'yolo',
      dryRun: cfg.dry_run,
      mode: cfg.mode ?? 'code',
      approvalMode: cfg.approval_mode,
      allowedWriteRoots: cfg.allowed_write_roots,
      requireDirPinForMutations: cfg.require_dir_pin_for_mutations,
      dirPinned: cfg.dir_pinned,
      repoCandidates: cfg.repo_candidates,
      confirm: overrides?.confirmBridge ?? defaultConfirmBridge,
      maxReadLines: cfg.max_read_lines,
      replay,
      vault,
      lens,
      signal: overrides?.signal ?? inFlight?.signal,
      onMutation:
        overrides?.onMutation ??
        ((absPath: string) => {
          lastEditedPath = absPath;
        }),
    };
  };

  const buildLspLensSymbolOutput = async (filePathRaw: string): Promise<string> => {
    if (!lspManager) return '[lsp] unavailable';

    const semantic = await lspManager.getSymbols(filePathRaw);
    if (!lens) return semantic;

    const cwd = projectDir;
    const absPath = filePathRaw.startsWith('/') ? filePathRaw : path.resolve(cwd, filePathRaw);
    const body = await fs.readFile(absPath, 'utf8').catch(() => '');
    if (!body) return semantic;

    const projection = await lens.projectFile(absPath, body).catch(() => '');
    const structural = extractLensBody(projection);
    if (!structural) return semantic;

    return `${semantic}\n\n[lens] Structural skeleton:\n${structural}`;
  };

  const dispatchLspTool = async (name: string, args: any): Promise<string> => {
    if (!lspManager) return '[lsp] unavailable';
    switch (name) {
      case 'lsp_diagnostics':
        return lspManager.getDiagnostics(
          typeof args?.path === 'string' ? args.path : undefined,
          typeof args?.severity === 'number' ? args.severity : undefined
        );
      case 'lsp_symbols':
        return buildLspLensSymbolOutput(String(args?.path ?? ''));
      case 'lsp_hover':
        return lspManager.getHover(
          String(args?.path ?? ''),
          Number(args?.line ?? 0),
          Number(args?.character ?? 0)
        );
      case 'lsp_definition':
        return lspManager.getDefinition(
          String(args?.path ?? ''),
          Number(args?.line ?? 0),
          Number(args?.character ?? 0)
        );
      case 'lsp_references':
        return lspManager.getReferences(
          String(args?.path ?? ''),
          Number(args?.line ?? 0),
          Number(args?.character ?? 0),
          typeof args?.max_results === 'number' ? args.max_results : 50
        );
      default:
        throw new Error(`unknown LSP tool: ${name}`);
    }
  };

  const executePlanStep = async (index?: number): Promise<string[]> => {
    if (!planSteps.length) return ['No plan steps to execute.'];

    const toExec =
      index != null
        ? planSteps.filter((s) => s.index === index && s.blocked && !s.executed)
        : planSteps.filter((s) => s.blocked && !s.executed);

    if (!toExec.length) return ['No pending blocked steps to execute.'];

    const ctx = buildToolCtx();
    const results: string[] = [];

    for (const step of toExec) {
      const fn = (tools as any)[step.tool] as Function | undefined;

      try {
        let content = '';

        if (fn) {
          const value = await fn(ctx, step.args);
          content = typeof value === 'string' ? value : JSON.stringify(value);
        } else if (step.tool === 'spawn_task') {
          content = await runSpawnTaskCore(step.args, { signal: inFlight?.signal });
        } else if (isLspTool(step.tool) && lspManager) {
          content = await dispatchLspTool(step.tool, step.args);
        } else if (mcpManager?.hasTool(step.tool)) {
          const callArgs =
            step.args && typeof step.args === 'object' && !Array.isArray(step.args)
              ? (step.args as Record<string, unknown>)
              : {};
          content = await mcpManager.callTool(step.tool, callArgs);
        } else {
          throw new Error(`unknown tool: ${step.tool}`);
        }

        step.executed = true;
        step.result = content;
        results.push(`#${step.index} ✓ ${step.summary}`);
        // Inject the result into conversation so the model knows it was executed
        messages.push({
          role: 'user',
          content: `[Plan step #${step.index} executed] ${step.tool}: ${content.slice(0, 500)}`,
        });
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        step.result = `ERROR: ${msg}`;
        results.push(`#${step.index} ✗ ${step.summary}: ${msg}`);
      }
    }

    return results;
  };

  const clearPlan = () => {
    planSteps = [];
  };

  const getLatestObjectiveText = (): string => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      const text = userContentToText((m.content ?? '') as UserContent).trim();
      if (!text) continue;
      if (text.startsWith('[system]')) continue;
      if (text.startsWith('[Trifecta Vault')) continue;
      if (text.startsWith('[Vault context')) continue;
      return text;
    }
    return '';
  };

  const compactionVaultGuidance = (): string => {
    if (!vault) return '';
    if (vaultMode === 'active' || activeVaultTools) {
      return 'Vault memory is available. Retrieve prior context with vault_search(query="...") when needed.';
    }
    if (vaultMode === 'passive') {
      return 'Vault memory is in passive mode; relevant entries may be auto-injected. You can also use vault_search(query="...") to recover specific earlier context if needed.';
    }
    return '';
  };

  const buildCompactionSystemNote = (kind: 'auto' | 'manual', dropped: number): string => {
    const prefix =
      kind === 'auto'
        ? `[auto-compacted: ${dropped} old messages dropped to stay within context budget. Continue current task.]`
        : `[compacted: ${dropped} messages dropped.]`;
    const guidance = compactionVaultGuidance();
    return guidance ? `${prefix} ${guidance}` : prefix;
  };

  const buildCompactionSummaryPrompt = (dropped: ChatMessage[]): string => {
    const parts: string[] = [];
    for (const m of dropped) {
      if (m.role === 'assistant') {
        const text = typeof m.content === 'string' ? m.content : '';
        const toolCalls = (m as any).tool_calls;
        if (toolCalls?.length) {
          for (const tc of toolCalls) {
            const args =
              typeof tc.function?.arguments === 'string' ? tc.function.arguments.slice(0, 200) : '';
            parts.push(`[tool_call: ${tc.function?.name}(${args})]`);
          }
        }
        if (text.trim()) parts.push(`[assistant]: ${text.slice(0, 500)}`);
      } else if (m.role === 'tool') {
        const content = typeof m.content === 'string' ? m.content : '';
        parts.push(`[tool_result]: ${content.slice(0, 300)}`);
      }
    }
    let combined = parts.join('\n');
    if (combined.length > 4000) {
      combined = combined.slice(0, 4000) + '\n[...truncated]';
    }
    return combined;
  };

  let lastAskInstructionText = '';
  let lastCompactionReminderObjective = '';
  const injectCompactionReminder = (reason: string) => {
    const objective = (getLatestObjectiveText() || lastAskInstructionText || '').trim();
    if (!objective) return;
    const clippedObjective =
      objective.length > 1600 ? `${objective.slice(0, 1600)}\n[truncated]` : objective;
    if (clippedObjective === lastCompactionReminderObjective) return;
    lastCompactionReminderObjective = clippedObjective;

    const vaultHint = compactionVaultGuidance();
    messages.push({
      role: 'user',
      content:
        `[system] Context was compacted (${reason}). Continue the SAME task from the current state; do not restart.\n` +
        `Most recent user objective:\n${clippedObjective}` +
        (vaultHint ? `\n\n${vaultHint}` : ''),
    });
  };

  // Session-level vault context injection: search vault for entries relevant to
  // the latest substantive objective and inject them into the conversation.
  // Used after compaction to restore context the model lost when messages were dropped.
  let lastVaultInjectionQuery = '';
  const injectVaultContext = async () => {
    if (!vault) return;
    const userText = (getLatestObjectiveText() || lastAskInstructionText || '').trim();
    if (!userText) return;
    const query = userText.slice(0, 200);
    if (query === lastVaultInjectionQuery) return;
    const hits = await vault.search(query, 4);
    if (!hits.length) return;
    const lines = hits.map(
      (r) =>
        `${r.updatedAt} ${r.kind} ${r.key ?? r.tool ?? r.id} ${String(r.value ?? r.snippet ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, 180)}`
    );
    if (!lines.length) return;
    lastVaultInjectionQuery = query;
    const vaultContextHeader =
      vaultMode === 'passive' ? '[Trifecta Vault (passive)]' : '[Vault context after compaction]';
    messages.push({
      role: 'user',
      content: `${vaultContextHeader} Relevant entries for "${query}":\n${lines.join('\n')}`,
    });
  };

  let compactionLockTail: Promise<void> = Promise.resolve();
  let compactionStats: CompactionStats = {
    inProgress: false,
    lockHeld: false,
    runs: 0,
    failedRuns: 0,
    beforeMessages: 0,
    afterMessages: 0,
    freedTokens: 0,
    archivedToolMessages: 0,
    droppedMessages: 0,
    dryRun: false,
  };

  const runCompactionWithLock = async (
    reason: string,
    runner: () => Promise<CompactionOutcome>
  ): Promise<CompactionOutcome> => {
    const prev = compactionLockTail;
    let release: () => void = () => {};
    compactionLockTail = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    await prev;

    compactionStats = {
      ...compactionStats,
      inProgress: true,
      lockHeld: true,
      lastReason: reason,
      lastError: undefined,
      updatedAt: new Date().toISOString(),
      // Reset run stats before fresh calculation.
      beforeMessages: 0,
      afterMessages: 0,
      freedTokens: 0,
      archivedToolMessages: 0,
      droppedMessages: 0,
      dryRun: false,
    };

    try {
      const result = await runner();
      compactionStats = {
        ...compactionStats,
        ...result,
        inProgress: false,
        lockHeld: false,
        runs: compactionStats.runs + 1,
        lastReason: reason,
        updatedAt: new Date().toISOString(),
      };
      return result;
    } catch (e: any) {
      compactionStats = {
        ...compactionStats,
        inProgress: false,
        lockHeld: false,
        failedRuns: compactionStats.failedRuns + 1,
        lastReason: reason,
        lastError: e?.message ?? String(e),
        updatedAt: new Date().toISOString(),
      };
      throw e;
    } finally {
      release();
    }
  };

  const compactHistory = async (opts?: {
    topic?: string;
    hard?: boolean;
    force?: boolean;
    dry?: boolean;
    reason?: string;
  }) => {
    const reason =
      opts?.reason ??
      (opts?.hard
        ? 'manual hard compaction'
        : opts?.force
          ? 'manual force compaction'
          : 'manual compaction');

    return await runCompactionWithLock(reason, async () => {
      const beforeMessages = messages.length;
      const beforeTokens = estimateTokensFromMessages(messages);

      let compacted: ChatMessage[];
      if (opts?.hard) {
        const sys = messages[0]?.role === 'system' ? [messages[0]] : [];
        const tail = messages.slice(-2);
        compacted = [...sys, ...tail];
      } else {
        compacted = enforceContextBudget({
          messages,
          contextWindow,
          maxTokens,
          minTailMessages: opts?.force ? 2 : 12,
          compactAt: opts?.force ? 0.5 : (cfg.compact_at ?? 0.8),
          toolSchemaTokens: estimateToolSchemaTokens(getToolsSchema()),
          force: opts?.force,
        });
      }

      const compactedByRefs = new Set(compacted);
      let dropped = messages.filter((m) => !compactedByRefs.has(m));

      if (opts?.topic) {
        const topic = opts.topic.toLowerCase();
        dropped = dropped.filter(
          (m) =>
            !userContentToText((m as any).content ?? '')
              .toLowerCase()
              .includes(topic)
        );
        const keepFromTopic = messages.filter((m) =>
          userContentToText((m as any).content ?? '')
            .toLowerCase()
            .includes(topic)
        );
        compacted = [...compacted, ...keepFromTopic.filter((m) => !compactedByRefs.has(m))];
      }

      const archivedToolMessages = dropped.filter((m) => m.role === 'tool').length;
      const afterMessages = compacted.length;
      const afterTokens = estimateTokensFromMessages(compacted);
      const freedTokens = Math.max(0, beforeTokens - afterTokens);

      if (!opts?.dry) {
        if (dropped.length && vault) {
          try {
            // Store the original/current user prompt before compaction so it survives context loss.
            let userPromptToPreserve: string | null = null;
            for (let i = messages.length - 1; i >= 0; i--) {
              const m = messages[i];
              if (m.role === 'user') {
                const text = userContentToText((m.content ?? '') as UserContent).trim();
                if (
                  text &&
                  !text.startsWith('[Trifecta Vault') &&
                  !text.startsWith('[Vault context') &&
                  text.length > 20
                ) {
                  userPromptToPreserve = text;
                  break;
                }
              }
            }
            if (userPromptToPreserve) {
              await vault.upsertNote('current_task', userPromptToPreserve.slice(0, 2000), 'system');
            }

            await vault.archiveToolMessages(dropped as ChatMessage[], new Map());
            await vault.note(
              'compaction_summary',
              `Dropped ${dropped.length} messages (${freedTokens} tokens).`
            );
          } catch {
            // best-effort
          }
        }
        messages = compacted;
        // Update current context token count after compaction
        currentContextTokens = estimateTokensFromMessages(compacted);
        if (dropped.length) {
          messages.push({
            role: 'system',
            content: buildCompactionSystemNote('manual', dropped.length),
          });
          await injectVaultContext().catch(() => {});
          if (opts?.reason || opts?.force) {
            injectCompactionReminder(opts?.reason ?? 'history compaction');
          }
        }
      }

      return {
        beforeMessages,
        afterMessages,
        freedTokens,
        archivedToolMessages,
        droppedMessages: dropped.length,
        dryRun: !!opts?.dry,
      };
    });
  };

  const cumulativeUsage = { prompt: 0, completion: 0 };
  // Track actual current context token count (can go up/down with compaction)
  // This is separate from cumulativeUsage which only increases.
  let currentContextTokens = 0;
  const turnDurationsMs: number[] = [];
  const ttftSamplesMs: number[] = [];
  const ppSamples: number[] = [];
  const tgSamples: number[] = [];
  let lastTurnMetrics: TurnPerformance | undefined;
  let lastTurnDebug: TurnRoutingDebug | undefined;
  let lastServerHealth: ServerHealthSnapshot | undefined;
  let lastToolLoopStats: {
    totalHistory: number;
    signatures: Array<{ signature: string; count: number }>;
    outcomes: Array<{ key: string; count: number }>;
    telemetry?: {
      callsRegistered: number;
      dedupedReplays: number;
      readCacheLookups: number;
      readCacheHits: number;
      warnings: number;
      criticals: number;
      recoveryRecommended: number;
      readCacheHitRate: number;
      dedupeRate: number;
    };
  } = {
    totalHistory: 0,
    signatures: [],
    outcomes: [],
    telemetry: {
      callsRegistered: 0,
      dedupedReplays: 0,
      readCacheLookups: 0,
      readCacheHits: 0,
      warnings: 0,
      criticals: 0,
      recoveryRecommended: 0,
      readCacheHitRate: 0,
      dedupeRate: 0,
    },
  };
  let lastModelsProbeMs = 0;

  const capture = new CaptureManager(stateDir());
  const normalizeEndpoint = (endpoint: string): string => endpoint.trim().replace(/\/+$/, '');

  const clientPool = new ClientPool({
    primary: client as any,
    primaryEndpoint: cfg.endpoint,
    apiKey: opts.apiKey,
    cfg,
    capture,
    ClientCtor: OpenAIClient as any,
  });

  // Thin wrapper used by setEndpoint when primary client is replaced.
  const applyClientRuntimeOptions = (target: OpenAIClient) => {
    if (typeof (target as any).setVerbose === 'function') (target as any).setVerbose(cfg.verbose);
    if (typeof cfg.response_timeout === 'number' && cfg.response_timeout > 0) target.setResponseTimeout(cfg.response_timeout);
    if (typeof (target as any).setConnectionTimeout === 'function' && typeof cfg.connection_timeout === 'number' && cfg.connection_timeout > 0) (target as any).setConnectionTimeout(cfg.connection_timeout);
    if (typeof (target as any).setInitialConnectionCheck === 'function' && typeof cfg.initial_connection_check === 'boolean') (target as any).setInitialConnectionCheck(cfg.initial_connection_check);
    if (typeof (target as any).setInitialConnectionProbeTimeout === 'function' && typeof cfg.initial_connection_timeout === 'number' && cfg.initial_connection_timeout > 0) (target as any).setInitialConnectionProbeTimeout(cfg.initial_connection_timeout);
  };

  const attachCaptureHook = (target: OpenAIClient) => {
    if (typeof (target as any).setExchangeHook !== 'function') return;
    (target as any).setExchangeHook(capture.createExchangeHook());
  };

  const getClientForEndpoint = (endpoint?: string): OpenAIClient =>
    clientPool.getForEndpoint(endpoint) as unknown as OpenAIClient;

  let runtimeRoutingModules:
    | {
        planner: typeof import('./runtime/planner.js');
        executor: typeof import('./runtime/executor.js');
        store: typeof import('./runtime/store.js');
      }
    | null = null;
  let runtimeRoutingUnavailable = false;
  let runtimeModelIdsCache: Set<string> | null = null;

  const loadRuntimeRoutingModules = async () => {
    if (runtimeRoutingUnavailable) return null;
    if (runtimeRoutingModules) return runtimeRoutingModules;
    try {
      const [planner, executor, store] = await Promise.all([
        import('./runtime/planner.js'),
        import('./runtime/executor.js'),
        import('./runtime/store.js'),
      ]);
      runtimeRoutingModules = { planner, executor, store };
      return runtimeRoutingModules;
    } catch {
      runtimeRoutingUnavailable = true;
      return null;
    }
  };

  const loadRuntimeModelIds = async (): Promise<Set<string>> => {
    if (runtimeModelIdsCache) return runtimeModelIdsCache;
    const mods = await loadRuntimeRoutingModules();
    if (!mods) {
      runtimeModelIdsCache = new Set();
      return runtimeModelIdsCache;
    }
    try {
      const runtimes = await mods.store.loadRuntimes();
      runtimeModelIdsCache = new Set(
        runtimes.models.filter((m) => m.enabled !== false).map((m) => m.id)
      );
      return runtimeModelIdsCache;
    } catch {
      runtimeModelIdsCache = new Set();
      return runtimeModelIdsCache;
    }
  };

  const ensureRuntimeModelActive = async (runtimeModelId: string): Promise<void> => {
    const mods = await loadRuntimeRoutingModules();
    if (!mods) throw new Error('Runtime routing is unavailable in this build/environment');

    const runtimes = await mods.store.loadRuntimes();
    runtimeModelIdsCache = new Set(runtimes.models.filter((m) => m.enabled !== false).map((m) => m.id));

    const modelExists = runtimes.models.some((m) => m.enabled !== false && m.id === runtimeModelId);
    if (!modelExists) {
      throw new Error(`Runtime model not found or disabled: ${runtimeModelId}`);
    }

    let active = await mods.executor.loadActiveRuntime();
    if (active?.healthy && active.modelId === runtimeModelId && active.endpoint) {
      if (normalizeEndpoint(active.endpoint) !== normalizeEndpoint(cfg.endpoint)) {
        await setEndpoint(active.endpoint);
      }
      return;
    }

    const planResult = mods.planner.plan({ modelId: runtimeModelId, mode: 'live' }, runtimes, active);
    if (!planResult.ok) {
      throw new Error(`Runtime switch plan failed for ${runtimeModelId}: ${planResult.reason}`);
    }

    if (!planResult.reuse) {
      const execResult = await mods.executor.execute(planResult, {
        confirm: async () => false,
      });
      if (!execResult.ok) {
        throw new Error(
          `Runtime switch failed for ${runtimeModelId}: ${execResult.error ?? 'unknown error'}`
        );
      }
    }

    active = await mods.executor.loadActiveRuntime();
    if (!active?.endpoint || active.healthy !== true) {
      throw new Error(`Runtime did not become healthy for ${runtimeModelId}`);
    }

    if (normalizeEndpoint(active.endpoint) !== normalizeEndpoint(cfg.endpoint)) {
      await setEndpoint(active.endpoint);
    }
  };

  const wireCaptureHook = () => {
    attachCaptureHook(client);
  };

  wireCaptureHook();

  const replayEnabled = cfg.trifecta?.enabled !== false && cfg.trifecta?.replay?.enabled !== false;
  const replay = replayEnabled ? (opts.runtime?.replay ?? new ReplayStore()) : undefined;
  // Init is best-effort; Replay must never crash the agent.
  if (replayEnabled && !opts.runtime?.replay && replay) {
    await replay.init().catch((e: any) => {
      console.warn(`[warn] replay init failed: ${e?.message ?? e}`);
    });
  }

  const cancel = () => {
    try {
      inFlight?.abort();
    } catch {
      // ignore
    }
  };

  const asNumber = (...values: any[]): number | undefined => {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
      }
    }
    return undefined;
  };

  const normalizeHealth = (raw: any): ServerHealthSnapshot => {
    const modelName =
      (typeof raw?.model === 'string' ? raw.model : undefined) ??
      raw?.model?.id ??
      raw?.model?.name ??
      raw?.loaded_model ??
      raw?.model_path;

    const contextUsedTokens = asNumber(
      raw?.kv_cache?.used_tokens,
      raw?.kv_used_tokens,
      raw?.cache?.used_tokens,
      raw?.context_used,
      raw?.ctx_used
    );

    const contextTotalTokens = asNumber(
      raw?.kv_cache?.total_tokens,
      raw?.kv_total_tokens,
      raw?.cache?.total_tokens,
      raw?.context_size,
      raw?.ctx_size
    );

    const kvPct =
      contextUsedTokens != null && contextTotalTokens != null && contextTotalTokens > 0
        ? (contextUsedTokens / contextTotalTokens) * 100
        : asNumber(raw?.kv_cache?.pct, raw?.kv_pct);

    const pendingRequests = asNumber(
      raw?.pending_requests,
      raw?.queue?.pending,
      raw?.n_pending_requests,
      raw?.requests_pending
    );

    const ppTokensPerSec = asNumber(
      raw?.speed?.prompt_tokens_per_second,
      raw?.prompt_tokens_per_second,
      raw?.pp_tps,
      raw?.timings?.prompt_per_second
    );

    const tgTokensPerSec = asNumber(
      raw?.speed?.tokens_per_second,
      raw?.tokens_per_second,
      raw?.tg_tps,
      raw?.timings?.tokens_per_second,
      raw?.generation_tokens_per_second
    );

    const slotCount = Array.isArray(raw?.slots)
      ? raw.slots.length
      : asNumber(raw?.slot_count, raw?.n_slots);

    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      model: modelName ? String(modelName) : undefined,
      status: typeof raw?.status === 'string' ? raw.status : 'ok',
      contextUsedTokens,
      contextTotalTokens,
      kvPct,
      pendingRequests,
      ppTokensPerSec,
      tgTokensPerSec,
      slotCount,
      raw,
    };
  };

  const refreshServerHealth = async (): Promise<ServerHealthSnapshot | null> => {
    if (typeof (client as any).health !== 'function') {
      return null;
    }

    try {
      const raw = await client.health();
      const snapshot = normalizeHealth(raw);
      lastServerHealth = snapshot;
      return snapshot;
    } catch (e: any) {
      const snapshot: ServerHealthSnapshot = {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: e?.message ?? String(e),
      };
      if (lastServerHealth?.ok !== false) {
        console.warn(`[server] health check failed: ${snapshot.error}`);
      }
      lastServerHealth = snapshot;
      return snapshot;
    }
  };

  const listModels = async (): Promise<string[]> => {
    const fresh = normalizeModelsResponse(await client.models());
    modelsList = fresh;
    return fresh.data.map((m) => m.id).filter(Boolean);
  };

  const setModel = (name: string) => {
    const previousModel = model;
    model = name;
    harness = selectHarness(
      model,
      cfg.harness && cfg.harness.trim() ? cfg.harness.trim() : undefined
    );
    const nextMeta = modelsList?.data?.find((m: any) => m.id === model);

    supportsVision = supportsVisionModel(model, nextMeta, harness);
    contextWindow = deriveContextWindow({
      explicitContextWindow,
      configuredContextWindow: cfg.context_window,
      previousContextWindow: contextWindow,
      modelMeta: nextMeta,
    });

    ({ maxTokens, temperature, topP, frequencyPenalty, presencePenalty } = deriveGenerationParams({
      harness,
      configuredMaxTokens: cfg.max_tokens,
      configuredTemperature: cfg.temperature,
      configuredTopP: cfg.top_p,
      configuredFrequencyPenalty: cfg.frequency_penalty,
      configuredPresencePenalty: cfg.presence_penalty,
      baseMaxTokens: BASE_MAX_TOKENS,
    }));

    // Update system prompt for the new model/harness
    if (messages.length > 0 && messages[0].role === 'system') {
      messages[0].content = buildEffectiveSystemPrompt();
    }

    emitDetached(
      hookManager.emit('model_changed', {
        previousModel,
        nextModel: model,
        harness: harness.id,
      }),
      'model_changed'
    );
  };

  const setEndpoint = async (endpoint: string, modelName?: string): Promise<void> => {
    const normalized = endpoint.replace(/\/+$/, '');
    cfg.endpoint = normalized;

    if (opts.runtime?.client) {
      (opts.runtime.client as any).setEndpoint?.(normalized);
      client = opts.runtime.client;
    } else {
      client = new OpenAIClient(normalized, opts.apiKey, cfg.verbose);
    }

    applyClientRuntimeOptions(client);

    clientPool.setPrimary(client as any);
    clientPool.reset();
    wireCaptureHook();

    modelsList = normalizeModelsResponse(await client.models());

    const chosen = modelName?.trim()
      ? modelName.trim()
      : (modelsList.data.find((m) => m.id === model)?.id ??
        (await autoPickModel(client, modelsList)));

    setModel(chosen);
  };

  const captureOn = (filePath?: string) => capture.on(filePath);
  const captureOff = () => capture.off();
  const captureSetRedact = (enabled: boolean) => capture.setRedact(enabled);
  const captureGetRedact = () => capture.getRedact();
  const captureOpen = () => capture.open();
  const captureLast = (filePath?: string) => capture.last(filePath);

  const listMcpServers = (): McpServerStatus[] => {
    return mcpManager?.listServers() ?? [];
  };

  const listMcpTools = (opts?: { includeDisabled?: boolean }): McpToolStatus[] => {
    return mcpManager?.listTools(opts) ?? [];
  };

  const restartMcpServer = async (name: string): Promise<{ ok: boolean; message: string }> => {
    if (!mcpManager) return { ok: false, message: 'MCP is not configured' };
    return await mcpManager.restartServer(String(name || '').trim());
  };

  const enableMcpTool = (name: string): boolean => {
    if (!mcpManager) return false;
    return mcpManager.enableTool(String(name || '').trim());
  };

  const disableMcpTool = (name: string): boolean => {
    if (!mcpManager) return false;
    return mcpManager.disableTool(String(name || '').trim());
  };

  const mcpWarnings = (): string[] => {
    return mcpManager?.getWarnings() ?? [];
  };

  const listLspServers = () => {
    return lspManager?.listServers() ?? [];
  };

  const close = async () => {
    await mcpManager?.close().catch(() => {});
    await lspManager?.close().catch(() => {});
    await clientPool.closeAll();
    vault?.close();
    lens?.close();
  };

  const setVerbose = (on: boolean) => {
    cfg.verbose = !!on;
    if (typeof (client as any).setVerbose === 'function') {
      (client as any).setVerbose(cfg.verbose);
    }
  };

  const getPerfSummary = (): PerfSummary => {
    const totalPromptTokens = cumulativeUsage.prompt;
    const totalCompletionTokens = cumulativeUsage.completion;
    const totalTokens = totalPromptTokens + totalCompletionTokens;

    const sorted = [...turnDurationsMs].sort((a, b) => a - b);
    const quantile = (q: number): number => {
      if (!sorted.length) return 0;
      const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
      return sorted[idx];
    };

    const avg = (arr: number[]) =>
      arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : undefined;

    return {
      turns: turnDurationsMs.length,
      totalTokens,
      totalPromptTokens,
      totalCompletionTokens,
      avgTtftMs: avg(ttftSamplesMs),
      avgTtcMs: avg(turnDurationsMs) ?? 0,
      p50TtcMs: quantile(0.5),
      p95TtcMs: quantile(0.95),
      avgPpTokensPerSec: avg(ppSamples),
      avgTgTokensPerSec: avg(tgSamples),
    };
  };

  const maybeAutoDetectModelChange = async () => {
    if (cfg.auto_detect_model_change === false) return;

    const now = Date.now();
    if (now - lastModelsProbeMs < 30_000) return;
    lastModelsProbeMs = now;

    let fresh: { data: Array<{ id: string; [k: string]: any }> };
    try {
      fresh = normalizeModelsResponse(await client.models());
    } catch {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      const spinnerStart = Date.now();
      let spinnerIdx = 0;
      let spinnerTimer: NodeJS.Timeout | undefined;

      if (process.stderr.isTTY && !process.env.IDLEHANDS_QUIET) {
        spinnerTimer = setInterval(() => {
          const elapsedSec = Math.floor((Date.now() - spinnerStart) / 1000);
          const frame = frames[spinnerIdx % frames.length];
          spinnerIdx++;
          process.stderr.write(
            `\r${frame} Server unavailable - waiting for reconnect (${elapsedSec}s)...`
          );
        }, 120);
      } else if (!process.env.IDLEHANDS_QUIET) {
        console.warn('[model] Server unavailable - waiting for reconnect...');
      }

      try {
        await client.waitForReady({ timeoutMs: 120_000, pollMs: 2_000 });
        fresh = normalizeModelsResponse(await client.models());
        if (!process.env.IDLEHANDS_QUIET) console.warn('[model] Reconnected to server.');
      } catch {
        return;
      } finally {
        if (spinnerTimer) {
          clearInterval(spinnerTimer);
          if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
        }
      }
    }

    modelsList = fresh;
    if (!fresh.data.length) return;

    const exists = fresh.data.some((m) => m.id === model);
    if (exists) return;

    const previousModel = model;
    const nextModel = fresh.data[0].id;
    setModel(nextModel);
    messages.push({
      role: 'system',
      content: '[system] Model changed mid-session. Previous context may not transfer perfectly.',
    });
    console.warn(
      `[model] Server model changed: ${previousModel} → ${nextModel} - switching harness to ${harness.id}`
    );
  };

  const ask = async (
    instruction: UserContent,
    hooks?: ((t: string) => void) | AgentHooks
  ): Promise<AgentResult> => {
    // Harness can override max_iterations for models that make bad decisions (§4i)
    const maxIters = harness.quirks.maxIterationsOverride
      ? Math.min(cfg.max_iterations, harness.quirks.maxIterationsOverride)
      : cfg.max_iterations;
    const wallStart = Date.now();

    const delegationForbiddenByUser = userDisallowsDelegation(instruction);
    const rawInstructionText = userContentToText(instruction).trim();

    // Route early so first-turn prelude/tool choices can adapt.
    const turnRoute = decideTurnRoute(cfg, rawInstructionText, model);

    // Apply hysteresis to suppress rapid lane thrashing in auto mode.
    const hysteresisResult = routeHysteresis.apply(
      turnRoute.selectedMode,
      turnRoute.selectedModeSource
    );
    if (hysteresisResult.suppressed) {
      // Override the selected mode with the hysteresis-stabilized lane.
      turnRoute.selectedMode = hysteresisResult.lane;
      turnRoute.selectedModeSource = 'hysteresis';
    }

    const routeFastByAuto =
      turnRoute.requestedMode === 'auto' &&
      turnRoute.selectedMode === 'fast' &&
      turnRoute.selectedModeSource !== 'override';
    const compactPreludeEnabled = (cfg.routing as any)?.fastCompactPrelude !== false;
    // Never use compact prelude when the harness injected format reminders
    // (e.g. tool_calls format for nemotron) — those are critical for correctness.
    const hasHarnessInjection = sessionMetaPending
      ? sessionMetaPending.includes('Use the tool_calls mechanism') ||
        sessionMetaPending.includes('[Format reminder]')
      : false;
    const useCompactPrelude = Boolean(
      sessionMetaPending && compactPreludeEnabled && routeFastByAuto && !hasHarnessInjection
    );

    // Prepend session meta to the first user instruction (§9b: variable context
    // goes in first user message, not system prompt, to preserve KV cache).
    // This avoids two consecutive user messages without an assistant response.
    let userContent: UserContent = instruction;
    if (sessionMetaPending) {
      const prelude = useCompactPrelude ? compactSessionMeta : sessionMetaPending;
      if (typeof instruction === 'string') {
        userContent = `${prelude}\n\n${instruction}`;
      } else {
        userContent = [{ type: 'text', text: prelude }, ...instruction];
      }
      sessionMetaPending = null;
    }

    // ── Auto vault context injection ─────────────────────────────────
    // Search the vault for entries relevant to the user's instruction and
    // prepend them to the user message so the model has context without
    // needing to call vault_search. Inspired by ZeroClaw's build_context().
    if (vault && vaultEnabled) {
      try {
        const queryText =
          typeof instruction === 'string'
            ? instruction
            : instruction
                .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                .map((p) => p.text)
                .join(' ');
        const vaultQuery = queryText.trim().slice(0, 200);
        if (vaultQuery.length >= 10) {
          const vaultHits = await vault.search(vaultQuery, 4);
          if (vaultHits.length > 0) {
            const vaultLines = vaultHits.map((r) => {
              const title = r.kind === 'note' ? `note:${r.key}` : `tool:${r.tool || r.key || 'unknown'}`;
              const body = (r.value ?? r.snippet ?? r.content ?? '').replace(/\s+/g, ' ').slice(0, 160);
              return `- ${title}: ${body}`;
            });
            const vaultBlock = `[Vault context]\n${vaultLines.join('\n')}\n`;
            if (typeof userContent === 'string') {
              userContent = `${vaultBlock}\n${userContent}`;
            } else {
              userContent = [{ type: 'text', text: vaultBlock }, ...userContent];
            }
          }
        }
      } catch {
        // Vault search is best-effort; don't fail the turn
      }
    }

    // Save rollback checkpoint before this turn (captures pre-turn state).
    conversationBranch.checkpoint(
      messages.length,
      typeof instruction === 'string' ? instruction : '[multimodal]'
    );

    messages.push({ role: 'user', content: userContent });

    const hookObj: AgentHooks = typeof hooks === 'function' ? { onToken: hooks } : (hooks ?? {});

    let turns = 0;
    let toolCalls = 0;
    const tokenEstimateCache = new WeakMap<object, number>();
    const estimateTokensCached = (msgs: ChatMessage[]): number => {
      const key = msgs as unknown as object;
      const cached = tokenEstimateCache.get(key);
      if (cached !== undefined) return cached;
      const v = estimateTokensFromMessages(msgs);
      tokenEstimateCache.set(key, v);
      return v;
    };

    const perfEnabled = process.env.IDLEHANDS_PERF_TRACE === '1';
    const perf = {
      modelMs: 0,
      ttftMsSum: 0,
      ttftSamples: 0,
      compactions: 0,
      compactMs: 0,
    };

    const askId = `ask-${timestampedId()}`;
    const hooksEnabled = hookManager.isEnabled();
    const hasOnToolCall = Boolean(hookObj.onToolCall);
    const hasOnToolResult = Boolean(hookObj.onToolResult);
    const hasOnToolLoop = Boolean(hookObj.onToolLoop);
    const hasOnTurnEnd = Boolean(hookObj.onTurnEnd);

    const emitToolCall = async (
      id: string,
      name: string,
      args: Record<string, unknown>,
      phase: ToolCallEvent['phase'] = 'executing'
    ): Promise<void> => {
      if (!hasOnToolCall && !hooksEnabled) return;
      const call: ToolCallEvent = { id, name, args, phase };
      if (hasOnToolCall) hookObj.onToolCall?.(call);
      if (hooksEnabled) {
        await hookManager.emit('tool_call', { askId, turn: turns, call });
      }
    };

    const emitToolStream = (stream: ToolStreamEvent): void => {
      try {
        void hookObj.onToolStream?.(stream);
      } catch {
        // best effort
      }
      if (hooksEnabled) {
        try {
          void hookManager.emit('tool_stream', { askId, turn: turns, stream });
        } catch {
          // best effort
        }
      }
    };

    const isReadOnlyToolDynamic = (toolName: string) => {
      return (
        isReadOnlyTool(toolName) ||
        isLspTool(toolName) ||
        Boolean(mcpManager?.isToolReadOnly(toolName))
      );
    };

    const emitToolResult = async (result: ToolResultEvent): Promise<void> => {
      if (!hasOnToolResult && !hooksEnabled) return;
      if (hasOnToolResult) await hookObj.onToolResult?.(result);
      if (hooksEnabled) {
        await hookManager.emit('tool_result', { askId, turn: turns, result });
      }
    };

    const emitToolLoop = async (loop: ToolLoopEvent): Promise<void> => {
      if (!hasOnToolLoop && !hooksEnabled) return;
      if (hasOnToolLoop) await hookObj.onToolLoop?.(loop);
      if (hooksEnabled) {
        await hookManager.emit('tool_loop', { askId, turn: turns, loop });
      }
    };

    const emitTurnEnd = async (stats: TurnEndEvent): Promise<void> => {
      if (!hasOnTurnEnd && !hooksEnabled) return;
      if (hasOnTurnEnd) await hookObj.onTurnEnd?.(stats);
      if (hooksEnabled) {
        await hookManager.emit('turn_end', { askId, stats });
      }
    };

    const finalizeAsk = async (text: string): Promise<AgentResult> => {
      const finalText = ensureInformativeAssistantText(text, { toolCalls, turns });

      // Auto-persist turn action summary to Vault so the model can recall what it did.
      if (vault && toolCalls > 0) {
        try {
          const actions: string[] = [];
          for (const [callId, name] of toolNameByCallId) {
            const args = toolArgsByCallId.get(callId) ?? {};
            actions.push(planModeSummary(name, args));
          }
          if (actions.length) {
            // Cap action list to prevent vault bloat on long sessions
            const MAX_SUMMARY_ACTIONS = 30;
            const cappedActions =
              actions.length > MAX_SUMMARY_ACTIONS
                ? [
                    ...actions.slice(0, MAX_SUMMARY_ACTIONS),
                    `... and ${actions.length - MAX_SUMMARY_ACTIONS} more`,
                  ]
                : actions;
            const userPrompt = lastAskInstructionText || '(unknown)';
            const userPromptSnippet =
              userPrompt.length > 120 ? userPrompt.slice(0, 120) + '…' : userPrompt;
            const resultSnippet =
              finalText.length > 200 ? finalText.slice(0, 200) + '…' : finalText;
            const summary = `User asked: ${userPromptSnippet}\nActions (${actions.length} tool calls, ${turns} turns):\n${cappedActions.map((a) => `- ${a}`).join('\n')}\nResult: ${resultSnippet}`;
            await vault.upsertNote(`turn_summary_${askId}`, summary, 'system');
          }
        } catch {
          // best-effort — never block ask completion for summary persistence
        }
      }

      if (hooksEnabled)
        await hookManager.emit('ask_end', { askId, text: finalText, turns, toolCalls });
      if (perfEnabled) {
        const wallMs = Date.now() - wallStart;
        const avgTtft = perf.ttftSamples > 0 ? Math.round(perf.ttftMsSum / perf.ttftSamples) : 0;
        console.error(
          `[perf] ask=${askId} turns=${turns} toolCalls=${toolCalls} wallMs=${wallMs} modelMs=${perf.modelMs} compactMs=${perf.compactMs} avgTTFTms=${avgTtft} compactions=${perf.compactions}`
        );
      }
      return { text: finalText, turns, toolCalls };
    };

    lastAskInstructionText = rawInstructionText;
    lastCompactionReminderObjective = '';
    if (hooksEnabled)
      await hookManager.emit('ask_start', { askId, instruction: rawInstructionText });
    const reviewKeys = reviewArtifactKeys(projectDir);
    const retrievalRequested = looksLikeReviewRetrievalRequest(rawInstructionText);
    const shouldPersistReviewArtifact =
      looksLikeCodeReviewRequest(rawInstructionText) && !retrievalRequested;

    if (
      !retrievalRequested &&
      cfg.initial_connection_check !== false &&
      !initialConnectionProbeDone
    ) {
      if (typeof (client as any).probeConnection === 'function') {
        await (client as any).probeConnection();
        initialConnectionProbeDone = true;
        if (typeof (client as any).getEndpoint === 'function') {
          clientPool.markProbed((client as any).getEndpoint());
        }
      }
    }

    if (retrievalRequested) {
      const latest = vault
        ? await vault.getLatestByKey(reviewKeys.latestKey, 'system').catch(() => null)
        : null;
      const parsedArtifact = latest?.value ? parseReviewArtifact(latest.value) : null;
      const artifact =
        parsedArtifact && parsedArtifact.projectId === reviewKeys.projectId ? parsedArtifact : null;

      if (artifact?.content?.trim()) {
        const stale = reviewArtifactStaleReason(artifact, projectDir);
        const stalePolicy = parseReviewArtifactStalePolicy(
          (cfg as any)?.trifecta?.vault?.stale_policy
        );

        if (stale && stalePolicy === 'block' && !retrievalAllowsStaleArtifact(rawInstructionText)) {
          const blocked =
            `Stored review is stale and retrieval policy is set to block. ${stale}\n` +
            'Reply with "print stale review anyway" to override, or request a fresh review.';

          messages.push({ role: 'assistant', content: blocked });
          hookObj.onToken?.(blocked);
          await emitTurnEnd({
            turn: turns,
            toolCalls,
            promptTokens: cumulativeUsage.prompt,
            completionTokens: cumulativeUsage.completion,
            final: true,
          });
          return await finalizeAsk(blocked);
        }

        const text = stale ? `${artifact.content}\n\n[artifact note] ${stale}` : artifact.content;

        messages.push({ role: 'assistant', content: text });
        hookObj.onToken?.(text);
        await emitTurnEnd({
          turn: turns,
          toolCalls,
          promptTokens: cumulativeUsage.prompt,
          completionTokens: cumulativeUsage.completion,
          final: true,
        });
        return await finalizeAsk(text);
      }

      const miss =
        'No stored full code review found yet. Ask me to run a code review first, then I can replay it verbatim.';
      messages.push({ role: 'assistant', content: miss });
      hookObj.onToken?.(miss);
      await emitTurnEnd({
        turn: turns,
        toolCalls,
        promptTokens: cumulativeUsage.prompt,
        completionTokens: cumulativeUsage.completion,
        final: true,
      });
      return await finalizeAsk(miss);
    }

    const primaryRoute = turnRoute.providerTargets[0];
    const runtimeModelIds = await loadRuntimeModelIds();

    const routeRuntimeFallbackModels = (primaryRoute?.fallbackModels ?? []).filter((m) =>
      runtimeModelIds.has(m)
    );
    const apiProviderTargets = turnRoute.providerTargets.map((target) => ({
      ...target,
      fallbackModels: (target.fallbackModels ?? []).filter((m) => !runtimeModelIds.has(m)),
    }));
    const routeApiFallbackModels = apiProviderTargets[0]?.fallbackModels ?? [];

    const primaryUsesRuntimeModel = !!primaryRoute?.model && runtimeModelIds.has(primaryRoute.model);
    const fastLaneToolless =
      (cfg.routing as any)?.fastLaneToolless !== false &&
      routeFastByAuto &&
      turnRoute.classificationHint === 'fast';

    // Fast-lane slim tools: on subsequent turns of a fast-route ask, include only
    // read-only / lightweight tools to reduce per-turn token overhead (~40-50%).
    // Only active when the classifier explicitly said 'fast' (not heuristic/fallback).
    const fastLaneSlimTools =
      (cfg.routing as any)?.fastLaneSlimTools !== false &&
      routeFastByAuto &&
      turnRoute.classificationHint === 'fast';

    // Non-runtime route models can be selected directly in-session.
    if (!primaryUsesRuntimeModel && primaryRoute?.model && primaryRoute.model !== model) {
      setModel(primaryRoute.model);
    }

    if (cfg.verbose) {
      const routeParts = [
        `requested=${turnRoute.requestedMode}`,
        `selected=${turnRoute.selectedMode}`,
        `source=${turnRoute.selectedModeSource}`,
        `hint=${turnRoute.classificationHint ?? 'none'}`,
        `provider=${primaryRoute?.name ?? 'default'}`,
        `model=${primaryRoute?.model ?? model}`,
      ];
      if (turnRoute.heuristicDecision) routeParts.push(`heuristic=${turnRoute.heuristicDecision}`);
      if (primaryUsesRuntimeModel) {
        const runtimeChain = [primaryRoute?.model, ...routeRuntimeFallbackModels]
          .filter(Boolean)
          .join(' -> ');
        routeParts.push(`runtime_chain=${runtimeChain || 'none'}`);
      } else if (routeApiFallbackModels.length) {
        routeParts.push(`api_fallbacks=${routeApiFallbackModels.join(',')}`);
      }
      if (useCompactPrelude) routeParts.push('compact_prelude=on');
      if (fastLaneToolless) routeParts.push('fast_toolless=on');
      console.error(`[routing] ${routeParts.join(' ')}`);
    }

    const persistReviewArtifact = async (finalText: string): Promise<void> => {
      if (!vault || !shouldPersistReviewArtifact) return;
      const clean = finalText.trim();
      if (!clean) return;

      const createdAt = new Date().toISOString();
      const id = `review-${timestampedId()}`;
      const artifact: ReviewArtifact = {
        id,
        kind: 'code_review',
        createdAt,
        model,
        projectId: reviewKeys.projectId,
        projectDir,
        prompt: rawInstructionText.slice(0, 2000),
        content: clean,
        gitHead: gitHead(projectDir),
        gitDirty: isGitDirty(projectDir),
      };

      try {
        const raw = JSON.stringify(artifact);
        await vault.upsertNote(reviewKeys.latestKey, raw, 'system');
        await vault.upsertNote(`${reviewKeys.byIdPrefix}${artifact.id}`, raw, 'system');
      } catch {
        // best effort only
      }
    };

    // Read-only tool call budgets (§ anti-scan guardrails)
    const READ_ONLY_PER_TURN_CAP = 6;
    const READ_BUDGET_WARN = 15;
    const READ_BUDGET_HARD = harness.quirks.readBudget ?? 20;
    let cumulativeReadOnlyCalls = 0;

    // Directory scan detection: track unique file paths per parent dir.
    // Only counts distinct files (re-reads of the same file after editing are normal).
    const readDirFiles = new Map<string, Set<string>>();
    const blockedDirs = new Set<string>();

    // Same-search detection: track search= params across read_file calls
    const searchTermFiles = new Map<string, Set<string>>(); // search term → set of file paths

    // identical tool call signature counts across this ask() run
    const sigCounts = new Map<string, number>();
    const toolNameByCallId = new Map<string, string>();
    const toolArgsByCallId = new Map<string, Record<string, unknown>>();

    // Loop-break helper state: bump mutationVersion whenever a tool mutates files.
    // We also record the mutationVersion at which a given signature was last seen.
    let mutationVersion = 0;
    const mutationVersionBySig = new Map<string, number>();

    // Consecutive-repeat tracking for read-only tools: only count identical calls
    // that happen back-to-back with no other tool calls in between.
    let lastTurnSigs = new Set<string>();
    const consecutiveCounts = new Map<string, number>();

    let malformedCount = 0;
    let toolRepairAttempts = 0;
    const MAX_TOOL_REPAIR_ATTEMPTS = 1;
    let noProgressTurns = 0;
    const NO_PROGRESS_TURN_CAP = 3;
    let noToolTurns = 0;
    const NO_TOOL_REPROMPT_THRESHOLD = 2;
    let repromptUsed = false;
    let readBudgetWarned = false;
    let noToolNudgeUsed = false;

    // ── Per-file mutation spiral detection ──
    // Track how many times the same file is mutated within a single ask().
    // When a file is edited too many times it usually means the model is in a
    // corruption spiral: edit → break → read → edit → break → ...
    const fileMutationCounts = new Map<string, number>();
    const fileMutationWarned = new Set<string>(); // per-file warning tracking
    const fileMutationBlocked = new Set<string>(); // per-file hard block tracking
    const FILE_MUTATION_WARN_THRESHOLD = 4; // soft warning appended to result
    const FILE_MUTATION_BLOCK_THRESHOLD = 8; // hard block: refuse further edits
    // Track blocked command loops by exact reason+command signature.
    const blockedExecAttemptsBySig = new Map<string, number>();
    // Cache successful read-only exec observations by exact signature.
    const execObservationCacheBySig = new Map<string, string>();
    // Cache ALL successful exec results so repeated identical calls under context
    // pressure can replay the cached result instead of re-executing.
    const lastExecResultBySig = new Map<string, string>();
    // Cache successful read_file/read_files/list_dir results by signature + mtime for invalidation.
    const _readFileCacheBySig = new Map<
      string,
      { content: string; paths: string[]; mtimes: number[] }
    >();
    const READ_FILE_CACHE_TOOLS = new Set(['read_file', 'read_files', 'list_dir']);

    const toolLoopGuard = new ToolLoopGuard({
      enabled: cfg.tool_loop_detection?.enabled,
      historySize: cfg.tool_loop_detection?.history_size,
      warningThreshold: cfg.tool_loop_detection?.warning_threshold,
      criticalThreshold: cfg.tool_loop_detection?.critical_threshold,
      globalCircuitBreakerThreshold: cfg.tool_loop_detection?.global_circuit_breaker_threshold,
      readCacheTtlMs: cfg.tool_loop_detection?.read_cache_ttl_ms,
      detectors: {
        genericRepeat: cfg.tool_loop_detection?.detectors?.generic_repeat,
        knownPollNoProgress: cfg.tool_loop_detection?.detectors?.known_poll_no_progress,
        pingPong: cfg.tool_loop_detection?.detectors?.ping_pong,
      },
      perTool: Object.fromEntries(
        Object.entries(cfg.tool_loop_detection?.per_tool ?? {}).map(([tool, policy]) => [
          tool,
          {
            warningThreshold: policy?.warning_threshold,
            criticalThreshold: policy?.critical_threshold,
            globalCircuitBreakerThreshold: policy?.global_circuit_breaker_threshold,
            detectors: {
              genericRepeat: policy?.detectors?.generic_repeat,
              knownPollNoProgress: policy?.detectors?.known_poll_no_progress,
              pingPong: policy?.detectors?.ping_pong,
            },
          },
        ])
      ),
    });
    const toolLoopWarningKeys = new Set<string>();
    let forceToollessRecoveryTurn = false;
    let toollessRecoveryUsed = false;
    const streamedToolCallPreviews = new Set<string>();
    const streamedToolCallPreviewScores = new Map<string, number>();

    // ── Security: credential leak detection + prompt injection guard ──
    const leakDetector = new LeakDetector();
    const promptGuard = new PromptGuard('warn');

    // ── Performance: response cache for repeated identical prompts ──
    let responseCache: ResponseCache | undefined;
    try {
      responseCache = new ResponseCache({
        cacheDir: path.join(projectDir, '.idlehands', 'cache'),
        ttlMinutes: 60,
        maxEntries: 200,
      });
    } catch {
      // Cache init failure is non-fatal — proceed without caching
    }
    // Prevent repeating the same "stop rerunning" reminder every turn.
    const readOnlyExecHintedSigs = new Set<string>();
    // Tool loop recovery: poisoned results and selective tool suppression.
    const suppressedTools = new Set<string>();
    // Keep a lightweight breadcrumb for diagnostics on partial failures.
    let lastSuccessfulTestRun: any = null;
    // One-time nudge to prevent post-success churn after green test runs.
    let finalizeAfterTestsNudgeUsed = false;
    // Recover once/twice from server-side context-overflow 400/413s by forcing compaction and retrying.
    let overflowCompactionAttempts = 0;
    const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 2;

    const archiveToolOutputForVault = async (msg: ChatMessage) => {
      if (!lens || !vault || msg.role !== 'tool' || typeof msg.content !== 'string') return msg;
      const tool = msg.tool_call_id ? toolNameByCallId.get(msg.tool_call_id) : undefined;
      if (!tool) return msg;
      try {
        const compact = await lens.summarizeToolOutput(msg.content, tool);
        if (typeof compact === 'string' && compact.length && compact.length < msg.content.length) {
          return { ...msg, content: compact };
        }
      } catch {
        // ignore and store raw tool output
      }
      return msg;
    };

    const compactToolMessageForHistory = async (
      toolCallId: string,
      rawContent: string
    ): Promise<ChatMessage> => {
      const toolName = toolNameByCallId.get(toolCallId) ?? 'tool';
      const toolArgs = toolArgsByCallId.get(toolCallId) ?? {};
      const rawMsg: ChatMessage = {
        role: 'tool',
        tool_call_id: toolCallId,
        content: rawContent,
      } as any;

      // Persist full-fidelity output immediately so live context can stay small.
      if (vault && typeof (vault as any).archiveToolResult === 'function') {
        try {
          await (vault as any).archiveToolResult(rawMsg, toolName);
        } catch (e) {
          console.warn(
            `[warn] vault archive failed: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }

      let compact = rawContent;
      if (lens) {
        try {
          const lensCompact = await lens.summarizeToolOutput(
            rawContent,
            toolName,
            typeof (toolArgs as any).path === 'string' ? String((toolArgs as any).path) : undefined
          );
          if (
            typeof lensCompact === 'string' &&
            lensCompact.length &&
            lensCompact.length < compact.length
          ) {
            compact = lensCompact;
          }
        } catch {
          // ignore lens failures; fallback to raw
        }
      }

      const success = !String(rawContent).startsWith('ERROR:');
      const digested = digestToolResult(
        toolName,
        { ...(toolArgs as Record<string, unknown>), _tool_call_id: toolCallId },
        compact,
        success
      );

      if (digested !== rawContent) {
        return {
          role: 'tool',
          tool_call_id: toolCallId,
          content: `${digested}\n[full output archived in vault: tool=${toolName}, call_id=${toolCallId}]`,
        } as any;
      }

      return rawMsg;
    };

    const persistFailure = async (error: unknown, contextLine?: string) => {
      if (!vault) return;
      const reason = error instanceof Error ? error.message : String(error);
      // Strip absolute paths from failure messages to prevent cross-project leaks in vault.
      // Replace /home/.../project/file.ts with just file.ts (relative to cwd) or the basename.
      const sanitized = sanitizePathsInMessage(
        `agent abort: ${contextLine ?? ''} ${reason}`,
        projectDir
      );
      const compact = lens ? await lens.summarizeFailureMessage(sanitized) : sanitized;
      try {
        await vault.note('agent failure', compact);
      } catch {
        // best-effort only
      }
    };

    const emitSubAgentStatus = (
      taskId: number,
      status: 'queued' | 'running' | 'completed' | 'failed',
      detail?: string
    ) => {
      if (!hookObj.onToken) return;
      const tail = detail ? ` — ${detail}` : '';
      hookObj.onToken(`\n[sub-agent #${taskId}] ${status}${tail}\n`);
    };

    const runSpawnTask = async (args: any): Promise<string> => {
      if (delegationForbiddenByUser) {
        throw new Error(
          'spawn_task: blocked — user explicitly asked for no delegation/sub-agents in this request. Continue directly in the current session.'
        );
      }
      return await runSpawnTaskCore(args, {
        signal: hookObj.signal,
        emitStatus: emitSubAgentStatus,
      });
    };

    // tool-loop
    try {
      while (turns < maxIters) {
        // Immediate bail if cancelled (Ctrl+C)
        if (inFlight?.signal?.aborted) break;

        turns++;
        if (hooksEnabled) await hookManager.emit('turn_start', { askId, turn: turns });

        const wallElapsed = (Date.now() - wallStart) / 1000;
        if (wallElapsed > cfg.timeout) {
          throw new Error(
            `session timeout exceeded (${cfg.timeout}s) after ${wallElapsed.toFixed(1)}s`
          );
        }

        await maybeAutoDetectModelChange();

        const compactionStartMs = Date.now();
        await runCompactionWithLock('auto context-budget compaction', async () => {
          const beforeMsgs = messages;
          const beforeTokens = estimateTokensCached(beforeMsgs);
          const compacted = enforceContextBudget({
            messages: beforeMsgs,
            contextWindow,
            maxTokens: maxTokens,
            minTailMessages: cfg.compact_min_tail ?? 12,
            compactAt: cfg.compact_at ?? 0.8,
            toolSchemaTokens: estimateToolSchemaTokens(getToolsSchema()),
          });

          let dropped: ChatMessage[];
          if (compacted.length === beforeMsgs.length) {
            // Fast path: no drops expected when lengths match.
            dropped = [];
          } else {
            const compactedByRefs = new Set(compacted);
            dropped = beforeMsgs.filter((m) => !compactedByRefs.has(m));
          }

          if (dropped.length && vault) {
            try {
              // Store the original/current user prompt before compaction so it survives context loss.
              // Find the last substantive user message that looks like a task/instruction.
              let userPromptToPreserve: string | null = null;
              for (let i = beforeMsgs.length - 1; i >= 0; i--) {
                const m = beforeMsgs[i];
                if (m.role === 'user') {
                  const text = userContentToText((m.content ?? '') as UserContent).trim();
                  // Skip vault injection messages and short prompts
                  if (
                    text &&
                    !text.startsWith('[Trifecta Vault') &&
                    !text.startsWith('[Vault context') &&
                    text.length > 20
                  ) {
                    userPromptToPreserve = text;
                    break;
                  }
                }
              }
              if (userPromptToPreserve) {
                await vault.upsertNote(
                  'current_task',
                  userPromptToPreserve.slice(0, 2000),
                  'system'
                );
              }

              const toArchive = lens
                ? await Promise.all(dropped.map((m) => archiveToolOutputForVault(m as ChatMessage)))
                : dropped;
              await vault.archiveToolMessages(toArchive as ChatMessage[], toolNameByCallId);
            } catch (e) {
              console.warn(
                `[warn] vault archive failed: ${e instanceof Error ? e.message : String(e)}`
              );
            }
          }

          messages = compacted;

          let summaryUsed = false;
          if (dropped.length) {
            let droppedTokens = 0;
            if (cfg.compact_summary !== false) {
              droppedTokens = estimateTokensCached(dropped as ChatMessage[]);
            }
            if (cfg.compact_summary !== false && droppedTokens > 200) {
              try {
                const summaryContent = buildCompactionSummaryPrompt(dropped as ChatMessage[]);
                const summaryMaxTokens = cfg.compact_summary_max_tokens ?? 300;
                const resp = await client.chat({
                  model,
                  messages: [
                    {
                      role: 'system',
                      content:
                        'Summarize this agent session progress concisely. List: files read, key findings, decisions made, current approach. Be terse.',
                    } as ChatMessage,
                    { role: 'user', content: summaryContent } as ChatMessage,
                  ],
                  max_tokens: summaryMaxTokens,
                  temperature: 0,
                  responseTimeoutMs: 5_000,
                });
                const summary = resp.choices?.[0]?.message?.content ?? '';
                if (summary.trim()) {
                  summaryUsed = true;
                  messages.push({
                    role: 'system',
                    content: `[Compacted ${dropped.length} messages (~${droppedTokens} tokens). Progress summary:]\n${summary.trim()}\n[Continue from where you left off. Do not repeat completed work.]`,
                  } as ChatMessage);
                } else {
                  messages.push({
                    role: 'system',
                    content: buildCompactionSystemNote('auto', dropped.length),
                  } as ChatMessage);
                }
              } catch {
                messages.push({
                  role: 'system',
                  content: buildCompactionSystemNote('auto', dropped.length),
                } as ChatMessage);
              }
            } else {
              messages.push({
                role: 'system',
                content: buildCompactionSystemNote('auto', dropped.length),
              } as ChatMessage);
            }
          }

          // Update token count AFTER injections so downstream reads are accurate
          currentContextTokens = estimateTokensCached(messages);

          const afterTokens = estimateTokensCached(compacted);
          const freedTokens = Math.max(0, beforeTokens - afterTokens);

          // Emit compaction event for callers (e.g. Anton controller → Discord)
          if (dropped.length) {
            perf.compactions++;
            try {
              await hookObj.onCompaction?.({
                droppedMessages: dropped.length,
                freedTokens,
                summaryUsed,
              });
            } catch {
              /* best effort */
            }
            console.error(
              `[compaction] auto: dropped=${dropped.length} msgs, freed=~${freedTokens} tokens, summary=${summaryUsed}, remaining=${messages.length} msgs (~${currentContextTokens} tokens)`
            );
          }

          return {
            beforeMessages: beforeMsgs.length,
            afterMessages: compacted.length,
            freedTokens,
            archivedToolMessages: dropped.filter((m) => m.role === 'tool').length,
            droppedMessages: dropped.length,
            dryRun: false,
          };
        });

        perf.compactMs += Date.now() - compactionStartMs;

        const ac = makeAbortController();
        inFlight = ac;

        // If caller provided an AbortSignal (bench iteration timeout, etc), propagate it.
        const callerSignal = hookObj.signal;
        const onCallerAbort = () => ac.abort();
        callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

        // Per-request timeout: the lesser of response_timeout (default 600s) or the remaining session wall time.
        // This prevents a single slow request from consuming the entire session budget.
        const perReqCap =
          cfg.response_timeout && cfg.response_timeout > 0 ? cfg.response_timeout : 600;
        const wallRemaining = Math.max(0, cfg.timeout - (Date.now() - wallStart) / 1000);
        const reqTimeout = Math.min(perReqCap, Math.max(10, wallRemaining));
        const timer = setTimeout(() => ac.abort(), reqTimeout * 1000);
        reqCounter++;

        const turnStartMs = Date.now();
        let ttftMs: number | undefined;

        const onFirstDelta = () => {
          if (ttftMs === undefined) {
            ttftMs = Date.now() - turnStartMs;
          }
          hookObj.onFirstDelta?.();
        };

        let resp;
        let streamFallbackDiag: string | undefined;
        try {
          try {
            // turns is 1-indexed (incremented at loop top), so first iteration = 1.
            const forceToollessByRouting = fastLaneToolless && turns === 1;
            // On fast-lane subsequent turns, slim the schema to read-only tools.
            const useSlimFast = !forceToollessByRouting && fastLaneSlimTools && turns > 1;
            const schemaContext = collectToolContext();
            const toolsForTurn =
              cfg.no_tools || forceToollessRecoveryTurn || forceToollessByRouting
                ? []
                : applyContextAwareToolDescriptions(
                    getToolsSchema(useSlimFast).filter((t) => !suppressedTools.has(t.function.name)),
                    schemaContext
                  );
            const toolChoiceForTurn =
              cfg.no_tools || forceToollessRecoveryTurn || forceToollessByRouting ? 'none' : 'auto';

            const promptBytesEstimate = Buffer.byteLength(JSON.stringify(messages), 'utf8');
            const toolSchemaBytesEstimate = toolsForTurn.length
              ? Buffer.byteLength(JSON.stringify(toolsForTurn), 'utf8')
              : 0;
            const toolSchemaTokenEstimate = estimateToolSchemaTokens(toolsForTurn);

            lastTurnDebug = {
              requestedMode: turnRoute.requestedMode,
              selectedMode: turnRoute.selectedMode,
              selectedModeSource: turnRoute.selectedModeSource,
              classificationHint: turnRoute.classificationHint,
              provider: primaryRoute?.name ?? 'default',
              model: primaryRoute?.model ?? model,
              runtimeRoute: primaryUsesRuntimeModel,
              compactPrelude: useCompactPrelude,
              fastLaneToolless,
              fastLaneSlimTools: useSlimFast,
              promptBytes: promptBytesEstimate,
              toolSchemaBytes: toolSchemaBytesEstimate,
              toolSchemaTokens: toolSchemaTokenEstimate,
              toolCount: toolsForTurn.length,
            };

            if (cfg.verbose) {
              console.error(
                `[turn-debug] prompt_bytes=${promptBytesEstimate} tools=${toolsForTurn.length} tool_schema_bytes=${toolSchemaBytesEstimate} tool_schema_tokens~=${toolSchemaTokenEstimate}`
              );
            }

            const noteStreamFallback = (providerName: string, response: any) => {
              const fallback = response?.meta?.stream_fallback;
              if (!fallback || typeof fallback !== 'object') return;

              const reason = String((fallback as any).reason ?? 'unknown');
              const attempt = Number((fallback as any).attempt ?? NaN);
              const status = Number((fallback as any).status ?? NaN);
              const detail = [
                Number.isFinite(attempt) ? `attempt=${attempt}` : null,
                Number.isFinite(status) ? `status=${status}` : null,
              ]
                .filter(Boolean)
                .join(' ');

              streamFallbackDiag = `${providerName}:${reason}${detail ? ` (${detail})` : ''}`;
              if (cfg.verbose) {
                console.warn(
                  `[routing] stream fallback provider=${providerName} reason=${reason}${detail ? ` ${detail}` : ''}`
                );
              }
            };

            // ── Response cache: check for cached response ──────────────
            // Only cache tool-less turns (final answers, explanations) since
            // tool-calling turns have side effects that shouldn't be replayed.
            const cacheableRequest = toolsForTurn.length === 0 && !!responseCache;
            const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
            const userPromptForCache = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
            const systemPromptForCache = messages.find((m) => m.role === 'system')?.content ?? '';

            if (cacheableRequest && userPromptForCache.length >= 10) {
              const cached = responseCache!.get(model, systemPromptForCache, userPromptForCache);
              if (cached) {
                resp = {
                  id: 'cache-hit',
                  choices: [{
                    index: 0,
                    message: { role: 'assistant' as const, content: cached },
                    finish_reason: 'stop',
                  }],
                } as any;
                if (cfg.verbose) console.log('[response-cache] cache hit, skipping API call');
              }
            }

            if (!resp) {
              const chatOptsBase = {
                messages,
                tools: toolsForTurn,
                tool_choice: toolChoiceForTurn,
                temperature,
                top_p: topP,
                max_tokens: maxTokens,
                extra: {
                  cache_prompt: cfg.cache_prompt ?? true,
                  ...(cfg.draft_model ? { draft_model: cfg.draft_model } : {}),
                  ...(cfg.draft_n
                    ? { speculative: { n: cfg.draft_n, p_min: cfg.draft_p_min ?? 0.5 } }
                    : {}),
                  ...(frequencyPenalty && { frequency_penalty: frequencyPenalty }),
                  ...(presencePenalty && { presence_penalty: presencePenalty }),
                },
                signal: ac.signal,
                requestId: `r${reqCounter}`,
                onToken: hookObj.onToken,
                onFirstDelta,
                onToolCallDelta: (delta: {
                  index: number;
                  id?: string;
                  name?: string;
                  argumentsSoFar?: string;
                  done?: boolean;
                }) => {
                  const name = typeof delta?.name === 'string' ? delta.name : '';
                  if (!name) return;

                  const id = typeof delta?.id === 'string' && delta.id.trim().length
                    ? delta.id
                    : `stream_call_${delta.index}`;
                  const previewKey = `${turns}:${id}:${name}`;

                  let parsedArgs: Record<string, unknown> = {};
                  const rawArgs =
                    typeof delta.argumentsSoFar === 'string' ? delta.argumentsSoFar.trim() : '';
                  if (rawArgs) {
                    try {
                      const parsed = parseJsonArgs(rawArgs);
                      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        parsedArgs = parsed as Record<string, unknown>;
                      }
                    } catch {
                      // partial JSON chunks are expected during streaming
                    }

                    if (!Object.keys(parsedArgs).length) {
                      parsedArgs = extractPartialToolArgsPreview(name, rawArgs);
                    }
                  }

                  const score = Object.keys(parsedArgs).length + (rawArgs ? 1 : 0);
                  const prevScore = streamedToolCallPreviewScores.get(previewKey) ?? 0;
                  const shouldEmit = !streamedToolCallPreviews.has(previewKey) || score > prevScore;
                  if (!shouldEmit) return;

                  streamedToolCallPreviews.add(previewKey);
                  streamedToolCallPreviewScores.set(previewKey, Math.max(prevScore, score));
                  void emitToolCall(id, name, parsedArgs, 'planned');
                },
              };

              if (primaryUsesRuntimeModel && primaryRoute?.model) {
                // Runtime-native routing: lane model/fallbacks reference runtime model IDs.
                const runtimePrimaryModel = primaryRoute.model;
                const runtimeFallbackMap: Record<string, string[]> = {};
                if (routeRuntimeFallbackModels.length > 0) {
                  runtimeFallbackMap[runtimePrimaryModel] = routeRuntimeFallbackModels;
                }

                resp = await resilientCall(
                  [
                    {
                      name: 'runtime-router',
                      execute: async (runtimeModelId: string) => {
                        await ensureRuntimeModelActive(runtimeModelId);
                        const runtimeClient = getClientForEndpoint();
                        const runtimeModel = model;
                        return runtimeClient.chatStream({ ...chatOptsBase, model: runtimeModel });
                      },
                    },
                  ],
                  runtimePrimaryModel,
                  {
                    maxRetries: 0,
                    modelFallbacks: runtimeFallbackMap,
                    onRetry: (info) => {
                      if (cfg.verbose) {
                        console.error(
                          `[routing] runtime-fallback: model=${info.model} attempt=${info.attempt}/${info.maxAttempts} reason=${info.reason}`
                        );
                      }
                    },
                  }
                );
                noteStreamFallback('runtime-router', resp);
              } else {
                const isLikelyAuthError = (errMsg: string): boolean => {
                  const lower = errMsg.toLowerCase();
                  return (
                    lower.includes('refresh_token_reused') ||
                    lower.includes('missing bearer') ||
                    lower.includes('missing api key') ||
                    lower.includes('invalid api key') ||
                    lower.includes('authentication failed') ||
                    lower.includes('unauthorized') ||
                    lower.includes('forbidden') ||
                    lower.includes('invalid token')
                  );
                };

                const providerFailures: string[] = [];
                for (const target of apiProviderTargets.length
                  ? apiProviderTargets
                  : [{
                      name: primaryRoute?.name ?? 'default',
                      endpoint: primaryRoute?.endpoint,
                      model: primaryRoute?.model ?? model,
                      fallbackModels: routeApiFallbackModels,
                    }]) {
                  const routeEndpoint = target.endpoint;
                  const activeClient = getClientForEndpoint(routeEndpoint);
                  if (routeEndpoint) {
                    await clientPool.probeIfNeeded(routeEndpoint);
                  }

                  const routeModel = target.model || model;
                  const modelFallbackMap: Record<string, string[]> = {};
                  if (target.fallbackModels?.length) {
                    modelFallbackMap[routeModel] = target.fallbackModels;
                  }

                  try {
                    resp = await resilientCall(
                      [
                        {
                          name: target.name ?? 'default',
                          execute: (m: string) =>
                            activeClient.chatStream({ ...chatOptsBase, model: m }),
                        },
                      ],
                      routeModel,
                      {
                        maxRetries: 0,
                        modelFallbacks: modelFallbackMap,
                        onRetry: (info) => {
                          if (cfg.verbose) {
                            console.error(
                              `[routing] retry: provider=${info.provider} model=${info.model} attempt=${info.attempt}/${info.maxAttempts} reason=${info.reason}`
                            );
                          }
                        },
                      }
                    );
                    noteStreamFallback(target.name ?? 'default', resp);
                    break;
                  } catch (providerErr: any) {
                    const errMsg = String(providerErr?.message ?? providerErr ?? 'unknown error');
                    const compactErr = errMsg.replace(/\s+/g, ' ').trim();
                    providerFailures.push(`${target.name}: ${compactErr}`);

                    if (cfg.verbose && isLikelyAuthError(errMsg)) {
                      console.warn(
                        `[routing] auth/provider failure on ${target.name}; trying next provider fallback`
                      );
                    }

                    if (isContextWindowExceededError(providerErr)) {
                      throw providerErr;
                    }
                  }
                }

                if (!resp) {
                  throw new Error(
                    `All routed providers failed for this turn. ${providerFailures.join(' | ')}`
                  );
                }
              }
            } // end if (!resp) — cache miss path

            if (streamFallbackDiag && lastTurnDebug) {
              lastTurnDebug.streamFallback = streamFallbackDiag;
            }

            // Successful response resets overflow recovery budget.
            overflowCompactionAttempts = 0;

            // ── Response cache: store cacheable responses ─────────────
            if (cacheableRequest && userPromptForCache.length >= 10 && resp.id !== 'cache-hit') {
              const respContent = resp.choices?.[0]?.message?.content;
              if (respContent && typeof respContent === 'string') {
                try {
                  responseCache!.set(
                    model,
                    systemPromptForCache,
                    userPromptForCache,
                    respContent,
                    resp.usage?.completion_tokens ?? 0
                  );
                } catch {
                  // Cache write failure is non-fatal
                }
              }
            }
          } catch (e) {
            if (
              isContextWindowExceededError(e) &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              overflowCompactionAttempts++;
              const useHardCompaction = overflowCompactionAttempts > 1;
              const compacted = await compactHistory({
                force: true,
                hard: useHardCompaction,
                reason: 'server context-window overflow recovery',
              });
              const mode = useHardCompaction ? 'hard' : 'force';
              messages.push({
                role: 'system',
                content: `[auto-recovery] Context overflow. Ran ${mode} compaction (freed ~${compacted.freedTokens} tokens). Continue current work.`,
              } as ChatMessage);
              continue;
            }
            throw e;
          }
        } finally {
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', onCallerAbort);
          inFlight = null;
        }

        const ttcMs = Date.now() - turnStartMs;
        perf.modelMs += ttcMs;
        if (ttftMs !== undefined) {
          perf.ttftMsSum += ttftMs;
          perf.ttftSamples++;
        }
        const promptTokensTurn = resp.usage?.prompt_tokens ?? 0;
        const completionTokensTurn = resp.usage?.completion_tokens ?? 0;

        // Track server-reported usage when available
        if (resp.usage) {
          cumulativeUsage.prompt += promptTokensTurn;
          cumulativeUsage.completion += completionTokensTurn;
          // Update current context estimate: prompt + completion approximates total context
          // This is more accurate than cumulative which never decreases
          currentContextTokens = promptTokensTurn + completionTokensTurn;
        }

        const ppTps =
          ttftMs && ttftMs > 0 && promptTokensTurn > 0
            ? promptTokensTurn / (ttftMs / 1000)
            : undefined;

        const genWindowMs = Math.max(1, ttcMs - (ttftMs ?? 0));
        const tgTps =
          completionTokensTurn > 0 ? completionTokensTurn / (genWindowMs / 1000) : undefined;

        if (ttcMs > 0) turnDurationsMs.push(ttcMs);
        if (ttftMs != null && ttftMs > 0) ttftSamplesMs.push(ttftMs);
        if (ppTps != null && Number.isFinite(ppTps) && ppTps > 0) ppSamples.push(ppTps);
        if (tgTps != null && Number.isFinite(tgTps) && tgTps > 0) tgSamples.push(tgTps);

        const slowThreshold = cfg.slow_tg_tps_threshold ?? 10;
        if (tgTps != null && Number.isFinite(tgTps) && tgTps > 0 && tgTps < slowThreshold) {
          console.warn(
            `[perf] Generation slowed to ${tgTps.toFixed(1)} t/s - context may be too large`
          );
        }

        let healthSnapshot: ServerHealthSnapshot | undefined;
        if (cfg.show_server_metrics !== false) {
          const health = await refreshServerHealth();
          if (health) healthSnapshot = health;
        }

        lastTurnMetrics = {
          totalMs: ttcMs,
          ttftMs,
          promptTokens: promptTokensTurn,
          completionTokens: completionTokensTurn,
          ppTokensPerSec: ppTps,
          tgTokensPerSec: tgTps,
          health: healthSnapshot,
        };

        const legacyChoice = (resp as any)?.role
          ? {
              finish_reason: (resp as any)?.finish_reason ?? 'stop',
              message: {
                role: (resp as any)?.role ?? 'assistant',
                content: (resp as any)?.content ?? '',
                tool_calls: (resp as any)?.tool_calls,
              },
            }
          : undefined;
        const wasToollessRecoveryTurn = forceToollessRecoveryTurn;
        forceToollessRecoveryTurn = false;
        const choice0 = resp.choices?.[0] ?? legacyChoice;
        const finishReason = choice0?.finish_reason ?? 'unknown';
        const msg = choice0?.message;
        const content = msg?.content ?? '';

        // Conditionally strip thinking blocks based on harness config (§4i).
        // Non-reasoning models (thinking.strip === false) never emit <think> blocks,
        // so stripping is a no-op — but we skip the regex work entirely.
        const st = harness.thinking.strip
          ? stripThinking(content)
          : { visible: content, thinking: '' };
        // Strip XML tool-call tag fragments that leak into visible narration
        // when llama-server partially parses Qwen/Hermes XML tool calls.
        const visible = st.visible
          .replace(/<\/?tool_call>/g, '')
          .replace(/<function=[\w.-]+>/g, '')
          .replace(/<\/function>/g, '')
          .replace(/<parameter=[\w.-]+>/g, '')
          .replace(/<\/parameter>/g, '')
          .trim();

        // Show thinking tokens in verbose mode (plan §10)
        if (cfg.verbose && st.thinking) {
          console.warn(`[thinking] ${st.thinking}`);
        }

        let toolCallsArr: import('./types.js').ToolCall[] | undefined = msg?.tool_calls;

        // For models with unreliable tool_calls arrays, validate entries and
        // fall through to content parsing if they look malformed (§4i).
        if (toolCallsArr?.length && !harness.toolCalls.reliableToolCallsArray) {
          const hasValid = toolCallsArr.some(
            (tc) =>
              tc.function?.name &&
              typeof tc.function.name === 'string' &&
              tc.function.name.length > 0
          );
          if (!hasValid) {
            if (cfg.verbose) {
              console.warn(
                `[harness] tool_calls array present but no valid entries (reliableToolCallsArray=false), trying content fallback`
              );
            }
            toolCallsArr = undefined;
          }
        }

        if ((!toolCallsArr || !toolCallsArr.length) && content) {
          const fallback = parseToolCallsFromContent(content);
          if (fallback?.length) {
            toolCallsArr = fallback;
            if (cfg.verbose) {
              console.warn(
                `[harness] extracted ${fallback.length} tool call(s) from content (contentFallbackLikely=${harness.toolCalls.contentFallbackLikely})`
              );
            }
          }
        }

        // Strip markdown code fences from tool arguments if harness says model does this
        if (toolCallsArr?.length && harness.quirks.emitsMarkdownInToolArgs) {
          for (const tc of toolCallsArr) {
            if (tc.function?.arguments) {
              tc.function.arguments = stripMarkdownFences(tc.function.arguments);
            }
          }
        }

        if (wasToollessRecoveryTurn && toolCallsArr?.length) {
          // Recovery turn explicitly disables tools; ignore any stray tool-call output.
          toolCallsArr = undefined;
        }

        if (cfg.verbose) {
          console.warn(
            `[turn ${turns}] finish_reason=${finishReason} content_chars=${content.length} visible_chars=${visible.length} tool_calls=${toolCallsArr?.length ?? 0}`
          );
        }

        const narration = (visible || content || '').trim();
        if ((!toolCallsArr || !toolCallsArr.length) && narration.length === 0) {
          noProgressTurns += 1;
          if (cfg.verbose) {
            console.warn(
              `[loop] no-progress turn ${noProgressTurns}/${NO_PROGRESS_TURN_CAP} (empty response)`
            );
          }
          if (noProgressTurns >= NO_PROGRESS_TURN_CAP) {
            throw new Error(
              `no progress for ${NO_PROGRESS_TURN_CAP} consecutive turns (empty responses with no tool calls). ` +
                `Likely malformed/empty model output loop; stopping early.`
            );
          }
          messages.push({
            role: 'user',
            content: '[system] Empty response. Call a tool or give final answer.',
          });
          await emitTurnEnd({
            turn: turns,
            toolCalls,
            promptTokens: cumulativeUsage.prompt,
            completionTokens: cumulativeUsage.completion,
            promptTokensTurn,
            completionTokensTurn,
            ttftMs,
            ttcMs,
            ppTps,
            tgTps,
          });
          continue;
        }
        noProgressTurns = 0;

        if (toolCallsArr && toolCallsArr.length) {
          noToolTurns = 0;
          // Deduplicate ghost tool calls: if llama-server's XML parser splits one
          // tool call into two entries (one with full args, one empty/partial),
          // drop the empty one. Only removes entries where a richer version of the
          // same tool name exists with strictly more params. Preserves genuine
          // parallel calls (e.g. 13x list_dir with same args = intentional).
          if (toolCallsArr.length > 1) {
            const byName = new Map<string, { tc: ToolCall; argCount: number }[]>();
            for (const tc of toolCallsArr) {
              const n = tc.function?.name ?? '';
              let argCount = 0;
              // Extract arg count without full parse if possible
              const argStr = tc.function?.arguments ?? '{}';
              if (argStr.length > 2) {
                try {
                  argCount = Object.keys(parseJsonArgs(argStr)).length;
                } catch {}
              }
              if (!byName.has(n)) byName.set(n, []);
              byName.get(n)!.push({ tc, argCount });
            }
            const deduped: ToolCall[] = [];
            for (const [, group] of byName) {
              if (group.length > 1) {
                const maxArgs = Math.max(...group.map((g) => g.argCount));
                // Drop entries with strictly fewer args than the richest (ghost duplicates).
                // Keep ALL entries that have the max arg count (genuine parallel calls).
                for (const g of group) {
                  if (g.argCount >= maxArgs || maxArgs === 0) {
                    deduped.push(g.tc);
                  }
                }
              } else {
                deduped.push(group[0].tc);
              }
            }
            if (deduped.length < toolCallsArr.length) {
              if (cfg.verbose)
                console.warn(
                  `[dedup] dropped ${toolCallsArr.length - deduped.length} ghost tool call(s)`
                );
            }
            toolCallsArr = deduped;
          }

          // Newline after model narration before tool execution, so the next
          // narration chunk starts on a fresh line (avoids wall-of-text output).
          if (visible && hookObj.onToken) hookObj.onToken('\n');

          const originalToolCallsArr = toolCallsArr;
          const preparedTurn = toolLoopGuard.prepareTurn(originalToolCallsArr);
          const replayByCallId = preparedTurn.replayByCallId;
          const parsedArgsByCallId = preparedTurn.parsedArgsByCallId;
          toolCallsArr = preparedTurn.uniqueCalls;

          toolCalls += originalToolCallsArr.length;
          const assistantToolCallText = visible || '';
          const compactAssistantToolCallText =
            assistantToolCallText.length > 900
              ? `${assistantToolCallText.slice(0, 900)}\n[history-compacted: assistant narration truncated before tool execution]`
              : assistantToolCallText;
          messages.push({
            role: 'assistant',
            content: compactAssistantToolCallText,
            tool_calls: originalToolCallsArr,
          });

          // sigCounts is scoped to the entire ask() run (see above)

          // Bridge ConfirmationProvider → legacy confirm callback for tools.
          // If a ConfirmationProvider is given, wrap it; otherwise fall back to raw callback.
          // The bridge accepts an optional context object for rich confirm data.
          const confirmBridge = opts.confirmProvider
            ? async (
                prompt: string,
                bridgeCtx?: { tool?: string; args?: Record<string, unknown>; diff?: string }
              ) =>
                opts.confirmProvider!.confirm({
                  tool: bridgeCtx?.tool ?? '',
                  args: bridgeCtx?.args ?? {},
                  summary: prompt,
                  diff: bridgeCtx?.diff,
                  mode: cfg.approval_mode,
                })
            : opts.confirm;

          const ctx = buildToolCtx({
            signal: ac.signal,
            confirmBridge,
            onMutation: (absPath: string) => {
              lastEditedPath = absPath;
              mutationVersion++;
              suppressedTools.clear(); // file changed, re-enable all tools
            },
          });

          // Tool-call argument parsing and validation logic
          const fileMutationsInTurn = toolCallsArr.filter((tc) =>
            isMutationTool(tc.function?.name)
          ).length;
          if (fileMutationsInTurn >= 3 && isGitDirty(ctx.cwd)) {
            const shouldStash = confirmBridge
              ? await confirmBridge(
                  `Working tree is dirty and the agent plans ${fileMutationsInTurn} file edits. Stash current changes first? [Y/n]`,
                  { tool: 'git_stash', args: { fileMutationsInTurn } }
                )
              : false;
            if (shouldStash) {
              const stashed = stashWorkingTree(ctx.cwd);
              if (!stashed.ok) {
                console.warn(`[warn] auto-stash failed: ${stashed.message}`);
              }
            }
          }

          const resolveCallId = (tc: ToolCall) =>
            tc.id || `call_${Date.now()}_${toolNameByCallId.size}`;

          // Pre-dispatch loop detection: check tool calls against previous turns.
          // We deduplicate within a single response (a model may emit multiple identical
          // read_file calls in one parallel batch — that's fine). We only count unique
          // signatures per LLM response, then check across responses.
          //
          // Important: repeated `exec {command:"npm test"}` can be normal during fix loops.
          // We only treat repeated exec as a loop if no file mutations happened since the
          // last time we saw that exact exec signature.
          const turnSigs = new Set<string>();
          const sigMetaBySig = new Map<
            string,
            { toolName: string; args: Record<string, unknown> }
          >();
          for (const tc of toolCallsArr) {
            const callId = resolveCallId(tc);
            const parsedArgs = parsedArgsByCallId.get(callId) ?? {};
            const sig = toolLoopGuard.computeSignature(tc.function.name, parsedArgs);
            turnSigs.add(sig);
            if (!sigMetaBySig.has(sig)) {
              sigMetaBySig.set(sig, { toolName: tc.function.name, args: parsedArgs });
            }
          }

          // Repeated read-only exec calls can be served from cache instead of hard-breaking.
          const repeatedReadOnlyExecSigs = new Set<string>();
          const readOnlyExecTurnHints: string[] = [];
          // Repeated exec calls (any kind) can replay cached results under pressure.
          const replayExecSigs = new Set<string>();
          // Repeated read_file/read_files/list_dir calls can be served from cache.
          const repeatedReadFileSigs = new Set<string>();
          // Poisoned tool sigs: at consec >= 3, don't execute — return error instead.
          const poisonedToolSigs = new Set<string>();

          let shouldForceToollessRecovery = false;
          const criticalLoopSigs = new Set<string>();
          for (const tc of toolCallsArr) {
            const callId = resolveCallId(tc);
            const args = parsedArgsByCallId.get(callId) ?? {};
            const detected = toolLoopGuard.detect(tc.function.name, args);
            const warning = toolLoopGuard.formatWarning(detected, tc.function.name);
            if (warning) {
              const warningKey = `${warning.level}:${warning.detector}:${detected.signature}`;
              if (!toolLoopWarningKeys.has(warningKey)) {
                toolLoopWarningKeys.add(warningKey);
                const argsSnippet = JSON.stringify(args).slice(0, 300);
                console.error(
                  `[tool-loop] ${warning.level}: ${warning.toolName} (${warning.detector}, count=${warning.count}) args=${argsSnippet}`
                );
                await emitToolLoop({
                  level: warning.level,
                  detector: warning.detector,
                  toolName: warning.toolName,
                  count: warning.count,
                  message: warning.message,
                });
                messages.push({
                  role: 'system',
                  content: `[tool-loop ${warning.level}] ${warning.message}. Use existing results; move on.`,
                } as ChatMessage);
              }
            }

            if (toolLoopGuard.shouldDisableToolsNextTurn(detected)) {
              shouldForceToollessRecovery = true;
              criticalLoopSigs.add(detected.signature);
            }
          }

          // Track whether a mutation happened since a given signature was last seen.
          // (Tool-loop is single-threaded across turns; this is safe to keep in-memory.)

          for (const sig of turnSigs) {
            sigCounts.set(sig, (sigCounts.get(sig) ?? 0) + 1);
            const sigMeta = sigMetaBySig.get(sig);
            const toolName = sigMeta?.toolName ?? sig.split(':')[0];

            if (criticalLoopSigs.has(sig)) {
              // Critical detector already fired for this signature; recover next turn
              // with tools disabled instead of throwing in per-tool hard-break logic.
              shouldForceToollessRecovery = true;
              continue;
            }

            // For exec loops, only break if nothing changed since last identical exec.
            if (toolName === 'exec') {
              // If this exact exec signature was seen before, record the mutation version at that time.
              // (First time we see it, assume it's OK.)
              const seenAt = mutationVersionBySig.get(sig);
              const hasMutatedSince = seenAt === undefined ? true : mutationVersion !== seenAt;

              // Update to "now" for next turn.
              mutationVersionBySig.set(sig, mutationVersion);

              if (!hasMutatedSince) {
                const count = sigCounts.get(sig) ?? 0;

                // Early replay: if this exact exec was already run (count >= 2) and
                // we have a cached result, replay it instead of re-executing.  This
                // prevents the compaction death spiral where tool results get dropped,
                // the model forgets it ran the command, and re-runs it endlessly.
                // Skip read-only commands that already have their own observation cache —
                // those are handled by the dedicated read-only path at loopThreshold.
                const command = execCommandFromSig(sig);
                const hasReadOnlyCache =
                  looksLikeReadOnlyExecCommand(command) && execObservationCacheBySig.has(sig);
                if (count >= 2 && lastExecResultBySig.has(sig) && !hasReadOnlyCache) {
                  replayExecSigs.add(sig);
                  continue;
                }

                let loopThreshold = harness.quirks.loopsOnToolError ? 3 : 6;
                // If the cached observation already tells the model "no matches found",
                // break much earlier — the model is ignoring the hint.
                const cachedObs = execObservationCacheBySig.get(sig) ?? '';
                if (cachedObs.includes('Do NOT retry')) {
                  loopThreshold = Math.min(loopThreshold, 3);
                }
                // At 3x, inject vault context so the model gets the data it needs
                if (count >= 3 && count < loopThreshold) {
                  await injectVaultContext().catch(() => {});
                }
                if (count >= loopThreshold) {
                  const sigArgs = sigMetaBySig.get(sig)?.args ?? {};
                  const command =
                    typeof (sigArgs as any)?.command === 'string'
                      ? String((sigArgs as any).command)
                      : '';
                  const canReuseReadOnlyObservation =
                    looksLikeReadOnlyExecCommand(command) && execObservationCacheBySig.has(sig);

                  if (canReuseReadOnlyObservation) {
                    repeatedReadOnlyExecSigs.add(sig);
                    if (!readOnlyExecHintedSigs.has(sig)) {
                      readOnlyExecHintedSigs.add(sig);
                      readOnlyExecTurnHints.push(command || 'exec command');
                    }
                    continue;
                  }

                  const argsPreviewRaw = JSON.stringify(sigArgs);
                  const argsPreview =
                    argsPreviewRaw.length > 220
                      ? argsPreviewRaw.slice(0, 220) + '…'
                      : argsPreviewRaw;
                  throw new Error(
                    `tool ${toolName}: identical call repeated ${loopThreshold}x across turns; breaking loop. ` +
                      `args=${argsPreview}`
                  );
                }
              }

              continue;
            }

            // Read-only tools: only count consecutive identical calls (back-to-back turns
            // with no other tool calls in between). A read → edit → read cycle is normal
            // and resets the counter.
            if (isReadOnlyTool(toolName)) {
              // Check if this sig was also in the previous turn's set
              if (lastTurnSigs.has(sig)) {
                consecutiveCounts.set(sig, (consecutiveCounts.get(sig) ?? 1) + 1);
              } else {
                consecutiveCounts.set(sig, 1);
              }
              const consec = consecutiveCounts.get(sig) ?? 1;
              const isReadFileTool = READ_FILE_CACHE_TOOLS.has(toolName);
              const hardBreakAt = isReadFileTool ? 6 : 4;

              // At 3x, first warning
              if (consec >= 3) {
                if (consec === 3) {
                  let warningMsg: string | null = null;
                  if (toolName === 'read_file') {
                    warningMsg = 'Stop repeatedly reading the same file over and over.';
                  } else if (toolName === 'read_files') {
                    warningMsg = 'Stop repeatedly reading the same files over and over.';
                  } else if (toolName === 'list_dir') {
                    warningMsg = 'Stop repeatedly reading the same directory over and over.';
                  }

                  if (warningMsg) {
                    messages.push({
                      role: 'system',
                      content: `${warningMsg} Content unchanged. Reuse prior result.`,
                    } as ChatMessage);
                  }
                }
              }

              // At 2x, serve from cache if available
              if (consec >= 2 && isReadFileTool) {
                const argsForSig = sigMetaBySig.get(sig)?.args ?? {};
                const replay = await toolLoopGuard.getReadCacheReplay(
                  toolName,
                  argsForSig,
                  ctx.cwd
                );
                if (replay) {
                  repeatedReadFileSigs.add(sig);
                  continue;
                }
              }

              // Deterministic recovery at threshold (no hard throw): force one no-tools turn.
              // IMPORTANT: evaluate this before the generic consec>=3 continue path.
              if (consec >= hardBreakAt) {
                shouldForceToollessRecovery = true;
                messages.push({
                  role: 'system',
                  content: `[tool-loop critical] ${toolName} repeated ${consec}x unchanged. Tools disabled next turn; use existing results.`,
                } as ChatMessage);
              }

              // At consec >= 3: poison the result (don't execute, return error).
              // At consec >= 4: also suppress the tool from the schema entirely.
              if (consec >= 3) {
                poisonedToolSigs.add(sig);
                if (consec >= 4) {
                  suppressedTools.add(toolName);
                }
                continue;
              }

              continue;
            }

            // Improved handling of mutating tool loops - gradual recovery instead of immediate error
            const sigCount = sigCounts.get(sig) ?? 0;
            const loopThreshold = harness.quirks.loopsOnToolError ? 2 : 3;
            
            if (sigCount >= loopThreshold) {
              const argsObj = sigMetaBySig.get(sig)?.args ?? {};
              const argsRaw = JSON.stringify(argsObj);
              const argsPreview = argsRaw.length > 220 ? argsRaw.slice(0, 220) + '…' : argsRaw;
              
              // At threshold: trigger toolless recovery instead of throwing error
              // This gives the model a chance to think and try a different approach
              console.error(
                `[tool-loop] critical: ${toolName} repeated ${sigCount}x with same args. Triggering recovery turn.`
              );
              shouldForceToollessRecovery = true;
              
              // Poison this specific tool signature to prevent re-execution
              poisonedToolSigs.add(sig);
              
              // Add helpful guidance
              messages.push({
                role: 'user' as const,
                content:
                  `[system] Tool loop detected: ${toolName} called ${sigCount}x with identical arguments.\n` +
                  `args=${argsPreview}\n\n` +
                  `The same edit is being attempted repeatedly. This usually means:\n` +
                  `1. The edit already succeeded - verify by reading the file\n` +
                  `2. The old_text doesn't match - read the file to see actual content\n` +
                  `3. A different approach is needed\n\n` +
                  `Do NOT repeat the same edit. Read the file first, then decide on next steps.`,
              } as ChatMessage);
              continue;
            }
            
            // At sigCount === loopThreshold - 1: inject early warning
            if (sigCount === loopThreshold - 1) {
              console.error(
                `[tool-loop] warning: ${toolName} repeated ${sigCount}x. Next repeat will trigger recovery.`
              );
              messages.push({
                role: 'user' as const,
                content:
                  `[system] Warning: ${toolName} has been called ${sigCount} times with identical arguments. ` +
                  `If this edit keeps failing, read the target file to verify its current state before trying again.`,
              } as ChatMessage);
            }
          }

          // Update consecutive tracking: save this turn's signatures for next turn comparison.
          lastTurnSigs = turnSigs;

          if (shouldForceToollessRecovery) {
            if (!toollessRecoveryUsed) {
              console.error(`[tool-loop] Disabling tools for one recovery turn (turn=${turns})`);
              forceToollessRecoveryTurn = true;
              toollessRecoveryUsed = true;
              messages.push({
                role: 'user' as const,
                content:
                  '[system] Tool loop detected. Tools disabled. Use existing results for next step.',
              });

              await emitTurnEnd({
                turn: turns,
                toolCalls,
                promptTokens: cumulativeUsage.prompt,
                completionTokens: cumulativeUsage.completion,
                promptTokensTurn,
                completionTokensTurn,
                ttftMs,
                ttcMs,
                ppTps,
                tgTps,
              });
              continue;
            }
            console.error(
              `[tool-loop] Recovery failed — model resumed looping after tools-disabled turn (turn=${turns})`
            );
            throw new AgentLoopBreak(
              'critical tool-loop persisted after one tools-disabled recovery turn. Stopping to avoid infinite loop.'
            );
          }

          const runOne = async (tc: ToolCall) => {
            // Resolve tool name aliases (bash→exec, file_read→read_file, etc.)
            const rawName = tc.function.name;
            const { resolved: name, wasAliased } = resolveToolAlias(rawName);
            if (wasAliased) {
              // Patch the tool call in-place so downstream code (loop guard, etc.) sees the canonical name
              tc.function.name = name;
            }
            const rawArgs = tc.function.arguments ?? '{}';
            const callId = resolveCallId(tc);
            toolNameByCallId.set(callId, name);

            let args: any;
            try {
              args = rawArgs ? parseJsonArgs(rawArgs) : {};
            } catch {
              // Respect harness retry limit for malformed JSON (§4i)
              malformedCount++;
              
              // Detect if the model is outputting diff/patch format instead of JSON
              const looksLikeDiff = /^[\s"]*---\s+a\/|^\+\+\+\s+b\/|^@@\s+-\d+/m.test(rawArgs);
              const looksLikePatch = /^diff\s+--git|^Index:|^\*\*\*\s+/m.test(rawArgs);
              
              if (malformedCount > harness.toolCalls.retryOnMalformed) {
                // Break the outer loop — this model won't self-correct
                const hint = looksLikeDiff || looksLikePatch
                  ? ' The model is outputting diff/patch format instead of JSON. This may be a model compatibility issue.'
                  : '';
                throw new AgentLoopBreak(
                  `tool ${name}: malformed JSON exceeded retry limit (${harness.toolCalls.retryOnMalformed}): ${rawArgs.slice(0, 200)}${hint}`
                );
              }
              
              // Give specific guidance based on the error pattern
              let hint = 'Return a valid JSON object for function.arguments.';
              if (looksLikeDiff || looksLikePatch) {
                hint = 
                  'ERROR: You output a diff/patch format instead of JSON. ' +
                  'Tool arguments must be a JSON object like {"path": "file.txt", "old_text": "...", "new_text": "..."}. ' +
                  'Do NOT use unified diff format (--- a/ +++ b/ @@). ' +
                  'Use the exact JSON schema required by the tool.';
              }
              
              throw new ToolError(
                'invalid_args',
                `tool ${name}: arguments not valid JSON`,
                false,
                hint,
                { raw: rawArgs.slice(0, 200) }
              );
            }

            if (args == null || typeof args !== 'object' || Array.isArray(args)) {
              throw new ValidationError([
                { field: 'arguments', message: 'must be a JSON object', value: args },
              ]);
            }

            const builtInFn = (tools as any)[name] as Function | undefined;
            const lspToolCall = isLspTool(name);
            const isSpawnTask = name === 'spawn_task';
            const hasMcpTool = mcpManager?.hasTool(name) === true;
            if (!builtInFn && !lspToolCall && !hasMcpTool && !isSpawnTask)
              throw new Error(`unknown tool: ${name}`);

            // Keep parsed args by call-id so we can digest/archive tool outputs with context.
            const parsedArgs = args && typeof args === 'object' && !Array.isArray(args)
              ? args
              : {};
            toolLoopGuard.registerCall(name, parsedArgs, callId);
            toolArgsByCallId.set(callId, parsedArgs);
            recordToolUsageForHints(name, parsedArgs as Record<string, unknown>);

            // Pre-dispatch argument validation.
            // - Required params
            // - Type/range/enums
            // - Unknown properties
            if (builtInFn || isSpawnTask) {
              const missing = getMissingRequiredParams(name, args);
              if (missing.length) {
                throw new ValidationError(
                  missing.map((m) => ({
                    field: m,
                    message: 'required parameter is missing',
                    value: undefined,
                  }))
                );
              }

              const argIssues = getArgValidationIssues(name, args);
              if (argIssues.length) {
                throw new ValidationError(
                  argIssues.map((i) => ({ field: i.field, message: i.message, value: i.value }))
                );
              }
            }

            // ── Pre-dispatch safety screening (Phase 9) ──
            // Catches forbidden commands at the agent level before tool execution.
            // This enables showBlocked notifications and plan mode integration.
            if (name === 'exec' && typeof args.command === 'string') {
              const sv = checkExecSafety(args.command);
              if (sv.tier === 'forbidden') {
                const reason = sv.reason || 'forbidden command';
                opts.confirmProvider?.showBlocked?.({ tool: name, args, reason });
                throw new Error(`exec: ${reason} — command: ${args.command}`);
              }
            }
            if (isMutationTool(name) && typeof args.path === 'string') {
              const absPath = args.path.startsWith('/')
                ? args.path
                : path.resolve(projectDir, args.path);

              // Track in turn transaction for potential atomic rollback.
              turnTransaction.track(absPath);

              // ── Pre-dispatch: block edits to files in a mutation spiral ──
              if (fileMutationBlocked.has(absPath)) {
                const basename = path.basename(absPath);
                throw new Error(
                  `${name}: BLOCKED — ${basename} has been edited ${fileMutationCounts.get(absPath) ?? '?'} times in this session and is likely corrupted. ` +
                    `Restore it first with: exec { "command": "git checkout -- ${args.path}" } or exec { "command": "git restore ${args.path}" }, ` +
                    'then make ONE well-planned edit. If you cannot fix it, tell the user what went wrong.'
                );
              }

              const pv = checkPathSafety(absPath);
              if (pv.tier === 'forbidden') {
                const reason = pv.reason || 'protected path';
                opts.confirmProvider?.showBlocked?.({ tool: name, args, reason });
                throw new Error(`${name}: ${reason}`);
              }
            }

            // ── Anti-scan: read_file guardrails (Fix 1/2/3) ──
            if (name === 'read_file' || name === 'read_files') {
              const filePath = typeof args.path === 'string' ? args.path : '';
              const searchTerm = typeof args.search === 'string' ? args.search : '';

              // Fix 1: Hard cumulative budget — refuse reads once hard cap is reached.
              // Count only actual executed read-only calls (not cache replays), so this check
              // blocks the next call exactly at the configured cap.
              if (cumulativeReadOnlyCalls >= READ_BUDGET_HARD) {
                await emitToolCall(callId, name, args);
                await emitToolResult({
                  id: callId,
                  name,
                  success: false,
                  summary: 'read budget exhausted',
                  result: '',
                });
                return {
                  id: callId,
                  content: `STOP: Read budget exhausted (${cumulativeReadOnlyCalls}/${READ_BUDGET_HARD} calls). Do NOT read more files. Use search_files or exec: grep -rn "pattern" path/ to find what you need.`,
                };
              }

              // Fix 2: Directory scan detection — counts unique files per dir (re-reads are OK)
              if (filePath) {
                const absFilePath = filePath.startsWith('/')
                  ? filePath
                  : path.resolve(projectDir, filePath);
                const parentDir = path.dirname(absFilePath);
                if (!readDirFiles.has(parentDir)) readDirFiles.set(parentDir, new Set());
                readDirFiles.get(parentDir)!.add(absFilePath);
                const uniqueCount = readDirFiles.get(parentDir)!.size;
                if (uniqueCount > 8 && !blockedDirs.has(parentDir)) {
                  blockedDirs.add(parentDir);
                }
                if (blockedDirs.has(parentDir) && uniqueCount > 8) {
                  await emitToolCall(callId, name, args);
                  await emitToolResult({
                    id: callId,
                    name,
                    success: false,
                    summary: 'dir scan blocked',
                    result: '',
                  });
                  return {
                    id: callId,
                    content: `STOP: Directory scan detected — you've read ${uniqueCount} unique files from ${parentDir}/. Use search_files(pattern, '${parentDir}') or exec: grep -rn "pattern" ${parentDir}/ instead of reading files individually.`,
                  };
                }
              }

              // Fix 3: Same-search-term detection
              if (searchTerm && filePath) {
                const key = searchTerm.toLowerCase();
                if (!searchTermFiles.has(key)) searchTermFiles.set(key, new Set());
                searchTermFiles.get(key)!.add(filePath);
                if (searchTermFiles.get(key)!.size >= 3) {
                  await emitToolCall(callId, name, args);
                  await emitToolResult({
                    id: callId,
                    name,
                    success: false,
                    summary: 'use search_files',
                    result: '',
                  });
                  return {
                    id: callId,
                    content: `STOP: You've searched ${searchTermFiles.get(key)!.size} files for "${searchTerm}" one at a time. This is what search_files does in one call. Use: search_files(pattern="${searchTerm}", path=".") or exec: grep -rn "${searchTerm}" .`,
                  };
                }
              }
            }

            // ── Plan mode blocking (Phase 8) ──
            // In plan mode, mutating tools return blocked stubs instead of executing.
            // Read-only tools still execute normally.
            if (cfg.approval_mode === 'plan' && !isReadOnlyToolDynamic(name)) {
              const summary = planModeSummary(name, args);
              const step: PlanStep = {
                index: planSteps.length + 1,
                tool: name,
                args,
                blocked: true,
                summary,
              };
              planSteps.push(step);

              const blockedMsg = `[blocked: approval_mode=plan] Would ${summary}`;

              // Notify via confirmProvider.showBlocked if available
              opts.confirmProvider?.showBlocked?.({
                tool: name,
                args,
                reason: `plan mode: ${summary}`,
              });

              // Hook: onToolCall + onToolResult for plan-blocked actions
              await emitToolCall(callId, name, args);
              await emitToolResult({
                id: callId,
                name,
                success: true,
                summary: `⏸ ${summary} (blocked)`,
                result: blockedMsg,
              });

              return { id: callId, content: blockedMsg };
            }

            // Hook: onToolCall (Phase 8.5)
            await emitToolCall(callId, name, args);

            if (cfg.step_mode) {
              const stepPrompt = `Step mode: execute ${name}(${JSON.stringify(args).slice(0, 200)}) ? [Y/n]`;
              const ok = confirmBridge
                ? await confirmBridge(stepPrompt, { tool: name, args })
                : true;
              if (!ok) {
                return { id: callId, content: '[skipped by user: step mode]' };
              }
            }

            const sig = toolLoopGuard.computeSignature(
              name,
              args && typeof args === 'object' && !Array.isArray(args) ? args : {}
            );

            // Poisoned tool call: don't execute, return error-like result.
            if (poisonedToolSigs.has(sig)) {
              const consec = consecutiveCounts.get(sig) ?? 3;
              const poisonMsg = `Error: This exact ${name} call has been repeated ${consec} times with identical arguments and results. The tool is temporarily disabled. Use the information you already have, or try a different approach.`;
              return { id: callId, content: poisonMsg };
            }

            let content = '';
            let reusedCachedReadOnlyExec = false;
            let reusedCachedReadTool = false;
            let toolFallbackNote: string | null = null;

            if (name === 'exec' && repeatedReadOnlyExecSigs.has(sig)) {
              const cached = execObservationCacheBySig.get(sig);
              if (cached) {
                content = withCachedExecObservationHint(cached);
                reusedCachedReadOnlyExec = true;
              }
            }

            // Replay any exec result (read-only or not) when the loop detector flagged it.
            if (name === 'exec' && !reusedCachedReadOnlyExec && replayExecSigs.has(sig)) {
              const cached = lastExecResultBySig.get(sig);
              if (cached) {
                content = withReplayedExecHint(cached);
                reusedCachedReadOnlyExec = true; // skip re-execution below
              }
            }

            if (READ_FILE_CACHE_TOOLS.has(name) && repeatedReadFileSigs.has(sig)) {
              const replay = await toolLoopGuard.getReadCacheReplay(
                name,
                args as Record<string, unknown>,
                ctx.cwd
              );
              if (replay) {
                content = replay;
                reusedCachedReadTool = true;
              }
            }

            if (!reusedCachedReadOnlyExec && !reusedCachedReadTool) {
              if (isSpawnTask) {
                content = await runSpawnTask(args);
              } else if (builtInFn) {
                const callCtx = {
                  ...ctx,
                  toolCallId: callId,
                  toolName: name,
                  onToolStream: emitToolStream,
                };

                let value: any;
                try {
                  value = await builtInFn(callCtx as any, args);
                } catch (err: any) {
                  const msg = String(err?.message ?? err ?? '');

                  // Fallback #1: edit_file mismatch -> targeted edit_range based on closest-match hint.
                  const isEditMismatch =
                    name === 'edit_file' && /edit_file:\s*old_text not found/i.test(msg);
                  if (isEditMismatch && typeof args?.path === 'string') {
                    const best = msg.match(/Closest match at line\s+(\d+)\s*\((\d+)% similarity\)/i);
                    const bestLine = best ? Number.parseInt(best[1], 10) : NaN;
                    const similarity = best ? Number.parseInt(best[2], 10) : NaN;
                    const oldTextForRange = String(args?.old_text ?? '');
                    const oldLineCount = Math.max(1, oldTextForRange.split(/\r?\n/).length);
                    const endLine = Number.isFinite(bestLine)
                      ? bestLine + oldLineCount - 1
                      : Number.NaN;
                    const editRangeFn = (tools as any)['edit_range'] as Function | undefined;

                    if (
                      editRangeFn &&
                      Number.isFinite(bestLine) &&
                      Number.isFinite(endLine) &&
                      Number.isFinite(similarity) &&
                      similarity >= 70
                    ) {
                      const fallbackArgs = {
                        path: args.path,
                        start_line: bestLine,
                        end_line: endLine,
                        replacement: args.new_text,
                      };
                      if (cfg.verbose) {
                        console.warn(
                          `[edit_file] auto-fallback to edit_range at ${bestLine}-${endLine} (${similarity}% similarity)`
                        );
                      }
                      value = await editRangeFn(callCtx as any, fallbackArgs);
                      args = fallbackArgs;
                      toolFallbackNote = 'auto edit_range fallback';
                    } else {
                      throw err;
                    }
                  } else {
                    const isWriteRefusal =
                      name === 'write_file' &&
                      !args?.overwrite &&
                      !args?.force &&
                      /write_file:\s*refusing to overwrite existing non-empty file/i.test(msg);

                    if (!isWriteRefusal) throw err;

                    // Fallback #2 (preferred): rewrite existing file via edit_range first.
                    const editRangeFn = (tools as any)['edit_range'] as Function | undefined;
                    let usedEditRangeFallback = false;
                    if (editRangeFn && typeof args?.path === 'string') {
                      try {
                        const absWritePath = args.path.startsWith('/')
                          ? args.path
                          : path.resolve(projectDir, args.path);
                        const curText = await fs.readFile(absWritePath, 'utf8');
                        const totalLines = Math.max(1, curText.split(/\r?\n/).length);
                        const fallbackArgs = {
                          path: args.path,
                          start_line: 1,
                          end_line: totalLines,
                          replacement: args.content,
                        };
                        if (cfg.verbose) {
                          console.warn(
                            `[write_file] auto-fallback to edit_range for existing file (${totalLines} lines)`
                          );
                        }
                        value = await editRangeFn(callCtx as any, fallbackArgs);
                        args = fallbackArgs;
                        toolFallbackNote = 'auto edit_range fallback';
                        usedEditRangeFallback = true;
                      } catch {
                        // fall through to explicit overwrite retry below
                      }
                    }

                    if (!usedEditRangeFallback) {
                      const retryArgs = { ...(args as Record<string, unknown>), overwrite: true };
                      if (cfg.verbose) {
                        console.warn(
                          '[write_file] auto-retrying with overwrite=true after explicit overwrite refusal'
                        );
                      }
                      value = await builtInFn(callCtx as any, retryArgs);
                      args = retryArgs;
                      toolFallbackNote = 'auto overwrite fallback';
                    }
                  }
                }

                content = typeof value === 'string' ? value : JSON.stringify(value);

                if (
                  READ_FILE_CACHE_TOOLS.has(name) &&
                  typeof content === 'string' &&
                  !content.startsWith('ERROR:')
                ) {
                  const baseCwd =
                    typeof (args as any)?.cwd === 'string' ? String((args as any).cwd) : ctx.cwd;
                  await toolLoopGuard.storeReadCache(
                    name,
                    args as Record<string, unknown>,
                    baseCwd,
                    content
                  );
                }

                if (name === 'exec') {
                  // Successful exec clears blocked-loop counters.
                  blockedExecAttemptsBySig.clear();

                  // Cache every exec result so repeated calls under context pressure
                  // can replay the result instead of re-executing.
                  lastExecResultBySig.set(sig, content);

                  const cmd = String(args?.command ?? '');
                  if (looksLikeReadOnlyExecCommand(cmd) && readOnlyExecCacheable(content)) {
                    execObservationCacheBySig.set(sig, content);
                  }

                  // Capture successful test runs for better partial-failure diagnostics.
                  try {
                    const parsed = JSON.parse(content);
                    const out = String(parsed?.out ?? '');
                    const rc = Number(parsed?.rc ?? NaN);
                    const looksLikeTest =
                      /(^|\s)(node\s+--test|npm\s+test|pnpm\s+test|yarn\s+test|pytest|go\s+test|cargo\s+test|ctest)(\s|$)/i.test(
                        cmd
                      );
                    if (looksLikeTest && Number.isFinite(rc) && rc === 0) {
                      lastSuccessfulTestRun = {
                        command: cmd,
                        outputPreview: out.slice(0, 400),
                      };
                    }
                  } catch {
                    // Ignore parse issues; non-JSON exec output is tolerated.
                  }
                }
              } else if (isLspTool(name) && lspManager) {
                // LSP tool dispatch
                content = await dispatchLspTool(name, args);
              } else {
                if (mcpManager == null) {
                  throw new Error(`unknown tool: ${name}`);
                }

                const mcpReadOnly = isReadOnlyToolDynamic(name);
                if (!cfg.step_mode && !ctx.noConfirm && !mcpReadOnly) {
                  const prompt = `Execute MCP tool '${name}'? [Y/n]`;
                  const ok = confirmBridge
                    ? await confirmBridge(prompt, { tool: name, args })
                    : true;
                  if (!ok) {
                    return { id: callId, content: '[skipped by user: approval]' };
                  }
                }

                const callArgs =
                  args && typeof args === 'object' && !Array.isArray(args)
                    ? (args as Record<string, unknown>)
                    : {};
                content = await mcpManager.callTool(name, callArgs);
              }
            }

            // Append a hint when a read-only tool is called consecutively with
            // identical arguments — the model may not realize the content hasn't changed.
            if (isReadOnlyToolDynamic(name)) {
              const consec = consecutiveCounts.get(sig) ?? 0;
              if (consec >= 2) {
                content += `\n\n[WARNING: You have read this exact same resource ${consec}x consecutively with identical arguments. The content has NOT changed. Do NOT read it again. Use the information above and move on to the next step.]`;
              }
            }

            // ── Early truncation pass ──────────────────────────────────
            // Cap extremely large tool output (>50KB) early to avoid
            // running leak detection, loop guard, and other processing
            // on megabytes of npm install / build output. The final
            // precise truncation still happens before return.
            const EARLY_TRUNCATION_LIMIT = 50_000;
            if (content.length > EARLY_TRUNCATION_LIMIT) {
              const headLen = Math.floor(EARLY_TRUNCATION_LIMIT * 0.8);
              const tailLen = EARLY_TRUNCATION_LIMIT - headLen - 100;
              content = content.slice(0, headLen) +
                `\n\n[...${content.length - headLen - tailLen} chars truncated for processing efficiency...]\n\n` +
                content.slice(-tailLen);
            }

            // Hook: onToolResult (Phase 8.5 + Phase 7 rich display)
            let toolSuccess = true;
            let summary = reusedCachedReadOnlyExec
              ? 'cached read-only exec observation (unchanged)'
              : toolResultSummary(name, args, content, true);
            if (toolFallbackNote) {
              summary = `${summary} (${toolFallbackNote})`;
            }
            const resultEvent: ToolResultEvent = {
              id: callId,
              name,
              success: true,
              summary,
              result: content,
            };

            // Phase 7: populate rich display fields
            if (name === 'exec') {
              try {
                const parsed = JSON.parse(content);
                if (parsed.out) resultEvent.execOutput = parsed.out;
                const rc = Number(parsed?.rc ?? NaN);
                if (Number.isFinite(rc)) {
                  resultEvent.execRc = rc;
                  const cmd = String(args?.command ?? '');
                  if (execRcShouldSignalFailure(cmd) && rc !== 0) {
                    toolSuccess = false;
                  }
                }
              } catch {}
            } else if (name === 'search_files') {
              const lines = content.split('\n').filter(Boolean);
              if (lines.length > 0) resultEvent.searchMatches = lines.slice(0, 20);
            } else if (isMutationTool(name) && replay) {
              // Grab the most recent checkpoint for a diff preview
              try {
                const cps = await replay.list(1);
                if (cps.length > 0) {
                  const got = await replay.get(cps[0].id);
                  const before = got.before.toString('utf8');
                  const after = (got.after ?? Buffer.from('')).toString('utf8');
                  if (before !== after) {
                    // Generate a minimal unified diff
                    resultEvent.diff = generateMinimalDiff(before, after, cps[0].filePath);
                  }
                }
              } catch {}
            }

            resultEvent.success = toolSuccess;
            if (!toolSuccess && name === 'exec' && typeof resultEvent.execRc === 'number') {
              resultEvent.summary = `rc=${resultEvent.execRc} (command failed)`;
            }

            await emitToolResult(resultEvent);

            // Proactive LSP diagnostics after file mutations
            if (lspManager?.hasServers() && lspCfg?.proactive_diagnostics !== false) {
              if (isMutationTool(name)) {
                const mutatedPath = typeof args.path === 'string' ? args.path : '';
                if (mutatedPath) {
                  try {
                    const absPath = mutatedPath.startsWith('/')
                      ? mutatedPath
                      : path.join(projectDir, mutatedPath);
                    const fileText = await fs.readFile(absPath, 'utf8');
                    await lspManager.ensureOpen(absPath, fileText);
                    await lspManager.notifyDidSave(absPath, fileText);
                    // Small delay so the server can process diagnostics
                    await new Promise((r) => setTimeout(r, 200));
                    const diags = await lspManager.getDiagnostics(absPath);
                    if (
                      diags &&
                      !diags.startsWith('No diagnostics') &&
                      !diags.startsWith('[lsp] no language')
                    ) {
                      content += `\n\n[lsp] Diagnostics after edit:\n${diags}`;
                    }
                  } catch {
                    // Best-effort; never block the agent loop.
                  }
                }
              }
            }

            toolLoopGuard.registerOutcome(name, args as Record<string, unknown>, {
              toolCallId: callId,
              result: content,
            });

            // Count only actual read-only executions toward cumulative read budget.
            // Cached/replayed read observations should not consume budget.
            if (
              isReadOnlyToolDynamic(name) &&
              !reusedCachedReadTool &&
              !reusedCachedReadOnlyExec
            ) {
              cumulativeReadOnlyCalls += 1;
            }

            // ── Per-file mutation spiral detection ──
            // Track edits to the same file. If the model keeps editing the same file
            // over and over, it's likely in an edit→break→read→edit corruption spiral.
            if (isMutationTool(name) && toolSuccess && typeof args.path === 'string') {
              const absPath = args.path.startsWith('/')
                ? args.path
                : path.resolve(projectDir, args.path);
              const basename = path.basename(absPath);

              // write_file = full rewrite. If the model is rewriting the file completely
              // after being warned, give it a fresh chance (reset counter to 1).
              if (name === 'write_file' && fileMutationCounts.has(absPath)) {
                fileMutationCounts.set(absPath, 1);
                fileMutationWarned.delete(absPath);
                fileMutationBlocked.delete(absPath);
              } else {
                const count = (fileMutationCounts.get(absPath) ?? 0) + 1;
                fileMutationCounts.set(absPath, count);

                if (count >= FILE_MUTATION_BLOCK_THRESHOLD) {
                  // Mark for pre-dispatch blocking on subsequent edits
                  fileMutationBlocked.add(absPath);
                  content +=
                    `\n\n⚠️ BLOCKED: You have edited ${basename} ${count} times. Further edits to this file are now blocked. ` +
                    `Restore it with: exec { "command": "git checkout -- ${args.path}" }, then make ONE complete edit.`;
                } else if (
                  count >= FILE_MUTATION_WARN_THRESHOLD &&
                  !fileMutationWarned.has(absPath)
                ) {
                  fileMutationWarned.add(absPath);
                  content +=
                    `\n\n⚠️ WARNING: You have edited ${basename} ${count} times. ` +
                    'If the file is broken, STOP making incremental fixes. ' +
                    `Restore it with: exec { "command": "git checkout -- ${args.path}" }, ` +
                    'read the original file carefully, then make ONE complete edit. Do NOT continue patching.';
                }
              }
            }

            // ── Detect file restores via exec (git checkout/restore) ──
            // If the model restores a file via git, reset that file's mutation counter
            // so it gets a fresh chance after recovery.
            if (name === 'exec' && toolSuccess && typeof args.command === 'string') {
              const cmd = args.command;
              const restoreMatch = cmd.match(/git\s+(?:checkout|restore)\s+(?:--\s+)?(\S+)/);
              if (restoreMatch) {
                const restoredFile = restoreMatch[1];
                const absRestored = restoredFile.startsWith('/')
                  ? restoredFile
                  : path.resolve(projectDir, restoredFile);
                if (fileMutationCounts.has(absRestored)) {
                  fileMutationCounts.set(absRestored, 0);
                  fileMutationWarned.delete(absRestored);
                  fileMutationBlocked.delete(absRestored);
                }
              }
            }

            // ── Credential leak scrubbing ─────────────────────────────
            // Scan tool output for credential leaks before passing back
            // to the model (and potentially to a chat channel).
            content = leakDetector.redactIfNeeded(content);

            // Context-aware truncation: cap oversized tool results before returning
            // to prevent blowing out the context window on subsequent LLM calls.
            const truncated = truncateToolResultContent(content, contextWindow);
            if (truncated.truncated && cfg.verbose) {
              console.warn(
                `[context-budget] truncated ${name} result: ${content.length} → ${truncated.content.length} chars`
              );
            }

            return { id: callId, content: truncated.content };
          };

          const results: Array<{ id: string; content: string }> = [];
          const turnTransaction = new EditTransaction();
          let invalidArgsThisTurn = false;

          // Helper: catch tool errors but re-throw AgentLoopBreak (those must break the outer loop)
          const catchToolError = async (e: any, tc: ToolCall) => {
            if (e instanceof AgentLoopBreak) throw e;

            const te =
              e instanceof ToolError || e instanceof ValidationError
                ? e
                : ToolError.fromError(e, 'internal');
            if (te.code === 'invalid_args' || te.code === 'validation') {
              invalidArgsThisTurn = true;
            }
            const msg = te.message ?? String(e ?? 'unknown error');
            const toolErrorContent =
              te instanceof ValidationError ? te.toToolResult() : te.toToolResult();

            // Fast-fail repeated blocked command loops with accurate reason labeling.
            // Applies to direct exec attempts and spawn_task delegation attempts.
            if (tc.function.name === 'exec' || tc.function.name === 'spawn_task') {
              const blockedMatch =
                msg.match(
                  /^exec:\s*blocked\s*\(([^)]+)\)\s*without --no-confirm\/--yolo:\s*(.*)$/i
                ) ||
                msg.match(/^(spawn_task):\s*blocked\s*—\s*(.*)$/i) ||
                msg.match(/^exec:\s*blocked\s+(background command\b[^.]*)\./i);
              if (blockedMatch) {
                const reason = (blockedMatch[1] || blockedMatch[2] || 'blocked command').trim();
                let parsedArgs: any = {};
                try {
                  parsedArgs = parseJsonArgs(tc.function.arguments ?? '{}');
                } catch {}
                const cmd =
                  tc.function.name === 'exec'
                    ? String(parsedArgs?.command ?? '')
                    : String(parsedArgs?.task ?? '');
                const normalizedReason = reason.toLowerCase();
                const aggregateByReason =
                  normalizedReason.includes('package install/remove') ||
                  normalizedReason.includes('background command');
                const sig = aggregateByReason
                  ? `${tc.function.name}|${reason}`
                  : `${tc.function.name}|${reason}|${cmd}`;
                const count = (blockedExecAttemptsBySig.get(sig) ?? 0) + 1;
                blockedExecAttemptsBySig.set(sig, count);
                if (count >= 2) {
                  throw new AgentLoopBreak(
                    `${tc.function.name}: repeated blocked command attempts (${reason}) in current approval mode. ` +
                      'Do not retry the same blocked command. Choose a safe alternative, skip cleanup, or ask the user to restart with --no-confirm/--yolo.'
                  );
                }
              }
            }

            const callId = resolveCallId(tc);
            await emitToolResult({
              id: callId,
              name: tc.function.name,
              success: false,
              summary: `${te.code}: ${msg}`.slice(0, 240),
              errorCode: te.code,
              retryable: te.retryable,
              result: toolErrorContent,
            });

            let parsedArgs: Record<string, unknown> = {};
            try {
              const parsed = parseJsonArgs(tc.function.arguments ?? '{}');
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                parsedArgs = parsed as Record<string, unknown>;
              }
            } catch {
              // keep empty object
            }
            toolLoopGuard.registerOutcome(tc.function.name, parsedArgs, {
              toolCallId: callId,
              error: msg,
            });

            // Inject fallback guidance after 2 consecutive read_file/read_files failures.
            let resultContent = toolErrorContent;
            if (tc.function.name === 'read_file' || tc.function.name === 'read_files') {
              const failureCount = toolLoopGuard.getReadFileFailureCount();
              if (failureCount >= 2) {
                resultContent +=
                  `\n\n[WARNING: ${tc.function.name} has failed ${failureCount} times consecutively. ` +
                  'Try using `sed` and the `edit_range` tool; if those do not work, create a temporary file with the full contents and save it. ' +
                  'Then remove the existing file and rename the temporary file to bypass edit_file failing.]';
                toolLoopGuard.resetReadFileFailureCount();
              }
            }

            return { id: callId, content: resultContent };
          };

          // ── Anti-scan guardrails (§ read budget, dir scan, same-search) ──
          const readOnlyInTurn = toolCallsArr.filter((tc) =>
            isReadOnlyToolDynamic(tc.function.name)
          );

          // Fix 5: Per-turn cap — drop excess read-only calls in a single response
          if (readOnlyInTurn.length > READ_ONLY_PER_TURN_CAP) {
            const kept = new Set(
              readOnlyInTurn.slice(0, READ_ONLY_PER_TURN_CAP).map((tc) => tc.id ?? tc.function.name)
            );
            const droppedCount = readOnlyInTurn.length - READ_ONLY_PER_TURN_CAP;
            toolCallsArr = toolCallsArr.filter(
              (tc) =>
                !isReadOnlyToolDynamic(tc.function.name) || kept.has(tc.id ?? tc.function.name)
            );
            for (const tc of readOnlyInTurn.slice(READ_ONLY_PER_TURN_CAP)) {
              const callId = resolveCallId(tc);
              results.push({
                id: callId,
                content: `STOP: Per-turn read limit (${READ_ONLY_PER_TURN_CAP}). Use search_files or exec with grep instead of reading files one by one.`,
              });
            }
            if (cfg.verbose) {
              console.warn(
                `[guardrail] capped ${droppedCount} read-only tool calls (per-turn limit ${READ_ONLY_PER_TURN_CAP})`
              );
            }
          }

          if (harness.toolCalls.parallelCalls) {
            // Models that support parallel calls: read-only in parallel, mutations sequential
            const readonly = toolCallsArr.filter((tc) => isReadOnlyToolDynamic(tc.function.name));
            const others = toolCallsArr.filter((tc) => !isReadOnlyToolDynamic(tc.function.name));

            const ro = await Promise.all(
              readonly.map((tc) => runOne(tc).catch((e: any) => catchToolError(e, tc)))
            );
            results.push(...ro);

            for (const tc of others) {
              if (ac.signal.aborted) break;
              try {
                results.push(await runOne(tc));
              } catch (e: any) {
                results.push(await catchToolError(e, tc));
                if (isMutationTool(tc.function.name)) {
                  // Fail-fast: after mutating tool failure, stop the remaining batch.
                  break;
                }
              }
            }
          } else {
            // Models with parallelCalls=false: run ALL calls sequentially (§4i).
            // These models lose track of results when calls are batched in parallel.
            for (const tc of toolCallsArr) {
              if (ac.signal.aborted) break;
              try {
                results.push(await runOne(tc));
              } catch (e: any) {
                results.push(await catchToolError(e, tc));
                if (isMutationTool(tc.function.name)) {
                  // Fail-fast: after mutating tool failure, stop the remaining batch.
                  break;
                }
              }
            }
          }

          if (replayByCallId.size > 0) {
            const canonicalById = new Map(results.map((r) => [r.id, r.content]));
            for (const [dupId, canonicalId] of replayByCallId.entries()) {
              const canonical = canonicalById.get(canonicalId);
              if (canonical == null) continue;
              results.push({
                id: dupId,
                content:
                  `[idlehands dedupe] Identical tool call replayed from ${canonicalId}. ` +
                  'Use that earlier tool result; no new execution was performed.',
              });
            }
          }

          // Store the turn transaction for potential post-turn rollback.
          if (turnTransaction.hasChanges) {
            turnTransaction.commit();
            lastTurnTransaction = turnTransaction;
          }

          // Bail immediately if cancelled during tool execution
          if (ac.signal.aborted) break;

          for (const r of results) {
            const compactToolMsg = await compactToolMessageForHistory(r.id, r.content);
            messages.push(compactToolMsg as any);
          }

          if (readOnlyExecTurnHints.length) {
            const previews = readOnlyExecTurnHints
              .slice(0, 2)
              .map((cmd) => (cmd.length > 140 ? `${cmd.slice(0, 140)}…` : cmd))
              .join(' | ');
            messages.push({
              role: 'user' as const,
              content:
                '[system] You repeated an identical read-only exec command with unchanged arguments. ' +
                `Idle Hands reused cached observation output instead of rerunning it (${previews}). ` +
                'Do not call the same read-only command again unless files/history changed; proceed with analysis or final answer.',
            });
          }

          // If tests are green and we've already made edits, nudge for final summary
          // once to avoid extra non-essential demo/cleanup turns.
          if (!finalizeAfterTestsNudgeUsed && lastSuccessfulTestRun && mutationVersion > 0) {
            finalizeAfterTestsNudgeUsed = true;
            messages.push({
              role: 'user' as const,
              content:
                '[system] Tests passed successfully. If the requested work is complete, provide the final summary now and stop. ' +
                'Only continue with additional commands if the user explicitly requested extra demos/cleanup.',
            });
          }

          // ── Per-file mutation spiral: post-turn system nudge ──
          // If any file was just blocked this turn, inject ONE system message.
          // fileMutationBlocked entries are only added when hitting BLOCK_THRESHOLD,
          // so this naturally fires once per file (subsequent edits are pre-dispatch blocked).
          for (const blockedPath of fileMutationBlocked) {
            const count = fileMutationCounts.get(blockedPath) ?? 0;
            // Only inject if the block was triggered THIS turn (count == BLOCK_THRESHOLD exactly)
            if (count === FILE_MUTATION_BLOCK_THRESHOLD) {
              const basename = path.basename(blockedPath);
              messages.push({
                role: 'user' as const,
                content:
                  `[system] CRITICAL: ${basename} has been edited ${count} times and is likely corrupted. ` +
                  'Further edits to this file are now BLOCKED. ' +
                  `Restore it with: exec { "command": "git checkout -- ${basename}" }, ` +
                  'then make ONE complete, well-planned edit. ' +
                  'If you cannot fix it in one edit, tell the user what went wrong and ask for guidance.',
              });
              break; // one message is enough
            }
          }

          // ── Escalating cumulative read budget (§ anti-scan guardrails) ──
          // Warn zone: append warnings to each read result when approaching the hard cap
          if (
            !readBudgetWarned &&
            cumulativeReadOnlyCalls > READ_BUDGET_WARN &&
            cumulativeReadOnlyCalls <= READ_BUDGET_HARD
          ) {
            readBudgetWarned = true;
            messages.push({
              role: 'user' as const,
              content: `[system] Read budget: ${cumulativeReadOnlyCalls}/${READ_BUDGET_HARD}. Use search_files instead of reading files individually.`,
            });
          }

          // One bounded automatic repair attempt for invalid tool args.
          if (invalidArgsThisTurn && toolRepairAttempts < MAX_TOOL_REPAIR_ATTEMPTS) {
            toolRepairAttempts++;
            messages.push({
              role: 'user' as const,
              content:
                '[system] Your previous tool call failed argument validation. Re-issue a corrected tool_calls array only. ' +
                'Do not narrate. Fix required/mistyped fields and unknown keys.',
            });
          }

          // Update session-level tool loop stats for observability
          lastToolLoopStats = toolLoopGuard.getStats();

          // Hook: onTurnEnd (Phase 8.5)
          await emitTurnEnd({
            turn: turns,
            toolCalls,
            promptTokens: cumulativeUsage.prompt,
            completionTokens: cumulativeUsage.completion,
            promptTokensTurn,
            completionTokensTurn,
            ttftMs,
            ttcMs,
            ppTps,
            tgTps,
          });

          continue;
        }

        if (
          mcpManager &&
          !mcpToolsLoaded &&
          (visible || content || '').toUpperCase().includes(MCP_TOOLS_REQUEST_TOKEN.toUpperCase())
        ) {
          mcpToolsLoaded = true;
          messages.push({ role: 'assistant', content: visible || content || '' });
          messages.push({
            role: 'user',
            content:
              '[system] MCP tools are now enabled for this task. Continue and call tools as needed.',
          });
          continue;
        }

        const assistantText = visible || content || '';

        // Recovery fuse: if the model keeps narrating/planning without tool use,
        // nudge it once with the original task. Never resend more than once per ask().
        // Skip this check entirely when no_tools is set — text IS the final answer.
        if (!cfg.no_tools && looksLikePlanningNarration(assistantText, finishReason)) {
          noToolTurns += 1;

          messages.push({ role: 'assistant', content: assistantText });

          if (noToolTurns >= NO_TOOL_REPROMPT_THRESHOLD) {
            if (!repromptUsed) {
              repromptUsed = true;
              noToolTurns = 0;
              const reminder = userContentToText(instruction).trim();
              const clippedReminder =
                reminder.length > 1600 ? `${reminder.slice(0, 1600)}\n[truncated]` : reminder;
              messages.push({
                role: 'user',
                content: `[system] Stuck narrating. Resume with tools.\nTask:\n${clippedReminder}`,
              });

              await emitTurnEnd({
                turn: turns,
                toolCalls,
                promptTokens: cumulativeUsage.prompt,
                completionTokens: cumulativeUsage.completion,
                promptTokensTurn,
                completionTokensTurn,
                ttftMs,
                ttcMs,
                ppTps,
                tgTps,
              });
              continue;
            }

            throw new Error(
              `no-tool loop detected: model produced planning/narration without tool calls for ${NO_TOOL_REPROMPT_THRESHOLD} turns even after one recovery reprompt`
            );
          }

          if (!noToolNudgeUsed) {
            noToolNudgeUsed = true;
            messages.push({
              role: 'user',
              content: '[system] Use tools now or give final answer.',
            });

            await emitTurnEnd({
              turn: turns,
              toolCalls,
              promptTokens: cumulativeUsage.prompt,
              completionTokens: cumulativeUsage.completion,
              promptTokensTurn,
              completionTokensTurn,
              ttftMs,
              ttcMs,
              ppTps,
              tgTps,
            });
            continue;
          }
          // Nudge already used — fall through to next iteration which will
          // increment noToolTurns and hit the reprompt threshold.
          await emitTurnEnd({
            turn: turns,
            toolCalls,
            promptTokens: cumulativeUsage.prompt,
            completionTokens: cumulativeUsage.completion,
            promptTokensTurn,
            completionTokensTurn,
            ttftMs,
            ttcMs,
            ppTps,
            tgTps,
          });
          continue;
        }

        noToolTurns = 0;

        const assistantOutput = ensureInformativeAssistantText(assistantText, { toolCalls, turns });

        // final assistant message
        messages.push({ role: 'assistant', content: assistantOutput });
        await persistReviewArtifact(assistantOutput).catch(() => {});
        await emitTurnEnd({
          turn: turns,
          toolCalls,
          promptTokens: cumulativeUsage.prompt,
          completionTokens: cumulativeUsage.completion,
          promptTokensTurn,
          completionTokensTurn,
          ttftMs,
          ttcMs,
          ppTps,
          tgTps,
          final: true,
        });
        return await finalizeAsk(assistantOutput);
      }

      const reason = `max iterations exceeded (${maxIters})`;
      const diag = lastSuccessfulTestRun
        ? ` Last successful test run: ${lastSuccessfulTestRun.command}`
        : '';
      throw new Error(reason + diag);
    } catch (e: unknown) {
      // Some code paths (or upstream libs) may incorrectly throw `undefined`.
      // Convert it to a real Error so benches can be stable and debuggable.
      if (e === undefined) {
        const lastMsg = messages[messages.length - 1];
        const lastMsgPreview = (() => {
          try {
            const c = (lastMsg as any)?.content;
            if (typeof c === 'string') return c.slice(0, 200);
            return JSON.stringify(c).slice(0, 200);
          } catch {
            return '';
          }
        })();
        const err = new Error(
          `BUG: threw undefined in agent.ask() (turn=${turns}). lastMsg=${lastMsg?.role ?? 'unknown'}:${lastMsgPreview}`
        );
        await persistFailure(err, `ask turn ${turns}`);
        if (hooksEnabled)
          await hookManager.emit('ask_error', {
            askId,
            error: err.message,
            turns,
            toolCalls,
          });
        throw err;
      }

      await persistFailure(e, `ask turn ${turns}`);
      const lastTestCmd = lastSuccessfulTestRun?.command;
      if (e instanceof AgentLoopBreak && lastTestCmd) {
        (e as Error).message += `\n[diagnostic] last successful test run: ${lastTestCmd}`;
      }
      // Never rethrow undefined; normalize to Error for debuggability.
      if (e === undefined) {
        const normalized = new Error('BUG: threw undefined (normalized at ask() boundary)');
        if (hooksEnabled)
          await hookManager.emit('ask_error', {
            askId,
            error: normalized.message,
            turns,
            toolCalls,
          });
        throw normalized;
      }

      await hookManager.emit('ask_error', {
        askId,
        error: e instanceof Error ? e.message : String(e),
        turns,
        toolCalls,
      });
      throw e;
    }
  };

  // expose via getters so setModel() / reset() don't break references
  return {
    get model() {
      return model;
    },
    get harness() {
      return harness.id;
    },
    get endpoint() {
      return cfg.endpoint;
    },
    get contextWindow() {
      return contextWindow;
    },
    get supportsVision() {
      return supportsVision;
    },
    get messages() {
      return messages;
    },
    get usage() {
      return { ...cumulativeUsage };
    },
    get currentContextTokens() {
      return currentContextTokens > 0 ? currentContextTokens : estimateTokensFromMessages(messages);
    },
    ask,
    rollbackLastTurnEdits: async () => {
      if (!lastTurnTransaction || !lastTurnTransaction.hasChanges) {
        return { ok: false, error: 'No file edits to roll back.' };
      }
      const tx = lastTurnTransaction;
      lastTurnTransaction = undefined;
      const callCtx = { cwd: projectDir, noConfirm: true, dryRun: false };
      const results = await tx.rollback(callCtx as any);
      return { ok: true, results };
    },
    rollback: () => {
      const cp = conversationBranch.rollback();
      if (!cp) return null;
      const removed = messages.length - cp.messageCount;
      messages.length = cp.messageCount;
      return { preview: cp.preview, removedMessages: removed };
    },
    listCheckpoints: () => conversationBranch.list(),
    setModel,
    setEndpoint,
    listModels,
    refreshServerHealth,
    getPerfSummary,
    getToolLoopStats: () => lastToolLoopStats,
    get lastAskInstructionText() {
      return lastAskInstructionText;
    },
    captureOn,
    captureOff,
    captureLast,
    captureSetRedact,
    captureGetRedact,
    captureOpen,
    get capturePath() {
      return capture.path;
    },
    getSystemPrompt: () =>
      messages[0]?.role === 'system' ? String(messages[0].content) : activeSystemPromptBase,
    setSystemPrompt,
    resetSystemPrompt,
    listMcpServers,
    listMcpTools,
    restartMcpServer,
    enableMcpTool,
    disableMcpTool,
    mcpWarnings,
    listLspServers,
    setVerbose,
    close,
    reset,
    cancel,
    restore,
    replay,
    vault,
    lens,
    hookManager,
    get lastEditedPath() {
      return lastEditedPath;
    },
    get lastTurnMetrics() {
      return lastTurnMetrics;
    },
    get lastTurnDebug() {
      return lastTurnDebug;
    },
    get lastServerHealth() {
      return lastServerHealth;
    },
    get planSteps() {
      return planSteps;
    },
    get compactionStats() {
      return { ...compactionStats };
    },
    executePlanStep,
    clearPlan,
    compactHistory,
  };
}

export async function runAgent(opts: {
  config: IdlehandsConfig;
  instruction: string;
  apiKey?: string;
  onToken?: (t: string) => void;
  confirm?: (prompt: string) => Promise<boolean>;
  confirmProvider?: ConfirmationProvider;
  runtime?: AgentRuntime;
}): Promise<AgentResult> {
  const session = await createSession({
    config: opts.config,
    apiKey: opts.apiKey,
    confirm: opts.confirm,
    confirmProvider: opts.confirmProvider,
    runtime: opts.runtime,
  });
  return session.ask(opts.instruction, opts.onToken);
}
