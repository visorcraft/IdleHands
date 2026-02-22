import crypto from 'node:crypto';

export type ToolLoopPolicy = {
  warningThreshold?: number;
  criticalThreshold?: number;
  globalCircuitBreakerThreshold?: number;
  detectors?: {
    genericRepeat?: boolean;
    knownPollNoProgress?: boolean;
    pingPong?: boolean;
  };
};

export type ToolLoopConfig = {
  enabled?: boolean;
  historySize?: number;
  warningThreshold?: number;
  criticalThreshold?: number;
  globalCircuitBreakerThreshold?: number;
  readCacheTtlMs?: number;
  detectors?: {
    genericRepeat?: boolean;
    knownPollNoProgress?: boolean;
    pingPong?: boolean;
  };
  perTool?: Record<string, ToolLoopPolicy>;
};

export type ToolCallRecord = {
  toolName: string;
  argsHash: string;
  signature: string;
  toolCallId?: string;
  timestamp: number;
  resultHash?: string;
};

export type ToolLoopState = {
  history: ToolCallRecord[];
  bySignature: Map<string, number>;
  byOutcomeKey: Map<string, number>;
};

export type ToolLoopDetectionResult = {
  level: 'none' | 'warning' | 'critical';
  detector?: 'generic_repeat' | 'known_poll_no_progress' | 'ping_pong' | 'global_circuit_breaker';
  message?: string;
  signature: string;
  argsHash: string;
  count: number;
};

type DetectorFlags = {
  genericRepeat: boolean;
  knownPollNoProgress: boolean;
  pingPong: boolean;
};

type NormalizedToolLoopPolicy = {
  warningThreshold: number;
  criticalThreshold: number;
  globalCircuitBreakerThreshold: number;
  detectors: DetectorFlags;
};

type NormalizedToolLoopConfig = {
  enabled: boolean;
  historySize: number;
  warningThreshold: number;
  criticalThreshold: number;
  globalCircuitBreakerThreshold: number;
  readCacheTtlMs: number;
  detectors: DetectorFlags;
  perTool: Record<string, NormalizedToolLoopPolicy>;
};

const DEFAULT_DETECTORS: DetectorFlags = {
  genericRepeat: true,
  knownPollNoProgress: true,
  pingPong: true,
};

const DEFAULTS: NormalizedToolLoopConfig = {
  enabled: true,
  historySize: 30,
  warningThreshold: 4,
  criticalThreshold: 8,
  globalCircuitBreakerThreshold: 12,
  readCacheTtlMs: 15_000,
  detectors: { ...DEFAULT_DETECTORS },
  perTool: {},
};

const KNOWN_POLL_TOOLS = new Set(['command_status', 'process.poll', 'process.log']);

export function createToolLoopState(): ToolLoopState {
  return {
    history: [],
    bySignature: new Map(),
    byOutcomeKey: new Map(),
  };
}

function normalizePolicy(base: NormalizedToolLoopPolicy, incoming?: ToolLoopPolicy): NormalizedToolLoopPolicy {
  const out: NormalizedToolLoopPolicy = {
    warningThreshold: Number.isFinite(Number(incoming?.warningThreshold)) ? Math.max(2, Math.floor(Number(incoming?.warningThreshold))) : base.warningThreshold,
    criticalThreshold: Number.isFinite(Number(incoming?.criticalThreshold)) ? Math.max(3, Math.floor(Number(incoming?.criticalThreshold))) : base.criticalThreshold,
    globalCircuitBreakerThreshold: Number.isFinite(Number(incoming?.globalCircuitBreakerThreshold)) ? Math.max(4, Math.floor(Number(incoming?.globalCircuitBreakerThreshold))) : base.globalCircuitBreakerThreshold,
    detectors: {
      genericRepeat: incoming?.detectors?.genericRepeat ?? base.detectors.genericRepeat,
      knownPollNoProgress: incoming?.detectors?.knownPollNoProgress ?? base.detectors.knownPollNoProgress,
      pingPong: incoming?.detectors?.pingPong ?? base.detectors.pingPong,
    },
  };
  if (out.warningThreshold >= out.criticalThreshold) out.criticalThreshold = out.warningThreshold + 2;
  if (out.criticalThreshold >= out.globalCircuitBreakerThreshold) out.globalCircuitBreakerThreshold = out.criticalThreshold + 2;
  return out;
}

