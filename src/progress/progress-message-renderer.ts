import type { TurnEndEvent } from '../types.js';
import type { IRBlock, IRDoc } from './ir.js';
import { irLine, irKvItem } from './ir.js';

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

  /** Optional: last diff for a recent file mutation (unified diff) */
  diff?: null | {
    title?: string;
    lines: string[];
  };

  /** Optional: perf / usage stats (TurnEndEvent) */
  stats?: TurnEndEvent | null;

  /** Partial assistant output buffer (usually markdown) */
  assistantMarkdown?: string | null;
};

export type ProgressRenderOptions = {
  maxToolLines: number; // default 6
  maxTailLines: number; // default 4
  maxDiffLines: number; // default 40
  maxAssistantChars: number; // default 2000
};

function tail<T>(arr: T[], n: number): T[] {
  if (!Array.isArray(arr) || n <= 0) return [];
  return arr.length <= n ? arr : arr.slice(arr.length - n);
}

function head<T>(arr: T[], n: number): T[] {
  if (!Array.isArray(arr) || n <= 0) return [];
  return arr.length <= n ? arr : arr.slice(0, n);
}

function clipEnd(s: string, maxChars: number): string {
  const t = String(s ?? '');
  if (maxChars <= 0) return '';
  if (t.length <= maxChars) return t;
  return '…' + t.slice(t.length - (maxChars - 1));
}

function fmtMs(ms: number | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r.toFixed(0).padStart(2, '0')}s`;
}

function fmtTps(tps: number | undefined): string | null {
  if (tps == null || !Number.isFinite(tps)) return null;
  return `${tps.toFixed(1)} tok/s`;
}

export class ProgressMessageRenderer {
  private readonly base: ProgressRenderOptions;

  constructor(opts?: Partial<ProgressRenderOptions>) {
    this.base = {
      maxToolLines: opts?.maxToolLines ?? 6,
      maxTailLines: opts?.maxTailLines ?? 4,
      maxDiffLines: opts?.maxDiffLines ?? 40,
      maxAssistantChars: opts?.maxAssistantChars ?? 2000,
    };
  }

  render(input: ProgressRenderInput, override?: Partial<ProgressRenderOptions>): IRDoc {
    const o = { ...this.base, ...(override ?? {}) };

    const blocks: IRBlock[] = [];

    const banner = (input.banner ?? '').trim();
    const status = (input.statusLine ?? '').trim();

    // Header
    const headerLines = [];
    if (banner) headerLines.push(irLine(banner, 'bold'));
    if (status) headerLines.push(irLine(status, banner ? 'dim' : 'dim'));
    if (!headerLines.length) headerLines.push(irLine('⏳ Thinking...', 'dim'));
    blocks.push({ type: 'lines', lines: headerLines });

    // Perf / usage stats (KV)
    const stats = input.stats ?? null;
    if (stats) {
      const items = [];
      items.push(irKvItem('turn', String(stats.turn)));
      items.push(irKvItem('tools', String(stats.toolCalls)));
      const ttft = fmtMs(stats.ttftMs);
      const ttc = fmtMs(stats.ttcMs);
      const pp = fmtTps(stats.ppTps);
      const tg = fmtTps(stats.tgTps);

      if (ttft) items.push(irKvItem('ttft', ttft, 'bold', 'plain'));
      if (ttc) items.push(irKvItem('ttc', ttc, 'bold', 'plain'));
      if (pp) items.push(irKvItem('pp', pp, 'bold', 'plain'));
      if (tg) items.push(irKvItem('tg', tg, 'bold', 'plain'));

      const pTurn = stats.promptTokensTurn;
      const cTurn = stats.completionTokensTurn;
      if (pTurn != null) items.push(irKvItem('promptΔ', String(pTurn)));
      if (cTurn != null) items.push(irKvItem('compΔ', String(cTurn)));

      // Keep it compact
      blocks.push({ type: 'kv', items: items.slice(0, 8) });
    }

    // Tool summary lines
    const toolLines = tail((input.toolLines ?? []).filter(Boolean), o.maxToolLines);
    if (toolLines.length) {
      blocks.push({ type: 'code', lines: toolLines });
    }

    // Diff (prefer showing the *start* of the diff)
    if (input.diff && (input.diff.lines ?? []).length) {
      const title = (input.diff.title ?? 'Δ diff').trim();
      const lines = head((input.diff.lines ?? []).filter((l) => l != null), o.maxDiffLines);
      blocks.push({ type: 'diff', title, lines });
    }

    // Tool tail
    if (input.toolTail) {
      const name = (input.toolTail.name ?? '').trim();
      const stream = input.toolTail.stream === 'stderr' ? 'stderr' : 'stdout';
      const lines = tail((input.toolTail.lines ?? []).filter(Boolean), o.maxTailLines);

      if (lines.length) {
        const label = `↳ ${stream} tail${name ? ` (${name})` : ''}`;
        blocks.push({ type: 'lines', lines: [irLine(label, 'dim')] });
        blocks.push({ type: 'code', lines, lang: stream });
      }
    }

    // Assistant partial
    const assistantRaw = (input.assistantMarkdown ?? '').trim();
    if (assistantRaw) {
      const assistant = clipEnd(assistantRaw, o.maxAssistantChars);
      if (assistant.trim()) blocks.push({ type: 'markdown', markdown: assistant });
    }

    return { blocks };
  }
}
