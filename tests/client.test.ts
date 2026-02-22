import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OpenAIClient, RateLimiter, BackpressureMonitor } from '../dist/client.js';

describe('OpenAIClient retry behavior', () => {
  it('connection timeout follows response timeout by default and is overrideable', () => {
    const client: any = new OpenAIClient('http://example.invalid/v1', undefined, false);

    assert.equal(client.defaultResponseTimeoutMs, 600_000);
    assert.equal(client.defaultConnectionTimeoutMs, 600_000);

    client.setResponseTimeout(900);
    assert.equal(client.defaultResponseTimeoutMs, 900_000);
    assert.equal(
      client.defaultConnectionTimeoutMs,
      900_000,
      'connection timeout should follow response timeout when not explicitly set'
    );

    client.setConnectionTimeout(1200);
    assert.equal(client.defaultConnectionTimeoutMs, 1_200_000);

    client.setResponseTimeout(30);
    assert.equal(client.defaultResponseTimeoutMs, 30_000);
    assert.equal(
      client.defaultConnectionTimeoutMs,
      1_200_000,
      'explicit connection timeout should remain pinned'
    );
  });

  it('runs initial connection probe once and supports fast probe timeout', async () => {
    const client: any = new OpenAIClient('http://example.invalid/v1', undefined, false);
    client.setInitialConnectionProbeTimeout(1);

    let calls = 0;
    const orig = client.fetchWithConnTimeout.bind(client);
    client.fetchWithConnTimeout = async (...args: any[]) => {
      calls += 1;
      return { ok: true, status: 200, text: async () => 'ok' } as any;
    };

    await client.probeConnection();
    await client.probeConnection();

    assert.equal(calls, 1, 'probe should run only once after first successful check');

    client.fetchWithConnTimeout = orig;
  });

  it('retries once on connection timeout (non-streaming chat)', async () => {
    const client: any = new OpenAIClient('http://example.invalid/v1', undefined, false);

    let calls = 0;
    client.fetchWithConnTimeout = async () => {
      calls += 1;
      if (calls === 1) {
        const e: any = new Error(
          'Connection timeout (10000ms) to http://example.invalid/v1/chat/completions'
        );
        e.retryable = true;
        throw e;
      }
      return new Response(
        JSON.stringify({
          id: 'ok',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const resp = await client.chat({
      model: 'fake',
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ],
    });

    assert.equal(resp.choices[0].message.content, 'hello');
    assert.equal(calls, 2);
  });

  it('returns a real Error when all non-streaming attempts are rejected', async () => {
    const client: any = new OpenAIClient('http://example.invalid/v1', undefined, false);

    client.fetchWithConnTimeout = async () => {
      const err: any = undefined;
      throw err;
    };

    let threw = null as unknown;
    try {
      await client.chat({
        model: 'fake',
        messages: [{ role: 'user', content: 'u' }],
      });
    } catch (e) {
      threw = e;
    }

    assert.ok(threw instanceof Error);
  });

  it('returns a real Error when streaming gets repeated 503 responses', async () => {
    const client: any = new OpenAIClient('http://example.invalid/v1', undefined, false);

    let calls = 0;
    const ok503 = new Response('', { status: 503, statusText: 'Service Unavailable' });
    const prevFallback = process.env.IDLEHANDS_STREAM_FALLBACK;
    process.env.IDLEHANDS_STREAM_FALLBACK = '0';

    client.fetchWithConnTimeout = async () => {
      calls += 1;
      return ok503;
    };

    let threw = null as unknown;
    try {
      await client.chatStream({
        model: 'fake',
        messages: [{ role: 'user', content: 'u' }],
      });
    } catch (e) {
      threw = e;
    }

    if (prevFallback === undefined) {
      delete process.env.IDLEHANDS_STREAM_FALLBACK;
    } else {
      process.env.IDLEHANDS_STREAM_FALLBACK = prevFallback;
    }

    assert.ok(calls >= 3);
    assert.ok(threw instanceof Error);
  });
});

describe('OpenAIClient request sanitization', () => {
  it('strips unsupported fields and normalizes developer role', () => {
    const client: any = new OpenAIClient('http://example.invalid/v1', undefined, false);

    const clean = client.sanitizeRequest({
      model: 'fake',
      store: true,
      reasoning_effort: 'high',
      stream_options: { include_usage: true },
      max_completion_tokens: 999,
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            strict: true,
            parameters: {
              type: 'object',
              strict: true,
              properties: {},
            },
          },
        },
      ],
      messages: [
        { role: 'developer', content: 'internal prompt' },
        { role: 'user', content: 'hi' },
      ],
    });

    assert.equal(clean.store, undefined);
    assert.equal(clean.reasoning_effort, undefined);
    assert.equal(clean.stream_options, undefined);
    assert.equal(clean.max_completion_tokens, undefined);
    assert.equal(clean.max_tokens, 999);
    assert.equal(clean.messages[0].role, 'system');
    assert.equal(clean.tools[0].function.strict, undefined);
    assert.equal(clean.tools[0].function.parameters.strict, undefined);
  });

  it('keeps stream_options for streaming requests and enables include_usage by default', () => {
    const client: any = new OpenAIClient('http://example.invalid/v1', undefined, false);

    const clean = client.buildBody({
      model: 'fake',
      messages: [{ role: 'user', content: 'u' }],
      stream: true,
    });

    assert.equal(clean.stream, true);
    assert.equal(clean.stream_options?.include_usage, true);
  });
});

