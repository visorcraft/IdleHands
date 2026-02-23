import type { TextBasedChannel } from 'discord.js';

import type { AgentHooks } from '../agent.js';
import {
  MessageEditScheduler,
  classifyDiscordEditError,
} from '../progress/message-edit-scheduler.js';
import { ProgressPresenter } from '../progress/progress-presenter.js';
import { formatToolCallSummary } from '../progress/tool-summary.js';

import { splitDiscord, safeContent } from './discord-routing.js';

export class DiscordStreamingMessage {
  private banner: string | null = null;
  private finalized = false;

  private presenter = new ProgressPresenter({
    maxToolLines: 8,
    maxTailLines: 4,
    maxDiffLines: 32,
    maxAssistantChars: 1200,
    discordMaxLen: 1900,
    toolCallSummary: (c) => formatToolCallSummary({ name: c.name, args: c.args as any }),
  });

  private scheduler: MessageEditScheduler | null = null;

  constructor(
    private readonly placeholder: any | null,
    private readonly channel: TextBasedChannel,
    private readonly opts?: { editIntervalMs?: number }
  ) {}

  start(): void {
    if (this.scheduler || this.finalized) return;

    this.presenter.start();

    if (this.placeholder) {
      const every = Math.max(500, Math.floor(this.opts?.editIntervalMs ?? 1500));
      this.scheduler = new MessageEditScheduler({
        intervalMs: every,
        render: () => this.presenter.renderDiscordMarkdown(),
        apply: async (text) => {
          if (!this.placeholder) return;
          await this.placeholder.edit(text);
        },
        isDirty: () => this.presenter.isDirty(),
        clearDirty: () => this.presenter.clearDirty(),
        classifyError: classifyDiscordEditError,
      });
      this.scheduler.start();
    }
  }

  stop(): void {
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
    }
    this.presenter.stop();
  }

  setBanner(text: string | null): void {
    this.banner = text?.trim() ? text.trim() : null;
    this.presenter.setBanner(this.banner);
  }

  hooks(): AgentHooks {
    return this.presenter.hooks();
  }

  async finalize(finalText: string): Promise<void> {
    this.finalized = true;
    this.stop();

    const snap = this.presenter.snapshot('stop');
    const toolLines = snap.toolLines.slice(-8);

    // Build combined text with informative fallback
    let combined = '';
    if (toolLines.length) combined += toolLines.join('\n') + '\n\n';

    if (finalText && finalText.trim()) {
      combined += finalText;
    } else if (finalText) {
      combined += '*(response contained only protocol artifacts - no user-visible content)*';
    } else {
      combined += '*(no response generated - task may be complete or awaiting further input)*';
    }

    const chunks = splitDiscord(safeContent(combined));

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

    const snap = this.presenter.snapshot('stop');
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
