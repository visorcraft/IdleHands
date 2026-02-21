import type { IRDoc, IRBlock, IRSpan } from './ir.js';
import { markdownToTelegramHtml, escapeHtml } from '../bot/format.js';

export type TelegramRenderOptions = {
  maxLen?: number; // Telegram hard limit: 4096
};

function spanToHtml(s: IRSpan): string {
  const t = escapeHtml(s.text ?? '');
  switch (s.style) {
    case 'bold':
      return `<b>${t}</b>`;
    case 'code':
      return `<code>${t}</code>`;
    case 'dim':
      // Telegram HTML doesn’t have a "dim" style. Use italics as a soft cue.
      return `<i>${t}</i>`;
    default:
      return t;
  }
}

function blockToHtml(b: IRBlock): string {
  switch (b.type) {
    case 'spacer': {
      const n = Math.max(1, b.lines ?? 1);
      return '\n'.repeat(n);
    }
    case 'divider':
      return '────────';
    case 'lines':
      return (b.lines ?? []).map((ln) => ln.spans.map(spanToHtml).join('')).join('\n');
    case 'code': {
      const body = escapeHtml((b.lines ?? []).join('\n'));
      return `<pre>${body}</pre>`;
    }
    case 'markdown':
      return markdownToTelegramHtml(b.markdown ?? '');
  }
}

export function renderTelegramHtml(doc: IRDoc, opts?: TelegramRenderOptions): string {
  const maxLen = Math.max(256, Math.floor(opts?.maxLen ?? 4096));

  const parts: string[] = [];
  let used = 0;
  let truncated = false;

  for (const block of doc.blocks ?? []) {
    const piece = blockToHtml(block);

    // Add a blank line between non-spacer blocks
    const sep = (parts.length && block.type !== 'spacer') ? '\n\n' : '';
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
  if (!out.trim()) out = '⏳ Thinking…';

  return out;
}
