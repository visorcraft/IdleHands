Below is a concrete, modular pattern that gives you **frequent, user-visible “still working / what I’m doing” updates** across **TUI + Telegram + Discord**, without each frontend inventing its own progress logic.

The key idea is to centralize:

1. **Phase tracking** (`thinking` → `tool` → `responding`)
2. **A heartbeat timer** that emits a *changed* status line every N seconds (bucketed to avoid spam/rate limits)
3. **Tool summaries** (shared formatting)
4. **A tiny hook combiner** so UI code can “subscribe” without duplicating agent hooks

You already have good hook surfaces (`onToken`, `onToolCall`, `onToolResult`, `onTurnEnd`, `onFirstDelta`). This builds on them.

---

## 1) Core shared module: `TurnProgressController`

Create these 3 new files:

### `src/progress/tool-summary.ts`

```ts
// src/progress/tool-summary.ts
export type AnyArgs = Record<string, any>;

function truncate(s: string, n: number): string {
  const t = String(s ?? '');
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + '…';
}

/**
 * Shared human summary for tool calls used by all UIs.
 * Keep this stable and short — it will appear in TUI status and bot updates.
 */
export function formatToolCallSummary(call: { name: string; args: AnyArgs }): string {
  const name = call?.name ?? 'unknown';
  const args = (call as any)?.args ?? {};

  switch (name) {
    case 'read_file': {
      const p = args.path ?? '?';
      const parts: string[] = [`read_file ${p}`];
      if (args.search) parts.push(`search=${truncate(args.search, 48)}`);
      if (args.format) parts.push(`format=${args.format}`);
      if (args.max_bytes != null) parts.push(`max_bytes=${args.max_bytes}`);
      if (args.offset != null) parts.push(`offset=${args.offset}`);
      if (args.limit != null) parts.push(`limit=${args.limit}`);
      return parts.join(' ');
    }
    case 'read_files': {
      const n = Array.isArray(args.requests) ? args.requests.length : '?';
      return `read_files (${n} files)`;
    }
    case 'apply_patch': {
      const size = typeof args.patch === 'string' ? args.patch.length : 0;
      return `apply_patch (${size.toLocaleString()} chars)`;
    }
    case 'edit_range':
      return `edit_range ${args.path || '?'} [${args.start_line ?? '?'}..${args.end_line ?? '?'}]`;

    case 'write_file':
      return `write_file ${args.path || '?'}`;

    case 'insert_file':
      return `insert_file ${args.path || '?'} (line ${args.line ?? '?'})`;

    case 'edit_file':
      return `edit_file ${args.path || '?'}`;

    case 'list_dir':
      return `list_dir ${args.path || '.'}${args.recursive ? ' (recursive)' : ''}`;

    case 'search_files':
      return `search_files "${truncate(args.pattern || '?', 48)}" in ${args.path || '.'}`;

    case 'exec': {
      const cmd = String(args.command || '?').replace(/\s+/g, ' ').trim();
      return `exec: ${truncate(cmd, 90)}`;
    }

    case 'vault_search':
      return `vault_search "${truncate(args.query || '?', 48)}"`;

    default:
      return name;
  }
}
```

---

### `src/progress/agent-hooks.ts`

```ts
// src/progress/agent-hooks.ts
import type { AgentHooks } from '../agent.js';

/**
 * Chain multiple AgentHooks into one, calling each handler in order.
 * Frontends can keep their existing hook logic and just add progress hooks.
 */
export function chainAgentHooks(...items: Array<AgentHooks | undefined | null>): AgentHooks {
  const hooks = items.filter(Boolean) as AgentHooks[];
  if (hooks.length === 0) return {};

  const chain = <K extends keyof AgentHooks>(key: K) => {
    const fns = hooks.map((h) => h[key]).filter(Boolean) as Array<(...args: any[]) => any>;
    if (!fns.length) return undefined;

    return (...args: any[]) => {
      for (const fn of fns) {
        try {
          fn(...args);
        } catch (e) {
          // Never let UI progress crash the agent turn.
          if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
            console.warn(`[progress] chained hook ${String(key)} threw:`, e);
          }
        }
      }
    };
  };

  return {
    onToken: chain('onToken'),
    onFirstDelta: chain('onFirstDelta'),
    onToolCall: chain('onToolCall'),
    onToolResult: chain('onToolResult'),
    onTurnEnd: chain('onTurnEnd'),
  };
}
```

---

### `src/progress/turn-progress.ts`

This is the reusable “heartbeat + phase” engine.

