/**
 * Adapter to integrate DiscordProgressStream with the message handler.
 * Provides callbacks compatible with GetReplyOptions.
 */

import type { RequestClient } from "@buape/carbon";
import { DiscordProgressStream, type DiscordProgressStreamOptions } from "../progress/index.js";
import type { TurnEndEvent } from "../progress/types.js";

export type ProgressStreamAdapterOptions = DiscordProgressStreamOptions & {
  /** Placeholder message to edit (if available) */
  placeholder?: { id: string } | null;
  /** Channel to send messages to */
  channelId: string;
  /** Discord REST client */
  rest: RequestClient;
  /** Timeout in ms (for finalizeTimeout display) */
  timeoutMs?: number;
};

export type ProgressStreamAdapter = {
  /** The underlying progress stream */
  stream: DiscordProgressStream;
  /** Start tracking progress */
  start: () => Promise<void>;
  /** Stop tracking (but dont finalize) */
  stop: () => void;
  /** Callback for onToolStart events */
  onToolStart: (payload: {
    name?: string;
    phase?: string;
    toolCallId?: string;
    args?: unknown;
  }) => void;
  /** Callback for onToolResult events - accepts ReplyPayload shape from IdleHands */
  onToolResult: (payload: { text?: string; mediaUrls?: string[] }) => void;
  /** Callback for onPartialReply - updates assistant text buffer */
  onPartialReply: (payload: { text?: string }) => void;
  /** Callback for turn end stats */
  onTurnEnd: (stats: TurnEndEvent) => void;
  /** Finalize with success */
  finalize: (finalText: string) => Promise<void>;
  /** Finalize with timeout */
  finalizeTimeout: (partialText?: string) => Promise<void>;
  /** Finalize with error */
  finalizeError: (errorMsg: string) => Promise<void>;
  /** Check if a placeholder message exists */
  hasPlaceholder: () => boolean;
  /** Get the message ID (if created) */
  getMessageId: () => string | undefined;
};

/**
 * Create a progress stream adapter for Discord message handling.
 */
export function createProgressStreamAdapter(
  opts: ProgressStreamAdapterOptions,
): ProgressStreamAdapter {
  const stream = new DiscordProgressStream(opts.placeholder ?? null, opts.channelId, opts.rest, {
    editIntervalMs: opts.editIntervalMs,
    maxChars: opts.maxChars,
    maxToolLines: opts.maxToolLines,
    maxAssistantChars: opts.maxAssistantChars,
    showStats: opts.showStats,
  });

  const hooks = stream.hooks();
  const timeoutMs = opts.timeoutMs;

  // Track last tool for result matching (IdleHands doesnt pass toolCallId in onToolResult)
  let lastToolName = "tool";
  let lastToolCallId = "";
  let firstDeltaCalled = false;

  return {
    stream,

    start: async () => {
      await stream.start();
    },

    stop: () => {
      stream.stop();
    },

    onToolStart: (payload) => {
      const toolCallId = payload.toolCallId ?? `tool-${Date.now()}`;
      const name = payload.name ?? "tool";

      // Track for result matching
      lastToolName = name;
      lastToolCallId = toolCallId;

      hooks.onToolCall?.({
        id: toolCallId,
        name,
        args: payload.args as Record<string, unknown> | undefined,
      });
    },

    onToolResult: (payload) => {
      // Use tracked tool info since IdleHands onToolResult only passes { text, mediaUrls }
      const name = lastToolName;
      const toolCallId = lastToolCallId;

      // Extract summary from text (tool results often have format "🔧 name: summary")
      let summary = "done";
      if (payload.text) {
        // Try to extract just the summary part
        const match = payload.text.match(/^🔧\s*\S+:\s*(.+)$/s);
        summary = match ? match[1].trim().slice(0, 60) : payload.text.slice(0, 60);
      }

      hooks.onToolResult?.({
        id: toolCallId,
        name,
        success: true, // IdleHands doesnt pass success status
        summary,
      });

      // Reset for next tool
      lastToolName = "tool";
      lastToolCallId = "";
    },

    onPartialReply: (payload) => {
      if (payload.text) {
        if (!firstDeltaCalled) {
          firstDeltaCalled = true;
          hooks.onFirstDelta?.();
        }
        // The progress stream tracks text internally via onToken
        hooks.onToken?.(payload.text);
      }
    },

    onTurnEnd: (stats) => {
      hooks.onTurnEnd?.(stats);
    },

    finalize: async (finalText: string) => {
      await stream.finalize(finalText);
    },

    finalizeTimeout: async (partialText?: string) => {
      await stream.finalizeTimeout(partialText ?? "", timeoutMs);
    },

    finalizeError: async (errorMsg: string) => {
      await stream.finalizeError(errorMsg);
    },

    hasPlaceholder: () => Boolean(opts.placeholder),

    getMessageId: () => {
      // The progress stream doesnt expose messageId directly
      // Wed need to add that if needed
      return undefined;
    },
  };
}