function normalizeConfig(config?: ToolLoopConfig): NormalizedToolLoopConfig {
  const basePolicy: NormalizedToolLoopPolicy = {
    warningThreshold: Number.isFinite(Number(config?.warningThreshold)) ? Math.max(2, Math.floor(Number(config?.warningThreshold))) : DEFAULTS.warningThreshold,
    criticalThreshold: Number.isFinite(Number(config?.criticalThreshold)) ? Math.max(3, Math.floor(Number(config?.criticalThreshold))) : DEFAULTS.criticalThreshold,
    globalCircuitBreakerThreshold: Number.isFinite(Number(config?.globalCircuitBreakerThreshold)) ? Math.max(4, Math.floor(Number(config?.globalCircuitBreakerThreshold))) : DEFAULTS.globalCircuitBreakerThreshold,
    detectors: {
      genericRepeat: config?.detectors?.genericRepeat ?? DEFAULT_DETECTORS.genericRepeat,
      knownPollNoProgress: config?.detectors?.knownPollNoProgress ?? DEFAULT_DETECTORS.knownPollNoProgress,
      pingPong: config?.detectors?.pingPong ?? DEFAULT_DETECTORS.pingPong,
    },
  };
  const normalizedBasePolicy = normalizePolicy(basePolicy);
  const perTool: Record<string, NormalizedToolLoopPolicy> = {};
  for (const [tool, policy] of Object.entries(config?.perTool ?? {})) {
    const key = String(tool || '').trim();
    if (!key) continue;
    perTool[key] = normalizePolicy(normalizedBasePolicy, policy);
  }

  return {
    enabled: config?.enabled ?? DEFAULTS.enabled,
    historySize: Number.isFinite(Number(config?.historySize)) ? Math.max(10, Math.floor(Number(config?.historySize))) : DEFAULTS.historySize,
    warningThreshold: normalizedBasePolicy.warningThreshold,
    criticalThreshold: normalizedBasePolicy.criticalThreshold,
    globalCircuitBreakerThreshold: normalizedBasePolicy.globalCircuitBreakerThreshold,
    readCacheTtlMs: Number.isFinite(Number(config?.readCacheTtlMs)) ? Math.max(0, Math.floor(Number(config?.readCacheTtlMs))) : DEFAULTS.readCacheTtlMs,
    detectors: normalizedBasePolicy.detectors,
    perTool,
  };
}

function resolvePolicyForTool(cfg: NormalizedToolLoopConfig, toolName: string): NormalizedToolLoopPolicy {
  return cfg.perTool[toolName] ?? {
    warningThreshold: cfg.warningThreshold,
    criticalThreshold: cfg.criticalThreshold,
    globalCircuitBreakerThreshold: cfg.globalCircuitBreakerThreshold,
    detectors: cfg.detectors,
  };
}

export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hashToolArgs(params: unknown): string {
  return sha256(stableStringify(params ?? {}));
}

export function hashToolCall(toolName: string, params: unknown): { argsHash: string; signature: string } {
  const argsHash = hashToolArgs(params);
  return {
    argsHash,
    signature: `${toolName}:${argsHash}`,
  };
}

function hashToolOutcome(result?: unknown, error?: unknown): string {
  if (error != null) {
    const msg = typeof error === 'string' ? error : (error as any)?.message ? String((error as any).message) : String(error);
    return `error:${sha256(msg.trim())}`;
  }

  const raw = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  // For large outputs, hash prefix + length to avoid expensive full hashing
  // This still detects "same outcome" reliably for loop detection purposes
  if (raw.length > 4096) {
    const prefix = raw.slice(0, 2048);
    const suffix = raw.slice(-1024);
    return `ok:${sha256(`${prefix}...${suffix}|len:${raw.length}`)}`;
  }
  return `ok:${sha256(raw ?? '')}`;
}

export function recordToolCall(
  state: ToolLoopState,
  toolName: string,
  params: unknown,
  toolCallId?: string,
  config?: ToolLoopConfig,
): ToolCallRecord {
  const cfg = normalizeConfig(config);
  const { argsHash, signature } = hashToolCall(toolName, params);
  const rec: ToolCallRecord = {
    toolName,
    argsHash,
    signature,
    toolCallId,
    timestamp: Date.now(),
  };

  state.history.push(rec);
  state.bySignature.set(signature, (state.bySignature.get(signature) ?? 0) + 1);

  while (state.history.length > cfg.historySize) {
    const dropped = state.history.shift();
    if (!dropped) break;
    const sigCount = (state.bySignature.get(dropped.signature) ?? 0) - 1;
    if (sigCount > 0) state.bySignature.set(dropped.signature, sigCount);
    else state.bySignature.delete(dropped.signature);

    if (dropped.resultHash) {
      const key = `${dropped.signature}|${dropped.resultHash}`;
      const outCount = (state.byOutcomeKey.get(key) ?? 0) - 1;
      if (outCount > 0) state.byOutcomeKey.set(key, outCount);
      else state.byOutcomeKey.delete(key);
    }
  }

  return rec;
}

export function recordToolCallOutcome(
  state: ToolLoopState,
  args: {
    toolName: string;
    toolParams: unknown;
    toolCallId?: string;
    result?: unknown;
    error?: unknown;
  },
  record?: ToolCallRecord,
): void {
  const outHash = hashToolOutcome(args.result, args.error);

  // If caller passed the record from recordToolCall, use it directly
  if (record && !record.resultHash) {
    record.resultHash = outHash;
  } else {
    // Fallback: search backwards for matching record without outcome
    const { signature } = hashToolCall(args.toolName, args.toolParams);
    for (let i = state.history.length - 1; i >= 0; i--) {
      const rec = state.history[i];
      if (rec.signature !== signature) continue;
      if (args.toolCallId && rec.toolCallId && rec.toolCallId !== args.toolCallId) continue;
      if (!rec.resultHash) {
        rec.resultHash = outHash;
        break;
      }
    }
  }

  const { signature } = hashToolCall(args.toolName, args.toolParams);
  const key = `${signature}|${outHash}`;
  state.byOutcomeKey.set(key, (state.byOutcomeKey.get(key) ?? 0) + 1);
}

