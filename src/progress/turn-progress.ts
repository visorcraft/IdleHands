import type { AgentHooks } from '../agent.js';
import { truncate } from '../shared/strings.js';
import type { ToolCallEvent, ToolResultEvent, TurnEndEvent } from '../types.js';

import { formatToolCallSummary } from './tool-summary.js';

export type TurnProgressPhase =
  | 'queued'
  | 'planning'
  | 'runtime_preflight'
  | 'executing'
  | 'verifying'
  | 'complete';
export type TurnProgressReason =
  | 'init'
  | 'heartbeat'
  | 'first_delta'
  | 'tool_call'
  | 'tool_result'
  | 'turn_end'
  | 'manual'
  | 'stop';

export type TurnProgressSnapshot = {
  phase: TurnProgressPhase;
  reason: TurnProgressReason;

  startedAt: number;
  now: number;

  elapsedMs: number;
  elapsedBucketMs: number;
  sinceLastActivityMs: number;

  statusLine: string;

  // Recent tool status lines (◆ running, ✓ done, ✗ error)
  toolLines: string[];

  // Current tool (if running)
  activeTool?: {
    name: string;
    summary: string;
    startedAt: number;
    elapsedMs: number;
    elapsedBucketMs: number;
  };

  // Most recent turn_end stats (if you want to display perf/usage)
  lastTurnEnd?: TurnEndEvent;
};

export type TurnProgressSink = (snap: TurnProgressSnapshot) => void | Promise<void>;

