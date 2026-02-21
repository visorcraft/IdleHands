Below is a **single shared “ProgressMessageRenderer”** that produces a **platform‑agnostic IR**, plus **three serializers** that map that IR into:

* **Telegram HTML** (parse_mode=HTML)
* **Discord Markdown**
* **TUI plain text / ANSI-ready lines**

The goal is: **all UIs call the same renderer**, then each UI just calls its serializer.

I’m intentionally keeping this *minimal but extensible*: blocks + lines + code blocks (+ optional markdown block for partial assistant output).

---

# 1) IR types: `src/progress/ir.ts`

```ts
// src/progress/ir.ts
export type IRDoc = {
  blocks: IRBlock[];
};

export type IRBlock =
  | { type: 'lines'; lines: IRLine[]; monospace?: boolean }
  | { type: 'code'; lines: string[]; lang?: string }
  | { type: 'markdown'; markdown: string }
  | { type: 'divider' }
  | { type: 'spacer'; lines?: number };

export type IRLine = {
  spans: IRSpan[];
};

export type IRSpan = {
  text: string;
  style?: 'plain' | 'bold' | 'dim' | 'code';
};

export function irLine(text: string, style: IRSpan['style'] = 'plain'): IRLine {
  return { spans: [{ text: String(text ?? ''), style }] };
}

export function irJoinLines(lines: string[], style: IRSpan['style'] = 'plain'): IRLine[] {
  return (lines ?? []).map((l) => irLine(l, style));
}
```

This IR is intentionally tiny:

* `lines` blocks can carry styled spans (optional)
* `code` blocks are an array of strings
* `markdown` blocks carry markdown as-is (serializer decides how)

---

# 2) Shared renderer: `src/progress/progress-message-renderer.ts`

This renderer is platform-agnostic and makes decisions like:

* only show last N tool lines
* only show last N tail lines
* only show last N assistant chars
* if there’s no assistant text yet, show the status line so the UI still updates

