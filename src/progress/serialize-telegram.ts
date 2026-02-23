import { markdownToTelegramHtml, escapeHtml } from '../bot/format.js';

import type { IRDoc, IRBlock, IRSpan, IRKvItem } from './ir.js';

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
      // Telegram HTML doesn't have dim; italic is a good soft cue.
      return `<i>${t}</i>`;
    default:
      return t;
  }
}

function kvItemToHtml(it: IRKvItem): string {
  const k = spanToHtml({ text: it.key, style: it.keyStyle ?? 'bold' });
  const v = spanToHtml({ text: it.value, style: it.valueStyle ?? 'plain' });
  return `${k}: ${v}`;
}

function blockToHtml(b: IRBlock): string {
  switch (b.type) {
    case 'spacer':
      return '\n'.repeat(Math.max(1, b.lines ?? 1));
    case 'divider':
      return '────────';
    case 'lines':
      return (b.lines ?? []).map((ln) => ln.spans.map(spanToHtml).join('')).join('\n');
    case 'kv':
      return (b.items ?? []).map(kvItemToHtml).join('\n');
    case 'code': {
      const body = escapeHtml((b.lines ?? []).join('\n'));
      return `<pre>${body}</pre>`;
    }
    case 'diff': {
      const title = escapeHtml((b.title ?? 'Δ diff').trim());
      const body = escapeHtml((b.lines ?? []).join('\n'));
      return `<i>${title}</i>\n<pre>${body}</pre>`;
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
