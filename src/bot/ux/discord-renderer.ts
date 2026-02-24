/**
 * Discord-specific renderer for the shared UX core.
 *
 * Converts canonical UX blocks (from the shared event model) into
 * Discord Markdown format, respecting Discord's message limits and formatting.
 */

import type { UXBlock } from './renderer.js';
import { blocksToPlainText } from './renderer.js';

/**
 * Discord message length limit (recommended: 1900, hard limit: 2000).
 */
export const DISCORD_MAX_LEN = 1900;

/**
 * Discord Markdown formatting options.
 */
export type DiscordRenderOptions = {
  maxLen?: number;
};

/**
 * Escape content to avoid breaking code fences.
 */
function escapeCodeFence(s: string): string {
  return String(s ?? '').replace(/```/g, '``\u200b`');
}

/**
 * Convert a UX block to Discord Markdown.
 */
function blockToDiscordMarkdown(block: UXBlock, opts?: DiscordRenderOptions): string {
  const maxLen = opts?.maxLen ?? DISCORD_MAX_LEN;

  switch (block.type) {
    case 'text': {
      let content = block.content;
      if (content.length > maxLen) {
        content = content.slice(0, maxLen - 1) + '…';
      }

      let formatted = content;
      if (block.format?.bold) formatted = `**${formatted}**`;
      if (block.format?.italic) formatted = `*${formatted}*`;
      if (block.format?.monospace) formatted = `\`${formatted}\``;
      if (block.format?.code) formatted = `\`${formatted}\``;
      if (block.format?.color) {
        // Discord doesn't support arbitrary colors, use inline code
        formatted = `\`${formatted}\``;
      }
      return formatted;
    }

    case 'section': {
      const title = block.title ? `**${block.title}**\n` : '';
      const content = Array.isArray(block.content)
        ? block.content.map((b) => blockToDiscordMarkdown(b, opts)).join('\n')
        : blockToDiscordMarkdown(block.content, opts);
      return title + content;
    }

    case 'message': {
      const content = Array.isArray(block.content)
        ? block.content.map((b) => blockToDiscordMarkdown(b, opts)).join('\n')
        : blockToDiscordMarkdown(block.content, opts);
      return content;
    }

    case 'actions': {
      const actions = block.actions
        .map((a) => {
          const label = `**${a.label}**`;
          return a.payload ? `${label}: ${a.payload}` : label;
        })
        .join('\n');
      return `\n*Actions:*\n${actions}`;
    }

    case 'progress': {
      const progress = Math.round(block.progress * 100);
      const message = block.message || 'Processing...';
      return `*${message}*\n[${'█'.repeat(Math.round((progress / 100) * 20))}${'░'.repeat(20 - Math.round((progress / 100) * 20))}] ${progress}%`;
    }
    case 'code': {
      const lang = block.language || '';
      const body = escapeCodeFence(block.content);
      return `\`\`\`${lang}\n${body}\n\`\`\``;
    }
    default: {
      return '';
    }
  }
}

/**
 * Render UX blocks to Discord Markdown, respecting message length limits.
 * Truncates content if necessary and adds ellipsis.
 */
export function renderDiscordMarkdown(blocks: UXBlock[], opts?: DiscordRenderOptions): string {
  const maxLen = Math.max(256, Math.floor(opts?.maxLen ?? DISCORD_MAX_LEN));

  const parts: string[] = [];
  let used = 0;
  let truncated = false;

  for (const block of blocks) {
    const piece = blockToDiscordMarkdown(block, opts);
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
  if (!out.trim()) out = '⏳ Thinking...';

  return out;
}

/**
 * Fallback: render blocks to plain text for very long messages.
 */
export function renderDiscordPlainText(blocks: UXBlock[], opts?: DiscordRenderOptions): string {
  const maxLen = Math.max(256, Math.floor(opts?.maxLen ?? DISCORD_MAX_LEN));
  let text = blocksToPlainText(blocks);

  if (text.length > maxLen) {
    text = text.slice(0, maxLen - 1) + '…';
  }

  if (!text.trim()) text = '⏳ Thinking...';

  return text;
}
