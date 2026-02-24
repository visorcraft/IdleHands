import type { ToolStreamEvent } from '../types.js';

export type ExecStreamContext = {
  onToolStream?: (ev: ToolStreamEvent) => void | Promise<void>;
  toolCallId?: string;
  toolName?: string;
  toolStreamIntervalMs?: number;
  toolStreamMaxChunkChars?: number;
  toolStreamMaxBufferChars?: number;
};

/** Best-effort quote stripping for lightweight shell pattern checks. */
export function stripSimpleQuotedSegments(s: string): string {
  return s
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** Detect standalone '&' background token (not &&, >&2, <&, &>). */
export function hasBackgroundExecIntent(command: string): boolean {
  const stripped = stripSimpleQuotedSegments(command);
  return /(^|[;\s])&(?![&><\d])(?=($|[;\s]))/.test(stripped);
}

/** Fire-and-forget helper that safely swallows async/sync errors. */
export function safeFireAndForget(fn: (() => void | Promise<void>) | undefined): void {
  if (!fn) return;
  try {
    const r = fn();
    if (r && typeof (r as any).catch === 'function') (r as any).catch(() => {});
  } catch {
    // best effort only
  }
}

/** Build throttled stdout/stderr streaming callbacks for exec tool output. */
export function makeExecStreamer(ctx: ExecStreamContext) {
  const cb = ctx.onToolStream;
  if (!cb) return null;

  const id = ctx.toolCallId ?? '';
  const name = ctx.toolName ?? 'exec';

  const intervalMs = Math.max(50, Math.floor(ctx.toolStreamIntervalMs ?? 750));
  const maxChunkChars = Math.max(80, Math.floor(ctx.toolStreamMaxChunkChars ?? 900));
  const maxBufferChars = Math.max(
    maxChunkChars,
    Math.floor(ctx.toolStreamMaxBufferChars ?? 12_000)
  );

  let outBuf = '';
  let errBuf = '';
  let lastEmit = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = (stream: 'stdout' | 'stderr', chunk: string) => {
    const trimmed = chunk.length > maxChunkChars ? chunk.slice(-maxChunkChars) : chunk;
    const ev: ToolStreamEvent = { id, name, stream, chunk: trimmed };
    safeFireAndForget(() => cb(ev));
  };

  const schedule = () => {
    if (timer) return;
    const delay = Math.max(0, intervalMs - (Date.now() - lastEmit));
    timer = setTimeout(() => {
      timer = null;
      flush(false);
    }, delay);
  };

  const flush = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < intervalMs) {
      schedule();
      return;
    }
    lastEmit = now;

    if (outBuf) {
      emit('stdout', outBuf);
      outBuf = '';
    }
    if (errBuf) {
      emit('stderr', errBuf);
      errBuf = '';
    }
  };

  const push = (stream: 'stdout' | 'stderr', textRaw: string) => {
    // Keep raw chunks here; caller can pre-process if needed.
    const text = textRaw.replace(/\r/g, '\n');
    if (!text) return;

    if (stream === 'stdout') outBuf += text;
    else errBuf += text;

    if (outBuf.length > maxBufferChars) outBuf = outBuf.slice(-maxBufferChars);
    if (errBuf.length > maxBufferChars) errBuf = errBuf.slice(-maxBufferChars);

    schedule();
  };

  const done = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flush(true);
  };

  return { push, done };
}
