/**
 * Message edit scheduler - throttles message edits to avoid rate limits.
 * Adapted from IdleHands.
 */

export type EditErrorClass = "retry" | "fatal" | "ignore";

export type ClassifiedError = {
  kind: EditErrorClass;
  retryAfterMs?: number;
  message?: string;
};

export type MessageSchedulerOptions = {
  /** How often to check for updates (default: 1500ms) */
  intervalMs?: number;
  /** Max backoff on rate limits (default: 30000ms) */
  maxBackoffMs?: number;
  /** Jitter for backoff (default: 500ms) */
  jitterMs?: number;
};

export type MessageSchedulerCallbacks = {
  /** Render current content to string */
  render: () => string;
  /** Apply text to the message (edit API call) */
  apply: (text: string) => Promise<void>;
  /** Check if content has changed since last render */
  isDirty: () => boolean;
  /** Clear dirty flag after successful apply */
  clearDirty: () => void;
  /** Classify an error for retry/fatal/ignore */
  classifyError?: (error: unknown) => ClassifiedError;
};

function defaultClassifyError(e: unknown): ClassifiedError {
  const err = e as Record<string, unknown>;
  const status = (err?.status ?? err?.httpStatus ?? 0) as number;
  const msg = String(err?.message ?? e);

  // Discord rate limit
  if (status === 429) {
    const retryAfter =
      ((err?.retryAfter ?? (err?.data as Record<string, unknown>)?.retry_after) as number) ?? 5;
    return { kind: "retry", retryAfterMs: retryAfter * 1000, message: msg };
  }

  // Server errors - retry
  if (status >= 500) {
    return { kind: "retry", retryAfterMs: 2000, message: msg };
  }

  // Client errors (except 404) - fatal
  if (status >= 400 && status < 500 && status !== 404) {
    return { kind: "fatal", message: msg };
  }

  // Rate limit in message
  if (msg.includes("rate limit") || msg.includes("Too Many Requests")) {
    return { kind: "retry", retryAfterMs: 5000, message: msg };
  }

  return { kind: "ignore", message: msg };
}

export class MessageEditScheduler {
  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly jitterMs: number;
  private readonly callbacks: MessageSchedulerCallbacks;
  private readonly classifyError: (e: unknown) => ClassifiedError;

  private timer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 0;
  private lastText = "";
  private stopped = false;
  private inFlight = false;

  constructor(callbacks: MessageSchedulerCallbacks, opts?: MessageSchedulerOptions) {
    this.callbacks = callbacks;
    this.intervalMs = Math.max(250, opts?.intervalMs ?? 1500);
    this.maxBackoffMs = opts?.maxBackoffMs ?? 30000;
    this.jitterMs = opts?.jitterMs ?? 500;
    this.classifyError = callbacks.classifyError ?? defaultClassifyError;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Force an immediate edit (bypasses throttle, used for finalization) */
  async flush(): Promise<void> {
    if (this.inFlight) {
      return;
    }

    const text = this.callbacks.render();
    if (!text || text === this.lastText) {
      this.callbacks.clearDirty();
      return;
    }

    this.inFlight = true;
    try {
      await this.callbacks.apply(text);
      this.lastText = text;
      this.callbacks.clearDirty();
    } finally {
      this.inFlight = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }

    // Backoff countdown
    if (this.backoffMs > 0) {
      this.backoffMs = Math.max(0, this.backoffMs - this.intervalMs);
      return;
    }

    // Skip if nothing changed
    if (!this.callbacks.isDirty()) {
      return;
    }

    // Prevent overlapping edits
    if (this.inFlight) {
      return;
    }

    const text = this.callbacks.render();
    if (!text || text === this.lastText) {
      this.callbacks.clearDirty();
      return;
    }

    this.inFlight = true;
    try {
      await this.callbacks.apply(text);
      this.lastText = text;
      this.callbacks.clearDirty();
      this.backoffMs = 0;
    } catch (e: unknown) {
      const classified = this.classifyError(e);

      if (classified.kind === "retry" && classified.retryAfterMs) {
        const baseRetry = Math.max(0, classified.retryAfterMs);
        const jitterCap = Math.min(this.jitterMs, Math.max(0, Math.floor(baseRetry / 2)));
        const jitter = jitterCap > 0 ? Math.floor(Math.random() * (jitterCap + 1)) : 0;
        this.backoffMs = Math.min(baseRetry + jitter, this.maxBackoffMs);
      } else if (classified.kind === "fatal") {
        console.error(`[message-scheduler] fatal edit error: ${classified.message ?? String(e)}`);
        this.stop();
      }
      // 'ignore' - continue
    } finally {
      this.inFlight = false;
    }
  }
}
