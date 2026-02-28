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
import { normalizeExecCommandForSig, normalizeTestCommandForSig } from './exec-helpers.js';

function normalizeSearchPatternForSig(raw: string): string {
  const tokens = (raw.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length >= 2);
  if (!tokens.length) return raw.trim().toLowerCase();
  return [...new Set(tokens)].sort().join('|');
}

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

type FileContentCacheEntry = {
  content: string;
  mtime: number;
  size: number;
};

export class ToolLoopGuard {
  private readonly loopState = createToolLoopState();
  private readonly readCache = new Map<string, ReadCacheEntry>();
  /** Per-file content cache keyed by absolute path — survives non-consecutive reads. */
  private readonly fileContentCache = new Map<string, FileContentCacheEntry>();
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
    // For read_file calls, include path + offset bucket so that reading different
    // sections of the same file is NOT treated as a loop, but re-reading the exact
    // same section IS detected.
    if (toolName === 'read_file' && typeof args.path === 'string') {
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const search = typeof args.search === 'string' ? args.search : '';
      // Bucket offsets into 200-line chunks so nearby reads don't count as different
      const offsetBucket = Math.floor(offset / 200);
      return hashToolCall(toolName, { path: args.path, offsetBucket, search }).signature;
    }

    // Same for read_files - include path + offset buckets
    if (toolName === 'read_files' && Array.isArray(args.requests)) {
      const normalized = (args.requests as Array<{ path?: string; offset?: number; search?: string }>).map((r) => {
        const offset = typeof r?.offset === 'number' ? r.offset : 0;
        return { path: r?.path, offsetBucket: Math.floor(offset / 200), search: r?.search ?? '' };
      });
      return hashToolCall(toolName, { requests: normalized }).signature;
    }

    // For edit tools, include path + target location so that edits to different
    // parts of the same file are NOT treated as loops, but repeated identical
    // edits to the same location ARE detected.
    if (
      (toolName === 'edit_file' || toolName === 'write_file' || toolName === 'edit_range' || toolName === 'insert_file') &&
      typeof args.path === 'string'
    ) {
      if (toolName === 'edit_range') {
        // Include line range so editing different sections isn't a "loop"
        const startLine = typeof args.start_line === 'number' ? args.start_line : 0;
        const endLine = typeof args.end_line === 'number' ? args.end_line : 0;
        return hashToolCall(toolName, { path: args.path, start_line: startLine, end_line: endLine }).signature;
      }
      if (toolName === 'edit_file') {
        // Include a hash of old_text so different edits to same file aren't loops
        const oldText = typeof args.old_text === 'string' ? args.old_text.slice(0, 200) : '';
        return hashToolCall(toolName, { path: args.path, old_text_prefix: oldText }).signature;
      }
      // write_file / insert_file: just path is fine (truly replacing whole file)
      return hashToolCall(toolName, { path: args.path }).signature;
    }

    // For apply_patch, normalize to the list of files
    if (toolName === 'apply_patch' && Array.isArray(args.files)) {
      return hashToolCall(toolName, { files: args.files }).signature;
    }

    // For search_files, normalize regex-like variations into a token signature
    // so near-identical searches are treated as repeats (e.g. "a|b" vs "b|a").
    if (toolName === 'search_files') {
      const pathArg = typeof args.path === 'string' ? args.path.trim() : '.';
      const includeArg = typeof args.include === 'string' ? args.include.trim() : '';
      const patternArg = typeof args.pattern === 'string' ? args.pattern : '';
      const normalizedPattern = normalizeSearchPatternForSig(patternArg);
      return hashToolCall(toolName, {
        path: pathArg,
        include: includeArg,
        pattern: normalizedPattern,
      }).signature;
    }