export type TurnProgressOptions = {
  /** How often to check whether the status line changed. */
  heartbeatMs?: number; // default 1000
  /** Quantize elapsed time so the status line changes only every N ms. */
  bucketMs?: number; // default 5000
  /** Keep only N most recent tool lines. */
  maxToolLines?: number; // default 6
  /** Override tool call summary formatting. */
  toolCallSummary?: (call: ToolCallEvent) => string;
  /** Time source (for tests) */
  now?: () => number;
};

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m${String(r).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${String(rm).padStart(2, '0')}m`;
}

function bucket(ms: number, bucketMs: number): number {
  if (bucketMs <= 1) return Math.max(0, ms);
  return Math.max(0, Math.floor(ms / bucketMs) * bucketMs);
}

function sanitizeToolResultSummary(name: string, summary: string): string {
  const normalized = String(summary ?? '').replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  if (
    name === 'write_file' &&
    lower.includes('internal: write_file: refusing to overwrite existing non-empty file')
  ) {
    return 'overwrite blocked (existing file; use edit_range/apply_patch or overwrite=true)';
  }

  if (lower.startsWith('internal:')) {
    const compact = normalized.slice('internal:'.length).trim();
    return `internal: ${truncate(compact, 120)}`;
  }

  return truncate(normalized, 120);
}

export function formatStatusLine(
  snap: Pick<TurnProgressSnapshot, 'phase' | 'elapsedBucketMs' | 'activeTool'>
): string {
  const total = formatElapsed(snap.elapsedBucketMs);

  if (snap.phase === 'executing' && snap.activeTool) {
    const tool = formatElapsed(snap.activeTool.elapsedBucketMs);
    return truncate(`🔧 ${snap.activeTool.summary} (${tool} tool, ${total} total)`, 160);
  }

  if (snap.phase === 'verifying') return `✅ Verifying (${total})`;
  if (snap.phase === 'complete') return `✅ Done (${total})`;
  if (snap.phase === 'runtime_preflight') return `⚙️ Pre-flight checks (${total})`;
  if (snap.phase === 'planning') return `📋 Planning (${total})`;
  if (snap.phase === 'queued') return `⏳ Queued (${total})`;
  return `⏳ Executing (${total})`;
}

/**
 * Shared progress tracker:
 * - attaches to AgentHooks
 * - keeps phase state
 * - emits a *changed* statusLine on a heartbeat, bucketed to avoid spam
 * - maintains compact toolLines
 */
export class TurnProgressController {
  private readonly heartbeatMs: number;
  private readonly bucketMs: number;
  private readonly maxToolLines: number;
  private readonly toolSummary: (call: ToolCallEvent) => string;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStatusLine: string = '';
  private lastActivityMs: number = 0;
  private lastTurnEnd?: TurnEndEvent;
  private lastHeartbeatAt: number = 0;
  private phase: TurnProgressPhase = 'queued';
  private statusLine: string = '';
  private toolLines: string[] = [];
  private activeTool?: {
    name: string;
    summary: string;
    startedAt: number;
    elapsedMs: number;
    elapsedBucketMs: number;
  };
  private sink: TurnProgressSink | null = null;

  constructor(sink?: TurnProgressSink | null, opts?: TurnProgressOptions);
  constructor(opts?: TurnProgressOptions);
  constructor(
    sinkOrOpts?: TurnProgressSink | TurnProgressOptions | null,
    maybeOpts?: TurnProgressOptions
  ) {
    let resolvedOpts: TurnProgressOptions | undefined;
    if (typeof sinkOrOpts === 'function') {
      this.sink = sinkOrOpts;
      resolvedOpts = maybeOpts;
    } else if (sinkOrOpts && typeof sinkOrOpts === 'object') {
      resolvedOpts = sinkOrOpts as TurnProgressOptions;
    } else {
      resolvedOpts = maybeOpts;
    }
    this.heartbeatMs = resolvedOpts?.heartbeatMs ?? 1000;
    this.bucketMs = resolvedOpts?.bucketMs ?? 5000;
    this.maxToolLines = resolvedOpts?.maxToolLines ?? 6;
    this.toolSummary = resolvedOpts?.toolCallSummary ?? formatToolCallSummary;
    this.now = resolvedOpts?.now ?? (() => Date.now());
  }

  /** Agent-hooks bridge: returns AgentHooks-compatible callbacks. */
  get hooks(): Pick<AgentHooks, 'onToolCall' | 'onToolResult' | 'onTurnEnd' | 'onToken' | 'onFirstDelta'> {
    return {
      onToken: () => {},
      onFirstDelta: () => {},
      onToolCall: (ev: ToolCallEvent) => this.onToolCall(ev),
      onToolResult: (ev: ToolResultEvent) => this.onToolResult(ev),
      onTurnEnd: (ev: TurnEndEvent) => this.onTurnEnd(ev),
    };
  }

  /** Take a snapshot on demand. */
  snapshot(reason: TurnProgressReason = 'manual'): TurnProgressSnapshot {
    const now = this.now();
    const elapsedMs = now - this.startedAt;
    const elapsedBucketMs = bucket(elapsedMs, this.bucketMs);
    const sinceLastActivityMs = now - this.lastActivityMs;

    return {
      phase: this.phase,
      reason,
      startedAt: this.startedAt,
      now,
      elapsedMs,
      elapsedBucketMs,
      sinceLastActivityMs,
      statusLine: this.statusLine,
      toolLines: [...this.toolLines],
      activeTool: this.activeTool
        ? {
            name: this.activeTool.name,
            summary: this.activeTool.summary,
            startedAt: this.activeTool.startedAt,
            elapsedMs: now - this.activeTool.startedAt,
            elapsedBucketMs: bucket(now - this.activeTool.startedAt, this.bucketMs),
          }
        : undefined,
      lastTurnEnd: this.lastTurnEnd,
    };
  }

  setSink(sink: TurnProgressSink | null): void {
    this.sink = sink;
  }

  start(): void {
    if (this.timer) return;
    const now = this.now();
    this.startedAt = now;
    this.lastActivityMs = now;
    this.lastHeartbeatAt = now;
    this.lastStatusLine = '';
    this.statusLine = formatStatusLine({
      phase: this.phase,
      elapsedBucketMs: 0,
      activeTool: undefined,
    });
    this.emit('init', true);
    this.timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  heartbeat(): void {
    const now = this.now();
    const elapsed = now - this.lastHeartbeatAt;
    if (elapsed < this.heartbeatMs) return;
    this.lastHeartbeatAt = now;

    const elapsedMs = now - this.startedAt;
    const elapsedBucketMs = bucket(elapsedMs, this.bucketMs);
    const sinceLastActivityMs = now - this.lastActivityMs;

    const snap: TurnProgressSnapshot = {
      phase: this.phase,
      reason: 'heartbeat',
      startedAt: this.startedAt,
      now,
      elapsedMs,
      elapsedBucketMs,
      sinceLastActivityMs,
      statusLine: this.statusLine,
      toolLines: [...this.toolLines],
      activeTool: this.activeTool
        ? {
            name: this.activeTool.name,
            summary: this.activeTool.summary,
            startedAt: this.activeTool.startedAt,
            elapsedMs: now - this.activeTool.startedAt,
            elapsedBucketMs: bucket(now - this.activeTool.startedAt, this.bucketMs),
          }
        : undefined,
      lastTurnEnd: this.lastTurnEnd,
    };

    const newStatusLine = formatStatusLine(snap);
    if (newStatusLine !== this.lastStatusLine) {
      this.lastStatusLine = newStatusLine;
      snap.statusLine = newStatusLine;
      this.statusLine = newStatusLine;
      this.sink?.(snap);
    }
  }

  private startedAt: number = 0;

  private markActivity(): void {
    this.lastActivityMs = this.now();
  }

  private emit(reason: TurnProgressReason, immediate = false): void {
    const now = this.now();
    const elapsedMs = now - this.startedAt;
    const elapsedBucketMs = bucket(elapsedMs, this.bucketMs);
    const sinceLastActivityMs = now - this.lastActivityMs;

    const snap: TurnProgressSnapshot = {
      phase: this.phase,
      reason,
      startedAt: this.startedAt,
      now,
      elapsedMs,
      elapsedBucketMs,
      sinceLastActivityMs,
      statusLine: this.statusLine,
      toolLines: [...this.toolLines],
      activeTool: this.activeTool
        ? {
            name: this.activeTool.name,
            summary: this.activeTool.summary,
            startedAt: this.activeTool.startedAt,
            elapsedMs: now - this.activeTool.startedAt,
            elapsedBucketMs: bucket(now - this.activeTool.startedAt, this.bucketMs),
          }
        : undefined,
      lastTurnEnd: this.lastTurnEnd,
    };

    if (immediate) {
      this.lastStatusLine = formatStatusLine(snap);
      snap.statusLine = this.lastStatusLine;
      this.statusLine = this.lastStatusLine;
      this.sink?.(snap);
    } else {
      // Defer to the heartbeat loop
      this.sink?.(snap);
    }
  }

  private onToolCall(ev: ToolCallEvent): void {
    this.markActivity();

    if (ev.phase === 'planned') {
      const summary = this.toolSummary(ev);
      const nextLine = `… planned ${ev.name}: ${summary}`;

      // Replace the most recent planned line for the same tool instead of appending
      // a new row on each streamed argument update.
      const plannedPrefix = `… planned ${ev.name}:`;
      let replaced = false;
      for (let i = this.toolLines.length - 1; i >= 0; i--) {
        if (this.toolLines[i].startsWith(plannedPrefix)) {
          this.toolLines[i] = nextLine;
          replaced = true;
          break;
        }
      }

      if (!replaced) this.appendToolLine(nextLine);
      this.emit('tool_call', true);
      return;
    }

    this.phase = 'executing';
    this.activeTool = {
      name: ev.name,
      summary: this.toolSummary(ev),
      startedAt: this.now(),
      elapsedMs: 0,
      elapsedBucketMs: 0,
    };
    this.emit('tool_call', true);
  }

  private onToolResult(ev: ToolResultEvent): void {
    this.markActivity();
    // After a tool, we are typically waiting for the model again.
    this.phase = 'verifying';

    const icon = ev.success ? '✓' : '✗';
    const summary = sanitizeToolResultSummary(ev.name, ev.summary);
    this.appendToolLine(`${icon} ${ev.name}: ${summary}`);

    this.emit('tool_result', true);
  }

  private appendToolLine(line: string): void {
    if (this.toolLines.length > 0) {
      const lastIdx = this.toolLines.length - 1;
      const last = this.toolLines[lastIdx];
      const baseLast = last.replace(/\s*\(x\d+\)$/, '');
      if (baseLast === line) {
        const m = last.match(/\(x(\d+)\)$/);
        const next = (m ? Number.parseInt(m[1], 10) : 1) + 1;
        this.toolLines[lastIdx] = `${line} (x${next})`;
        return;
      }
    }

    this.toolLines.push(line);
    if (this.toolLines.length > this.maxToolLines) {
      this.toolLines.shift();
    }
  }

  private onTurnEnd(stats: TurnEndEvent): void {
    this.markActivity();
    this.lastTurnEnd = stats;

    // IMPORTANT: turn_end can fire multiple times within a single user request
    // (e.g., tool turn -> follow-up model turn). Mark complete only when agent
    // explicitly says this is the final completion event.
    this.phase = stats.final ? 'complete' : 'verifying';
    this.emit('turn_end', true);
  }

  setManualStatus(text: string | null, phase?: TurnProgressPhase): void {
    if (phase) this.phase = phase;
    this.statusLine = text ?? '';
    this.lastStatusLine = this.statusLine;
    this.markActivity();
    this.emit('manual', true);
  }
}