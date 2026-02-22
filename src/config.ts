import fs from 'node:fs/promises';
import path from 'node:path';

import type { IdlehandsConfig } from './types.js';
import { configDir } from './utils.js';

const DEFAULTS: IdlehandsConfig = {
  endpoint: 'http://localhost:8080/v1',
  model: '',
  dir: process.cwd(),
  max_tokens: 16384,
  temperature: 0.2,
  top_p: 0.95,
  timeout: 600,
  max_iterations: 100,
  tool_loop_detection: {
    enabled: true,
    history_size: 30,
    warning_threshold: 4,
    critical_threshold: 8,
    global_circuit_breaker_threshold: 12,
    read_cache_ttl_ms: 15000,
    detectors: {
      generic_repeat: true,
      known_poll_no_progress: true,
      ping_pong: true,
    },
    per_tool: {},
  },
  response_timeout: 600,
  connection_timeout: 600,
  initial_connection_check: true,
  initial_connection_timeout: 10,
  approval_mode: 'auto-edit',
  no_confirm: false,
  verbose: false,
  quiet: false,
  dry_run: false,
  output_format: 'text',
  fail_on_error: true,
  diff_only: false,
  mode: 'code',
  sys_eager: false,
  context_window: 131072,
  cache_prompt: true,
  i_know_what_im_doing: false,
  theme: 'default',
  vim_mode: false,
  harness: '',
  context_file: '',
  context_file_names: ['.idlehands.md', 'AGENTS.md', '.github/AGENTS.md'],
  context_max_tokens: 8192,
  compact_at: 0.8,
  show_change_summary: true,
  step_mode: false,
  editor: '',
  system_prompt_override: '',
  show_server_metrics: true,
  auto_detect_model_change: true,
  slow_tg_tps_threshold: 10,
  watchdog_timeout_ms: 120000,
  watchdog_max_compactions: 3,
  watchdog_idle_grace_timeouts: 1,
  debug_abort_reason: false,
  hooks: {
    enabled: true,
    strict: false,
    plugin_paths: [],
    warn_ms: 250,
    allow_capabilities: ['observe'],
  },
  trifecta: {
    enabled: true,
    vault: { enabled: true },
    lens: { enabled: true },
    replay: { enabled: true },
  },
  auto_update_check: true,
  offline: false,
  lsp: {
    enabled: false,
    servers: [],
    auto_detect: true,
    proactive_diagnostics: true,
    diagnostic_severity_threshold: 1,
  },
  sub_agents: {
    enabled: true,
    max_iterations: 50,
    max_tokens: 16384,
    timeout_sec: 600,
    result_token_cap: 4000,
    system_prompt: 'You are a focused coding sub-agent. Execute only the delegated task.',
    inherit_context_file: true,
    inherit_vault: true,
  },
  mcp_tool_budget: 1000,
  mcp_call_timeout_sec: 30,
  mcp: {
    servers: [],
  },
  anton: {
    max_retries: 3,
    max_iterations: 200,
    task_timeout_sec: 600,
    total_timeout_sec: 7200,
    max_total_tokens: undefined, // unlimited
    verify_ai: true,
    decompose: true,
    max_decompose_depth: 2,
    max_total_tasks: 500,
    skip_on_fail: true,
    approval_mode: 'yolo',
    verbose: false,
    auto_commit: true,
  },
};

export function defaultConfigPath() {
  return path.join(configDir(), 'config.json');
}

function parseBool(v: string | undefined): boolean | undefined {
  if (v == null) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(v.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(v.toLowerCase())) return false;
  return undefined;
}

function parseBoolLike(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return parseBool(v);
  return undefined;
}

