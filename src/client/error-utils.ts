import type { ClientError } from '../client.js';

export function makeClientError(msg: string, status?: number, retryable?: boolean): ClientError {
  const e = new Error(msg) as ClientError;
  e.status = status;
  e.retryable = retryable;
  return e;
}

export function isConnRefused(e: any): boolean {
  const msg = String(e?.message ?? '');
  return e?.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed/i.test(msg);
}

export function isFetchFailed(e: any): boolean {
  return /fetch failed/i.test(String(e?.message ?? ''));
}

export function isConnTimeout(e: any): boolean {
  const msg = String(e?.message ?? '');
  return Boolean(e?.retryable) && /Connection timeout \(\d+ms\)/i.test(msg);
}

export function asError(e: unknown, fallback = 'unknown error'): Error {
  if (e instanceof Error) return e;
  if (e === undefined) return new Error(fallback);
  return new Error(String(e));
}

export function getRetryDelayMs(defaultMs: number): number {
  const raw = process.env.IDLEHANDS_TEST_RETRY_DELAY_MS;
  if (raw == null) return defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultMs;
  return Math.floor(parsed);
}