    // For exec calls, normalize the command for loop detection.
    // 1. Test commands: normalize to framework + filter (e.g., "php artisan test --filter=Foo")
    // 2. General commands: strip trailing output-filter pipes (tail/head/grep)
    if (toolName === 'exec' && typeof args.command === 'string') {
      // Try test command normalization first (more specific)
      const testNormalized = normalizeTestCommandForSig(args.command);
      if (testNormalized) {
        return hashToolCall(toolName, { command: testNormalized }).signature;
      }
      // Fall back to general exec normalization
      const normalized = normalizeExecCommandForSig(args.command);
      if (normalized !== args.command) {
        const normalizedArgs = { ...args, command: normalized };
        return hashToolCall(toolName, normalizedArgs).signature;
      }
    }
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

  /**
   * Check if a file has been read before and is unchanged (by mtime/size).
   * Works across non-consecutive reads — unlike the signature-based readCache
   * which only catches back-to-back identical calls.
   * Returns cached content with a hint, or null if not cached/stale.
   */
  async getFileContentCache(
    toolName: string,
    args: Record<string, unknown>,
    cwd: string
  ): Promise<string | null> {
    if (toolName !== 'read_file') return null;

    const filePath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!filePath) return null;

    const absPath = filePath.startsWith('/') ? filePath : path.resolve(cwd, filePath);
    const offset = args.offset != null ? Number(args.offset) : 0;
    const limit = args.limit != null ? Number(args.limit) : 0;
    const cacheKey = `${absPath}|${offset}|${limit}`;
    const cached = this.fileContentCache.get(cacheKey);
    if (!cached) return null;

    // Check if file has changed since we cached it
    try {
      const stat = await fs.stat(absPath);
      if (stat.mtimeMs !== cached.mtime || stat.size !== cached.size) {
        // File changed — invalidate cache
        this.fileContentCache.delete(cacheKey);
        return null;
      }
    } catch {
      this.fileContentCache.delete(cacheKey);
      return null;
    }

    this.telemetry.readCacheHits += 1;
    const hints = getReadLoopHints(toolName, args);
    const hintSuffix = hints.length > 0 ? ` Tip: ${hints[0]}` : "";
    return (
      `[CACHE HIT] File unchanged since previous read — returning cached content. Do NOT re-read this file unless you edit it first.${hintSuffix}\n\n` +
      cached.content
    );
  }

  /**
   * Store file content in the per-file cache after a successful read.
   */
  async storeFileContentCache(
    toolName: string,
    args: Record<string, unknown>,
    cwd: string,
    content: string
  ): Promise<void> {
    if (toolName !== 'read_file') return;
    if (content.startsWith('ERROR:')) return;

    const filePath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!filePath) return;

    const absPath = filePath.startsWith('/') ? filePath : path.resolve(cwd, filePath);
    const offset = args.offset != null ? Number(args.offset) : 0;
    const limit = args.limit != null ? Number(args.limit) : 0;
    const cacheKey = `${absPath}|${offset}|${limit}`;

    try {
      const stat = await fs.stat(absPath);
      this.fileContentCache.set(cacheKey, {
        content,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    } catch {
      // File doesn't exist or unreadable — don't cache
    }
  }

  /**
   * Invalidate file content cache for a path that was just edited.
   * Call this after any mutation tool (edit_file, write_file, etc.) completes.
   */
  invalidateFileContentCache(absPath: string): void {
    // Clear all cached entries for this file (any offset/limit combo)
    for (const key of this.fileContentCache.keys()) {
      if (key === absPath || key.startsWith(absPath + '|')) {
        this.fileContentCache.delete(key);
      }
    }
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
    return makeCacheReplayContent(toolName, cached.content, args);
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

function makeCacheReplayContent(toolName: string, content: string, args?: Record<string, unknown>): string {
  const MAX_REPLAY_CHARS = 16_000;
  const body =
    content.length > MAX_REPLAY_CHARS
      ? `${content.slice(0, MAX_REPLAY_CHARS)}\n[truncated cached replay: ${content.length - MAX_REPLAY_CHARS} chars omitted]`
      : content;
  const hints = args ? getReadLoopHints(toolName, args) : [];
  const hintSuffix = hints.length > 0 ? ` Tip: ${hints[0]}` : "";
  return `${makeCacheHint(toolName)}${hintSuffix}\n\n${body}`;
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