```ts
// src/progress/progress-message-renderer.ts
import type { IRDoc, IRBlock } from './ir.js';
import { irLine } from './ir.js';

export type ProgressRenderInput = {
  /** Optional: watchdog / compaction banner (short) */
  banner?: string | null;

  /** Something like "⏳ Thinking (15s)" or "🔧 exec: npm test (...)" */
  statusLine?: string | null;

  /** Lines like: "◆ read_file src/agent.ts..." then "✓ exec: ..." */
  toolLines?: string[] | null;

  /** Optional tail (typically from ToolTailBuffer.get(activeToolId)) */
  toolTail?: null | {
    name?: string;
    stream: 'stdout' | 'stderr';
    lines: string[];
  };

  /** Partial assistant output buffer (usually markdown) */
  assistantMarkdown?: string | null;
};

export type ProgressRenderOptions = {
  maxToolLines: number;        // default 6
  maxTailLines: number;        // default 4
  maxAssistantChars: number;   // default 2000

  /** Prefer code block for toolLines (recommended) */
  toolLinesAsCode: boolean;    // default true

  /** Show status even if assistant has content */
  showStatusAlways: boolean;   // default false

  /** If assistant is empty, render status line */
  showStatusWhenEmpty: boolean; // default true
};

function tail<T>(arr: T[], n: number): T[] {
  if (!Array.isArray(arr) || n <= 0) return [];
  return arr.length <= n ? arr : arr.slice(arr.length - n);
}

function clipEnd(s: string, maxChars: number): string {
  const t = String(s ?? '');
  if (maxChars <= 0) return '';
  if (t.length <= maxChars) return t;
  return '…' + t.slice(t.length - (maxChars - 1));
}

export class ProgressMessageRenderer {
  private readonly base: ProgressRenderOptions;

  constructor(opts?: Partial<ProgressRenderOptions>) {
    this.base = {
      maxToolLines: opts?.maxToolLines ?? 6,
      maxTailLines: opts?.maxTailLines ?? 4,
      maxAssistantChars: opts?.maxAssistantChars ?? 2000,
      toolLinesAsCode: opts?.toolLinesAsCode ?? true,
      showStatusAlways: opts?.showStatusAlways ?? false,
      showStatusWhenEmpty: opts?.showStatusWhenEmpty ?? true,
    };
  }

  render(input: ProgressRenderInput, override?: Partial<ProgressRenderOptions>): IRDoc {
    const o = { ...this.base, ...(override ?? {}) };

    const blocks: IRBlock[] = [];

    const banner = (input.banner ?? '').trim();
    const status = (input.statusLine ?? '').trim();

    const toolLines = tail((input.toolLines ?? []).filter(Boolean), o.maxToolLines);
    const assistant = clipEnd((input.assistantMarkdown ?? '').trim(), o.maxAssistantChars);

    const tailInfo = input.toolTail
      ? {
          name: (input.toolTail.name ?? '').trim(),
          stream: input.toolTail.stream,
          lines: tail((input.toolTail.lines ?? []).filter(Boolean), o.maxTailLines),
        }
      : null;

    // Banner first (watchdog/compaction/etc.)
    if (banner) {
      blocks.push({ type: 'lines', lines: [irLine(banner, 'bold')] });
      blocks.push({ type: 'spacer', lines: 1 });
    }

    // Tool lines (monospace)
    if (toolLines.length) {
      if (o.toolLinesAsCode) {
        blocks.push({ type: 'code', lines: toolLines });
      } else {
        blocks.push({ type: 'lines', lines: toolLines.map((l) => irLine(l, 'plain')), monospace: true });
      }
      blocks.push({ type: 'spacer', lines: 1 });
    }

    // Tool tail (if any)
    if (tailInfo && tailInfo.lines.length) {
      const label = `↳ ${tailInfo.stream} tail${tailInfo.name ? ` (${tailInfo.name})` : ''}`;
      blocks.push({ type: 'lines', lines: [irLine(label, 'dim')] });
      blocks.push({ type: 'code', lines: tailInfo.lines, lang: tailInfo.stream });
      blocks.push({ type: 'spacer', lines: 1 });
    }

    // Status line (optionally)
    if (status && (o.showStatusAlways || (!assistant && o.showStatusWhenEmpty))) {
      blocks.push({ type: 'lines', lines: [irLine(status, 'dim')] });
      if (!assistant) return { blocks }; // keep updates compact when no assistant text yet
      blocks.push({ type: 'spacer', lines: 1 });
    }

    // Partial assistant markdown (or final text, if you reuse this renderer there)
    if (assistant) {
      blocks.push({ type: 'markdown', markdown: assistant });
    }

    // If absolutely nothing, show a minimal placeholder
    if (!blocks.length) {
      blocks.push({ type: 'lines', lines: [irLine('⏳ Thinking…', 'dim')] });
    }

    // Trim trailing spacers
    while (blocks.length && blocks[blocks.length - 1].type === 'spacer') blocks.pop();

    return { blocks };
  }
}
```

---

# 3) Serializers (IR → Telegram HTML / Discord Markdown / TUI text)

## 3.1 Telegram HTML: `src/progress/serialize-telegram.ts`

Uses Telegram HTML rules and **avoids breaking tags** by truncating only at block boundaries.

```ts
// src/progress/serialize-telegram.ts
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
```

## 3.2 Discord Markdown: `src/progress/serialize-discord.ts`

````ts
// src/progress/serialize-discord.ts
import type { IRDoc, IRBlock, IRSpan } from './ir.js';

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
      // Minimal inline code safety
      const safe = t.replace(/`/g, 'ˋ');
      return `\`${safe}\``;
    }
    case 'dim':
      // No true dim in markdown; italic is usually fine.
      return `*${t}*`;
    default:
      return t;
  }
}

