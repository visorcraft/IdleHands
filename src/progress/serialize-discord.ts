import type { IRDoc, IRBlock, IRSpan, IRKvItem } from './ir.js';

export type DiscordRenderOptions = {
  maxLen?: number; // keep under 2000; recommended 1900
};

function escapeCodeFence(s: string): string {
  // Avoid closing the fence prematurely.
  return String(s ?? '').replace(/```/g, '``\u200b`');
}

function spanToMd(s: IRSpan): string {
  const t = String(s.text ?? '');
  switch (s.style) {
    case 'bold':
      return `**${t}**`;
    case 'code': {
      const safe = t.replace(/`/g, 'ˋ');
      return `\`${safe}\``;
    }
    case 'dim':
      return `*${t}*`;
    default:
      return t;
  }
}

function kvItemToMd(it: IRKvItem): string {
  const k = spanToMd({ text: it.key, style: it.keyStyle ?? 'bold' });
  const v = spanToMd({ text: it.value, style: it.valueStyle ?? 'plain' });
  return `${k}: ${v}`;
}

function blockToMd(b: IRBlock): string {
  switch (b.type) {
    case 'spacer':
      return '\n'.repeat(Math.max(1, b.lines ?? 1));
    case 'divider':
      return '---';
    case 'lines':
      return (b.lines ?? []).map((ln) => ln.spans.map(spanToMd).join('')).join('\n');
    case 'kv':
      return (b.items ?? []).map(kvItemToMd).join('\n');
    case 'code': {
      const lang = b.lang ? String(b.lang).trim() : '';
      const body = escapeCodeFence((b.lines ?? []).join('\n'));
      return `\`\`\`${lang}\n${body}\n\`\`\``;
    }
    case 'diff': {
      const title = String((b.title ?? 'Δ diff').trim());
      const body = escapeCodeFence((b.lines ?? []).join('\n'));
      return `*${title}*\n\`\`\`diff\n${body}\n\`\`\``;
    }
    case 'markdown':
      return String(b.markdown ?? '');
  }
}

export function renderDiscordMarkdown(doc: IRDoc, opts?: DiscordRenderOptions): string {
  const maxLen = Math.max(256, Math.floor(opts?.maxLen ?? 1900));

  const parts: string[] = [];
  let used = 0;
  let truncated = false;

  for (const block of doc.blocks ?? []) {
    const piece = blockToMd(block);
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
