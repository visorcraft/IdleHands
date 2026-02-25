/**
 * Shared formatter utilities for platform-specific renderers.
 *
 * Provides common truncation logic to prevent duplication across platforms
 * (Discord, Telegram, etc.) while allowing platform-specific formatting.
 */

import type { UXBlock } from './renderer.js';

/**
 * Options for truncating formatted content.
 */
export type TruncationOptions = {
  /** Maximum allowed length in characters */
  maxLen: number;
  /** Fallback string to return if output is empty */
  fallback?: string;
};

/**
 * Truncates formatted content from UX blocks to fit within maxLen.
 *
 * This function implements the common truncation algorithm used across
 * all platform renderers, allowing them to share logic while using
 * platform-specific formatting functions.
 *
 * @param blocks - Array of UX blocks to format and truncate
 * @param blockToFormatted - Function that converts a single UX block to formatted string
 * @param opts - Truncation options including max length and optional fallback
 * @returns Formatted and truncated string, or fallback if empty
 */
export function truncateBlocks(
  blocks: UXBlock[],
  blockToFormatted: (block: UXBlock, opts?: any) => string,
  opts?: TruncationOptions
): string {
  const maxLen = Math.max(256, Math.floor(opts?.maxLen ?? 1900));
  const fallback = opts?.fallback ?? '⏳ Thinking...';

  const parts: string[] = [];
  let used = 0;
  let truncated = false;

  for (const block of blocks) {
    const piece = blockToFormatted(block, opts);
    const sep = parts.length ? '\n\n' : '';
    const add = sep + piece;

    if (used + add.length > maxLen) {
      truncated = true;
      break;
    }

    parts.push(add);
    used += add.length;
  }

  let out = parts.join('');
  if (truncated && out.length + 2 <= maxLen) out += '\n…';
  if (!out.trim()) out = fallback;

  return out;
}