```ts
// src/progress/turn-progress.ts
import type { AgentHooks } from '../agent.js';
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

function truncate(s: string, n: number): string {
  if (n <= 0) return '';
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}

export function formatStatusLine(snap: Pick<TurnProgressSnapshot, 'phase' | 'elapsedBucketMs' | 'activeTool'>): string {
  const total = formatElapsed(snap.elapsedBucketMs);

  if (snap.phase === 'tool' && snap.activeTool) {
    const tool = formatElapsed(snap.activeTool.elapsedBucketMs);
    return truncate(`🔧 ${snap.activeTool.summary} (${tool} tool, ${total} total)`, 160);
  }

  if (snap.phase === 'responding') return `✍️ Writing response (${total})`;
  return `⏳ Thinking (${total})`;
}

/**
 * Shared progress tracker:
 * - attaches to AgentHooks
 * - keeps "phase" state
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

  private timer: NodeJS.Timeout | null = null;
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
    this.toolSummary = opts?.toolCallSummary ?? ((c) => formatToolCallSummary({ name: c.name, args: c.args as any }));

    this.hooks = {
      onFirstDelta: () => this.onFirstDelta(),
      onToken: (_t: string) => this.onToken(),
      onToolCall: (c: ToolCallEvent) => this.onToolCall(c),
      onToolResult: (r: ToolResultEvent) => this.onToolResult(r),
      onTurnEnd: (s: TurnEndEvent) => this.onTurnEnd(s),
    };
  }

  start(): void {
    const now = this.nowFn();
    this.startedAt = now;
    this.lastActivityAt = now;
    this.phase = 'thinking';
    this.activeTool = null;
    this.toolLines = [];
    this.lastToolLine = '';
    this.lastToolRepeat = 0;
    this.manualLine = null;

    this.emit('init', true);

    this.timer = setInterval(() => {
      this.emit('heartbeat', false);
    }, this.heartbeatMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emit('stop', true);
  }

  /** Optional: set a temporary “banner”/manual status (e.g., watchdog / compaction). */
  setManualStatus(text: string | null, phase?: TurnProgressPhase): void {
    this.manualLine = text && text.trim() ? text.trim() : null;
    if (phase) this.phase = phase;
    this.emit('manual', true);
  }

  snapshot(reason: TurnProgressReason = 'heartbeat'): TurnProgressSnapshot {
    const now = this.nowFn();
    const elapsedMs = Math.max(0, now - this.startedAt);
    const elapsedBucketMs = Math.floor(elapsedMs / this.bucketMs) * this.bucketMs;

    const sinceLastActivityMs = Math.max(0, now - this.lastActivityAt);

    const activeTool = this.activeTool
      ? (() => {
          const toolElapsedMs = Math.max(0, now - this.activeTool!.startedAt);
          const toolElapsedBucketMs = Math.floor(toolElapsedMs / this.bucketMs) * this.bucketMs;
          return {
            name: this.activeTool!.name,
            summary: this.activeTool!.summary,
            startedAt: this.activeTool!.startedAt,
            elapsedMs: toolElapsedMs,
            elapsedBucketMs: toolElapsedBucketMs,
          };
        })()
      : undefined;

    const statusLine = this.manualLine
      ? truncate(`${this.manualLine} (${formatElapsed(elapsedBucketMs)})`, 160)
      : formatStatusLine({ phase: this.phase, elapsedBucketMs, activeTool });

    return {
      phase: this.phase,
      reason,
      startedAt: this.startedAt,
      now,
      elapsedMs,
      elapsedBucketMs,
      sinceLastActivityMs,
      statusLine,
      toolLines: [...this.toolLines],
      activeTool,
      lastTurnEnd: this.lastTurnEnd,
    };
  }

  // ─────────────────────────────────────────────────────────────

  private markActivity(): void {
    this.lastActivityAt = this.nowFn();
    // Once real activity happens, clear any manual banner.
    this.manualLine = null;
  }

  private emit(reason: TurnProgressReason, force: boolean): void {
    const snap = this.snapshot(reason);

    // Only emit when the rendered line changes unless force is true.
    if (!force && snap.statusLine === this.lastRenderedLine) return;

    this.lastRenderedLine = snap.statusLine;

    try {
      void Promise.resolve(this.sink(snap)).catch((e) => {
        if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
          console.warn('[progress] sink failed:', e?.message ?? e);
        }
      });
    } catch (e: any) {
      if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
        console.warn('[progress] sink threw:', e?.message ?? e);
      }
    }
  }

  private pushToolLine(line: string): void {
    if (this.maxToolLines <= 0) return;

    if (line === this.lastToolLine && this.toolLines.length > 0) {
      this.lastToolRepeat += 1;
      this.toolLines[this.toolLines.length - 1] = `${line} (x${this.lastToolRepeat + 1})`;
      return;
    }

    this.lastToolLine = line;
    this.lastToolRepeat = 0;
    this.toolLines.push(line);

    if (this.toolLines.length > this.maxToolLines) {
      this.toolLines = this.toolLines.slice(this.toolLines.length - this.maxToolLines);
    }
  }

  private replaceLastToolLine(line: string): void {
    if (this.toolLines.length === 0) {
      this.pushToolLine(line);
      return;
    }
    this.toolLines[this.toolLines.length - 1] = line;
  }

  private onFirstDelta(): void {
    this.markActivity();
    if (this.phase !== 'responding') {
      this.phase = 'responding';
      this.emit('first_delta', true);
    }
  }

  private onToken(): void {
    // Called for every token; we only emit when phase changes.
    this.markActivity();
    if (this.phase !== 'responding') {
      this.phase = 'responding';
      this.emit('first_delta', true);
    }
  }

  private onToolCall(call: ToolCallEvent): void {
    this.markActivity();
    const summary = this.toolSummary(call);

    this.phase = 'tool';
    this.activeTool = { name: call.name, summary, startedAt: this.nowFn() };
    this.pushToolLine(`◆ ${summary}...`);

    this.emit('tool_call', true);
  }

  private onToolResult(result: ToolResultEvent): void {
    this.markActivity();

    this.activeTool = null;
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
```

This is the heart of “frequent status returns” in a reusable way.

---

## 2) TUI integration (status line without spam)

### Add a status field + events

#### `src/tui/types.ts` (add field)

Add to `TuiState`:

```ts
// add to TuiState
statusText?: string;
```

#### `src/tui/events.ts` (add events)

Add:

```ts
| { type: "STATUS_SET"; text: string }
| { type: "STATUS_CLEAR" }
```

#### `src/tui/state.ts` (handle them)

In `createInitialTuiState()`:

```ts
statusText: undefined,
```

In reducer:

```ts
case "STATUS_SET":
  return { ...state, statusText: ev.text };

case "STATUS_CLEAR":
  return { ...state, statusText: undefined };
```

### Render it

In `src/tui/render.ts`, you currently choose between last alert vs “ready” on that third line.
Modify that logic to prefer **warn/error alerts**, otherwise show `statusText` if present:

```ts
// existing: const alert = state.alerts[state.alerts.length - 1];
const alert = state.alerts[state.alerts.length - 1];
const statusText = state.statusText;

// Prefer warn/error alerts
const showAlert = alert && (alert.level === 'warn' || alert.level === 'error');
const lineText =
  showAlert ? `[${alert!.level}] ${alert!.text}`
  : statusText ? statusText
  : alert ? `[${alert.level}] ${alert.text}`
  : 'ready';
```

Then render with your `placeRight(...)` and coloring as you already do.

### Drive it from the shared controller

