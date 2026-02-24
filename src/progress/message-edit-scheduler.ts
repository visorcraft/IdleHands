export type EditErrorClass = 'retry' | 'fatal' | 'ignore';

export type ClassifiedError = {
  kind: EditErrorClass;
  retryAfterMs?: number;
  message?: string;
};

export type MessageEditSchedulerOptions = {
  intervalMs: number;
  render: () => string;
  apply: (text: string) => Promise<void>;
  isDirty: () => boolean;
  clearDirty: () => void;
  classifyError: (error: unknown) => ClassifiedError;
  maxBackoffMs?: number;
  jitterMs?: number;
};

export class MessageEditScheduler {
  private readonly opts: MessageEditSchedulerOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 0;
  private lastText = '';
  private stopped = false;
  private inFlight = false;

  constructor(opts: MessageEditSchedulerOptions) {
    this.opts = {
      maxBackoffMs: 30_000,
      jitterMs: 500,
      ...opts,
    };
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    // Backoff countdown
    if (this.backoffMs > 0) {
      this.backoffMs = Math.max(0, this.backoffMs - this.opts.intervalMs);
      return;
    }

    // Skip if nothing changed
    if (!this.opts.isDirty()) return;

    // Prevent overlapping edits
    if (this.inFlight) return;

    const text = this.opts.render();
    if (!text || text === this.lastText) {
      this.opts.clearDirty();
      return;
    }

    this.inFlight = true;
    try {
      await this.opts.apply(text);
      this.lastText = text;
      this.opts.clearDirty();
      this.backoffMs = 0;
    } catch (e: unknown) {
      const classified = this.opts.classifyError(e);

      if (classified.kind === 'retry' && classified.retryAfterMs) {
        const baseRetry = Math.max(0, classified.retryAfterMs);
        // Keep jitter proportional so very small retry windows stay small in tests/runtime.
        const jitterCap = Math.min(
          this.opts.jitterMs ?? 500,
          Math.max(0, Math.floor(baseRetry / 2))
        );
        const jitter = jitterCap > 0 ? Math.floor(Math.random() * (jitterCap + 1)) : 0;
        this.backoffMs = Math.min(baseRetry + jitter, this.opts.maxBackoffMs ?? 30_000);
      } else if (classified.kind === 'fatal') {
        console.error(`[scheduler] fatal edit error: ${classified.message ?? String(e)}`);
        this.stop();
      }
      // 'ignore' - do nothing, continue
    } finally {
      this.inFlight = false;
    }
  }
}

export function classifyTelegramEditError(e: unknown): ClassifiedError {
  const err = e as any;
  const desc = err?.description ?? err?.message ?? '';

  if (desc.includes('Too Many Requests') || desc.includes('429')) {
    const retryAfter = (err?.parameters?.retry_after ?? 3) * 1000;
    return { kind: 'retry', retryAfterMs: retryAfter, message: desc };
  }

  if (desc.includes('message is not modified')) {
    return { kind: 'ignore' };
  }

  if (desc.includes('message to edit not found')) {
    return { kind: 'fatal', message: desc };
  }

  // Unknown Telegram edit errors are usually transient/provider-side; retry conservatively.
  return { kind: 'retry', retryAfterMs: 3000, message: desc };
}

export function classifyDiscordEditError(e: unknown): ClassifiedError {
  const err = e as any;
  const status = err?.status ?? err?.httpStatus ?? 0;
  const msg = err?.message ?? String(e);

  if (status === 429) {
    const retryAfter = ((err?.retryAfter ?? err?.data?.retry_after) as number) ?? 5;
    return { kind: 'retry', retryAfterMs: retryAfter * 1000, message: msg };
  }

  if (status >= 500) {
    return { kind: 'retry', retryAfterMs: 2000, message: msg };
  }

  if (status >= 400 && status < 500 && status !== 404) {
    return { kind: 'fatal', message: msg };
  }

  if (msg.includes('rate limit') || msg.includes('Too Many Requests')) {
    return { kind: 'retry', retryAfterMs: 5000, message: msg };
  }

  return { kind: 'ignore', message: msg };
}
