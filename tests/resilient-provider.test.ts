import { describe, it, expect } from 'vitest';
import {
  isNonRetryable,
  isRateLimited,
  isContextWindowExceeded,
  isNonRetryableRateLimit,
  parseRetryAfterMs,
  resilientCall,
} from '../src/agent/resilient-provider.js';

describe('Error Classification', () => {
  it('detects 401 as non-retryable', () => {
    expect(isNonRetryable(new Error('401 Unauthorized'))).toBe(true);
  });

  it('detects 403 as non-retryable', () => {
    expect(isNonRetryable(new Error('403 Forbidden'))).toBe(true);
  });

  it('detects 404 as non-retryable', () => {
    expect(isNonRetryable(new Error('404 Not Found'))).toBe(true);
  });

  it('does not flag 429 as non-retryable', () => {
    expect(isNonRetryable(new Error('429 Too Many Requests'))).toBe(false);
  });

  it('does not flag 500 as non-retryable', () => {
    expect(isNonRetryable(new Error('500 Internal Server Error'))).toBe(false);
  });

  it('detects auth failure keywords', () => {
    expect(isNonRetryable(new Error('invalid api key provided'))).toBe(true);
    expect(isNonRetryable(new Error('authentication failed'))).toBe(true);
  });

  it('detects model not found', () => {
    expect(isNonRetryable(new Error('model glm-4.7 not found'))).toBe(true);
    expect(isNonRetryable(new Error('unsupported model: qwen'))).toBe(true);
  });

  it('detects context window exceeded', () => {
    expect(isContextWindowExceeded('Your input exceeds the context window of this model')).toBe(true);
    expect(isContextWindowExceeded('maximum context length exceeded')).toBe(true);
    expect(isContextWindowExceeded('normal error message')).toBe(false);
  });

  it('detects rate limiting', () => {
    expect(isRateLimited(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRateLimited(new Error('HTTP 429 rate limit exceeded'))).toBe(true);
    expect(isRateLimited(new Error('401 Unauthorized'))).toBe(false);
  });

  it('detects non-retryable rate limits (business errors)', () => {
    expect(isNonRetryableRateLimit(new Error('429 Too Many Requests: plan does not include glm-5'))).toBe(true);
    expect(isNonRetryableRateLimit(new Error('429 Too Many: insufficient balance'))).toBe(true);
    expect(isNonRetryableRateLimit(new Error('429 Too Many Requests: rate limit exceeded'))).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses integer Retry-After', () => {
    expect(parseRetryAfterMs(new Error('429, Retry-After: 5'))).toBe(5000);
  });

  it('parses float Retry-After', () => {
    expect(parseRetryAfterMs(new Error('Rate limited. retry_after: 2.5 seconds'))).toBe(2500);
  });

  it('returns null when not present', () => {
    expect(parseRetryAfterMs(new Error('500 Internal Server Error'))).toBeNull();
  });
});

describe('resilientCall', () => {
  it('succeeds on first try', async () => {
    const result = await resilientCall(
      [{ name: 'test', execute: async () => 'ok' }],
      'model-1'
    );
    expect(result).toBe('ok');
  });

  it('retries and recovers', async () => {
    let attempt = 0;
    const result = await resilientCall(
      [{
        name: 'test',
        execute: async () => {
          attempt++;
          if (attempt < 2) throw new Error('temporary');
          return 'recovered';
        },
      }],
      'model-1',
      { maxRetries: 2, baseBackoffMs: 1 }
    );
    expect(result).toBe('recovered');
    expect(attempt).toBe(2);
  });

  it('falls back to second provider', async () => {
    const result = await resilientCall(
      [
        { name: 'primary', execute: async () => { throw new Error('primary down'); } },
        { name: 'fallback', execute: async () => 'from fallback' },
      ],
      'model-1',
      { maxRetries: 0 }
    );
    expect(result).toBe('from fallback');
  });

  it('tries fallback models', async () => {
    const modelsUsed: string[] = [];
    const result = await resilientCall(
      [{
        name: 'provider',
        execute: async (model) => {
          modelsUsed.push(model);
          if (model === 'opus') throw new Error('500 unavailable');
          return 'ok from ' + model;
        },
      }],
      'opus',
      { maxRetries: 0, modelFallbacks: { opus: ['sonnet', 'haiku'] } }
    );
    expect(result).toBe('ok from sonnet');
    expect(modelsUsed).toEqual(['opus', 'sonnet']);
  });

  it('throws aggregated error when all fail', async () => {
    await expect(
      resilientCall(
        [{ name: 'p1', execute: async () => { throw new Error('fail'); } }],
        'model-1',
        { maxRetries: 0 }
      )
    ).rejects.toThrow('All providers/models failed');
  });

  it('aborts immediately on context window exceeded', async () => {
    let attempts = 0;
    await expect(
      resilientCall(
        [{
          name: 'p1',
          execute: async () => {
            attempts++;
            throw new Error('Your input exceeds the context window of this model');
          },
        }],
        'model-1',
        { maxRetries: 5, modelFallbacks: { 'model-1': ['model-2'] } }
      )
    ).rejects.toThrow('context window');
    expect(attempts).toBe(1);
  });

  it('skips retries on non-retryable errors', async () => {
    let attempts = 0;
    await expect(
      resilientCall(
        [{
          name: 'p1',
          execute: async () => {
            attempts++;
            throw new Error('401 Unauthorized');
          },
        }],
        'model-1',
        { maxRetries: 5 }
      )
    ).rejects.toThrow('All providers/models failed');
    expect(attempts).toBe(1);
  });
});