describe('OpenAIClient SSE parsing + malformed handling', () => {
  it('parses SSE content deltas and emits token callbacks', async () => {
    const client: any = new OpenAIClient('http://example.invalid/v1', undefined, false);
    const chunks: string[] = [];
    const firstDeltaCalls: number[] = [];

    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
        controller.enqueue(
          enc.encode(
            'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n'
          )
        );
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    client.fetchWithConnTimeout = async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

    const resp = await client.chatStream({
      model: 'fake',
      messages: [{ role: 'user', content: 'u' }],
      onToken: (t: string) => chunks.push(t),
      onFirstDelta: () => firstDeltaCalls.push(Date.now()),
    });

    assert.equal(chunks.join(''), 'Hello');
    assert.equal(firstDeltaCalls.length, 1, 'onFirstDelta should fire exactly once');
    assert.equal(resp.choices?.[0]?.message?.content, 'Hello');
    assert.equal(resp.usage?.prompt_tokens, 3);
    assert.equal(resp.usage?.completion_tokens, 2);
  });

  it('captures usage from usage-only SSE chunks (choices = [])', async () => {
    const client: any = new OpenAIClient('http://example.invalid/v1', undefined, false);
    const enc = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        controller.enqueue(
          enc.encode('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n')
        );
        controller.enqueue(
          enc.encode(
            'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n'
          )
        );
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    client.fetchWithConnTimeout = async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

    const resp = await client.chatStream({
      model: 'fake',
      messages: [{ role: 'user', content: 'u' }],
    });

    assert.equal(resp.choices?.[0]?.message?.content, 'ok');
    assert.equal(resp.usage?.prompt_tokens, 11);
    assert.equal(resp.usage?.completion_tokens, 7);
  });

  it('ignores malformed SSE frames and continues parsing', async () => {
    const client: any = new OpenAIClient('http://example.invalid/v1', undefined, false);
    const enc = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {not-json}\n\n'));
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    client.fetchWithConnTimeout = async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

    const resp = await client.chatStream({
      model: 'fake',
      messages: [{ role: 'user', content: 'u' }],
    });

    assert.equal(resp.choices?.[0]?.message?.content, 'ok');
  });

  it('surfaces malformed non-stream JSON responses as errors', async () => {
    const client: any = new OpenAIClient('http://example.invalid/v1', undefined, false);

    client.fetchWithConnTimeout = async () =>
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    await assert.rejects(
      () => client.chat({ model: 'fake', messages: [{ role: 'user', content: 'u' }] }),
      /Unexpected token|JSON|parse/i
    );
  });

  it('returns response timeout for stalled non-stream requests', async () => {
    const client: any = new OpenAIClient('http://example.invalid/v1', undefined, false);

    client.fetchWithConnTimeout = async (_url: string, init: RequestInit) => {
      // Simulate a request that outlives chat() response timeout
      await new Promise((r) => setTimeout(r, 30));
      if (init.signal && (init.signal as AbortSignal).aborted) {
        throw new Error('aborted');
      }
      return new Response(
        JSON.stringify({
          id: 'late',
          choices: [{ index: 0, message: { role: 'assistant', content: 'late' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    await assert.rejects(
      () =>
        client.chat({
          model: 'fake',
          messages: [{ role: 'user', content: 'u' }],
          responseTimeoutMs: 5,
        }),
      /Response timeout/i
    );
  });
});

describe('RateLimiter', () => {
  it('returns zero delay when under threshold', () => {
    const rl = new RateLimiter(60_000, 5);
    rl.record503();
    rl.record503();
    assert.equal(rl.getDelay(), 0);
    assert.equal(rl.recentCount, 2);
  });

  it('returns escalating delay after threshold exceeded', () => {
    const rl = new RateLimiter(60_000, 3);
    rl.record503();
    rl.record503();
    rl.record503();
    const d1 = rl.getDelay();
    assert.ok(d1 > 0, `expected positive delay, got ${d1}`);

    // Record more → higher backoff
    rl.record503();
    const d2 = rl.getDelay();
    assert.ok(d2 >= d1, `expected escalating delay: ${d2} >= ${d1}`);
  });

  it('caps backoff at maxBackoffMs', () => {
    const rl = new RateLimiter(60_000, 1, 5_000);
    for (let i = 0; i < 20; i++) rl.record503();
    assert.ok(rl.getDelay() <= 5_000);
  });

  it('resets cleanly', () => {
    const rl = new RateLimiter(60_000, 2);
    rl.record503();
    rl.record503();
    rl.record503();
    assert.ok(rl.getDelay() > 0);
    rl.reset();
    assert.equal(rl.getDelay(), 0);
    assert.equal(rl.recentCount, 0);
  });
});

describe('BackpressureMonitor', () => {
  it('does not warn with fewer than 3 samples', () => {
    const bp = new BackpressureMonitor({ multiplier: 3 });
    const r1 = bp.record(100);
    assert.equal(r1.warn, false);
    const r2 = bp.record(100);
    assert.equal(r2.warn, false);
  });

  it('warns when response time exceeds multiplier × average', () => {
    const bp = new BackpressureMonitor({ multiplier: 3 });
    bp.record(100);
    bp.record(100);
    bp.record(100);
    // Now avg is 100, threshold is 300
    const r = bp.record(500);
    assert.equal(r.warn, true);
    assert.equal(r.current, 500);
    assert.ok(r.avg > 0);
  });

  it('does not warn for normal variation', () => {
    const bp = new BackpressureMonitor({ multiplier: 3 });
    bp.record(100);
    bp.record(120);
    bp.record(110);
    const r = bp.record(200);
    assert.equal(r.warn, false);
  });

  it('tracks rolling average across samples', () => {
    const bp = new BackpressureMonitor({ maxSamples: 3 });
    bp.record(100);
    bp.record(200);
    bp.record(300);
    assert.equal(bp.average, 200);
    assert.equal(bp.samples, 3);
    // Adding one more should evict the oldest
    bp.record(400);
    assert.equal(bp.samples, 3);
    assert.equal(bp.average, 300); // (200+300+400)/3
  });

  it('resets cleanly', () => {
    const bp = new BackpressureMonitor();
    bp.record(100);
    bp.record(200);
    bp.reset();
    assert.equal(bp.samples, 0);
    assert.equal(bp.average, 0);
  });
});