In `src/tui/controller.ts`, in the `submitInput(...)` block around `session.ask(...)`, create a progress controller:

```ts
import { TurnProgressController } from '../progress/turn-progress.js';
import { chainAgentHooks } from '../progress/agent-hooks.js';
import { formatToolCallSummary } from '../progress/tool-summary.js'; // optional if you want consistent summaries
```

Then:

```ts
const progress = new TurnProgressController(
  (snap) => {
    // One line, stable, bucketed
    this.dispatch({ type: 'STATUS_SET', text: snap.statusLine });
  },
  {
    heartbeatMs: 1000,
    bucketMs: 5000,
    maxToolLines: 0, // TUI already shows tool events; keep status minimal
    toolCallSummary: (c) => formatToolCallSummary({ name: c.name, args: c.args as any }),
  }
);

progress.start();

try {
  const uiHooks: AgentHooks = {
    onToken: (t) => {
      this.lastProgressAt = Date.now();
      watchdogGraceUsed = 0;
      this.dispatch({ type: 'AGENT_STREAM_TOKEN', id, token: t });
    },
    onToolCall: (c) => {
      this.lastProgressAt = Date.now();
      watchdogGraceUsed = 0;
      this.dispatch({ type: 'TOOL_START', id: `${c.name}-${Date.now()}`, name: c.name, detail: JSON.stringify(c.args).slice(0, 120) });
    },
    onToolResult: async (r) => {
      this.lastProgressAt = Date.now();
      watchdogGraceUsed = 0;
      this.dispatch({ type: r.success ? 'TOOL_END' : 'TOOL_ERROR', id: `${r.name}-${Date.now()}`, name: r.name, detail: r.summary });
    },
    onTurnEnd: () => {
      this.lastProgressAt = Date.now();
      watchdogGraceUsed = 0;
    },
  };

  const hooks = chainAgentHooks(uiHooks, progress.hooks);

  await this.session.ask(askText, { ...hooks, signal: attemptController.signal });
} finally {
  progress.stop();
  this.dispatch({ type: 'STATUS_CLEAR' });
}
```

Result in TUI: even if no tokens for 30–60s, the status line updates every 5s bucket:

* `⏳ Thinking (10s)`
* `⏳ Thinking (15s)`
* `🔧 read_file src/agent.ts (5s tool, 20s total)`
  …etc.

---

## 3) Telegram integration (no more “static ⏳ Thinking...”)

Your Telegram bot already has `StreamingMessage` and a periodic edit loop, but **it doesn’t change text while waiting for first token**, so edits skip.

Inject the shared progress controller into `StreamingMessage` so the placeholder text becomes time-varying (bucketed), which triggers edits.

Inside `src/bot/telegram.ts`, in `StreamingMessage`:

### Add imports

```ts
import { TurnProgressController } from '../progress/turn-progress.js';
import { chainAgentHooks } from '../progress/agent-hooks.js'; // optional, but handy if you want
// formatToolCallSummary already exists; ideally re-export from progress/tool-summary for consistency
```

### Add fields

```ts
private statusLine = '⏳ Thinking...';
private progress: TurnProgressController;
```

### Instantiate in constructor

```ts
constructor(...) {
  ...
  this.progress = new TurnProgressController(
    (snap) => { this.statusLine = snap.statusLine; },
    {
      heartbeatMs: 1000,
      bucketMs: 5000,         // edits at most every 5s when idle
      maxToolLines: 8,        // optional; you already keep tool lines
      toolCallSummary: (c) => formatToolCallSummary(c),
    }
  );
}
```

### Start/stop it

In `init()` after you send the placeholder:

```ts
await this.bot.api.sendMessage(... '⏳ Thinking...' ...);
this.progress.start();
this.startEditLoop();
```

In `finalize()` and `finalizeError()`:

```ts
this.progress.stop();
```

### Forward tool/tokens into the progress controller

```ts
onToken(token: string): void {
  this.buffer += token;
  this.progress.hooks.onToken?.(token);
}

onToolCall(call: ToolCallEvent): void {
  this.progress.hooks.onToolCall?.(call);
  ...
}

onToolResult(result: ToolResultEvent): void {
  this.progress.hooks.onToolResult?.(result);
  ...
}
```

### Use the status line in `render()` when buffer is empty

Replace:

```ts
if (!out.trim()) { out = '⏳ Thinking...'; }
```

with:

```ts
if (!out.trim()) {
  // bucketed string changes every 5s → edit loop will actually send updates
  out = escapeHtml(this.statusLine);
}
```

Also, if you want toolLines + status when there are tool lines but no assistant output:

```ts
if (this.toolLines.length && !this.buffer.trim()) {
  out = `${escapeHtml(this.toolLines.join('\n'))}\n\n${escapeHtml(this.statusLine)}`;
}
```

Now Telegram will visibly update while waiting:

* `⏳ Thinking (10s)`
* `⏳ Thinking (15s)`
* `🔧 exec: npm test (10s tool, 25s total)`
  etc — without any new bot-specific logic beyond “display the shared statusLine”.

---

## 4) Discord integration (stream edits like Telegram, using the same core)

Discord currently buffers `streamed += t` but **never edits** until the end. Add a small helper that:

* edits placeholder every `edit_interval_ms`
* shows tool lines + partial answer OR status line if empty
* uses the shared `TurnProgressController`

### Add new file: `src/bot/discord-streaming.ts`