function parseNum(v: string | undefined): number | undefined {
  if (v == null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseCsv(v: string | undefined): string[] | undefined {
  if (v == null) return undefined;
  const values = v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

function parseTrifectaMode(v: string | undefined): 'active' | 'passive' | 'off' | undefined {
  if (v == null) return undefined;
  const lower = v.toLowerCase();
  if (lower === 'active' || lower === 'passive' || lower === 'off') return lower;
  return undefined;
}

function parseReviewArtifactStalePolicy(v: string | undefined): 'warn' | 'block' | undefined {
  if (v == null) return undefined;
  const lower = v.toLowerCase();
  if (lower === 'warn' || lower === 'block') return lower;
  return undefined;
}

function mergeTrifecta(base: Partial<any> = {}, override: Partial<any> = {}) {
  const out: any = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v === undefined) continue;
    const existing = out[k] as any;
    if (
      existing !== null &&
      v !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      out[k] = mergeTrifecta(existing, v as any);
      continue;
    }
    out[k] = v;
  }
  return out;
}
export async function loadConfig(opts: {
  configPath?: string;
  cli?: Partial<IdlehandsConfig>;
  /**
   * When true, prefer process.cwd() as the working dir unless CLI/env explicitly set one.
   * Used by --fresh to avoid inheriting a stale dir from config.json.
   */
  preferCwdDir?: boolean;
}): Promise<{ config: IdlehandsConfig; configPath: string }> {
  const configPath = opts.configPath ?? defaultConfigPath();

  let fileCfg: Partial<IdlehandsConfig> = {};
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    if (raw.trim().length) {
      fileCfg = JSON.parse(raw);
    } else {
      fileCfg = {};
    }
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }

  const envCfgRaw: Partial<IdlehandsConfig> = {
    endpoint: process.env.IDLEHANDS_ENDPOINT,
    model: process.env.IDLEHANDS_MODEL,
    dir: process.env.IDLEHANDS_DIR,
    max_tokens: parseNum(process.env.IDLEHANDS_MAX_TOKENS),
    temperature: parseNum(process.env.IDLEHANDS_TEMPERATURE),
    top_p: parseNum(process.env.IDLEHANDS_TOP_P),
    timeout: parseNum(process.env.IDLEHANDS_TIMEOUT),
    max_iterations: parseNum(process.env.IDLEHANDS_MAX_ITERATIONS),
    tool_loop_detection: {
      enabled: parseBool(process.env.IDLEHANDS_TOOL_LOOP_DETECTION_ENABLED),
      history_size: parseNum(process.env.IDLEHANDS_TOOL_LOOP_HISTORY_SIZE),
      warning_threshold: parseNum(process.env.IDLEHANDS_TOOL_LOOP_WARNING_THRESHOLD),
      critical_threshold: parseNum(process.env.IDLEHANDS_TOOL_LOOP_CRITICAL_THRESHOLD),
      global_circuit_breaker_threshold: parseNum(process.env.IDLEHANDS_TOOL_LOOP_CIRCUIT_BREAKER_THRESHOLD),
      read_cache_ttl_ms: parseNum(process.env.IDLEHANDS_TOOL_LOOP_READ_CACHE_TTL_MS),
      detectors: {
        generic_repeat: parseBool(process.env.IDLEHANDS_TOOL_LOOP_DETECTOR_GENERIC_REPEAT),
        known_poll_no_progress: parseBool(process.env.IDLEHANDS_TOOL_LOOP_DETECTOR_KNOWN_POLL),
        ping_pong: parseBool(process.env.IDLEHANDS_TOOL_LOOP_DETECTOR_PING_PONG),
      },
    },
    response_timeout: parseNum(process.env.IDLEHANDS_RESPONSE_TIMEOUT),
    connection_timeout: parseNum(process.env.IDLEHANDS_CONNECTION_TIMEOUT),
    initial_connection_check: parseBool(process.env.IDLEHANDS_INITIAL_CONNECTION_CHECK),
    initial_connection_timeout: parseNum(process.env.IDLEHANDS_INITIAL_CONNECTION_TIMEOUT),
    approval_mode: process.env.IDLEHANDS_APPROVAL_MODE as any,
    no_confirm: parseBool(process.env.IDLEHANDS_NO_CONFIRM),
    verbose: parseBool(process.env.IDLEHANDS_VERBOSE),
    quiet: parseBool(process.env.IDLEHANDS_QUIET),
    dry_run: parseBool(process.env.IDLEHANDS_DRY_RUN),
    output_format: process.env.IDLEHANDS_OUTPUT_FORMAT as any,
    fail_on_error: parseBool(process.env.IDLEHANDS_FAIL_ON_ERROR),
    diff_only: parseBool(process.env.IDLEHANDS_DIFF_ONLY),
    mode: ((): 'code' | 'sys' | undefined => {
      const m = process.env.IDLEHANDS_MODE?.toLowerCase();
      if (!m) return undefined;
      return m === 'code' || m === 'sys' ? m : undefined;
    })(),
    sys_eager: parseBool(process.env.IDLEHANDS_SYS_EAGER),
    context_window: parseNum(process.env.IDLEHANDS_CONTEXT_WINDOW),
    cache_prompt: parseBool(process.env.IDLEHANDS_CACHE_PROMPT),
    i_know_what_im_doing: parseBool(process.env.IDLEHANDS_I_KNOW_WHAT_IM_DOING),
    theme: process.env.IDLEHANDS_THEME,
    vim_mode: parseBool(process.env.IDLEHANDS_VIM_MODE),
    harness: process.env.IDLEHANDS_HARNESS,
    context_file: process.env.IDLEHANDS_CONTEXT_FILE,
    no_context: parseBool(process.env.IDLEHANDS_NO_CONTEXT),
    // context_file_names via env not supported (keep config file)
    context_max_tokens: parseNum(process.env.IDLEHANDS_CONTEXT_MAX_TOKENS),
    compact_at: parseNum(process.env.IDLEHANDS_COMPACT_AT),
    show_change_summary: parseBool(process.env.IDLEHANDS_SHOW_CHANGE_SUMMARY),
    step_mode: parseBool(process.env.IDLEHANDS_STEP_MODE),
    editor: process.env.IDLEHANDS_EDITOR,
    system_prompt_override: process.env.IDLEHANDS_SYSTEM_PROMPT_OVERRIDE,
    show_server_metrics: parseBool(process.env.IDLEHANDS_SHOW_SERVER_METRICS),
    auto_detect_model_change: parseBool(process.env.IDLEHANDS_AUTO_DETECT_MODEL_CHANGE),
    slow_tg_tps_threshold: parseNum(process.env.IDLEHANDS_SLOW_TG_TPS_THRESHOLD),
    watchdog_timeout_ms: parseNum(process.env.IDLEHANDS_WATCHDOG_TIMEOUT_MS),
    watchdog_max_compactions: parseNum(process.env.IDLEHANDS_WATCHDOG_MAX_COMPACTIONS),
    watchdog_idle_grace_timeouts: parseNum(process.env.IDLEHANDS_WATCHDOG_IDLE_GRACE_TIMEOUTS),
    debug_abort_reason: parseBool(
      process.env.IDLEHANDS_DEBUG_ABORT_REASON ?? process.env.IDLEHANDS_DEBUG_CANCEL_REASON
    ),
    hooks: {
      enabled: parseBool(process.env.IDLEHANDS_HOOKS_ENABLED),
      strict: parseBool(process.env.IDLEHANDS_HOOKS_STRICT),
      plugin_paths: parseCsv(process.env.IDLEHANDS_HOOK_PLUGIN_PATHS),
      warn_ms: parseNum(process.env.IDLEHANDS_HOOK_WARN_MS),
      allow_capabilities: parseCsv(process.env.IDLEHANDS_HOOK_ALLOW_CAPABILITIES) as any,
    },
    auto_update_check: parseBool(process.env.IDLEHANDS_AUTO_UPDATE_CHECK),
    offline: parseBool(process.env.IDLEHANDS_OFFLINE),
    lsp: {
      enabled: parseBool(process.env.IDLEHANDS_LSP_ENABLED),
      auto_detect: parseBool(process.env.IDLEHANDS_LSP_AUTO_DETECT),
      proactive_diagnostics: parseBool(process.env.IDLEHANDS_LSP_PROACTIVE_DIAGNOSTICS),
      diagnostic_severity_threshold: parseNum(process.env.IDLEHANDS_LSP_SEVERITY_THRESHOLD),
    },
    sub_agents: {
      enabled: (() => {
        const raw = process.env.IDLEHANDS_NO_SUB_AGENTS;
        if (raw == null) return undefined;
        const disabled = parseBool(raw);
        if (disabled === undefined) return undefined;
        return !disabled;
      })(),
    },
    mcp_tool_budget: parseNum(process.env.IDLEHANDS_MCP_TOOL_BUDGET),
    mcp_call_timeout_sec: parseNum(process.env.IDLEHANDS_MCP_CALL_TIMEOUT_SEC),
    anton: {
      max_retries: parseNum(process.env.IDLEHANDS_ANTON_MAX_RETRIES),
      max_iterations: parseNum(process.env.IDLEHANDS_ANTON_MAX_ITERATIONS),
      task_timeout_sec: parseNum(process.env.IDLEHANDS_ANTON_TASK_TIMEOUT_SEC),
      total_timeout_sec: parseNum(process.env.IDLEHANDS_ANTON_TOTAL_TIMEOUT_SEC),
      max_total_tokens: parseNum(process.env.IDLEHANDS_ANTON_MAX_TOTAL_TOKENS),
      verify_ai: parseBool(process.env.IDLEHANDS_ANTON_VERIFY_AI),
      verify_model: process.env.IDLEHANDS_ANTON_VERIFY_MODEL,
      verbose: parseBool(process.env.IDLEHANDS_ANTON_VERBOSE),
    },
    trifecta: {
      enabled: (() => {
        const raw = process.env.IDLEHANDS_NO_TRIFECTA;
        if (raw == null) return undefined;
        const disabled = parseBool(raw);
        if (disabled === undefined) return undefined;
        return !disabled;
      })(),
      vault: {
        enabled: (() => {
          const raw = process.env.IDLEHANDS_NO_VAULT;
          if (raw == null) return undefined;
          const disabled = parseBool(raw);
          if (disabled === undefined) return undefined;
          return !disabled;
        })(),
        mode: parseTrifectaMode(process.env.IDLEHANDS_VAULT_MODE),
        stale_policy: parseReviewArtifactStalePolicy(
          process.env.IDLEHANDS_REVIEW_ARTIFACT_STALE_POLICY ??
            process.env.IDLEHANDS_VAULT_STALE_POLICY
        ),
        immutable_review_artifacts_per_project: parseNum(
          process.env.IDLEHANDS_REVIEW_ARTIFACT_IMMUTABLE_CAP ??
            process.env.IDLEHANDS_VAULT_IMMUTABLE_REVIEW_CAP
        ),
      },
      lens: {
        enabled: (() => {
          const raw = process.env.IDLEHANDS_NO_LENS;
          if (raw == null) return undefined;
          const disabled = parseBool(raw);
          if (disabled === undefined) return undefined;
          return !disabled;
        })(),
      },
      replay: {
        enabled: (() => {
          const raw = process.env.IDLEHANDS_NO_REPLAY;
          if (raw == null) return undefined;
          const disabled = parseBool(raw);
          if (disabled === undefined) return undefined;
          return !disabled;
        })(),
      },
    },
  };

  const stripUndef = <T extends Record<string, any>>(obj: T): Partial<T> => {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) out[k] = v;
    }
    return out;
  };

  const envCfg = stripUndef(envCfgRaw);
  const cliCfg = stripUndef(opts.cli ?? {});

  const merged: any = { ...DEFAULTS, ...fileCfg, ...envCfg, ...cliCfg };

  // --fresh should start from current cwd unless user explicitly set dir via CLI/env.
  // This avoids inheriting stale config.json dir values from prior sessions.
  if (opts.preferCwdDir && cliCfg.dir === undefined && envCfg.dir === undefined) {
    merged.dir = process.cwd();
  }
  const fileTrifecta = (fileCfg as any).trifecta;
  const envTrifecta = (envCfg as any).trifecta;
  const cliTrifecta = (cliCfg as any).trifecta;

  merged.trifecta = mergeTrifecta(
    mergeTrifecta(mergeTrifecta(DEFAULTS.trifecta as any, fileTrifecta ?? {}), envTrifecta ?? {}),
    cliTrifecta ?? {}
  );

  // Anton: shallow merge like trifecta (defaults < file < env < cli)
  const fileAnton = (fileCfg as any).anton;
  const envAnton = (envCfg as any).anton;
  const cliAnton = (cliCfg as any).anton;
  merged.anton = {
    ...(DEFAULTS.anton ?? {}),
    ...stripUndef(fileAnton ?? {}),
    ...stripUndef(envAnton ?? {}),
    ...stripUndef(cliAnton ?? {}),
  };

  // Sub-agents: shallow merge (defaults < file < env < cli)
  const fileSubAgents = (fileCfg as any).sub_agents;
  const envSubAgents = (envCfg as any).sub_agents;
  const cliSubAgents = (cliCfg as any).sub_agents;
  merged.sub_agents = {
    ...(DEFAULTS.sub_agents ?? {}),
    ...stripUndef(fileSubAgents ?? {}),
    ...stripUndef(envSubAgents ?? {}),
    ...stripUndef(cliSubAgents ?? {}),
  };

  // Hooks: shallow merge (defaults < file < env < cli)
  const fileHooks = (fileCfg as any).hooks;
  const envHooks = (envCfg as any).hooks;
  const cliHooks = (cliCfg as any).hooks;
  merged.hooks = {
    ...(DEFAULTS.hooks ?? {}),
    ...stripUndef(fileHooks ?? {}),
    ...stripUndef(envHooks ?? {}),
    ...stripUndef(cliHooks ?? {}),
  };

  // Tool-loop detection: shallow merge + nested detectors (defaults < file < env < cli)
  const fileToolLoop = (fileCfg as any).tool_loop_detection;
  const envToolLoop = (envCfg as any).tool_loop_detection;
  const cliToolLoop = (cliCfg as any).tool_loop_detection;
  const defaultPerTool = ((DEFAULTS.tool_loop_detection as any)?.per_tool ?? {}) as Record<string, any>;
  const mergedPerTool: Record<string, any> = { ...defaultPerTool };
  for (const src of [fileToolLoop, envToolLoop, cliToolLoop]) {
    const p = (src ?? {}).per_tool;
    if (!p || typeof p !== 'object') continue;
    for (const [tool, policy] of Object.entries(p as Record<string, any>)) {
      mergedPerTool[tool] = {
        ...(mergedPerTool[tool] ?? {}),
        ...stripUndef(policy ?? {}),
        detectors: {
          ...((mergedPerTool[tool] ?? {}).detectors ?? {}),
          ...(stripUndef((policy ?? {}).detectors ?? {}) as any),
        },
      };
    }
  }

  merged.tool_loop_detection = {
    ...(DEFAULTS.tool_loop_detection ?? {}),
    ...stripUndef(fileToolLoop ?? {}),
    ...stripUndef(envToolLoop ?? {}),
    ...stripUndef(cliToolLoop ?? {}),
    detectors: {
      ...((DEFAULTS.tool_loop_detection as any)?.detectors ?? {}),
      ...(stripUndef((fileToolLoop ?? {}).detectors ?? {}) as any),
      ...(stripUndef((envToolLoop ?? {}).detectors ?? {}) as any),
      ...(stripUndef((cliToolLoop ?? {}).detectors ?? {}) as any),
    },
    per_tool: mergedPerTool,
  };

  // merge order: defaults < file < env < cli

  // Normalize
  merged.endpoint = String(merged.endpoint || DEFAULTS.endpoint).replace(/\/+$/, '');
  // Resolve dir: prefer config/env/cli value, fall back to cwd.
  // If the resolved dir doesn't exist, fall back to cwd (stale config entries).
  const resolvedDir = path.resolve(String(merged.dir || process.cwd()));
  try {
    const st = await fs.stat(resolvedDir);
    merged.dir = st.isDirectory() ? resolvedDir : process.cwd();
  } catch {
    // Dir doesn't exist (stale config) — use cwd
    if (resolvedDir !== process.cwd()) {
      console.warn(
        `[warn] configured dir "${resolvedDir}" does not exist, using cwd "${process.cwd()}"`
      );
    }
    merged.dir = process.cwd();
  }
  merged.model = String(merged.model ?? '');
  merged.harness = String(merged.harness ?? '');
  merged.context_file = String(merged.context_file ?? '');
  merged.editor = String(merged.editor ?? '');
  merged.system_prompt_override = String(merged.system_prompt_override ?? '');
  // LSP normalization
  merged.lsp = merged.lsp && typeof merged.lsp === 'object' ? merged.lsp : {};
  merged.lsp.servers = Array.isArray(merged.lsp.servers)
    ? merged.lsp.servers
        .filter(
          (s: any) =>
            s &&
            typeof s === 'object' &&
            typeof s.language === 'string' &&
            typeof s.command === 'string'
        )
        .map((s: any) => ({
          language: String(s.language).trim().toLowerCase(),
          command: String(s.command).trim(),
          args: Array.isArray(s.args) ? s.args.map((a: any) => String(a)) : undefined,
          env: s.env && typeof s.env === 'object' ? s.env : undefined,
          enabled: s.enabled !== false,
        }))
        .filter((s: any) => s.language.length > 0 && s.command.length > 0)
    : [];
  if (typeof merged.lsp.diagnostic_severity_threshold === 'number') {
    merged.lsp.diagnostic_severity_threshold = Math.max(
      1,
      Math.min(4, Math.floor(merged.lsp.diagnostic_severity_threshold))
    );
  }

  merged.hooks = merged.hooks && typeof merged.hooks === 'object' ? merged.hooks : {};
  const hooksEnabled = parseBoolLike(merged.hooks.enabled);
  if (hooksEnabled !== undefined) merged.hooks.enabled = hooksEnabled;
  const hooksStrict = parseBoolLike(merged.hooks.strict);
  if (hooksStrict !== undefined) merged.hooks.strict = hooksStrict;
  merged.hooks.plugin_paths = Array.isArray(merged.hooks.plugin_paths)
    ? merged.hooks.plugin_paths.map((x: any) => String(x).trim()).filter(Boolean)
    : [];
  if (typeof merged.hooks.warn_ms === 'number') {
    merged.hooks.warn_ms = Math.max(0, Math.floor(merged.hooks.warn_ms));
  }
  const allowedHookCapabilities = new Set([
    'observe',
    'read_prompts',
    'read_responses',
    'read_tool_args',
    'read_tool_results',
  ]);
  merged.hooks.allow_capabilities = Array.isArray(merged.hooks.allow_capabilities)
    ? merged.hooks.allow_capabilities
        .map((x: any) => String(x).trim())
        .filter((x: string) => allowedHookCapabilities.has(x))
    : ['observe'];
  if (merged.hooks.allow_capabilities.length === 0) {
    merged.hooks.allow_capabilities = ['observe'];
  }

  merged.tool_loop_detection = merged.tool_loop_detection && typeof merged.tool_loop_detection === 'object'
    ? merged.tool_loop_detection
    : { ...(DEFAULTS.tool_loop_detection ?? {}) };
  const toolLoopEnabled = parseBoolLike(merged.tool_loop_detection.enabled);
  if (toolLoopEnabled !== undefined) merged.tool_loop_detection.enabled = toolLoopEnabled;

  if (typeof merged.tool_loop_detection.history_size === 'number') {
    merged.tool_loop_detection.history_size = Math.max(10, Math.floor(merged.tool_loop_detection.history_size));
  }
  if (typeof merged.tool_loop_detection.warning_threshold === 'number') {
    merged.tool_loop_detection.warning_threshold = Math.max(2, Math.floor(merged.tool_loop_detection.warning_threshold));
  }
  if (typeof merged.tool_loop_detection.critical_threshold === 'number') {
    merged.tool_loop_detection.critical_threshold = Math.max(3, Math.floor(merged.tool_loop_detection.critical_threshold));
  }
  if (typeof merged.tool_loop_detection.global_circuit_breaker_threshold === 'number') {
    merged.tool_loop_detection.global_circuit_breaker_threshold = Math.max(4, Math.floor(merged.tool_loop_detection.global_circuit_breaker_threshold));
  }
  if (typeof merged.tool_loop_detection.read_cache_ttl_ms === 'number') {
    merged.tool_loop_detection.read_cache_ttl_ms = Math.max(0, Math.floor(merged.tool_loop_detection.read_cache_ttl_ms));
  }
  // Ensure threshold ordering: warning < critical < circuit_breaker
  if (typeof merged.tool_loop_detection.warning_threshold === 'number' &&
      typeof merged.tool_loop_detection.critical_threshold === 'number' &&
      merged.tool_loop_detection.warning_threshold >= merged.tool_loop_detection.critical_threshold) {
    merged.tool_loop_detection.critical_threshold = merged.tool_loop_detection.warning_threshold + 2;
  }
  if (typeof merged.tool_loop_detection.critical_threshold === 'number' &&
      typeof merged.tool_loop_detection.global_circuit_breaker_threshold === 'number' &&
      merged.tool_loop_detection.critical_threshold >= merged.tool_loop_detection.global_circuit_breaker_threshold) {
    merged.tool_loop_detection.global_circuit_breaker_threshold = merged.tool_loop_detection.critical_threshold + 2;
  }

  const d = merged.tool_loop_detection.detectors = merged.tool_loop_detection.detectors && typeof merged.tool_loop_detection.detectors === 'object'
    ? merged.tool_loop_detection.detectors
    : {};
  const genRepeat = parseBoolLike(d.generic_repeat);
  if (genRepeat !== undefined) d.generic_repeat = genRepeat;
  const knownPoll = parseBoolLike(d.known_poll_no_progress);
  if (knownPoll !== undefined) d.known_poll_no_progress = knownPoll;
  const pingPong = parseBoolLike(d.ping_pong);
  if (pingPong !== undefined) d.ping_pong = pingPong;

  const perToolRaw = merged.tool_loop_detection.per_tool;
  const perTool: Record<string, any> = {};
  if (perToolRaw && typeof perToolRaw === 'object') {
    for (const [tool, rawPolicy] of Object.entries(perToolRaw as Record<string, any>)) {
      const name = String(tool || '').trim();
      if (!name) continue;
      const policy = rawPolicy && typeof rawPolicy === 'object' ? { ...rawPolicy } : {};
      if (typeof policy.warning_threshold === 'number') {
        policy.warning_threshold = Math.max(2, Math.floor(policy.warning_threshold));
      }
      if (typeof policy.critical_threshold === 'number') {
        policy.critical_threshold = Math.max(3, Math.floor(policy.critical_threshold));
      }
      if (typeof policy.global_circuit_breaker_threshold === 'number') {
        policy.global_circuit_breaker_threshold = Math.max(4, Math.floor(policy.global_circuit_breaker_threshold));
      }
      if (typeof policy.warning_threshold === 'number' && typeof policy.critical_threshold === 'number' && policy.warning_threshold >= policy.critical_threshold) {
        policy.critical_threshold = policy.warning_threshold + 2;
      }
      if (typeof policy.critical_threshold === 'number' && typeof policy.global_circuit_breaker_threshold === 'number' && policy.critical_threshold >= policy.global_circuit_breaker_threshold) {
        policy.global_circuit_breaker_threshold = policy.critical_threshold + 2;
      }
      const pd = policy.detectors = policy.detectors && typeof policy.detectors === 'object' ? policy.detectors : {};
      const pdGen = parseBoolLike(pd.generic_repeat);
      if (pdGen !== undefined) pd.generic_repeat = pdGen;
      const pdPoll = parseBoolLike(pd.known_poll_no_progress);
      if (pdPoll !== undefined) pd.known_poll_no_progress = pdPoll;
      const pdPp = parseBoolLike(pd.ping_pong);
      if (pdPp !== undefined) pd.ping_pong = pdPp;
      perTool[name] = policy;
    }
  }
  merged.tool_loop_detection.per_tool = perTool;

  const subAgentsEnabled = parseBoolLike(merged.sub_agents.enabled);
  if (subAgentsEnabled !== undefined) merged.sub_agents.enabled = subAgentsEnabled;
  const inheritContext = parseBoolLike(merged.sub_agents.inherit_context_file);
  if (inheritContext !== undefined) merged.sub_agents.inherit_context_file = inheritContext;
  const inheritVault = parseBoolLike(merged.sub_agents.inherit_vault);
  if (inheritVault !== undefined) merged.sub_agents.inherit_vault = inheritVault;

  if (typeof merged.sub_agents.max_iterations === 'number') {
    merged.sub_agents.max_iterations = Math.max(1, Math.floor(merged.sub_agents.max_iterations));
  }
  if (typeof merged.sub_agents.max_tokens === 'number') {
    merged.sub_agents.max_tokens = Math.max(128, Math.floor(merged.sub_agents.max_tokens));
  }
  if (typeof merged.sub_agents.timeout_sec === 'number') {
    merged.sub_agents.timeout_sec = Math.max(1, Math.floor(merged.sub_agents.timeout_sec));
  }
  if (typeof merged.sub_agents.result_token_cap === 'number') {
    merged.sub_agents.result_token_cap = Math.max(
      128,
      Math.floor(merged.sub_agents.result_token_cap)
    );
  }
  if (
    typeof merged.sub_agents.system_prompt !== 'string' ||
    !merged.sub_agents.system_prompt.trim()
  ) {
    merged.sub_agents.system_prompt = DEFAULTS.sub_agents?.system_prompt;
  }
  if (typeof merged.sub_agents.model === 'string') {
    merged.sub_agents.model = merged.sub_agents.model.trim();
  }
  if (typeof merged.sub_agents.endpoint === 'string') {
    merged.sub_agents.endpoint = merged.sub_agents.endpoint.trim().replace(/\/+$/, '');
  }
  if (
    merged.sub_agents.approval_mode &&
    !['plan', 'reject', 'default', 'auto-edit', 'yolo'].includes(merged.sub_agents.approval_mode)
  ) {
    delete merged.sub_agents.approval_mode;
  }

  merged.mcp_tool_budget = Number.isFinite(merged.mcp_tool_budget)
    ? Math.max(0, Math.floor(merged.mcp_tool_budget))
    : DEFAULTS.mcp_tool_budget;
  merged.mcp_call_timeout_sec = Number.isFinite(merged.mcp_call_timeout_sec)
    ? Math.max(1, Math.floor(merged.mcp_call_timeout_sec))
    : DEFAULTS.mcp_call_timeout_sec;
  merged.mcp = merged.mcp && typeof merged.mcp === 'object' ? merged.mcp : { servers: [] };
  merged.mcp.servers = Array.isArray(merged.mcp.servers)
    ? merged.mcp.servers
        .filter(
          (s: any) =>
            s &&
            typeof s === 'object' &&
            typeof s.name === 'string' &&
            typeof s.transport === 'string'
        )
        .map((s: any) => ({
          ...s,
          name: String(s.name).trim(),
          transport: s.transport === 'http' ? 'http' : 'stdio',
          args: Array.isArray(s.args) ? s.args.map((a: any) => String(a)) : undefined,
          command: s.command == null ? undefined : String(s.command),
          url: s.url == null ? undefined : String(s.url),
        }))
        .filter((s: any) => s.name.length > 0)
    : [];

  if (merged.trifecta?.vault) {
    const parsedMode = parseTrifectaMode(merged.trifecta.vault.mode);
    if (parsedMode) merged.trifecta.vault.mode = parsedMode;
    else if (merged.trifecta.vault.mode) delete merged.trifecta.vault.mode;

    const parsedStale = parseReviewArtifactStalePolicy(merged.trifecta.vault.stale_policy);
    if (parsedStale) merged.trifecta.vault.stale_policy = parsedStale;
    else if (merged.trifecta.vault.stale_policy) delete merged.trifecta.vault.stale_policy;

    if (typeof merged.trifecta.vault.immutable_review_artifacts_per_project === 'number') {
      merged.trifecta.vault.immutable_review_artifacts_per_project = Math.max(
        1,
        Math.floor(merged.trifecta.vault.immutable_review_artifacts_per_project)
      );
    }
  }

  // Anton validation
  if (merged.anton) {
    const a = merged.anton;
    if (typeof a.max_retries === 'number') a.max_retries = Math.max(1, Math.floor(a.max_retries));
    if (typeof a.max_iterations === 'number')
      a.max_iterations = Math.max(1, Math.floor(a.max_iterations));
    if (typeof a.task_timeout_sec === 'number')
      a.task_timeout_sec = Math.max(10, Math.floor(a.task_timeout_sec));
    if (typeof a.total_timeout_sec === 'number')
      a.total_timeout_sec = Math.max(10, Math.floor(a.total_timeout_sec));
    if (typeof a.task_timeout_sec === 'number' && typeof a.total_timeout_sec === 'number') {
      a.total_timeout_sec = Math.max(a.total_timeout_sec, a.task_timeout_sec);
    }
    if (typeof a.max_decompose_depth === 'number')
      a.max_decompose_depth = Math.max(0, Math.min(5, Math.floor(a.max_decompose_depth)));
    if (typeof a.max_total_tasks === 'number')
      a.max_total_tasks = Math.max(1, Math.floor(a.max_total_tasks));
    const validApprovalModes = ['plan', 'reject', 'default', 'auto-edit', 'yolo'];
    if (a.approval_mode && !validApprovalModes.includes(a.approval_mode)) {
      if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
        console.error(`[config] invalid anton.approval_mode "${a.approval_mode}", using "yolo"`);
      }
      a.approval_mode = 'yolo';
    }
  }

  // Validate numeric ranges (clamp to sane bounds)
  if (typeof merged.max_tokens === 'number') {
    merged.max_tokens = Math.max(1, Math.floor(merged.max_tokens));
  }
  if (typeof merged.context_window === 'number') {
    merged.context_window = Math.max(1024, Math.floor(merged.context_window));
  }
  if (typeof merged.timeout === 'number') {
    merged.timeout = Math.max(1, Math.floor(merged.timeout));
  }
  if (typeof merged.max_iterations === 'number') {
    merged.max_iterations = Math.max(1, Math.floor(merged.max_iterations));
  }
  if (typeof merged.response_timeout === 'number') {
    merged.response_timeout = Math.max(1, Math.floor(merged.response_timeout));
  }
  if (typeof merged.connection_timeout === 'number') {
    merged.connection_timeout = Math.max(1, Math.floor(merged.connection_timeout));
  }
  const initialConnCheck = parseBoolLike(merged.initial_connection_check);
  if (initialConnCheck !== undefined) merged.initial_connection_check = initialConnCheck;
  if (typeof merged.initial_connection_timeout === 'number') {
    merged.initial_connection_timeout = Math.max(1, Math.floor(merged.initial_connection_timeout));
  }
  if (typeof merged.temperature === 'number') {
    merged.temperature = Math.max(0, Math.min(2, merged.temperature));
  }
  if (typeof merged.top_p === 'number') {
    merged.top_p = Math.max(0, Math.min(1, merged.top_p));
  }
  if (typeof merged.context_max_tokens === 'number') {
    merged.context_max_tokens = Math.max(64, Math.floor(merged.context_max_tokens));
  }
  if (typeof merged.compact_at === 'number') {
    merged.compact_at = Math.max(0.1, Math.min(0.99, merged.compact_at));
  }
  if (typeof merged.slow_tg_tps_threshold === 'number') {
    merged.slow_tg_tps_threshold = Math.max(1, merged.slow_tg_tps_threshold);
  }
  if (typeof merged.watchdog_timeout_ms === 'number') {
    merged.watchdog_timeout_ms = Math.max(30_000, Math.floor(merged.watchdog_timeout_ms));
  }
  if (typeof merged.watchdog_max_compactions === 'number') {
    merged.watchdog_max_compactions = Math.max(0, Math.floor(merged.watchdog_max_compactions));
  }
  if (typeof merged.watchdog_idle_grace_timeouts === 'number') {
    merged.watchdog_idle_grace_timeouts = Math.max(
      0,
      Math.floor(merged.watchdog_idle_grace_timeouts)
    );
  }

  // Normalize mode
  const validRunModes = ['code', 'sys'];
  if (!merged.mode || !validRunModes.includes(merged.mode)) {
    merged.mode = 'code';
  }

  // Normalize approval_mode
  const validModes = ['plan', 'reject', 'default', 'auto-edit', 'yolo'];
  if (merged.approval_mode && !validModes.includes(merged.approval_mode)) {
    if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
      console.error(`[config] invalid approval_mode "${merged.approval_mode}", using "auto-edit"`);
    }
    merged.approval_mode = 'auto-edit';
  }

  // Legacy: --no-confirm / --yolo maps to approval_mode 'yolo'
  if (merged.no_confirm && merged.approval_mode !== 'yolo') {
    merged.approval_mode = 'yolo';
  }

  // Normalize output_format
  const validOutputFormats = ['text', 'json', 'stream-json'];
  if (merged.output_format && !validOutputFormats.includes(merged.output_format)) {
    if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
      console.error(`[config] invalid output_format "${merged.output_format}", using "text"`);
    }
    merged.output_format = 'text';
  }

  // Phase 9: sys mode default approval is `default` unless user explicitly set approval mode.
  const explicitApproval =
    (fileCfg as any).approval_mode !== undefined ||
    (envCfg as any).approval_mode !== undefined ||
    (cliCfg as any).approval_mode !== undefined ||
    (fileCfg as any).no_confirm !== undefined ||
    (envCfg as any).no_confirm !== undefined ||
    (cliCfg as any).no_confirm !== undefined;
  if (merged.mode === 'sys' && !explicitApproval) {
    merged.approval_mode = 'default';
  }

  // Bot config: pass through from file (env overrides happen in bot/telegram.ts)
  if ((fileCfg as any).bot) {
    merged.bot = (fileCfg as any).bot;
  }

  return { config: merged as IdlehandsConfig, configPath };
}

/**
 * If a runtime is active (via `idlehands select`), override config.endpoint
 * with the endpoint derived at select time. CLI --endpoint always wins.
 * Returns true if the endpoint was overridden.
 */
export async function applyRuntimeEndpoint(
  config: IdlehandsConfig,
  cliEndpoint?: string
): Promise<boolean> {
  // CLI --endpoint is explicit intent — never override
  if (cliEndpoint) return false;

  try {
    const { loadActiveRuntime } = await import('./runtime/executor.js');
    const active = await loadActiveRuntime();
    if (active?.endpoint && active.healthy) {
      config.endpoint = active.endpoint;
      return true;
    }
  } catch {
    // Runtime system not available / no state — fall through to config endpoint
  }
  return false;
}

export async function ensureConfigDir(configPath: string) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
}
