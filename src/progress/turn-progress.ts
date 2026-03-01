/**
 * Turn progress controller - tracks tool calls and maintains status.
 * Adapted from IdleHands.
 */

import type {
  ProgressHooks,
  ProgressPhase,
  ProgressSnapshot,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
} from "./types.js";

export type TurnProgressOptions = {
  /** Heartbeat interval for status updates (default: 1000ms) */
  heartbeatMs?: number;
  /** Quantize elapsed time to reduce status line churn (default: 5000ms) */
  bucketMs?: number;
  /** Max tool lines to keep (default: 8) */
  maxToolLines?: number;
  /** Custom tool call summary formatter */
  formatToolCall?: (call: ToolCallEvent) => string;
};

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) {
    return `${m}m${String(r).padStart(2, "0")}s`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${String(rm).padStart(2, "0")}m`;
}

function bucket(ms: number, bucketMs: number): number {
  if (bucketMs <= 1) {
    return Math.max(0, ms);
  }
  return Math.max(0, Math.floor(ms / bucketMs) * bucketMs);
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) {
    return s;
  }
  return s.slice(0, maxLen - 1) + "…";
}

/** Safely extract a string value from args */
function getArgString(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  if (typeof val === "string") {
    return val;
  }
  return undefined;
}

function defaultFormatToolCall(call: ToolCallEvent): string {
  const name = call.name ?? "unknown";
  const args = call.args ?? {};

  // Handle common tools with useful summaries
  if (name === "exec") {
    const cmd = getArgString(args, "command");
    if (cmd) {
      return `exec: ${truncate(cmd.replace(/\s+/g, " ").trim(), 80)}`;
    }
  }
  if (name === "read" || name === "Read") {
    const path = getArgString(args, "path") ?? getArgString(args, "file_path");
    if (path) {
      return `read ${path}`;
    }
  }
  if (name === "write" || name === "Write") {
    const path = getArgString(args, "path") ?? getArgString(args, "file_path");
    if (path) {
      return `write ${path}`;
    }
  }
  if (name === "edit" || name === "Edit") {
    const path = getArgString(args, "path") ?? getArgString(args, "file_path");
    if (path) {
      return `edit ${path}`;
    }
  }
  if (name === "web_search") {
    const query = getArgString(args, "query");
    if (query) {
      return `search: ${truncate(query, 60)}`;
    }
  }
  if (name === "web_fetch") {
    const url = getArgString(args, "url");
    if (url) {
      return `fetch: ${truncate(url, 60)}`;
    }
  }

  return name;
}

function formatTokens(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

export type ProgressSink = (snap: ProgressSnapshot) => void;

export class TurnProgressController {
  public readonly hooks: ProgressHooks;

  private readonly sink: ProgressSink;
  private readonly heartbeatMs: number;
  private readonly bucketMs: number;
  private readonly maxToolLines: number;
  private readonly formatToolCall: (call: ToolCallEvent) => string;

  private startedAt = 0;
  private lastActivityAt = 0;
  private phase: ProgressPhase = "thinking";
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRenderedLine = "";

  private activeTool: { name: string; summary: string; startedAt: number } | null = null;
  private toolLines: string[] = [];

  // Turn/token tracking
  private turnCount = 0;
  private totalToolCalls = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private lastTurnStats: TurnEndEvent | null = null;
  private contextTokens = 0;

  constructor(sink: ProgressSink, opts?: TurnProgressOptions) {
    this.sink = sink;
    this.heartbeatMs = Math.max(250, opts?.heartbeatMs ?? 1000);
    this.bucketMs = Math.max(1000, opts?.bucketMs ?? 5000);
    this.maxToolLines = Math.max(1, opts?.maxToolLines ?? 8);
    this.formatToolCall = opts?.formatToolCall ?? defaultFormatToolCall;

    this.hooks = {
      onToken: (t) => this.onToken(t),
      onFirstDelta: () => this.onFirstDelta(),
      onToolCall: (call) => this.onToolCall(call),
      onToolResult: (result) => this.onToolResult(result),
      onTurnEnd: (stats) => this.onTurnEnd(stats),
    };
  }

  start(): void {
    if (this.startedAt > 0) {
      return;
    }
    const now = Date.now();
    this.startedAt = now;
    this.lastActivityAt = now;
    this.phase = "thinking";
    this.emit(true);
    this.timer = setInterval(() => this.emit(false), this.heartbeatMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.startedAt <= 0) {
      return;
    }
    this.phase = "done";
    this.emit(true);
  }

  snapshot(): ProgressSnapshot {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - this.startedAt);
    const elapsedBucket = bucket(elapsedMs, this.bucketMs);

    const activeTool = this.activeTool
      ? {
          name: this.activeTool.name,
          summary: this.activeTool.summary,
          elapsedMs: Math.max(0, now - this.activeTool.startedAt),
        }
      : undefined;

    const statusLine = this.buildStatusLine(elapsedBucket, activeTool);

    return {
      phase: this.phase,
      elapsedMs,
      statusLine,
      toolLines: [...this.toolLines],
      activeTool,
      turnCount: this.turnCount,
      totalToolCalls: this.totalToolCalls,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      contextTokens: this.contextTokens || undefined,
      lastTurnStats: this.lastTurnStats ?? undefined,
    };
  }

  private buildStatusLine(
    elapsedBucket: number,
    activeTool?: { name: string; summary: string; elapsedMs: number },
  ): string {
    const total = formatElapsed(elapsedBucket);
    const turnInfo = this.turnCount > 0 ? `T${this.turnCount}` : "";
    // Context tokens (current window size)
    const ctxInfo = this.contextTokens > 0 ? `${formatTokens(this.contextTokens)} ctx` : "";
    // Completion tokens this turn
    const turnGen = this.lastTurnStats?.completionTokensTurn
      ? `+${formatTokens(this.lastTurnStats.completionTokensTurn)}`
      : "";
    const stats = [turnInfo, ctxInfo, turnGen].filter(Boolean).join(" · ");
    const statsSuffix = stats ? ` [${stats}]` : "";

    if (this.phase === "tool" && activeTool) {
      const toolTime = formatElapsed(bucket(activeTool.elapsedMs, this.bucketMs));
      return truncate(`🔧 ${activeTool.summary} (${toolTime} / ${total})${statsSuffix}`, 140);
    }

    if (this.phase === "responding") {
      return `✍️ Writing (${total})${statsSuffix}`;
    }
    if (this.phase === "done") {
      return `✅ Done (${total})${statsSuffix}`;
    }
    return `⏳ Thinking (${total})${statsSuffix}`;
  }

  private emit(force: boolean): void {
    if (this.startedAt <= 0) {
      return;
    }
    const snap = this.snapshot();
    if (!force && snap.statusLine === this.lastRenderedLine) {
      return;
    }
    this.lastRenderedLine = snap.statusLine;
    this.sink(snap);
  }

  private markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  private pushToolLine(line: string): void {
    this.toolLines.push(line);
    if (this.toolLines.length > this.maxToolLines) {
      this.toolLines.splice(0, this.toolLines.length - this.maxToolLines);
    }
  }

  private replaceLastToolLine(line: string): void {
    if (this.toolLines.length === 0) {
      this.pushToolLine(line);
      return;
    }
    this.toolLines[this.toolLines.length - 1] = line;
  }

  private onToken(_token: string): void {
    this.markActivity();
    if (this.phase !== "tool") {
      this.phase = "responding";
    }
  }

  private onFirstDelta(): void {
    this.turnCount++;
    this.markActivity();
    if (this.phase !== "tool") {
      this.phase = "responding";
    }
    this.emit(true);
  }

  private onToolCall(call: ToolCallEvent): void {
    this.markActivity();
    this.totalToolCalls++;

    const summary = this.formatToolCall(call);
    this.activeTool = { name: call.name, summary, startedAt: Date.now() };
    this.phase = "tool";

    this.pushToolLine(`◆ ${summary}`);
    this.emit(true);
  }

  private onToolResult(result: ToolResultEvent): void {
    this.markActivity();

    this.activeTool = null;
    this.phase = "thinking";

    const icon = result.success ? "✓" : "✗";
    this.replaceLastToolLine(`${icon} ${result.name}: ${result.summary}`);
    this.emit(true);
  }

  private onTurnEnd(stats: TurnEndEvent): void {
    this.markActivity();
    this.turnCount++;
    this.lastTurnStats = stats;

    // Accumulate tokens
    if (stats.promptTokensTurn != null) {
      this.totalPromptTokens += stats.promptTokensTurn;
    }
    if (stats.contextTokens != null) {
      this.contextTokens = stats.contextTokens;
    }
    if (stats.completionTokensTurn != null) {
      this.totalCompletionTokens += stats.completionTokensTurn;
    }

    this.emit(true);
  }
}
