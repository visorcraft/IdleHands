/**
 * Resilient Provider Wrapper
 *
 * Three-level failover strategy for LLM API calls:
 *   1. Retry loop — exponential backoff with Retry-After parsing
 *   2. Provider chain — try next provider on exhausted retries
 *   3. Model fallback — try fallback models when all providers fail
 *
 * Additional features:
 * - Non-retryable error detection (401, 403, context window exceeded)
 * - Rate-limit detection with key rotation
 * - Business/quota error detection (plan limits, insufficient balance)
 *
 * Inspired by ZeroClaw's reliable.rs.
 */

// ── Error Classification ─────────────────────────────────────────────────

/** Check if an error is non-retryable (client errors that won't resolve with retries). */
export function isNonRetryable(err: Error | string): boolean {
  const msg = typeof err === 'string' ? err : err.message;
  const lower = msg.toLowerCase();

  if (isContextWindowExceeded(msg)) return true;

  // Check for HTTP status codes
  const statusMatch = msg.match(/\b(4\d{2})\b/);
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10);
    // 4xx errors are non-retryable except 429 (rate-limit) and 408 (timeout)
    if (code >= 400 && code < 500 && code !== 429 && code !== 408) return true;
  }

  // Auth/model failure keywords
  const authHints = [
    'invalid api key', 'incorrect api key', 'missing api key', 'api key not set',
    'authentication failed', 'auth failed', 'unauthorized', 'forbidden',
    'permission denied', 'access denied', 'invalid token',
  ];
  if (authHints.some((h) => lower.includes(h))) return true;

  // Model not found
  if (lower.includes('model') && (
    lower.includes('not found') || lower.includes('unknown') ||
    lower.includes('unsupported') || lower.includes('does not exist') ||
    lower.includes('invalid')
  )) return true;

  return false;
}

/** Check if error is a context window exceeded error. */
export function isContextWindowExceeded(msg: string): boolean {
  const lower = msg.toLowerCase();
  const hints = [
    'exceeds the context window', 'context window of this model',
    'maximum context length', 'context length exceeded',
    'too many tokens', 'token limit exceeded',
    'prompt is too long', 'input is too long',
  ];
  return hints.some((h) => lower.includes(h));
}

/** Check if error is a rate-limit (429). */
export function isRateLimited(err: Error | string): boolean {
  const msg = typeof err === 'string' ? err : err.message;
  return msg.includes('429') && (
    msg.includes('Too Many') || msg.toLowerCase().includes('rate') || msg.toLowerCase().includes('limit')
  );
}

/** Check if a 429 is a business/quota error that retries cannot fix. */
export function isNonRetryableRateLimit(err: Error | string): boolean {
  const msg = typeof err === 'string' ? err : err.message;
  if (!isRateLimited(msg)) return false;

  const lower = msg.toLowerCase();
  const businessHints = [
    'plan does not include', "doesn't include", 'not include',
    'insufficient balance', 'insufficient_balance',
    'insufficient quota', 'insufficient_quota',
    'quota exhausted', 'out of credits',
    'no available package', 'package not active',
    'purchase package', 'model not available for your plan',
  ];
  return businessHints.some((h) => lower.includes(h));
}

/** Try to extract a Retry-After value (in milliseconds) from an error message. */
export function parseRetryAfterMs(err: Error | string): number | null {
  const msg = typeof err === 'string' ? err : err.message;
  const lower = msg.toLowerCase();

  for (const prefix of ['retry-after:', 'retry_after:', 'retry-after ', 'retry_after ']) {
    const pos = lower.indexOf(prefix);
    if (pos === -1) continue;
    const after = msg.slice(pos + prefix.length).trim();
    const numStr = after.match(/^[\d.]+/)?.[0];
    if (numStr) {
      const secs = parseFloat(numStr);
      if (Number.isFinite(secs) && secs >= 0) {
        return Math.round(secs * 1000);
      }
    }
  }
  return null;
}

// ── Resilient Wrapper ────────────────────────────────────────────────────

export interface ResilientProviderOptions {
  /** Maximum retries per provider attempt. Default: 2. */
  maxRetries?: number;
  /** Base backoff in ms. Default: 500. */
  baseBackoffMs?: number;
  /** Model fallback chains: modelName → [fallback1, fallback2, ...] */
  modelFallbacks?: Record<string, string[]>;
  /** Extra API keys for round-robin rotation on rate limits. */
  apiKeys?: string[];
  /** Called before each retry with attempt info. */
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  error: string;
  provider: string;
  model: string;
  reason: 'retryable' | 'rate_limited' | 'non_retryable';
  backoffMs: number;
}

export interface ProviderCall<T> {
  /** Provider name for logging. */
  name: string;
  /** Execute the call. */
  execute: (model: string) => Promise<T>;
}

/**
 * Execute a call with retry + provider fallback + model fallback.
 *
 * Usage:
 * ```ts
 * const result = await resilientCall(
 *   [{ name: 'primary', execute: (model) => client.chat(model, messages) }],
 *   'gpt-4',
 *   { maxRetries: 2, modelFallbacks: { 'gpt-4': ['gpt-3.5-turbo'] } }
 * );
 * ```
 */
export async function resilientCall<T>(
  providers: ProviderCall<T>[],
  model: string,
  options: ResilientProviderOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const baseBackoffMs = Math.max(50, options.baseBackoffMs ?? 500);
  const modelChain = [model, ...(options.modelFallbacks?.[model] ?? [])];
  const apiKeys = options.apiKeys ?? [];
  let keyIndex = 0;
  const failures: string[] = [];

  for (const currentModel of modelChain) {
    for (const provider of providers) {
      let backoffMs = baseBackoffMs;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await provider.execute(currentModel);
          return result;
        } catch (rawErr) {
          const err = rawErr instanceof Error ? rawErr : new Error(String(rawErr));
          const nonRetryableRL = isNonRetryableRateLimit(err);
          const nonRetryable = isNonRetryable(err) || nonRetryableRL;
          const rateLimited = isRateLimited(err);

          const reason: RetryInfo['reason'] = rateLimited && nonRetryable
            ? 'non_retryable'
            : rateLimited
              ? 'rate_limited'
              : nonRetryable
                ? 'non_retryable'
                : 'retryable';

          failures.push(
            `provider=${provider.name} model=${currentModel} attempt ${attempt + 1}/${maxRetries + 1}: ${reason}; error=${err.message.slice(0, 200)}`
          );

          // Rotate API key on rate limit
          if (rateLimited && !nonRetryableRL && apiKeys.length > 0) {
            keyIndex = (keyIndex + 1) % apiKeys.length;
          }

          // Context window exceeded — abort everything
          if (isContextWindowExceeded(err.message)) {
            throw new Error(
              `Request exceeds model context window; retries and fallbacks were skipped. Attempts:\n${failures.join('\n')}`
            );
          }

          // Non-retryable — skip to next provider
          if (nonRetryable) break;

          // Retry with backoff
          if (attempt < maxRetries) {
            const retryAfter = parseRetryAfterMs(err);
            const wait = retryAfter != null ? Math.min(retryAfter, 30_000) : backoffMs;

            options.onRetry?.({
              attempt: attempt + 1,
              maxAttempts: maxRetries + 1,
              error: err.message.slice(0, 200),
              provider: provider.name,
              model: currentModel,
              reason,
              backoffMs: wait,
            });

            await new Promise((resolve) => setTimeout(resolve, wait));
            backoffMs = Math.min(backoffMs * 2, 10_000);
          }
        }
      }
    }
  }

  throw new Error(`All providers/models failed. Attempts:\n${failures.join('\n')}`);
}
