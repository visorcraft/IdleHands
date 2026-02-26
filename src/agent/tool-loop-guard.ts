import fs from 'node:fs/promises';
import path from 'node:path';

import type { ToolCall } from '../types.js';

import {
  createToolLoopState,
  detectToolCallLoop,
  getToolCallStats,
  hashToolCall,
  recordToolCall,
  recordToolCallOutcome,
  stableStringify,
  type ToolLoopConfig,
  type ToolLoopDetectionResult,
  type ToolCallRecord,
} from './tool-loop-detection.js';

type ReadCacheEntry = {
  content: string;
  paths: string[];
  versions: string[];
  cachedAt: number;
};

type ToolLoopTelemetry = {
  callsRegistered: number;
  dedupedReplays: number;
  readCacheLookups: number;
  readCacheHits: number;
  warnings: number;
  criticals: number;
  recoveryRecommended: number;
  readFileFailures: number;
};

export type ToolLoopWarning = {
  level: 'warning' | 'critical';
  detector: string;
  toolName: string;
  message: string;
  count: number;
};

export type PreparedTurn = {
  uniqueCalls: ToolCall[];
  replayByCallId: Map<string, string>;
  signatureByCallId: Map<string, string>;
  parsedArgsByCallId: Map<string, Record<string, unknown>>;
};

export class ToolLoopGuard {
  private readonly loopState = createToolLoopState();
  private readonly readCache = new Map<string, ReadCacheEntry>();
  private readonly config: ToolLoopConfig;
  private readonly recordByCallId = new Map<string, ToolCallRecord>();
  private readonly telemetry: ToolLoopTelemetry = {
    callsRegistered: 0,
    dedupedReplays: 0,
    readCacheLookups: 0,
    readCacheHits: 0,
    warnings: 0,
    criticals: 0,
    recoveryRecommended: 0,
    readFileFailures: 0,
  };

  constructor(config?: ToolLoopConfig) {
    this.config = {
      enabled: config?.enabled ?? true,
      historySize: config?.historySize ?? 30,
      warningThreshold: config?.warningThreshold ?? 4,
      criticalThreshold: config?.criticalThreshold ?? 8,
      globalCircuitBreakerThreshold: config?.globalCircuitBreakerThreshold ?? 12,
      readCacheTtlMs: config?.readCacheTtlMs ?? 15_000,
      detectors: {
        genericRepeat: config?.detectors?.genericRepeat ?? true,
        knownPollNoProgress: config?.detectors?.knownPollNoProgress ?? true,
        pingPong: config?.detectors?.pingPong ?? true,
      },
      perTool: config?.perTool ?? {},
    };
  }

  parseArgs(raw: string): Record<string, unknown> {
    try {
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // keep below
    }
    return {};
  }

  computeSignature(toolName: string, args: Record<string, unknown>): string {
    return hashToolCall(toolName, args).signature;
  }