function consecutiveSignatureStreak(history: ToolCallRecord[], signature: string): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const rec = history[i];
    if (rec.signature !== signature) break;
    count++;
  }
  return count;
}

function consecutiveOutcomeStreak(history: ToolCallRecord[], signature: string, outcomeHash: string): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const rec = history[i];
    if (rec.signature !== signature) break;
    if (rec.resultHash !== outcomeHash) break;
    count++;
  }
  return count;
}

export function detectToolCallLoop(
  state: ToolLoopState,
  toolName: string,
  params: unknown,
  config?: ToolLoopConfig,
): ToolLoopDetectionResult {
  const cfg = normalizeConfig(config);
  const policy = resolvePolicyForTool(cfg, toolName);
  const { signature, argsHash } = hashToolCall(toolName, params);

  if (!cfg.enabled) {
    return { level: 'none', signature, argsHash, count: 0 };
  }

  const genericCount = state.bySignature.get(signature) ?? 0;
  const signatureStreak = consecutiveSignatureStreak(state.history, signature);

  if (policy.detectors.genericRepeat && genericCount >= policy.globalCircuitBreakerThreshold) {
    return {
      level: 'critical',
      detector: 'global_circuit_breaker',
      message: `Global circuit breaker: identical tool signature repeated ${genericCount}x`,
      signature,
      argsHash,
      count: genericCount,
    };
  }

  const latestSameOutcome = [...state.history]
    .reverse()
    .find((h) => h.signature === signature && typeof h.resultHash === 'string' && h.resultHash.length > 0);

  const outcomeKey = latestSameOutcome?.resultHash ? `${signature}|${latestSameOutcome.resultHash}` : '';
  const outcomeCount = outcomeKey ? (state.byOutcomeKey.get(outcomeKey) ?? 0) : 0;
  const outcomeStreak = latestSameOutcome?.resultHash
    ? consecutiveOutcomeStreak(state.history, signature, latestSameOutcome.resultHash)
    : 0;

  if (
    policy.detectors.knownPollNoProgress &&
    KNOWN_POLL_TOOLS.has(toolName) &&
    Math.max(outcomeCount, outcomeStreak) >= policy.criticalThreshold
  ) {
    const count = Math.max(outcomeCount, outcomeStreak);
    return {
      level: 'critical',
      detector: 'known_poll_no_progress',
      message: `${toolName} repeated with no outcome change (${count}x)` ,
      signature,
      argsHash,
      count,
    };
  }

  if (policy.detectors.pingPong && state.history.length >= 4) {
    const tail = state.history.slice(-4);
    const [a, b, c, d] = tail;
    // Ping-pong: A→B→A→B with same outcomes each time
    // But only flag if at least one is a read-only tool (avoid false positives on legitimate edit patterns)
    const readOnlyTools = new Set(['read_file', 'read_files', 'list_dir', 'search_files', 'exec']);
    const isAReadOnly = readOnlyTools.has(a.toolName);
    const isBReadOnly = readOnlyTools.has(b.toolName);
    const hasReadOnly = isAReadOnly || isBReadOnly;

    if (
      hasReadOnly &&
      a.signature === c.signature &&
      b.signature === d.signature &&
      a.signature !== b.signature &&
      a.resultHash && b.resultHash && c.resultHash && d.resultHash &&
      a.resultHash === c.resultHash &&
      b.resultHash === d.resultHash
    ) {
      return {
        level: 'warning',
        detector: 'ping_pong',
        message: `Detected ping-pong tool loop between ${a.toolName} and ${b.toolName}`,
        signature,
        argsHash,
        count: 4,
      };
    }
  }

  if (policy.detectors.genericRepeat) {
    const repeatCount = Math.max(outcomeStreak, signatureStreak);
    if (repeatCount >= policy.criticalThreshold) {
      return {
        level: 'critical',
        detector: 'generic_repeat',
        message: `Repeated identical tool call with no meaningful change (${repeatCount}x)`,
        signature,
        argsHash,
        count: repeatCount,
      };
    }

    if (repeatCount >= policy.warningThreshold) {
      return {
        level: 'warning',
        detector: 'generic_repeat',
        message: `Repeated identical tool call detected (${repeatCount}x)`,
        signature,
        argsHash,
        count: repeatCount,
      };
    }
  }

  return { level: 'none', signature, argsHash, count: Math.max(outcomeStreak, signatureStreak) };
}

export function getToolCallStats(state: ToolLoopState): {
  totalHistory: number;
  signatures: Array<{ signature: string; count: number }>;
  outcomes: Array<{ key: string; count: number }>;
} {
  const signatures = [...state.bySignature.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([signature, count]) => ({ signature, count }));
  const outcomes = [...state.byOutcomeKey.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));

  return {
    totalHistory: state.history.length,
    signatures,
    outcomes,
  };
}
