import type { ToolStreamEvent } from '../types.js';

export type ToolTailSnapshot = {
  id: string;
  name: string;
  stream: 'stdout' | 'stderr';
  lines: string[];
  updatedAt: number;
};

type TailState = {
  name: string;
  stream: 'stdout' | 'stderr';
  buf: string;
  updatedAt: number;
};

export class ToolTailBuffer {
  private byId = new Map<string, TailState>();
  private readonly maxChars: number;
  private readonly maxLines: number;

  constructor(opts?: { maxChars?: number; maxLines?: number }) {
    this.maxChars = Math.max(256, Math.floor(opts?.maxChars ?? 4096));
    this.maxLines = Math.max(1, Math.floor(opts?.maxLines ?? 4));
  }

  reset(id: string, name: string): void {
    this.byId.set(id, { name, stream: 'stdout', buf: '', updatedAt: Date.now() });
  }

  clear(id: string): void {
    this.byId.delete(id);
  }

  push(ev: ToolStreamEvent): ToolTailSnapshot | null {
    if (!ev?.id) return null;

    const cur = this.byId.get(ev.id) ?? {
      name: ev.name ?? 'tool',
      stream: ev.stream,
      buf: '',
      updatedAt: 0,
    };

    cur.name = ev.name ?? cur.name;
    cur.stream = ev.stream === 'stderr' ? 'stderr' : 'stdout';
    cur.updatedAt = Date.now();

    cur.buf += (ev.chunk ?? '').replace(/\r/g, '\n');
    if (cur.buf.length > this.maxChars) cur.buf = cur.buf.slice(-this.maxChars);

    this.byId.set(ev.id, cur);
    return this.get(ev.id);
  }

  get(id: string): ToolTailSnapshot | null {
    const cur = this.byId.get(id);
    if (!cur) return null;

    const rawLines = cur.buf.split(/\r?\n/);
    const lines = rawLines.filter((l) => l.trim().length > 0).slice(-this.maxLines);

    return {
      id,
      name: cur.name,
      stream: cur.stream,
      lines,
      updatedAt: cur.updatedAt,
    };
  }
}
