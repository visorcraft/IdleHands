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
} from './tool-loop-detection.js';

type ReadCacheEntry = {
  content: string;
  paths: string[];
  versions: string[];
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
  private readonly config: Required<ToolLoopConfig>;

  constructor(config?: ToolLoopConfig) {
    this.config = {
      enabled: config?.enabled ?? true,
      historySize: config?.historySize ?? 30,
      warningThreshold: config?.warningThreshold ?? 4,
      criticalThreshold: config?.criticalThreshold ?? 8,
      globalCircuitBreakerThreshold: config?.globalCircuitBreakerThreshold ?? 12,
      detectors: {
        genericRepeat: config?.detectors?.genericRepeat ?? true,
        knownPollNoProgress: config?.detectors?.knownPollNoProgress ?? true,
        pingPong: config?.detectors?.pingPong ?? true,
      },
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

    return { uniqueCalls, replayByCallId, signatureByCallId, parsedArgsByCallId };
  }

  detect(toolName: string, args: Record<string, unknown>): ToolLoopDetectionResult {
    return detectToolCallLoop(this.loopState, toolName, args, this.config);
  }

  registerCall(toolName: string, args: Record<string, unknown>, toolCallId?: string): void {
    recordToolCall(this.loopState, toolName, args, toolCallId, this.config);
  }

  registerOutcome(toolName: string, args: Record<string, unknown>, outcome: { toolCallId?: string; result?: unknown; error?: unknown }): void {
    recordToolCallOutcome(this.loopState, {
      toolName,
      toolParams: args,
      toolCallId: outcome.toolCallId,
      result: outcome.result,
      error: outcome.error,
    });
  }

  getStats() {
    return getToolCallStats(this.loopState);
  }

  shouldDisableToolsNextTurn(result: ToolLoopDetectionResult): boolean {
    return result.level === 'critical';
  }

  async getReadCacheReplay(
    toolName: string,
    args: Record<string, unknown>,
    cwd: string,
  ): Promise<string | null> {
    if (!isReadCacheableTool(toolName)) return null;

    const sig = this.computeSignature(toolName, args);
    const cached = this.readCache.get(sig);
    if (!cached) return null;

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

    return makeCacheHint(toolName);
  }

  async storeReadCache(
    toolName: string,
    args: Record<string, unknown>,
    cwd: string,
    content: string,
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
  if (toolName === 'read_file') return '[CACHE HIT] File unchanged since previous read. Use the content you already have.';
  if (toolName === 'read_files') return '[CACHE HIT] Files unchanged since previous read. Use the content you already have.';
  if (toolName === 'list_dir') return '[CACHE HIT] Directory unchanged since previous read. Use the content you already have.';
  return '[CACHE HIT] Resource unchanged since previous read. Use the content you already have.';
}

function resolveWithCwd(baseCwd: string, p: string): string {
  return path.resolve(baseCwd, p);
}

function extractReadPaths(toolName: string, args: Record<string, unknown>, cwd: string): { paths: string[] } {
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