```ts
// src/bot/discord-streaming.ts
import type { Message, TextBasedChannel } from 'discord.js';
import type { AgentHooks } from '../agent.js';
import type { ToolCallEvent, ToolResultEvent, TurnEndEvent } from '../types.js';
import { TurnProgressController } from '../progress/turn-progress.js';
import { formatToolCallSummary } from '../progress/tool-summary.js';
import { splitDiscord, safeContent } from './discord-routing.js';

type Opts = {
  editIntervalMs?: number;
  statusBucketMs?: number;
  maxToolLines?: number;
  maxEditChars?: number; // default 2000
};

export class DiscordStreamingMessage {
  private buffer = '';
  private banner: string | null = null;

  private statusLine = '⏳ Thinking...';
  private editTimer: NodeJS.Timeout | null = null;
  private typingTimer: NodeJS.Timeout | null = null;

  private lastEditText = '';
  private finalized = false;
  private backoffUntil = 0;

  private progress: TurnProgressController;

  constructor(
    private readonly placeholder: Message | null,
    private readonly channel: TextBasedChannel,
    private readonly opts: Opts = {}
  ) {
    this.progress = new TurnProgressController(
      (snap) => { this.statusLine = snap.statusLine; },
      {
        heartbeatMs: 1000,
        bucketMs: opts.statusBucketMs ?? 5000,
        maxToolLines: opts.maxToolLines ?? 6,
        toolCallSummary: (c) => formatToolCallSummary({ name: c.name, args: c.args as any }),
      }
    );
  }

  start(): void {
    this.progress.start();

    // Discord typing indicator expires; refresh periodically.
    this.sendTyping();
    this.typingTimer = setInterval(() => this.sendTyping(), 8_000);

    const interval = Math.max(400, this.opts.editIntervalMs ?? 1200);
    this.editTimer = setInterval(() => { void this.flush(); }, interval);
  }

  stop(): void {
    this.progress.stop();
    if (this.editTimer) clearInterval(this.editTimer);
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.editTimer = null;
    this.typingTimer = null;
  }

  setBanner(text: string | null): void {
    this.banner = text && text.trim() ? text.trim() : null;
  }

  hooks(): AgentHooks {
    return {
      onFirstDelta: () => this.progress.hooks.onFirstDelta?.(),
      onToken: (t: string) => this.onToken(t),
      onToolCall: (c: ToolCallEvent) => this.onToolCall(c),
      onToolResult: (r: ToolResultEvent) => this.onToolResult(r),
      onTurnEnd: (s: TurnEndEvent) => this.progress.hooks.onTurnEnd?.(s),
    };
  }

  private sendTyping(): void {
    // best-effort
    (this.channel as any).sendTyping?.().catch?.(() => {});
  }

  private onToken(t: string): void {
    this.buffer += t;
    this.progress.hooks.onToken?.(t);
  }

  private onToolCall(call: ToolCallEvent): void {
    this.progress.hooks.onToolCall?.(call);
  }

  private onToolResult(result: ToolResultEvent): void {
    this.progress.hooks.onToolResult?.(result);
  }

  private renderForEdit(maxChars: number): string {
    const snap = this.progress.snapshot('heartbeat');
    const toolLines = snap.toolLines;

    let out = '';
    if (this.banner) out += `${this.banner}\n\n`;
    if (toolLines.length) out += `${toolLines.join('\n')}\n\n`;

    if (this.buffer.trim()) out += this.buffer;
    else out += this.statusLine;

    out = safeContent(out || '');

    if (out.length > maxChars) {
      out = out.slice(0, Math.max(0, maxChars - 1)) + '…';
    }
    return out;
  }

  private async flush(): Promise<void> {
    if (!this.placeholder || this.finalized) return;
    const now = Date.now();
    if (now < this.backoffUntil) return;

    const maxChars = this.opts.maxEditChars ?? 2000;
    const text = this.renderForEdit(maxChars);
    if (!text || text === this.lastEditText) return;

    this.lastEditText = text;
    try {
      await this.placeholder.edit(text);
    } catch (e: any) {
      // discord.js usually handles rate limits internally, but keep a defensive backoff.
      const msg = String(e?.message ?? e ?? '');
      if (/rate limit|429/i.test(msg)) {
        this.backoffUntil = Date.now() + 5_000;
      }
    }
  }

  async finalize(finalText: string): Promise<void> {
    this.finalized = true;
    this.stop();

    const snap = this.progress.snapshot('stop');
    const toolLines = snap.toolLines.slice(-8); // don't spam

    const combined = safeContent(
      (toolLines.length ? toolLines.join('\n') + '\n\n' : '') + (finalText ?? '')
    );

    const chunks = splitDiscord(combined);
    if (this.placeholder && chunks.length > 0) {
      await this.placeholder.edit(chunks[0]).catch(() => {});
    } else if (chunks.length > 0) {
      await (this.channel as any).send(chunks[0]).catch(() => {});
    }

    for (let i = 1; i < chunks.length && i < 10; i++) {
      await (this.channel as any).send(chunks[i]).catch(() => {});
    }
    if (chunks.length > 10) {
      await (this.channel as any).send('[truncated — response too long]').catch(() => {});
    }
  }

  async finalizeError(errMsg: string): Promise<void> {
    this.finalized = true;
    this.stop();

    const snap = this.progress.snapshot('stop');
    const toolLines = snap.toolLines.slice(-8);

    const combined = safeContent(
      (toolLines.length ? toolLines.join('\n') + '\n\n' : '') + `❌ ${errMsg}`
    );

    const chunks = splitDiscord(combined);
    if (this.placeholder && chunks.length > 0) {
      await this.placeholder.edit(chunks[0]).catch(() => {});
    } else if (chunks.length > 0) {
      await (this.channel as any).send(chunks[0]).catch(() => {});
    }
  }
}
```

### Modify `src/bot/discord.ts` to use it

At top:

```ts
import { DiscordStreamingMessage } from './discord-streaming.js';
import { chainAgentHooks } from '../progress/agent-hooks.js';
```

In `processMessage(...)`, replace the “streamed += t” logic with:

```ts
const placeholder = await sendUserVisible(msg, '⏳ Thinking...').catch(() => null);

const streamer = new DiscordStreamingMessage(
  placeholder,
  msg.channel,
  { editIntervalMs: botConfig.edit_interval_ms ?? 1200 }
);
streamer.start();

let watchdogCompactPending = false;
let watchdogGraceUsed = 0;
let watchdogForcedCancel = false;

const baseHooks: AgentHooks = {
  onToken: () => {
    if (!isTurnActive(managed, turnId)) return;
    markProgress(managed, turnId);
    watchdogGraceUsed = 0;
  },
  onToolCall: () => {
    if (!isTurnActive(managed, turnId)) return;
    markProgress(managed, turnId);
    watchdogGraceUsed = 0;
  },
  onToolResult: () => {
    if (!isTurnActive(managed, turnId)) return;
    markProgress(managed, turnId);
    watchdogGraceUsed = 0;
  },
  onTurnEnd: () => {
    if (!isTurnActive(managed, turnId)) return;
    markProgress(managed, turnId);
    watchdogGraceUsed = 0;
  },
};

const hooks = chainAgentHooks(baseHooks, streamer.hooks());
```

