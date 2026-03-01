/**
 * Progress message renderer - builds Discord markdown from progress state.
 * Adapted from IdleHands.
 */

import type { ProgressSnapshot } from "./types.js";

export type RenderOptions = {
  /** Max characters for Discord message (default: 1900) */
  maxChars?: number;
  /** Max tool lines to show (default: 8) */
  maxToolLines?: number;
  /** Max assistant preview chars (default: 1200) */
  maxAssistantChars?: number;
  /** Show stats line (turn count, tokens) */
  showStats?: boolean;
};

function escapeCodeFence(s: string): string {
  return String(s ?? "").replace(/```/g, "``\u200b`");
}

function clipEnd(s: string, maxChars: number): string {
  const t = String(s ?? "").trim();
  if (maxChars <= 0) {
    return "";
  }
  if (t.length <= maxChars) {
    return t;
  }
  return "…" + t.slice(t.length - (maxChars - 1));
}

function tail<T>(arr: T[], n: number): T[] {
  if (!Array.isArray(arr) || n <= 0) {
    return [];
  }
  return arr.length <= n ? arr : arr.slice(arr.length - n);
}

function formatTokens(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h${String(mins).padStart(2, "0")}m`;
}

function formatTps(tps: number | undefined): string | null {
  if (tps == null || !Number.isFinite(tps)) {
    return null;
  }
  return `${tps.toFixed(0)} t/s`;
}

export type ProgressRenderInput = {
  /** Banner text (e.g., warnings) */
  banner?: string | null;
  /** Progress snapshot from TurnProgressController */
  snapshot: ProgressSnapshot;
  /** Accumulated assistant markdown text */
  assistantText?: string;
  /** Optional tool output tail */
  toolTail?: {
    stream: "stdout" | "stderr";
    lines: string[];
  } | null;
};

export function renderProgressMarkdown(input: ProgressRenderInput, opts?: RenderOptions): string {
  const maxChars = opts?.maxChars ?? 1900;
  const maxToolLines = opts?.maxToolLines ?? 8;
  const maxAssistantChars = opts?.maxAssistantChars ?? 1200;
  const showStats = opts?.showStats ?? true;

  const parts: string[] = [];
  let usedChars = 0;

  const addPart = (text: string, separator = "\n\n"): boolean => {
    const sep = parts.length ? separator : "";
    const chunk = sep + text;
    if (usedChars + chunk.length > maxChars) {
      return false;
    }
    parts.push(chunk);
    usedChars += chunk.length;
    return true;
  };

  // Banner (if any)
  const banner = input.banner?.trim();
  if (banner) {
    addPart(`**${banner}**`);
  }

  // Status line
  const status = input.snapshot.statusLine?.trim();
  if (status) {
    addPart(`*${status}*`);
  } else {
    addPart("*⏳ Thinking...*");
  }

  // Stats line (turn count, tokens, speed)
  if (showStats && input.snapshot.turnCount > 0) {
    const snap = input.snapshot;
    const statParts: string[] = [];

    statParts.push(`Turn ${snap.turnCount}`);

    if (snap.totalToolCalls > 0) {
      statParts.push(`${snap.totalToolCalls} tools`);
    }

    // Show context size (prompt tokens)
    if (snap.contextTokens) {
      statParts.push(`ctx: ${formatTokens(snap.contextTokens)}`);
    }

    // Show total tokens (accumulated prompt + completion)
    const totalTokens = snap.totalPromptTokens + snap.totalCompletionTokens;
    if (totalTokens > 0) {
      statParts.push(`total: ${formatTokens(totalTokens)}`);
    }

    // Show completion tokens generated
    if (snap.totalCompletionTokens > 0) {
      statParts.push(`+${formatTokens(snap.totalCompletionTokens)} gen`);
    }

    // Show generation speed if available
    const tgTps = formatTps(snap.lastTurnStats?.tgTps);
    if (tgTps) {
      statParts.push(tgTps);
    }

    if (statParts.length > 0) {
      addPart(`\`${statParts.join(" · ")}\``, "\n");
    }
  }

  // Tool lines block (code block for monospace)
  const toolLines = tail((input.snapshot.toolLines ?? []).filter(Boolean), maxToolLines);
  if (toolLines.length > 0) {
    const toolBlock = "```\n" + escapeCodeFence(toolLines.join("\n")) + "\n```";
    addPart(toolBlock);
  }

  // Tool output tail (for exec commands showing stdout/stderr)
  if (input.toolTail && input.toolTail.lines.length > 0) {
    const tailLines = tail(input.toolTail.lines, 4);
    const label = `↳ ${input.toolTail.stream}`;
    const tailBlock = `*${label}*\n\`\`\`\n${escapeCodeFence(tailLines.join("\n"))}\n\`\`\``;
    addPart(tailBlock);
  }

  // Assistant text preview
  const assistant = input.assistantText?.trim();
  if (assistant) {
    const clipped = clipEnd(assistant, maxAssistantChars);
    addPart(clipped);
  }

  let result = parts.join("");

  // Final safety truncation
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 1) + "…";
  }

  return result || "*⏳ Thinking...*";
}

export type FinalStatus = "completed" | "timeout" | "error";

export type FinalMessageStats = {
  turnCount: number;
  totalToolCalls: number;
  totalTokens: number;
  elapsedMs: number;
  status: FinalStatus;
  /** Timeout limit in ms (for display when status is timeout) */
  timeoutMs?: number;
};

/**
 * Render final message with tool history + final response.
 * Used when the run completes.
 */
export function renderFinalMessage(
  toolLines: string[],
  finalText: string,
  opts?: {
    maxChars?: number;
    maxToolLines?: number;
    stats?: FinalMessageStats;
  },
): string {
  const maxChars = opts?.maxChars ?? 1900;
  const maxToolLines = opts?.maxToolLines ?? 8;

  const parts: string[] = [];

  // Status indicator + stats summary at the top
  if (opts?.stats) {
    const { turnCount, totalToolCalls, totalTokens, elapsedMs, status, timeoutMs } = opts.stats;
    const elapsed = formatElapsed(elapsedMs);

    let statusIcon: string;
    let statusText: string;

    switch (status) {
      case "timeout":
        statusIcon = "⏱️";
        statusText = timeoutMs
          ? `Timed out after ${formatElapsed(timeoutMs)}`
          : `Timed out after ${elapsed}`;
        break;
      case "error":
        statusIcon = "❌";
        statusText = `Failed after ${elapsed}`;
        break;
      case "completed":
      default:
        statusIcon = "✅";
        statusText = `Completed in ${elapsed}`;
        break;
    }

    const statParts = [
      `${turnCount} turn${turnCount !== 1 ? "s" : ""}`,
      `${totalToolCalls} tool${totalToolCalls !== 1 ? "s" : ""}`,
      `${formatTokens(totalTokens)} tokens`,
    ];

    parts.push(`${statusIcon} **${statusText}** · \`${statParts.join(" · ")}\``);
  }

  // Keep last N tool lines
  const keptLines = tail(toolLines.filter(Boolean), maxToolLines);
  if (keptLines.length > 0) {
    parts.push("```\n" + escapeCodeFence(keptLines.join("\n")) + "\n```");
  }

  // Final text
  const final = finalText?.trim();
  if (final) {
    parts.push(final);
  } else if (opts?.stats?.status === "timeout") {
    parts.push("*(task timed out before completion)*");
  } else {
    parts.push("*(no response)*");
  }

  let result = parts.join("\n\n");

  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 1) + "…";
  }

  return result;
}