function blockToMd(b: IRBlock): string {
  switch (b.type) {
    case 'spacer': {
      const n = Math.max(1, b.lines ?? 1);
      return '\n'.repeat(n);
    }
    case 'divider':
      return '---';
    case 'lines':
      return (b.lines ?? []).map((ln) => ln.spans.map(spanToMd).join('')).join('\n');
    case 'code': {
      const lang = b.lang ? String(b.lang).trim() : '';
      const body = escapeCodeFence((b.lines ?? []).join('\n'));
      return `\`\`\`${lang}\n${body}\n\`\`\``;
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
````

## 3.3 TUI plain text: `src/progress/serialize-tui.ts`

This returns **lines** so your TUI can decide where to show them (status bar vs transcript).

```ts
// src/progress/serialize-tui.ts
import type { IRDoc, IRBlock } from './ir.js';

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
```

---

# 4) How each UI uses it

The UIs should not decide formatting anymore. They just:

1. build a `ProgressRenderInput`
2. call `renderer.render(...)` to get `IRDoc`
3. call the platform serializer

## 4.1 Telegram bot (inside `StreamingMessage.render()`)

```ts
import { ProgressMessageRenderer } from '../progress/progress-message-renderer.js';
import { renderTelegramHtml } from '../progress/serialize-telegram.js';

private renderer = new ProgressMessageRenderer({
  maxToolLines: 6,
  maxTailLines: 4,
  maxAssistantChars: 2400,
});

private render(): string {
  const tail = this.activeToolId ? this.tails.get(this.activeToolId) : null;

  const doc = this.renderer.render({
    banner: this.bannerText ?? null,
    statusLine: this.statusLine,                 // from TurnProgressController
    toolLines: this.toolLines,
    toolTail: tail ? { name: tail.name, stream: tail.stream, lines: tail.lines } : null,
    assistantMarkdown: this.buffer,              // partial assistant output
  });

  // Telegram edit: keep under 4096 always
  return renderTelegramHtml(doc, { maxLen: 4096 });
}
```

## 4.2 Discord bot (inside your placeholder edit loop)

```ts
import { ProgressMessageRenderer } from '../progress/progress-message-renderer.js';
import { renderDiscordMarkdown } from '../progress/serialize-discord.js';

private renderer = new ProgressMessageRenderer({
  maxToolLines: 6,
  maxTailLines: 4,
  maxAssistantChars: 1400, // Discord has tighter limits
});

private renderForEdit(): string {
  const tail = this.activeToolId ? this.tails.get(this.activeToolId) : null;

  const doc = this.renderer.render({
    banner: this.bannerText ?? null,
    statusLine: this.statusLine,
    toolLines: this.toolLines,
    toolTail: tail ? { name: tail.name, stream: tail.stream, lines: tail.lines } : null,
    assistantMarkdown: this.buffer,
  });

  return renderDiscordMarkdown(doc, { maxLen: 1900 });
}
```

## 4.3 TUI (status bar + optional tool panel)

You can choose to show:

* just the **first non-empty** line as status bar text
* show the full `renderTuiLines` output in your “logs” pane

```ts
import { ProgressMessageRenderer } from '../progress/progress-message-renderer.js';
import { renderTuiLines } from '../progress/serialize-tui.js';

const renderer = new ProgressMessageRenderer({ maxAssistantChars: 800 });

function onProgressFlush() {
  const doc = renderer.render({
    statusLine: snap.statusLine,
    toolLines: snap.toolLines,
    toolTail: tail ? { name: tail.name, stream: tail.stream, lines: tail.lines } : null,
    assistantMarkdown: streamedSoFar,
  });

  const lines = renderTuiLines(doc, { maxLines: 8 });
  const status = lines.find((l) => l.trim().length) ?? '';

  dispatch({ type: 'STATUS_SET', text: status });
  // optional: dispatch({ type:'PROGRESS_PANEL_SET', lines });
}
```

---

# 5) Why this IR approach pays off

* The **composition logic** (what to show, how many tool lines, how to clip assistant text, where status appears) is in one place: `ProgressMessageRenderer`.
* Each UI is reduced to a **tiny serializer + transport** (edit message / redraw screen).
* Adding a new UI (Slack, web UI, etc.) is: implement one serializer.

---

# 6) Small recommendation: keep renderer budgets “UI‑aware” but centralized

Practical defaults I’ve seen work:

* Telegram:

  * `maxAssistantChars ~ 2400`
  * `maxToolLines 6`
  * `maxTailLines 4`
  * `bucketMs 5000` (from progress controller)
* Discord:

  * `maxAssistantChars 1200–1600`
  * `maxLen 1900`
* TUI:

  * `maxLines 6–12` depending on your layout

You can encode these defaults in a single config object (e.g., `renderBudgets.telegram`, `.discord`, `.tui`) so it’s still centralized.

---