Then when calling ask:

```ts
const result = await managed.session.ask(askText, { ...hooks, signal: attemptController.signal });
const finalText = safeContent(result.text);
await streamer.finalize(finalText);
```

For error paths:

```ts
await streamer.finalizeError(errMsg);
```

For watchdog “still working” messaging, instead of editing placeholder directly:

```ts
streamer.setBanner('⏳ Still working… model is taking longer than usual.');
```

And for compaction retry:

```ts
streamer.setBanner(`🧠 Context too large — compacting and retrying (attempt ${managed.watchdogCompactAttempts}/${maxWatchdogCompacts})…`);
```

Because the streamer owns edits, you avoid races where two different code paths fight over `placeholder.edit(...)`.

---

## 5) Why this solves your UX pain

* **TUI**: statusText updates even before first token; no more “silent pause”.
* **Telegram**: placeholder is no longer static; it changes every bucket (e.g., 5s) while idle → edit loop actually edits → user sees progress.
* **Discord**: placeholder is edited periodically with tool lines + partial output/status; users get updates instead of waiting for the final response.

All three share:

* `TurnProgressController` (phase + heartbeat)
* `formatToolCallSummary` (consistent tool wording)
* `chainAgentHooks` (easy integration without refactoring your existing hook logic)

---

## Optional next-level improvement (worth it)

If you want “status during long `exec`” (e.g., `npm test` runs 2 minutes), the next step is:

* Add `ToolContext.onExecChunk?: (chunk: string) => void`
* In `tools.exec`, push output chunks (capped + throttled)
* Emit a `ToolResultEvent`-like “tool_stream” hook to the UI

Then your status line can show:
`🔧 exec: npm test (running… last output: “FAIL src/foo.test.ts:123”)`

This is more invasive, but very implementable with the same architecture: you’d just feed `onExecChunk` into the same streamer (banner or toolLines tail).

---

# Sketch of the minimal “tool streaming” changes (`tools.exec` + new hook type + how to display a tail in each UI) using the same modular pattern above.
Below is a minimal, end-to-end “tool streaming” sketch that:

1. adds a new hook/event (`ToolStreamEvent` + `AgentHooks.onToolStream`)
2. wires it through `createSession.ask()` → tool dispatch → `ToolContext`
3. makes **`tools.exec` emit throttled stdout/stderr chunks** while the process runs
4. shows a **tail** (last N lines) in **TUI**, **Telegram**, and **Discord**, with a **shared tail buffer** (so the UIs aren’t duplicating parsing/line-capping logic)

I’m keeping this intentionally “smallest plausible surface area” so you can extend later (e.g., streaming for MCP tools, LSP, downloads, etc.).

---

## 1) New event type: `ToolStreamEvent`

### `src/types.ts` (add)

```ts
export type ToolStreamEvent = {
  /** tool call id (same as ToolCallEvent.id / ToolResultEvent.id) */
  id: string;
  /** tool name (e.g. "exec") */
  name: string;
  /** where the chunk came from */
  stream: 'stdout' | 'stderr';
  /** text chunk (UTF-8, already safe to display; ANSI stripped recommended) */
  chunk: string;
};
```

---

## 2) Agent hook: `onToolStream`, and wiring into tool execution

### `src/agent.ts` (modify `AgentHooks`)

Add the hook:

```ts
export type AgentHooks = {
  signal?: AbortSignal;
  onToken?: (t: string) => void;
  onFirstDelta?: () => void;
  onToolCall?: (call: ToolCallEvent) => void;
  onToolResult?: (result: ToolResultEvent) => void | Promise<void>;
  onToolStream?: (ev: ToolStreamEvent) => void | Promise<void>;
  onTurnEnd?: (stats: TurnEndEvent) => void | Promise<void>;
};
```

Also update the imports at the top of `agent.ts` to include `ToolStreamEvent` from `./types.js`.

### Wire it during tool dispatch (core idea)

Wherever you currently call built-in tools like:

```ts
const value = await builtInFn(ctx as any, args);
```

wrap the base ctx into a per-call context that includes the tool id/name and a streaming emitter:

```ts
const emitToolStream = (ev: ToolStreamEvent): void => {
  try {
    hookObj.onToolStream?.(ev);
  } catch {}
  // Optional: if you want plugins to see it, add a hookManager event as well.
  // If you do, also update src/hooks/types.ts and manager redaction (see §3.5).
  try {
    void hookManager?.emit('tool_stream' as any, { askId, turn: turns, stream: ev });
  } catch {}
};

const callCtx = {
  ...ctx,
  toolCallId: callId,
  toolName: name,
  onToolStream: emitToolStream,
};

const value = await builtInFn(callCtx as any, args);
```

The only requirement is: `ToolContext` must accept `toolCallId`, `toolName`, and `onToolStream` (next section), and `tools.exec` must use them.

---

## 3) ToolContext additions + `tools.exec` streaming

### 3.1 `src/tools.ts`: extend `ToolContext`

Add these optional fields:

