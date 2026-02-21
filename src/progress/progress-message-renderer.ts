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
  maxToolLines: number; // default 6
  maxTailLines: number; // default 4
  maxAssistantChars: number; // default 2000

  /** Prefer code block for toolLines (recommended) */
  toolLinesAsCode: boolean; // default true

  /** Show status even if assistant has content */
  showStatusAlways: boolean; // default false

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
