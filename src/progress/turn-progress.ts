import type { AgentHooks } from '../agent.js';
import { truncate } from '../shared/strings.js';
import type { ToolCallEvent, ToolResultEvent, TurnEndEvent } from '../types.js';

import { formatToolCallSummary } from './tool-summary.js';

export type TurnProgressPhase = 'thinking' | 'responding' | 'tool' | 'done';
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

export function formatStatusLine(
  snap: Pick<TurnProgressSnapshot, 'phase' | 'elapsedBucketMs' | 'activeTool'>
): string {
  const total = formatElapsed(snap.elapsedBucketMs);

  if (snap.phase === 'tool' && snap.activeTool) {
    const tool = formatElapsed(snap.activeTool.elapsedBucketMs);
    return truncate(`🔧 ${snap.activeTool.summary} (${tool} tool, ${total} total)`, 160);
  }

  if (snap.phase === 'responding') return `✍️ Writing response (${total})`;
  if (snap.phase === 'done') return `✅ Done (${total})`;
  return `⏳ Thinking (${total})`;
}

/**
 * Shared progress tracker:
 * - attaches to AgentHooks
 * - keeps phase state
 * - emits a *changed* statusLine on a heartbeat, bucketed to avoid spam
 * - maintains compact toolLines
 */
export class TurnProgressController {
  public readonly hooks: AgentHooks;

  private readonly sink: TurnProgressSink;
  private readonly nowFn: () => number;
  private readonly heartbeatMs: number;
  private readonly bucketMs: number;
  private readonly maxToolLines: number;
  private readonly toolSummary: (call: ToolCallEvent) => string;

  private startedAt = 0;
  private lastActivityAt = 0;
  private phase: TurnProgressPhase = 'thinking';

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRenderedLine = '';
  private lastTurnEnd?: TurnEndEvent;

  private activeTool: { name: string; summary: string; startedAt: number } | null = null;

  private toolLines: string[] = [];
  private lastToolLine = '';
  private lastToolRepeat = 0;

  private manualLine: string | null = null;

  constructor(sink: TurnProgressSink, opts?: TurnProgressOptions) {
    this.sink = sink;
    this.nowFn = opts?.now ?? (() => Date.now());
    this.heartbeatMs = Math.max(250, Math.floor(opts?.heartbeatMs ?? 1000));
    this.bucketMs = Math.max(1000, Math.floor(opts?.bucketMs ?? 5000));
    this.maxToolLines = Math.max(0, Math.floor(opts?.maxToolLines ?? 6));
    this.toolSummary =
      opts?.toolCallSummary ??
      ((call) => formatToolCallSummary({ name: call.name, args: call.args as any }));

    this.hooks = {
      onToken: (t) => this.onToken(t),
      onFirstDelta: () => this.onFirstDelta(),
      onToolCall: (call) => this.onToolCall(call),
      onToolResult: (result) => this.onToolResult(result),
      onTurnEnd: (stats) => this.onTurnEnd(stats),
    };
  }

  start(): void {
    if (this.startedAt > 0) return;
    const now = this.nowFn();
    this.startedAt = now;
    this.lastActivityAt = now;
    this.phase = 'thinking';
    this.emit('init', true);

    this.timer = setInterval(() => this.emit('heartbeat', false), this.heartbeatMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.startedAt <= 0) return;
    this.phase = 'done';
    this.emit('stop', true);
  }

  setManualStatus(text: string | null, phase?: TurnProgressPhase): void {
    this.manualLine = text && text.trim() ? text.trim() : null;
    if (phase) this.phase = phase;
    this.emit('manual', true);
  }

  snapshot(reason: TurnProgressReason = 'manual'): TurnProgressSnapshot {
    const now = this.nowFn();
    const elapsedMs = Math.max(0, now - this.startedAt);
    const elapsedBucketMs = bucket(elapsedMs, this.bucketMs);
    const sinceLastActivityMs = Math.max(0, now - this.lastActivityAt);

    const activeTool = this.activeTool
      ? {
          name: this.activeTool.name,
          summary: this.activeTool.summary,
          startedAt: this.activeTool.startedAt,
          elapsedMs: Math.max(0, now - this.activeTool.startedAt),
          elapsedBucketMs: bucket(Math.max(0, now - this.activeTool.startedAt), this.bucketMs),
        }
      : undefined;

    const baseSnap: TurnProgressSnapshot = {
      phase: this.phase,
      reason,
      startedAt: this.startedAt,
      now,
      elapsedMs,
      elapsedBucketMs,
      sinceLastActivityMs,
      statusLine: '',
      toolLines: [...this.toolLines],
      activeTool,
      lastTurnEnd: this.lastTurnEnd,
    };

    const statusLine = this.manualLine || formatStatusLine(baseSnap);
    return { ...baseSnap, statusLine };
  }

  private markActivity(): void {
    this.lastActivityAt = this.nowFn();
  }

  private pushToolLine(line: string): void {
    if (this.maxToolLines <= 0) return;
    this.toolLines.push(line);
    if (this.toolLines.length > this.maxToolLines) {
      this.toolLines.splice(0, this.toolLines.length - this.maxToolLines);
    }
  }

  private replaceLastToolLine(line: string): void {
    if (this.maxToolLines <= 0) return;
    if (this.toolLines.length === 0) {
      this.pushToolLine(line);
      return;
    }
    this.toolLines[this.toolLines.length - 1] = line;
  }

  private emit(reason: TurnProgressReason, force = false): void {
    if (this.startedAt <= 0) return;
    const snap = this.snapshot(reason);
    const lineChanged = snap.statusLine !== this.lastRenderedLine;
    if (!force && !lineChanged) return;
    this.lastRenderedLine = snap.statusLine;

    try {
      void this.sink(snap);
    } catch {
      // Sink failures should never break agent flow.
    }
  }

  private onToken(_token: string): void {
    this.markActivity();
    // If we get generation tokens while not in a tool call, we're responding.
    if (this.phase !== 'tool') this.phase = 'responding';
    this.emit('heartbeat', false);
  }

  private onFirstDelta(): void {
    this.markActivity();
    if (this.phase !== 'tool') this.phase = 'responding';
    this.emit('first_delta', true);
  }

  private onToolCall(call: ToolCallEvent): void {
    this.markActivity();

    const summary = this.toolSummary(call);
    this.activeTool = { name: call.name, summary, startedAt: this.nowFn() };
    this.phase = 'tool';

    const line = `◆ ${summary}...`;
    if (this.lastToolLine === line && this.toolLines.length > 0) {
      this.lastToolRepeat += 1;
      this.toolLines[this.toolLines.length - 1] = `${line} (x${this.lastToolRepeat + 1})`;
    } else {
      this.lastToolLine = line;
      this.lastToolRepeat = 0;
      this.pushToolLine(line);
    }

    this.emit('tool_call', true);
  }

  private onToolResult(result: ToolResultEvent): void {
    this.markActivity();

    this.activeTool = null;
    this.lastToolLine = '';
    this.lastToolRepeat = 0;

    // After a tool, we are typically waiting for the model again.
    this.phase = 'thinking';

    const icon = result.success ? '✓' : '✗';
    this.replaceLastToolLine(`${icon} ${result.name}: ${result.summary}`);

    this.emit('tool_result', true);
  }

  private onTurnEnd(stats: TurnEndEvent): void {
    this.markActivity();
    this.lastTurnEnd = stats;
    this.emit('turn_end', true);
  }
}