```ts
export type ToolContext = {
  cwd: string;
  noConfirm: boolean;
  dryRun: boolean;
  mode?: 'code' | 'sys';
  backupDir?: string;
  maxExecBytes?: number;
  maxExecCaptureBytes?: number;
  maxBackupsPerFile?: number;
  confirm?: (prompt: string, ctx?: { tool?: string; args?: Record; diff?: string }) => Promise<boolean>;
  replay?: ReplayStore;
  vault?: VaultStore;
  lens?: LensStore;
  signal?: AbortSignal;
  lastEditedPath?: string;
  onMutation?: (absPath: string) => void;

  /** NEW: assigned per-tool-call by agent */
  toolCallId?: string;
  toolName?: string;

  /** NEW: tool output streaming hook (don’t await inside exec) */
  onToolStream?: (ev: import('./types.js').ToolStreamEvent) => void | Promise<void>;

  /**
   * NEW: optional throttling knobs (safe defaults in tools.exec)
   * - interval controls UI update cadence
   * - chunk chars controls how much text per event
   */
  toolStreamIntervalMs?: number;
  toolStreamMaxChunkChars?: number;
  toolStreamMaxBufferChars?: number;
};
```

### 3.2 `src/tools.ts`: import the new type

At the top:

```ts
import { ExecResult, type ToolStreamEvent } from './types.js';
```

### 3.3 `src/tools.ts`: minimal streaming emitter inside `exec`

Right before you attach stdout/stderr listeners, add a small throttled streamer.

This is written to be **fire-and-forget** (never `await` inside the hot path), and it always sends the **tail** of the buffered output (so UIs can show “latest”).

```ts
function safeFireAndForget(fn: (() => void | Promise<void>) | undefined): void {
  if (!fn) return;
  try {
    const r = fn();
    if (r && typeof (r as any).catch === 'function') (r as any).catch(() => {});
  } catch {}
}

function makeExecStreamer(ctx: ToolContext) {
  const cb = ctx.onToolStream;
  if (!cb) return null;

  const id = ctx.toolCallId ?? '';
  const name = ctx.toolName ?? 'exec';

  const intervalMs = Math.max(50, Math.floor(ctx.toolStreamIntervalMs ?? 750));
  const maxChunkChars = Math.max(80, Math.floor(ctx.toolStreamMaxChunkChars ?? 900));
  const maxBufferChars = Math.max(maxChunkChars, Math.floor(ctx.toolStreamMaxBufferChars ?? 12_000));

  let outBuf = '';
  let errBuf = '';
  let lastEmit = 0;
  let timer: NodeJS.Timeout | null = null;

  const emit = (stream: 'stdout' | 'stderr', chunk: string) => {
    const trimmed = chunk.length > maxChunkChars ? chunk.slice(-maxChunkChars) : chunk;
    const ev: ToolStreamEvent = { id, name, stream, chunk: trimmed };
    safeFireAndForget(() => cb(ev));
  };

  const flush = (force = false) => {
    if (!cb) return;
    const now = Date.now();
    if (!force && now - lastEmit < intervalMs) {
      schedule();
      return;
    }
    lastEmit = now;

    if (outBuf) {
      emit('stdout', outBuf);
      outBuf = '';
    }
    if (errBuf) {
      emit('stderr', errBuf);
      errBuf = '';
    }
  };

  const schedule = () => {
    if (timer) return;
    const delay = Math.max(0, intervalMs - (Date.now() - lastEmit));
    timer = setTimeout(() => {
      timer = null;
      flush(false);
    }, delay);
  };

  const push = (stream: 'stdout' | 'stderr', textRaw: string) => {
    // Normalize carriage returns so progress bars “advance” instead of overwriting.
    const text = stripAnsi(textRaw).replace(/\r/g, '\n');
    if (!text) return;

    if (stream === 'stdout') outBuf += text;
    else errBuf += text;

    if (outBuf.length > maxBufferChars) outBuf = outBuf.slice(-maxBufferChars);
    if (errBuf.length > maxBufferChars) errBuf = errBuf.slice(-maxBufferChars);

    schedule();
  };

  const done = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flush(true);
  };

  return { push, done };
}
```

### 3.4 `src/tools.ts`: use it in the non-PTY exec path

In your `exec` function, after creating `child` and the `pushCapped` helper, set up streaming:

```ts
const streamer = makeExecStreamer(ctx);

child.stdout.on('data', (d) => {
  pushCapped(outChunks, d, 'out');
  streamer?.push('stdout', d.toString('utf8'));
});

child.stderr.on('data', (d) => {
  pushCapped(errChunks, d, 'err');
  streamer?.push('stderr', d.toString('utf8'));
});
```

And after the child closes (right after you clear timers / remove abort listener), flush the last chunk:

```ts
streamer?.done();
```

### 3.5 Optional: also expose streaming to hook plugins

If you want plugins to observe tool streaming, you should *actually* add it to hook typing and redact it when the plugin lacks `read_tool_results`.

**`src/hooks/types.ts`**: add to `HookEventMap`:

```ts
import type { ToolCallEvent, ToolResultEvent, TurnEndEvent, ToolStreamEvent } from '../types.js';

export type HookEventMap = {
  // ...
  tool_stream: { askId: string; turn: number; stream: ToolStreamEvent };
};
```

**`src/hooks/manager.ts`**: redact `tool_stream` if missing capability:

```ts
if (event === 'tool_stream' && !caps.has('read_tool_results')) {
  if (out.stream && typeof out.stream === 'object') {
    out.stream.chunk = '[redacted: missing read_tool_results capability]';
  }
}
```

If you don’t care about plugins seeing streaming output right now, skip this entirely.

---

## 4) Shared tail buffer (reused by TUI + Telegram + Discord)

This keeps the “tail rendering logic” in one place.

### `src/progress/tool-tail.ts` (new)

