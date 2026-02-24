/**
 * Track 503 errors over a rolling window and impose escalating back-off.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  private backoffLevel = 0;

  constructor(
    readonly windowMs = 60_000,
    readonly threshold = 5,
    readonly maxBackoffMs = 60_000
  ) {}

  recordRetryableError(): void {
    this.timestamps.push(Date.now());
    this.prune();
    if (this.timestamps.length >= this.threshold) {
      this.backoffLevel = Math.min(this.backoffLevel + 1, 6);
    }
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }

  getDelay(): number {
    this.prune();
    if (this.timestamps.length < this.threshold) {
      if (this.timestamps.length === 0) this.backoffLevel = 0;
      return 0;
    }
    return Math.min(Math.pow(2, this.backoffLevel) * 1000, this.maxBackoffMs);
  }

  get recentCount(): number {
    this.prune();
    return this.timestamps.length;
  }

  reset(): void {
    this.timestamps = [];
    this.backoffLevel = 0;
  }
}

/** Track response times and detect overload/backpressure spikes. */
export class BackpressureMonitor {
  private times: number[] = [];
  private readonly maxSamples: number;
  readonly multiplier: number;

  constructor(opts?: { maxSamples?: number; multiplier?: number }) {
    this.maxSamples = opts?.maxSamples ?? 20;
    this.multiplier = opts?.multiplier ?? 3;
  }

  record(responseMs: number): { warn: boolean; avg: number; current: number } {
    const avg = this.average;
    this.times.push(responseMs);
    if (this.times.length > this.maxSamples) {
      this.times.shift();
    }

    if (this.times.length < 3) return { warn: false, avg, current: responseMs };

    const warn = avg > 0 && responseMs > avg * this.multiplier;
    return { warn, avg, current: responseMs };
  }

  get average(): number {
    if (!this.times.length) return 0;
    const sum = this.times.reduce((a, b) => a + b, 0);
    return sum / this.times.length;
  }

  get samples(): number {
    return this.times.length;
  }

  reset(): void {
    this.times = [];
  }
}