  prepareTurn(toolCalls: ToolCall[]): PreparedTurn {
    const uniqueCalls: ToolCall[] = [];
    const replayByCallId = new Map<string, string>();
    const canonicalBySig = new Map<string, string>();
    const signatureByCallId = new Map<string, string>();
    const parsedArgsByCallId = new Map<string, Record<string, unknown>>();

    for (const tc of toolCalls) {
      const toolName = tc.function?.name ?? '';
      const callId = tc.id ?? `${toolName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      if (!tc.id) tc.id = callId;
      const args = this.parseArgs(tc.function?.arguments ?? '{}');
      const sig = this.computeSignature(toolName, args);

      signatureByCallId.set(callId, sig);
      parsedArgsByCallId.set(callId, args);

      const canonicalId = canonicalBySig.get(sig);
      if (!canonicalId) {
        canonicalBySig.set(sig, callId);
        uniqueCalls.push(tc);
      } else {
        replayByCallId.set(callId, canonicalId);
      }
    }

    this.telemetry.dedupedReplays += replayByCallId.size;
    return { uniqueCalls, replayByCallId, signatureByCallId, parsedArgsByCallId };
  }

  detect(toolName: string, args: Record<string, unknown>): ToolLoopDetectionResult {
    const detected = detectToolCallLoop(this.loopState, toolName, args, this.config);
    if (detected.level === 'warning') this.telemetry.warnings += 1;
    if (detected.level === 'critical') this.telemetry.criticals += 1;
    return detected;
  }

  registerCall(toolName: string, args: Record<string, unknown>, toolCallId?: string): void {
    const rec = recordToolCall(this.loopState, toolName, args, toolCallId, this.config);
    this.telemetry.callsRegistered += 1;
    if (toolCallId) {
      this.recordByCallId.set(toolCallId, rec);
    }
  }

  registerOutcome(
    toolName: string,
    args: Record<string, unknown>,
    outcome: { toolCallId?: string; result?: unknown; error?: unknown }
  ): void {
    const record = outcome.toolCallId ? this.recordByCallId.get(outcome.toolCallId) : undefined;
    recordToolCallOutcome(
      this.loopState,
      {
        toolName,
        toolParams: args,
        toolCallId: outcome.toolCallId,
        result: outcome.result,
        error: outcome.error,
      },
      record
    );
    // Clean up the record reference after outcome is recorded
    if (outcome.toolCallId) {
      this.recordByCallId.delete(outcome.toolCallId);
    }

    // Track consecutive read_file/read_files failures
    const isReadFileTool = toolName === 'read_file' || toolName === 'read_files';
    if (isReadFileTool && outcome.error !== undefined) {
      this.telemetry.readFileFailures += 1;
    } else if (isReadFileTool && outcome.error === undefined) {
      // Reset on success
      this.telemetry.readFileFailures = 0;
    }
  }

  getStats() {
    const base = getToolCallStats(this.loopState);
    const readCacheHitRate =
      this.telemetry.readCacheLookups > 0
        ? this.telemetry.readCacheHits / this.telemetry.readCacheLookups
        : 0;
    const dedupeRate =
      this.telemetry.callsRegistered > 0
        ? this.telemetry.dedupedReplays / this.telemetry.callsRegistered
        : 0;
    return {
      ...base,
      telemetry: {
        ...this.telemetry,
        readCacheHitRate,
        dedupeRate,
      },
    };
  }

  shouldDisableToolsNextTurn(result: ToolLoopDetectionResult): boolean {
    const should = result.level === 'critical';
    if (should) this.telemetry.recoveryRecommended += 1;
    return should;
  }

  getReadFileFailureCount(): number {
    return this.telemetry.readFileFailures;
  }

  resetReadFileFailureCount(): void {
    this.telemetry.readFileFailures = 0;
  }

  async getReadCacheReplay(
    toolName: string,
    args: Record<string, unknown>,
    cwd: string
  ): Promise<string | null> {
    if (!isReadCacheableTool(toolName)) return null;

    this.telemetry.readCacheLookups += 1;
    const sig = this.computeSignature(toolName, args);
    const cached = this.readCache.get(sig);
    if (!cached) return null;

    if (typeof this.config.readCacheTtlMs === 'number' && this.config.readCacheTtlMs > 0) {
      if (Date.now() - cached.cachedAt > this.config.readCacheTtlMs) {
        this.readCache.delete(sig);
        return null;
      }
    }

    const { paths } = extractReadPaths(toolName, args, cwd);
    if (!paths.length || paths.length !== cached.paths.length) {
      this.readCache.delete(sig);
      return null;
    }

    const versions = await Promise.all(paths.map((p) => getResourceVersion(p)));
    const stillValid = versions.every((v, i) => Boolean(v) && v === cached.versions[i]);
    if (!stillValid) {
      this.readCache.delete(sig);
      return null;
    }

    this.telemetry.readCacheHits += 1;
    return makeCacheReplayContent(toolName, cached.content);
  }

  async storeReadCache(
    toolName: string,
    args: Record<string, unknown>,
    cwd: string,
    content: string
  ): Promise<void> {
    if (!isReadCacheableTool(toolName)) return;
    if (content.startsWith('ERROR:')) return;

    const { paths } = extractReadPaths(toolName, args, cwd);
    if (!paths.length) return;

    const versions = await Promise.all(paths.map((p) => getResourceVersion(p)));
    if (versions.some((v) => !v)) return;

    const sig = this.computeSignature(toolName, args);
    this.readCache.set(sig, {
      content,
      paths,
      versions: versions as string[],
      cachedAt: Date.now(),
    });
  }

  formatWarning(result: ToolLoopDetectionResult, toolName: string): ToolLoopWarning | null {
    if (result.level === 'none') return null;
    return {
      level: result.level,
      detector: result.detector ?? 'generic_repeat',
      toolName,
      count: result.count,
      message: result.message ?? `${toolName}: repeated identical tool call detected`,
    };
  }
}

function isReadCacheableTool(toolName: string): boolean {
  return toolName === 'read_file' || toolName === 'read_files' || toolName === 'list_dir';
}

function makeCacheHint(toolName: string): string {
  if (toolName === 'read_file')
    return '[CACHE HIT] File unchanged since previous read. Replaying cached content below.';
  if (toolName === 'read_files')
    return '[CACHE HIT] Files unchanged since previous read. Replaying cached content below.';
  if (toolName === 'list_dir')
    return '[CACHE HIT] Directory unchanged since previous read. Replaying cached content below.';
  return '[CACHE HIT] Resource unchanged since previous read. Replaying cached content below.';
}

function makeCacheReplayContent(toolName: string, content: string): string {
  const MAX_REPLAY_CHARS = 16_000;
  const body =
    content.length > MAX_REPLAY_CHARS
      ? `${content.slice(0, MAX_REPLAY_CHARS)}\n[truncated cached replay: ${content.length - MAX_REPLAY_CHARS} chars omitted]`
      : content;
  return `${makeCacheHint(toolName)}\n\n${body}`;
}

function resolveWithCwd(baseCwd: string, p: string): string {
  return path.resolve(baseCwd, p);
}

function extractReadPaths(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string
): { paths: string[] } {
  if (toolName === 'read_file' || toolName === 'list_dir') {
    const p = typeof args.path === 'string' ? args.path.trim() : '';
    if (!p) return { paths: [] };
    return { paths: [resolveWithCwd(cwd, p)] };
  }

  if (toolName === 'read_files') {
    const reqs = (args as any)?.requests;
    if (!Array.isArray(reqs)) return { paths: [] };
    const paths: string[] = [];
    for (const req of reqs) {
      const p = typeof req?.path === 'string' ? req.path.trim() : '';
      if (p) paths.push(resolveWithCwd(cwd, p));
    }
    return { paths };
  }

  return { paths: [] };
}

async function getResourceVersion(absPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absPath);
    return `${absPath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

export function stableToolArgsForTests(v: unknown): string {
  return stableStringify(v);
}

/**
 * Generate parameter mutation hints for read-only tools caught in loops.
 * Helps the model understand how to read different content instead of repeating.
 */
export function getReadLoopHints(
  toolName: string,
  args: Record<string, unknown>
): string[] {
  const hints: string[] = [];

  if (toolName === "read_file" || toolName === "read_files") {
    const hasOffset = "offset" in args && args.offset !== undefined;
    const hasSearch = "search" in args && args.search !== undefined;
    const limit = typeof args.limit === "number" ? args.limit : 100;
    const currentOffset = typeof args.offset === "number" ? args.offset : 1;

    if (!hasOffset && !hasSearch) {
      hints.push(`Use offset=${limit + 1} to read the next section`);
      hints.push(`Use search="keyword" to jump to specific content`);
    } else if (hasOffset && !hasSearch) {
      hints.push(`Increase offset to ${currentOffset + limit} for the next section`);
      hints.push(`Or use search="keyword" to find specific content`);
    }
  } else if (toolName === "list_dir") {
    hints.push(`Use recursive=true if you need subdirectory contents`);
    hints.push(`Or filter results with grep/exec instead of re-reading`);
  } else if (toolName === "search_files") {
    hints.push(`Adjust the pattern or path to find different results`);
    hints.push(`Increase max_results if truncated`);
  }

  return hints;
}