```ts
import type { ToolStreamEvent } from '../types.js';

export type ToolTailSnapshot = {
  id: string;
  name: string;
  stream: 'stdout' | 'stderr';
  lines: string[];
  updatedAt: number;
};

type TailState = {
  name: string;
  stream: 'stdout' | 'stderr';
  buf: string;
  updatedAt: number;
};

export class ToolTailBuffer {
  private byId = new Map<string, TailState>();
  private readonly maxChars: number;
  private readonly maxLines: number;

  constructor(opts?: { maxChars?: number; maxLines?: number }) {
    this.maxChars = Math.max(256, Math.floor(opts?.maxChars ?? 4096));
    this.maxLines = Math.max(1, Math.floor(opts?.maxLines ?? 4));
  }

  reset(id: string, name: string): void {
    this.byId.set(id, { name, stream: 'stdout', buf: '', updatedAt: Date.now() });
  }

  clear(id: string): void {
    this.byId.delete(id);
  }

  push(ev: ToolStreamEvent): ToolTailSnapshot | null {
    if (!ev?.id) return null;

    const cur =
      this.byId.get(ev.id) ??
      ({ name: ev.name ?? 'tool', stream: ev.stream, buf: '', updatedAt: 0 } satisfies TailState);

    cur.name = ev.name ?? cur.name;
    cur.stream = ev.stream === 'stderr' ? 'stderr' : 'stdout';
    cur.updatedAt = Date.now();

    cur.buf += (ev.chunk ?? '').replace(/\r/g, '\n');
    if (cur.buf.length > this.maxChars) cur.buf = cur.buf.slice(-this.maxChars);

    this.byId.set(ev.id, cur);
    return this.get(ev.id);
  }

  get(id: string): ToolTailSnapshot | null {
    const cur = this.byId.get(id);
    if (!cur) return null;

    const rawLines = cur.buf.split(/\r?\n/);
    const lines = rawLines.filter((l) => l.trim().length > 0).slice(-this.maxLines);

    return {
      id,
      name: cur.name,
      stream: cur.stream,
      lines,
      updatedAt: cur.updatedAt,
    };
  }
}
```

---

## 5) UI: show a tail in each interface

### 5.1 TUI

Goal: show *something* while tools run, without flooding transcript.

Minimal UX: update the current “running tool” line with `— <last output line>`.

#### a) Add a new TUI event for tail updates

**`src/tui/events.ts`**: add to `TuiEvent` union:

```ts
| { type: "TOOL_TAIL"; id: string; tail: string }
```

#### b) Handle it in reducer

**`src/tui/state.ts`**: add a case:

```ts
case "TOOL_TAIL": {
  // Update the most recent TOOL_START for that id (don’t append new events).
  const idxFromEnd = [...state.toolEvents].reverse().findIndex(
    (e) => e.id === ev.id && e.phase === "start"
  );
  if (idxFromEnd < 0) return state;

  const idx = state.toolEvents.length - 1 - idxFromEnd;
  const toolEvents = state.toolEvents.map((t, i) =>
    i === idx ? { ...t, detail: ev.tail } : t
  );
  return { ...state, toolEvents };
}
```

#### c) Render the tail (small tweak)

**`src/tui/render.ts`**: tweak `formatToolUsage`:

```ts
function formatToolUsage(e: ToolEvent): string {
  const durationMs = typeof e.durationMs === 'number' ? e.durationMs : Math.max(0, Date.now() - e.ts);
  const icon = e.phase === 'error' ? `${C.red}✗${C.reset}` : e.phase === 'end' ? `${C.green}✓${C.reset}` : `${C.yellow}⠋${C.reset}`;
  const base = `${icon} ${e.name} (${secs(durationMs)})`;
  if (e.phase === 'start' && e.detail) return `${base} — ${truncate(e.detail, 70)}`;
  return base;
}
```

#### d) Wire `onToolStream` in controller (reuse shared `ToolTailBuffer`)

**`src/tui/controller.ts`**: import and use:

```ts
import { ToolTailBuffer } from "../progress/tool-tail.js";
```

Inside the ask loop, create one buffer:

```ts
const tails = new ToolTailBuffer({ maxChars: 4096, maxLines: 4 });
let activeToolId: string | null = null;
```

Then update hooks:

```ts
onToolCall: (c) => {
  this.lastProgressAt = Date.now();
  watchdogGraceUsed = 0;

  activeToolId = c.id;
  tails.reset(c.id, c.name);

  this.dispatch({
    type: "TOOL_START",
    id: c.id,                 // IMPORTANT: use tool call id
    name: c.name,
    detail: JSON.stringify(c.args).slice(0, 120),
  });
},

onToolStream: (ev) => {
  if (!activeToolId || ev.id !== activeToolId) return;
  const snap = tails.push(ev);
  const last = snap?.lines?.[snap.lines.length - 1];
  if (last) {
    this.dispatch({ type: "TOOL_TAIL", id: ev.id, tail: last });
  }
},

onToolResult: async (r) => {
  this.lastProgressAt = Date.now();
  watchdogGraceUsed = 0;

  if (activeToolId === r.id) {
    activeToolId = null;
    tails.clear(r.id);
  }

  this.dispatch({
    type: r.success ? "TOOL_END" : "TOOL_ERROR",
    id: r.id,                 // IMPORTANT: use tool result id (same as call id)
    name: r.name,
    detail: r.summary,
  });
},
```

That’s enough for “tail while running” without spamming the transcript.

---

### 5.2 Telegram bot

Telegram already edits a “Thinking…” message. Add `onToolStream` and a tail block under the tool lines.

#### a) Import and store tail buffer

In `src/bot/telegram.ts`:

```ts
import { ToolTailBuffer } from '../progress/tool-tail.js';
import type { ToolStreamEvent } from '../types.js';
```

Inside `StreamingMessage`:

```ts
private tails = new ToolTailBuffer({ maxChars: 4096, maxLines: 4 });
private activeToolId: string | null = null;
```

#### b) Add `onToolStream`

```ts
onToolCall(call: ToolCallEvent): void {
  this.activeToolId = call.id;
  this.tails.reset(call.id, call.name);
  // existing toolLines logic...
}

onToolStream(ev: ToolStreamEvent): void {
  if (!this.activeToolId || ev.id !== this.activeToolId) return;
  this.tails.push(ev);
}

onToolResult(result: ToolResultEvent): void {
  if (this.activeToolId === result.id) {
    this.tails.clear(result.id);
    this.activeToolId = null;
  }
  // existing tool result logic...
}
```

#### c) Render the tail

In `render()` after toolLines:

