import type { AgentHooks } from '../agent.js';
import type { ToolCallEvent, ToolResultEvent, ToolStreamEvent, TurnEndEvent } from '../types.js';

import { ProgressMessageRenderer } from './progress-message-renderer.js';
import { renderDiscordMarkdown } from './serialize-discord.js';
import { renderTelegramHtml } from './serialize-telegram.js';
import { renderTuiLines } from './serialize-tui.js';
import { ToolTailBuffer } from './tool-tail.js';
import { TurnProgressController, type TurnProgressSnapshot } from './turn-progress.js';

export type ProgressPresenterBudgets = {
  maxToolLines?: number;
  maxTailLines?: number;
  maxDiffLines?: number;
  maxAssistantChars?: number;
  telegramMaxLen?: number;
  discordMaxLen?: number;
  tuiMaxLines?: number;
  toolCallSummary?: (call: { name: string; args: any }) => string;
};

export class ProgressPresenter {
  private buffer = '';
  private banner: string | null = null;

  private tails = new ToolTailBuffer({ maxChars: 4096, maxLines: 4 });
  private activeToolId: string | null = null;

  private lastSnap: TurnProgressSnapshot | null = null;
  private dirty = true;

  private progress: TurnProgressController;
  private renderer: ProgressMessageRenderer;
  private readonly budgets: Required<Omit<ProgressPresenterBudgets, 'toolCallSummary'>> & {
    toolCallSummary?: (call: { name: string; args: any }) => string;
    telegramMaxLen: number;
    discordMaxLen: number;
    tuiMaxLines: number;
  };

  getBudgets(): Required<Omit<ProgressPresenterBudgets, 'toolCallSummary'>> & {
    telegramMaxLen: number;
    discordMaxLen: number;
    tuiMaxLines: number;
  } {
    return this.budgets;
  }

  constructor(budgets?: ProgressPresenterBudgets) {
    this.budgets = {
      maxToolLines: budgets?.maxToolLines ?? 8,
      maxTailLines: budgets?.maxTailLines ?? 4,
      maxDiffLines: budgets?.maxDiffLines ?? 40,
      maxAssistantChars: budgets?.maxAssistantChars ?? 2000,
      telegramMaxLen: budgets?.telegramMaxLen ?? 4096,
      discordMaxLen: budgets?.discordMaxLen ?? 1900,
      tuiMaxLines: budgets?.tuiMaxLines ?? 10,
      toolCallSummary: budgets?.toolCallSummary,
    };

    this.progress = new TurnProgressController(
      (snap) => {
        this.lastSnap = snap;
        this.dirty = true;
      },
      {
        heartbeatMs: 1000,
        bucketMs: 5000,
        maxToolLines: this.budgets.maxToolLines,
        toolCallSummary: this.budgets.toolCallSummary,
      }
    );

    this.renderer = new ProgressMessageRenderer({
      maxToolLines: this.budgets.maxToolLines,
      maxTailLines: this.budgets.maxTailLines,
      maxDiffLines: this.budgets.maxDiffLines,
      maxAssistantChars: this.budgets.maxAssistantChars,
    });
  }

  start(): void {
    this.progress.start();
  }

  stop(): void {
    this.progress.stop();
  }

  setBanner(text: string | null): void {
    this.banner = text?.trim() ? text.trim() : null;
    this.dirty = true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  snapshot(reason: 'manual' | 'stop' = 'manual'): TurnProgressSnapshot {
    return this.progress.snapshot(reason);
  }

  hooks(): AgentHooks {
    const clearBannerOnActivity = () => {
      if (this.banner) this.banner = null;
    };

    return {
      onToken: (t) => {
        clearBannerOnActivity();
        this.buffer += t;
        this.progress.hooks.onToken?.(t);
        this.dirty = true;
      },
      onFirstDelta: () => {
        clearBannerOnActivity();
        this.progress.hooks.onFirstDelta?.();
        this.dirty = true;
      },
      onToolCall: (call: ToolCallEvent) => {
        clearBannerOnActivity();
        this.progress.hooks.onToolCall?.(call);
        this.activeToolId = call.id;
        this.tails.reset(call.id, call.name);
        this.dirty = true;
      },
      onToolStream: (ev: ToolStreamEvent) => {
        if (this.activeToolId && ev.id === this.activeToolId) {
          this.tails.push(ev);
          this.dirty = true;
        }
      },
      onToolResult: (res: ToolResultEvent) => {
        clearBannerOnActivity();
        this.progress.hooks.onToolResult?.(res);
        if (this.activeToolId === res.id) {
          this.tails.clear(res.id);
          this.activeToolId = null;
        }
        if (!res.success) {
          const code = res.errorCode ? ` (${res.errorCode})` : '';
          this.banner = `⚠ Tool failed: ${res.name}${code}`;
        }
        this.dirty = true;
      },
      onTurnEnd: (stats: TurnEndEvent) => {
        clearBannerOnActivity();
        this.progress.hooks.onTurnEnd?.(stats);
        this.dirty = true;
      },
    };
  }

  private renderIR() {
    const snap = this.lastSnap ?? this.progress.snapshot('manual');

    const tail = this.activeToolId ? this.tails.get(this.activeToolId) : null;

    return this.renderer.render({
      banner: this.banner,
      statusLine: snap.statusLine,
      toolLines: snap.toolLines,
      toolTail: tail ? { name: tail.name, stream: tail.stream, lines: tail.lines } : null,
      assistantMarkdown: this.buffer,
    });
  }

  renderTelegramHtml(): string {
    this.clearDirty();
    return renderTelegramHtml(this.renderIR(), { maxLen: this.budgets.telegramMaxLen });
  }

  renderDiscordMarkdown(): string {
    this.clearDirty();
    return renderDiscordMarkdown(this.renderIR(), { maxLen: this.budgets.discordMaxLen });
  }

  renderTuiLines(): string[] {
    this.clearDirty();
    return renderTuiLines(this.renderIR(), { maxLines: this.budgets.tuiMaxLines });
  }
}
