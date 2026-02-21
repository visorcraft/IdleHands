import type { TextBasedChannel } from 'discord.js';
import type { AgentHooks } from '../agent.js';
import type { ToolCallEvent, ToolResultEvent, ToolStreamEvent, TurnEndEvent } from '../types.js';
import { splitDiscord, safeContent } from './discord-routing.js';
import { formatToolCallSummary } from '../progress/tool-summary.js';
import { TurnProgressController } from '../progress/turn-progress.js';
import { ToolTailBuffer } from '../progress/tool-tail.js';
import { ProgressMessageRenderer } from '../progress/progress-message-renderer.js';
import { renderDiscordMarkdown } from '../progress/serialize-discord.js';

export class DiscordStreamingMessage {
  private buffer = '';
  private toolLines: string[] = [];
  private lastToolLine = '';
  private lastToolRepeat = 0;

  private statusLine = '⏳ Thinking...';
  private banner: string | null = null;

  private tails = new ToolTailBuffer({ maxChars: 4096, maxLines: 4 });
  private activeToolId: string | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private dirty = true;
  private finalized = false;

  private progress = new TurnProgressController(
    (snap) => {
      this.statusLine = snap.statusLine;
      this.dirty = true;
    },
    {
      heartbeatMs: 1000,
      bucketMs: 5000,
      maxToolLines: 8,
      toolCallSummary: (c) => formatToolCallSummary({ name: c.name, args: c.args as any }),
    },
  );

  private renderer = new ProgressMessageRenderer({
    maxToolLines: 6,
    maxTailLines: 4,
    maxAssistantChars: 1400,
  });

  constructor(
    private readonly placeholder: any | null,
    private readonly channel: TextBasedChannel,
    private readonly opts?: { editIntervalMs?: number },
  ) {}

  start(): void {
    if (this.timer) return;
    this.progress.start();
    const every = Math.max(500, Math.floor(this.opts?.editIntervalMs ?? 1500));
    this.timer = setInterval(() => void this.flush(), every);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.progress.stop();
  }

  setBanner(text: string | null): void {
    this.banner = text?.trim() ? text.trim() : null;
    this.dirty = true;
  }

  hooks(): AgentHooks {
    return {
      onToken: (t) => {
        this.buffer += t;
        this.progress.hooks.onToken?.(t);
        this.dirty = true;
      },
      onToolCall: (call) => {
        this.progress.hooks.onToolCall?.(call);

        this.activeToolId = call.id;
        this.tails.reset(call.id, call.name);

        const line = `◆ ${formatToolCallSummary({ name: call.name, args: call.args as any })}...`;
        if (this.lastToolLine === line && this.toolLines.length > 0) {
          this.lastToolRepeat += 1;
          this.toolLines[this.toolLines.length - 1] = `${line} (x${this.lastToolRepeat + 1})`;
        } else {
          this.lastToolLine = line;
          this.lastToolRepeat = 0;
          this.toolLines.push(line);
          if (this.toolLines.length > 8) this.toolLines.splice(0, this.toolLines.length - 8);
        }

        this.dirty = true;
      },
      onToolStream: (ev: ToolStreamEvent) => {
        if (!this.activeToolId || ev.id !== this.activeToolId) return;
        this.tails.push(ev);
        this.dirty = true;
      },
      onToolResult: (result: ToolResultEvent) => {
        this.progress.hooks.onToolResult?.(result);

        this.lastToolLine = '';
        this.lastToolRepeat = 0;
        if (this.toolLines.length > 0) {
          const icon = result.success ? '✓' : '✗';
          this.toolLines[this.toolLines.length - 1] = `${icon} ${result.name}: ${result.summary}`;
        }
        if (this.activeToolId === result.id) {
          this.tails.clear(result.id);
          this.activeToolId = null;
        }

        this.dirty = true;
      },
      onTurnEnd: (stats: TurnEndEvent) => {
        this.progress.hooks.onTurnEnd?.(stats);
      },
    };
  }

  private renderProgressText(): string {
    const tail = this.activeToolId ? this.tails.get(this.activeToolId) : null;
    const assistant = this.buffer.trim() ? safeContent(this.buffer) : '';

    const doc = this.renderer.render({
      banner: this.banner,
      statusLine: this.statusLine,
      toolLines: this.toolLines,
      toolTail: tail ? { name: tail.name, stream: tail.stream, lines: tail.lines } : null,
      assistantMarkdown: assistant,
    });

    return renderDiscordMarkdown(doc, { maxLen: 1900 });
  }

  private async flush(): Promise<void> {
    if (this.finalized) return;
    if (!this.dirty) return;
    this.dirty = false;

    const text = this.renderProgressText();
    try {
      if (this.placeholder) {
        await this.placeholder.edit(text);
      }
    } catch {
      // ignore edit failures
    }
  }

  async finalize(finalText: string): Promise<void> {
    this.finalized = true;
    this.stop();

    const snap = this.progress.snapshot('stop');
    const toolLines = snap.toolLines.slice(-8);
    const combined = safeContent((toolLines.length ? toolLines.join('\n') + '\n\n' : '') + (finalText ?? ''));
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
    const combined = safeContent((toolLines.length ? toolLines.join('\n') + '\n\n' : '') + `❌ ${errMsg}`);
    const chunks = splitDiscord(combined);

    if (this.placeholder && chunks.length > 0) {
      await this.placeholder.edit(chunks[0]).catch(() => {});
    } else if (chunks.length > 0) {
      await (this.channel as any).send(chunks[0]).catch(() => {});
    }
  }
}
