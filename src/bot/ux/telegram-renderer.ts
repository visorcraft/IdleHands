/**
 * Telegram-specific renderer for the shared UX core.
 *
 * Converts canonical UX blocks (from the shared event model) into
 * Telegram HTML format, respecting Telegram's message limits and formatting.
 */

import type { UXBlock } from './renderer.js';
import { blocksToPlainText } from './renderer.js';

/**
 * Telegram message length limit (hard limit: 4096 characters).
 */
export const TELEGRAM_MAX_LEN = 4096;

/**
 * Telegram HTML formatting options.
 */
export type TelegramRenderOptions = {
  maxLen?: number;
};

/**
 * Convert a UX block to Telegram HTML.
 */
function blockToTelegramHtml(block: UXBlock, opts?: TelegramRenderOptions): string {
  const maxLen = opts?.maxLen ?? TELEGRAM_MAX_LEN;

  switch (block.type) {
    case 'text': {
      let content = block.content;
      if (content.length > maxLen) {
        content = content.slice(0, maxLen - 1) + '…';
      }

      let formatted = content;
      if (block.format?.bold) formatted = `<b>${formatted}</b>`;
      if (block.format?.italic) formatted = `<i>${formatted}</i>`;
      if (block.format?.monospace) formatted = `<code>${formatted}</code>`;
      if (block.format?.code) formatted = `<code>${formatted}</code>`;
      if (block.format?.color) {
        // Telegram doesn't support arbitrary colors, use inline code for colored text
        formatted = `<code>${formatted}</code>`;
      }
      return formatted;
    }

    case 'section': {
      const title = block.title ? `<b>${block.title}</b>\n` : '';
      const content = Array.isArray(block.content)
        ? block.content.map((b) => blockToTelegramHtml(b, opts)).join('\n')
        : blockToTelegramHtml(block.content, opts);
      return title + content;
    }

    case 'message': {
      const content = Array.isArray(block.content)
        ? block.content.map((b) => blockToTelegramHtml(b, opts)).join('\n')
        : blockToTelegramHtml(block.content, opts);
      return content;
    }

    case 'actions': {
      const actions = block.actions
        .map((a) => {
          const label = `<b>${a.label}</b>`;
          return a.payload ? `${label}: ${a.payload}` : label;
        })
        .join('\n');
      return `\n<i>Actions:</i>\n${actions}`;
    }

    case 'progress': {
      const progress = Math.round(block.progress * 100);
      const message = block.message || 'Processing...';
      return `<i>${message}</i>\n[${'█'.repeat(Math.round((progress / 100) * 20))}${'░'.repeat(20 - Math.round((progress / 100) * 20))}] ${progress}%`;
    }

    case 'divider': {
      return '────────';
    }

    case 'code': {
      const body = block.content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<pre>${body}</pre>`;
    }

    default: {
      return '';
    }
  }
}

/**
 * Render UX blocks to Telegram HTML, respecting message length limits.
 * Truncates content if necessary and adds ellipsis.
 */
export function renderTelegramHtml(blocks: UXBlock[], opts?: TelegramRenderOptions): string {
  const maxLen = Math.max(256, Math.floor(opts?.maxLen ?? TELEGRAM_MAX_LEN));

  const parts: string[] = [];
  let used = 0;
  let truncated = false;

  for (const block of blocks) {
    const piece = blockToTelegramHtml(block, opts);
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
export function renderTelegramPlainText(blocks: UXBlock[], opts?: TelegramRenderOptions): string {
  const maxLen = Math.max(256, Math.floor(opts?.maxLen ?? TELEGRAM_MAX_LEN));
  let text = blocksToPlainText(blocks);

  if (text.length > maxLen) {
    text = text.slice(0, maxLen - 1) + '…';
  }

  if (!text.trim()) text = '⏳ Thinking...';

  return text;
}