```ts
if (this.activeToolId) {
  const tail = this.tails.get(this.activeToolId);
  if (tail?.lines?.length) {
    const label = tail.stream === 'stderr' ? 'stderr' : 'stdout';
    out += `<b>↳ ${escapeHtml(label)} tail</b>\n<pre>${escapeHtml(tail.lines.join('\n'))}</pre>\n\n`;
  }
}
```

That’s it: users will see the last few lines of `exec` output while the command is running.

---

### 5.3 Discord bot

Discord’s current flow (as of the code you have) doesn’t continuously edit the placeholder with progress. Minimal approach: introduce a tiny “edit loop” helper (same as Telegram concept) and show tool tail + partial model output.

Here’s the smallest self-contained pattern that won’t spam messages:

#### a) Add the helper (can live in `src/bot/discord.ts` or a small shared file)

```ts
import { ToolTailBuffer } from '../progress/tool-tail.js';
import type { ToolStreamEvent, ToolCallEvent, ToolResultEvent } from '../types.js';

class DiscordStreamingMessage {
  private buffer = '';
  private toolLines: string[] = [];
  private tails = new ToolTailBuffer({ maxChars: 4096, maxLines: 4 });
  private activeToolId: string | null = null;

  private timer: NodeJS.Timeout | null = null;
  private dirty = true;

  constructor(private placeholder: import('discord.js').Message, private editEveryMs: number) {}

  start() {
    this.timer = setInterval(() => void this.flush(), this.editEveryMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onToken(t: string) {
    this.buffer += t;
    this.dirty = true;
  }

  onToolCall(c: ToolCallEvent) {
    this.activeToolId = c.id;
    this.tails.reset(c.id, c.name);
    this.toolLines.push(`◆ ${c.name}…`);
    this.dirty = true;
  }

  onToolStream(ev: ToolStreamEvent) {
    if (!this.activeToolId || ev.id !== this.activeToolId) return;
    this.tails.push(ev);
    this.dirty = true;
  }

  onToolResult(r: ToolResultEvent) {
    const icon = r.success ? '✓' : '✗';
    // Replace last “◆ ...” if present
    if (this.toolLines.length) this.toolLines[this.toolLines.length - 1] = `${icon} ${r.name}: ${r.summary}`;
    if (this.activeToolId === r.id) {
      this.tails.clear(r.id);
      this.activeToolId = null;
    }
    this.dirty = true;
  }

  private render(): string {
    const parts: string[] = [];
    parts.push('⏳ Thinking…');

    if (this.toolLines.length) {
      parts.push('');
      parts.push(this.toolLines.slice(-6).join('\n'));
    }

    if (this.activeToolId) {
      const tail = this.tails.get(this.activeToolId);
      if (tail?.lines?.length) {
        const label = tail.stream === 'stderr' ? 'stderr' : 'stdout';
        parts.push('');
        parts.push(`\`\`\`${label}\n${tail.lines.join('\n')}\n\`\`\``);
      }
    }

    if (this.buffer.trim()) {
      // Keep placeholder short—Discord has message limits.
      const snippet = this.buffer.length > 1500 ? this.buffer.slice(-1500) : this.buffer;
      parts.push('');
      parts.push(snippet);
    }

    const out = parts.join('\n');
    return out.length > 1900 ? out.slice(0, 1900) + '…' : out;
  }

  private async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await this.placeholder.edit(this.render());
    } catch {
      // ignore (deleted message, perms, etc.)
    }
  }
}
```

#### b) Wire it into existing `processMessage` hooks

Where you currently do:

```ts
const placeholder = await sendUserVisible(msg, '⏳ Thinking...').catch(() => null);
let streamed = '';
const hooks: AgentHooks = { onToken: ..., onToolCall: ..., onToolResult: ... };
```

Replace with:

```ts
const placeholder = await sendUserVisible(msg, '⏳ Thinking...').catch(() => null);
const streamer = placeholder ? new DiscordStreamingMessage(placeholder, 1500) : null;
streamer?.start();

const hooks: AgentHooks = {
  onToken: (t) => {
    if (!isTurnActive(managed, turnId)) return;
    markProgress(managed, turnId);
    streamer?.onToken(t);
  },
  onToolCall: (c) => {
    if (!isTurnActive(managed, turnId)) return;
    markProgress(managed, turnId);
    streamer?.onToolCall(c);
  },
  onToolStream: (ev) => {
    if (!isTurnActive(managed, turnId)) return;
    markProgress(managed, turnId);
    streamer?.onToolStream(ev);
  },
  onToolResult: (r) => {
    if (!isTurnActive(managed, turnId)) return;
    markProgress(managed, turnId);
    streamer?.onToolResult(r);
  },
  onTurnEnd: () => {
    if (!isTurnActive(managed, turnId)) return;
    markProgress(managed, turnId);
  },
};

try {
  const result = await managed.session.ask(msg.content, hooks);
  streamer?.stop();
  // send final response normally...
} finally {
  streamer?.stop();
}
```

Now Discord gets the same “tail while tool runs” UX as Telegram, without chat spam.

---

## 6) Why this is “minimal” but extensible

* The only new cross-cutting concepts are:

  * `ToolStreamEvent`
  * `AgentHooks.onToolStream`
  * `ToolContext.onToolStream` + `toolCallId/toolName`

* Only **`exec`** streams for now. Later you can stream from:

  * MCP tool calls (if the MCP server supports progress callbacks)
  * long file ops (downloads, git clone, etc.)
  * LSP operations (progress notifications)

* The UI tail logic is centralized in `ToolTailBuffer` so all UIs behave consistently and you tune one place.

---

## 7) Tuning knobs you’ll likely want

You can tune without touching UIs:

* `ctx.toolStreamIntervalMs`

  * 500–1000ms is a sweet spot (Telegram edit limits; Discord rate limits)

* `ctx.toolStreamMaxChunkChars`

  * 600–1200 chars is usually enough

* `ToolTailBuffer(maxLines)`

  * 3–6 lines is enough for “what’s happening now”

If you want a config surface, you can expose these under `IdlehandsConfig` (e.g., `ui.tool_stream_interval_ms`, `ui.tool_tail_lines`) and set them when building `callCtx` inside the agent.

