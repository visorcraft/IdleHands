import type { IRDoc } from './ir.js';

export type TuiRenderOptions = {
  maxLines?: number;
};

export function renderTuiLines(doc: IRDoc, opts?: TuiRenderOptions): string[] {
  const maxLines = Math.max(1, Math.floor(opts?.maxLines ?? 12));
  const out: string[] = [];

  const push = (s: string) => {
    for (const line of String(s ?? '').split('\n')) out.push(line);
  };

  for (const b of doc.blocks ?? []) {
    if (b.type === 'spacer') {
      const n = Math.max(1, b.lines ?? 1);
      for (let i = 0; i < n; i++) out.push('');
      continue;
    }
    if (b.type === 'divider') {
      out.push('────────────────────────');
      continue;
    }
    if (b.type === 'lines') {
      for (const ln of b.lines ?? []) push(ln.spans.map((sp) => sp.text ?? '').join(''));
      continue;
    }
    if (b.type === 'kv') {
      for (const it of b.items ?? []) out.push(`${it.key}: ${it.value}`);
      continue;
    }
    if (b.type === 'diff') {
      const title = (b.title ?? 'Δ diff').trim();
      if (title) out.push(title);
      for (const ln of b.lines ?? []) out.push('  ' + ln);
      continue;
    }
    if (b.type === 'code') {
      // Indent code blocks lightly for readability
      for (const ln of b.lines ?? []) out.push('  ' + ln);
      continue;
    }
    if (b.type === 'markdown') {
      // TUI: keep raw markdown for now; you can strip/pretty-print later.
      push(b.markdown ?? '');
      continue;
    }
  }

  // Keep it bounded
  return out.length <= maxLines ? out : out.slice(out.length - maxLines);
}
