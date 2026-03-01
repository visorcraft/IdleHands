/**
 * Discord progress streaming message - shows tool history block like IdleHands.
 *
 * Usage:
 *   const stream = new DiscordProgressStream(placeholder, channel, rest);
 *   stream.start();
 *
 *   // Wire up to agent events
 *   agent.on("tool_call", stream.hooks.onToolCall);
 *   agent.on("tool_result", stream.hooks.onToolResult);
 *   agent.on("token", stream.hooks.onToken);
 *
 *   // When done
 *   await stream.finalize(finalText);
 *   // Or on timeout
 *   await stream.finalizeTimeout(partialText, timeoutMs);
 */

import type { RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { MessageEditScheduler } from "./message-scheduler.js";
import {
  renderProgressMarkdown,
  renderFinalMessage,
  type FinalStatus,
} from "./progress-renderer.js";
import { TurnProgressController } from "./turn-progress.js";
import type { ProgressHooks, ProgressSnapshot, ToolStreamEvent } from "./types.js";

export type DiscordProgressStreamOptions = {
  /** Message edit interval (default: 1500ms) */
  editIntervalMs?: number;
  /** Max Discord message length (default: 1900) */
  maxChars?: number;
  /** Max tool lines to display (default: 8) */
  maxToolLines?: number;
  /** Max assistant text preview chars (default: 1200) */
  maxAssistantChars?: number;
  /** Show stats line (turn count, tokens) - default: true */
  showStats?: boolean;
};

export class DiscordProgressStream {
  private readonly rest: RequestClient;
  private readonly channelId: string;
  private readonly placeholder: { id: string } | null;
  private readonly opts: Required<DiscordProgressStreamOptions>;

  private progress: TurnProgressController;
  private scheduler: MessageEditScheduler | null = null;

  private lastSnapshot: ProgressSnapshot | null = null;
  private assistantBuffer = "";
  private toolTail: { stream: "stdout" | "stderr"; lines: string[] } | null = null;
  private banner: string | null = null;
  private dirty = true;
  private finalized = false;
  private messageId: string | null = null;

  constructor(
    placeholder: { id: string } | null,
    channelId: string,
    rest: RequestClient,
    opts?: DiscordProgressStreamOptions,
  ) {
    this.placeholder = placeholder;
    this.channelId = channelId;
    this.rest = rest;
    this.opts = {
      editIntervalMs: opts?.editIntervalMs ?? 1500,
      maxChars: opts?.maxChars ?? 1900,
      maxToolLines: opts?.maxToolLines ?? 8,
      maxAssistantChars: opts?.maxAssistantChars ?? 1200,
      showStats: opts?.showStats ?? true,
    };

    this.progress = new TurnProgressController(
      (snap) => {
        this.lastSnapshot = snap;
        this.dirty = true;
      },
      {
        heartbeatMs: 1000,
        bucketMs: 5000,
        maxToolLines: this.opts.maxToolLines,
      },
    );
  }

  /** Start tracking progress and editing the placeholder message */
  async start(): Promise<void> {
    if (this.scheduler || this.finalized) {
      return;
    }

    this.progress.start();

    // Use existing placeholder or create a new message
    let targetMessageId = this.placeholder?.id ?? null;

    if (!targetMessageId) {
      // Create initial progress message
      try {
        const initialContent = this.render();
        const response = (await this.rest.post(Routes.channelMessages(this.channelId), {
          body: { content: initialContent || "⏳ Working..." },
        })) as { id: string };
        targetMessageId = response.id;
        console.log("[progress-stream] Created initial message:", targetMessageId);
      } catch (err) {
        console.error("[progress-stream] Failed to create initial message:", err);
        return;
      }
    }

    this.messageId = targetMessageId;

    if (this.messageId) {
      this.scheduler = new MessageEditScheduler(
        {
          render: () => this.render(),
          apply: async (text) => {
            if (!this.messageId) {
              return;
            }
            try {
              await this.rest.patch(Routes.channelMessage(this.channelId, this.messageId), {
                body: { content: text },
              });
            } catch (err) {
              console.error("[progress-stream] Failed to edit message:", err);
            }
          },
          isDirty: () => this.dirty,
          clearDirty: () => {
            this.dirty = false;
          },
        },
        { intervalMs: this.opts.editIntervalMs },
      );
      this.scheduler.start();
    }
  }

  /** Stop progress tracking (but do not finalize) */
  stop(): void {
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
    }
    this.progress.stop();
  }

  /** Get hooks to wire up to agent events */
  hooks(): ProgressHooks {
    return {
      onToken: (t) => {
        this.assistantBuffer += t;
        this.progress.hooks.onToken?.(t);
        this.dirty = true;
      },
      onFirstDelta: () => {
        this.progress.hooks.onFirstDelta?.();
        this.dirty = true;
      },
      onToolCall: (call) => {
        this.toolTail = null; // Clear tail for new tool
        this.progress.hooks.onToolCall?.(call);
        this.dirty = true;
      },
      onToolStream: (ev: ToolStreamEvent) => {
        // Capture tool output tail for display
        if (!this.toolTail || this.toolTail.stream !== ev.stream) {
          this.toolTail = { stream: ev.stream, lines: [] };
        }
        // Append text, split into lines, keep last 4
        const combined = (this.toolTail.lines.join("\n") + ev.text).split("\n");
        this.toolTail.lines = combined.slice(-4);
        this.dirty = true;
      },
      onToolResult: (result) => {
        this.toolTail = null; // Clear tail after tool completes
        this.progress.hooks.onToolResult?.(result);
        this.dirty = true;
      },
      onTurnEnd: (stats) => {
        this.progress.hooks.onTurnEnd?.(stats);
        this.dirty = true;
      },
    };
  }

  /** Set a banner message (e.g., warnings) */
  setBanner(text: string | null): void {
    this.banner = text?.trim() || null;
    this.dirty = true;
  }

  /** Get current snapshot */
  getSnapshot(): ProgressSnapshot {
    return this.lastSnapshot ?? this.progress.snapshot();
  }

  /** Render current state to Discord markdown */
  private render(): string {
    const snapshot = this.lastSnapshot ?? this.progress.snapshot();
    return renderProgressMarkdown(
      {
        banner: this.banner,
        snapshot,
        assistantText: this.assistantBuffer,
        toolTail: this.toolTail,
      },
      {
        maxChars: this.opts.maxChars,
        maxToolLines: this.opts.maxToolLines,
        maxAssistantChars: this.opts.maxAssistantChars,
        showStats: this.opts.showStats,
      },
    );
  }

  /** Build stats object from current snapshot */
  private buildStats(status: FinalStatus, timeoutMs?: number) {
    const snapshot = this.lastSnapshot ?? this.progress.snapshot();
    return {
      turnCount: snapshot.turnCount,
      totalToolCalls: snapshot.totalToolCalls,
      totalTokens: snapshot.totalPromptTokens + snapshot.totalCompletionTokens,
      elapsedMs: snapshot.elapsedMs,
      status,
      timeoutMs,
    };
  }

  /** Finalize with the final response text (successful completion) */
  async finalize(finalText: string): Promise<void> {
    await this.finalizeWithStatus(finalText, "completed");
  }

  /** Finalize due to timeout */
  async finalizeTimeout(partialText: string, timeoutMs?: number): Promise<void> {
    await this.finalizeWithStatus(partialText, "timeout", timeoutMs);
  }

  /** Finalize with an error message */
  async finalizeError(errorMsg: string): Promise<void> {
    await this.finalizeWithStatus(`❌ ${errorMsg}`, "error");
  }

  /** Internal finalize with status */
  private async finalizeWithStatus(
    finalText: string,
    status: FinalStatus,
    timeoutMs?: number,
  ): Promise<void> {
    this.finalized = true;
    this.stop();

    const snapshot = this.lastSnapshot ?? this.progress.snapshot();
    const toolLines = snapshot.toolLines;

    const combined = renderFinalMessage(toolLines, finalText, {
      maxChars: this.opts.maxChars,
      maxToolLines: this.opts.maxToolLines,
      stats: this.buildStats(status, timeoutMs),
    });

    // Split if too long
    const chunks = this.splitMessage(combined);

    // Edit placeholder with first chunk
    if (this.placeholder && chunks.length > 0) {
      try {
        await this.rest.patch(Routes.channelMessage(this.channelId, this.placeholder.id), {
          body: { content: chunks[0] },
        });
      } catch {
        // If edit fails, try sending instead
        await this.sendMessage(chunks[0]);
      }
    } else if (chunks.length > 0) {
      await this.sendMessage(chunks[0]);
    }

    // Send additional chunks
    for (let i = 1; i < chunks.length && i < 10; i++) {
      await this.sendMessage(chunks[i]);
    }

    if (chunks.length > 10) {
      await this.sendMessage("[truncated — response too long]");
    }
  }

  private async sendMessage(content: string): Promise<void> {
    await this.rest.post(Routes.channelMessages(this.channelId), {
      body: { content },
    });
  }

  private splitMessage(text: string, maxLen = 2000): string[] {
    if (text.length <= maxLen) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point
      let breakAt = maxLen;
      const newlinePos = remaining.lastIndexOf("\n", maxLen);
      if (newlinePos > maxLen * 0.5) {
        breakAt = newlinePos;
      }

      chunks.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }

    return chunks;
  }
}
