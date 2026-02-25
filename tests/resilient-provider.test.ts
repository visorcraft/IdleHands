import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNonRetryable,
  isRateLimited,
  isContextWindowExceeded,
  isNonRetryableRateLimit,
  parseRetryAfterMs,
  resilientCall,
} from '../dist/agent/resilient-provider.js';

describe('Error Classification', () => {
  it('detects 401 as non-retryable', () => {
    assert.strictEqual(isNonRetryable(new Error('401 Unauthorized')), true);
  });

  it('detects 403 as non-retryable', () => {
    assert.strictEqual(isNonRetryable(new Error('403 Forbidden')), true);
  });

  it('detects 404 as non-retryable', () => {
    assert.strictEqual(isNonRetryable(new Error('404 Not Found')), true);
  });

  it('does not flag 429 as non-retryable', () => {
    assert.strictEqual(isNonRetryable(new Error('429 Too Many Requests')), false);
  });

  it('does not flag 500 as non-retryable', () => {
    assert.strictEqual(isNonRetryable(new Error('500 Internal Server Error')), false);
  });

  it('detects auth failure keywords', () => {
    assert.strictEqual(isNonRetryable(new Error('invalid api key provided')), true);
    assert.strictEqual(isNonRetryable(new Error('authentication failed')), true);
  });

  it('detects model not found', () => {
    assert.strictEqual(isNonRetryable(new Error('model glm-4.7 not found')), true);
    assert.strictEqual(isNonRetryable(new Error('unsupported model: qwen')), true);
  });

  it('detects context window exceeded', () => {
    assert.strictEqual(isContextWindowExceeded('Your input exceeds the context window of this model'), true);
    assert.strictEqual(isContextWindowExceeded('maximum context length exceeded'), true);
    assert.strictEqual(isContextWindowExceeded('normal error message'), false);
  });

  it('detects rate limiting', () => {
    assert.strictEqual(isRateLimited(new Error('429 Too Many Requests')), true);
    assert.strictEqual(isRateLimited(new Error('HTTP 429 rate limit exceeded')), true);
    assert.strictEqual(isRateLimited(new Error('401 Unauthorized')), false);
  });

  it('detects non-retryable rate limits (business errors)', () => {
    assert.strictEqual(isNonRetryableRateLimit(new Error('429 Too Many Requests: plan does not include glm-5')), true);
    assert.strictEqual(isNonRetryableRateLimit(new Error('429 Too Many: insufficient balance')), true);
    assert.strictEqual(isNonRetryableRateLimit(new Error('429 Too Many Requests: rate limit exceeded')), false);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses integer Retry-After', () => {
    assert.strictEqual(parseRetryAfterMs(new Error('429, Retry-After: 5')), 5000);
  });

  it('parses float Retry-After', () => {
    assert.strictEqual(parseRetryAfterMs(new Error('Rate limited. retry_after: 2.5 seconds')), 2500);
  });

  it('returns null when not present', () => {
    assert.strictEqual(parseRetryAfterMs(new Error('500 Internal Server Error')), null);
  });
});

describe('resilientCall', () => {
  it('succeeds on first try', async () => {
    const result = await resilientCall(
      [{ name: 'test', execute: async () => 'ok' }],
      'model-1'
    );
    assert.strictEqual(result, 'ok');
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
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(attempt, 2);
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
    assert.strictEqual(result, 'from fallback');
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
    assert.strictEqual(result, 'ok from sonnet');
    assert.deepStrictEqual(modelsUsed, ['opus', 'sonnet']);
  });

  it('throws aggregated error when all fail', async () => {
    await assert.rejects(
      resilientCall(
        [{ name: 'p1', execute: async () => { throw new Error('fail'); } }],
        'model-1',
        { maxRetries: 0 }
      ),
      (err: Error) => { assert.ok(err.message.includes('All providers/models failed')); return true; }
    );
  });

  it('aborts immediately on context window exceeded', async () => {
    let attempts = 0;
    await assert.rejects(
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
      ),
      (err: Error) => { assert.ok(err.message.includes('context window')); return true; }
    );
    assert.strictEqual(attempts, 1);
  });

  it('skips retries on non-retryable errors', async () => {
    let attempts = 0;
    await assert.rejects(
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
      ),
      (err: Error) => { assert.ok(err.message.includes('All providers/models failed')); return true; }
    );
    assert.strictEqual(attempts, 1);
  });
});
