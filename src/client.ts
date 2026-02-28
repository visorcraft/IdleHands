import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from 'undici';

import {
  asError,
  getRetryDelayMs,
  isConnRefused,
  isConnTimeout,
  isFetchFailed,
  makeClientError,
} from './client/error-utils.js';
import { BackpressureMonitor, RateLimiter } from './client/pressure.js';
export { BackpressureMonitor, RateLimiter } from './client/pressure.js';
import type { ChatCompletionResponse, ChatMessage, ModelsResponse, ToolSchema } from './types.js';

// ── Persistent connection pool ───────────────────────────────────────────
// Reuses TCP+TLS connections across requests to avoid the overhead of
// handshake negotiation on every API call. Supports HTTP/2 multiplexing
// when the server advertises it (e.g., llama-server, OpenAI, Anthropic).
//
// ZeroClaw does this via reqwest::Client with connection pooling;
// we use undici's Agent which backs Node's global fetch().
const pooledAgent = new Agent({
  keepAliveTimeout: 30_000,       // Keep idle connections alive for 30s
  keepAliveMaxTimeout: 120_000,   // Max keep-alive for any connection
  connections: 16,                // Max connections per origin
  pipelining: 1,                  // HTTP/1.1 pipelining depth
  allowH2: true,                  // Negotiate HTTP/2 when available
  connect: {
    rejectUnauthorized: true,     // Enforce TLS verification
  },
});

export type ClientError = Error & {
  status?: number;
  retryable?: boolean;
};

export type ExchangeRecord = {
  timestamp: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  metrics?: {
    total_ms?: number;
    ttft_ms?: number;
    tg_speed?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

export class OpenAIClient {
  readonly rateLimiter = new RateLimiter();
  readonly backpressure = new BackpressureMonitor();
  private exchangeHook?: (record: ExchangeRecord) => void | Promise<void>;
  private cachedHeaders?: Record<string, string>;
  private cachedRootEndpoint?: string;

  /** Default response timeout in ms (overridable per-call). */
  private defaultResponseTimeoutMs = 600_000;
  /** Default connection/header timeout in ms for chat requests. */
  private defaultConnectionTimeoutMs = 600_000;
  /** True when connection timeout was explicitly set by caller/config. */
  private explicitConnectionTimeout = false;

  /** Optional one-time preflight connectivity check before first model call. */
  private initialConnectionCheckEnabled = true;
  private initialConnectionProbeTimeoutMs = 10_000;
  private initialConnectionProbeComplete = false;

  /**
   * When true, tools/tool_choice are stripped from API requests.
   * Tool descriptions are injected into the system prompt instead,
   * and tool calls are parsed from model content output.
   * Auto-enabled when server template errors are detected.
   */
  contentModeToolCalls = false;

  /**
   * Built-in model name patterns known to need content-mode tool calls.
   * Can be extended dynamically via ~/.config/idlehands/compat-models.json
   */
  static readonly CONTENT_MODE_PATTERNS: RegExp[] = [
    /qwen3[.\-_]?5/i,
    /qwen397b/i,
    /qwen3.*coder/i,
  ];

  /** Telemetry counters for compatibility behavior. */
  private compatTelemetry = {
    knownPatternMatches: 0,
    autoSwitches: 0,
  };

  private static dynamicPatternsCache: { patterns: RegExp[]; loadedAt: number } | null = null;

  private static loadDynamicCompatPatterns(): RegExp[] {
    try {
      const now = Date.now();
      if (
        OpenAIClient.dynamicPatternsCache &&
        now - OpenAIClient.dynamicPatternsCache.loadedAt < 30_000
      ) {
        return OpenAIClient.dynamicPatternsCache.patterns;
      }

      const cfgPath = path.join(os.homedir(), '.config', 'idlehands', 'compat-models.json');
      if (!fsSync.existsSync(cfgPath)) {
        OpenAIClient.dynamicPatternsCache = { patterns: [], loadedAt: now };
        return [];
      }

      const raw = fsSync.readFileSync(cfgPath, 'utf8');
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed?.content_mode_patterns)
        ? parsed.content_mode_patterns
        : Array.isArray(parsed)
          ? parsed
          : [];

      const patterns = arr
        .filter((x: any) => typeof x === 'string' && x.trim().length)
        .map((x: string) => new RegExp(x, 'i'));

      OpenAIClient.dynamicPatternsCache = { patterns, loadedAt: now };
      return patterns;
    } catch {
      OpenAIClient.dynamicPatternsCache = { patterns: [], loadedAt: Date.now() };
      return [];
    }
  }

  /** Check if a model name matches built-in or dynamic content-mode patterns. */
  static needsContentMode(modelName: string): boolean {
    for (const p of OpenAIClient.CONTENT_MODE_PATTERNS) {
      if (p.test(modelName)) return true;
    }
    const dynamic = OpenAIClient.loadDynamicCompatPatterns();
    for (const p of dynamic) {
      if (p.test(modelName)) return true;
    }
    return false;
  }

  recordKnownPatternMatch(): void {
    this.compatTelemetry.knownPatternMatches += 1;
  }

  getCompatTelemetry(): {
    knownPatternMatches: number;
    autoSwitches: number;
    contentModeActive: boolean;
  } {
    return {
      knownPatternMatches: this.compatTelemetry.knownPatternMatches,
      autoSwitches: this.compatTelemetry.autoSwitches,
      contentModeActive: this.contentModeToolCalls,
    };
  }

  constructor(
    private endpoint: string,
    private readonly apiKey?: string,
    private verbose: boolean = false
  ) {
    this.cachedRootEndpoint = this.endpoint.replace(/\/v1\/?$/, '');
  }

  /** Set the default response timeout (in seconds) for all requests. */
  setResponseTimeout(seconds: number): void {
    if (Number.isFinite(seconds) && seconds > 0) {
      this.defaultResponseTimeoutMs = seconds * 1000;
      // Keep connection timeout aligned unless explicitly overridden.
      if (!this.explicitConnectionTimeout) {
        this.defaultConnectionTimeoutMs = this.defaultResponseTimeoutMs;
      }
    }
  }

  /** Set the default connection/header timeout (in seconds) for requests. */
  setConnectionTimeout(seconds: number): void {
    if (Number.isFinite(seconds) && seconds > 0) {
      this.defaultConnectionTimeoutMs = seconds * 1000;
      this.explicitConnectionTimeout = true;
    }
  }

  /** Enable/disable initial connectivity preflight before first ask. */
  setInitialConnectionCheck(enabled: boolean): void {
    this.initialConnectionCheckEnabled = enabled === true;
  }

  /** Set timeout (in seconds) for initial connectivity preflight. */
  setInitialConnectionProbeTimeout(seconds: number): void {
    if (Number.isFinite(seconds) && seconds > 0) {
      this.initialConnectionProbeTimeoutMs = seconds * 1000;
    }
  }

  /** Run one-time connectivity probe against /models to fail fast on unreachable endpoints. */
  async probeConnection(signal?: AbortSignal): Promise<void> {
    if (!this.initialConnectionCheckEnabled || this.initialConnectionProbeComplete) return;

    const url = `${this.endpoint}/models`;
    try {
      await this.fetchWithConnTimeout(
        url,
        {
          method: 'GET',
          headers: this.headers(),
          signal,
        },
        this.initialConnectionProbeTimeoutMs
      );
      this.initialConnectionProbeComplete = true;
    } catch (e: any) {
      if (signal?.aborted) throw e;
      throw makeClientError(
        `Initial connection check failed (${this.initialConnectionProbeTimeoutMs}ms) to ${url}: ${e?.message ?? String(e)}`,
        undefined,
        true
      );
    }
  }

  setVerbose(v: boolean): void {
    this.verbose = v;
  }

  setEndpoint(endpoint: string): void {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.cachedRootEndpoint = this.endpoint.replace(/\/v1\/?$/, '');
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  setExchangeHook(fn?: (record: ExchangeRecord) => void | Promise<void>): void {
    this.exchangeHook = fn;
  }

  private emitExchange(record: ExchangeRecord): void {
    if (!this.exchangeHook) return;
    void Promise.resolve(this.exchangeHook(record)).catch(() => {});
  }

  private emitExchangeError(
    request: Record<string, unknown>,
    err: unknown,
    opts?: { attempt?: number; streamed?: boolean; totalMs?: number }
  ): Error {
    const e = asError(err);
    this.emitExchange({
      timestamp: new Date().toISOString(),
      request,
      response: {
        error: {
          name: e.name,
          message: e.message,
          status: (e as any)?.status,
          retryable: (e as any)?.retryable,
          attempt: opts?.attempt,
          streamed: opts?.streamed === true,
        },
      },
      metrics: {
        total_ms: opts?.totalMs,
      },
    });
    return e;
  }

  private rootEndpoint(): string {
    if (this.cachedRootEndpoint) return this.cachedRootEndpoint;
    this.cachedRootEndpoint = this.endpoint.replace(/\/v1\/?$/, '');
    return this.cachedRootEndpoint;
  }

  private headers() {
    if (this.cachedHeaders) return this.cachedHeaders;
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    this.cachedHeaders = h;
    return h;
  }

  private log(msg: string) {
    if (this.verbose) console.error(`[idlehands] ${msg}`);
  }

  /**
   * Detect server-side tool-call incompatibilities that are fixed by content-mode.
   */
  private detectToolCallCompatFailure(text: string): {
    kind: 'template-items-string' | 'tool-args-json-parse';
    reason: string;
  } | null {
    const body = String(text ?? '');

    if (/filter.*items.*String|items.*type.*String/i.test(body)) {
      return {
        kind: 'template-items-string',
        reason: 'tool-call template incompatibility (|items on String)',
      };
    }

    if (
      /failed to parse tool call arguments as JSON|parse tool call arguments as JSON|json\.exception\.parse_error|invalid string:\s*missing closing quote/i.test(
        body
      )
    ) {
      return {
        kind: 'tool-args-json-parse',
        reason: 'server failed to parse tool-call arguments JSON',
      };
    }

    return null;
  }

  async models(signal?: AbortSignal): Promise<ModelsResponse> {
    const url = `${this.endpoint}/models`;
    const res = await this.fetchWithConnTimeout(
      url,
      { method: 'GET', headers: this.headers(), signal },
      10_000
    );
    if (!res.ok) {
      throw new Error(`GET /models failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as ModelsResponse;
  }

  async health(signal?: AbortSignal): Promise<any> {
    const url = `${this.rootEndpoint()}/health`;
    const res = await this.fetchWithConnTimeout(
      url,
      { method: 'GET', headers: this.headers(), signal },
      5_000
    );
    if (!res.ok) {
      throw makeClientError(
        `GET /health failed: ${res.status} ${res.statusText}`,
        res.status,
        true
      );
    }

    const ct = String(res.headers.get('content-type') ?? '');
    if (ct.includes('application/json')) {
      return await res.json();
    }

    const text = await res.text();
    return { status: 'ok', raw: text };
  }

  async waitForReady(opts?: { timeoutMs?: number; pollMs?: number }) {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const pollMs = opts?.pollMs ?? 2000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await this.models();
        return;
      } catch {
        // keep waiting
      }
      await delay(pollMs);
    }
    throw makeClientError(
      `Server not ready after ${timeoutMs}ms (${this.endpoint})`,
      undefined,
      true
    );
  }

  sanitizeRequest(body: any) {
    delete body.store;
    delete body.reasoning_effort;
    const thinkingMode = body.thinking_mode as 'default' | 'think' | 'no_think' | undefined;
    delete body.thinking_mode;
    // Keep stream_options for streaming calls (used for include_usage on SSE),
    // but strip it from non-stream requests for compatibility.
    if (!body.stream) delete body.stream_options;

    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (m?.role === 'developer') m.role = 'system';
      }

      if (thinkingMode === 'think' || thinkingMode === 'no_think') {
        const directive = thinkingMode === 'no_think' ? '/no_think' : '/think';
        for (let i = body.messages.length - 1; i >= 0; i--) {
          const m = body.messages[i];
          if (m?.role !== 'user' || typeof m.content !== 'string') continue;
          const text = String(m.content);
          if (!text.startsWith('/no_think') && !text.startsWith('/think')) {
            m.content = `${directive}\n${text}`;
          }
          break;
        }
      }

      // For llama-server/OpenAI-compatible backends: enforce thinking mode at API level.
      // NOTE: Do NOT set enable_thinking=false — llama-server's Qwen3 Jinja template
      // injects <think></think> as assistant prefill when enable_thinking=false, which
      // then conflicts with llama-server's own assistant-prefill validation.
      // Instead, rely on /no_think directive in the user message + reasoning_format=none.
      if (thinkingMode === 'no_think') {
        body.reasoning_format = 'none';
        // Explicitly delete enable_thinking to avoid template prefill conflicts
        delete body.enable_thinking;
      } else if (thinkingMode === 'think') {
        body.enable_thinking = true;
      }
    }

    if (body.max_completion_tokens != null && body.max_tokens == null) {
      body.max_tokens = body.max_completion_tokens;
    }
    delete body.max_completion_tokens;

    if (Array.isArray(body.tools)) {
      for (const t of body.tools) {
        if (t?.function) {
          if ('strict' in t.function) delete t.function.strict;
          if (t.function.parameters && 'strict' in t.function.parameters) {
            delete t.function.parameters.strict;
          }
        }
      }
    }

    // Content-mode tool calls: strip tools/tool_choice from the request body,
    // and sanitize historical tool_call structures that trigger template bugs.
    if (this.contentModeToolCalls) {
      // Capture tool schemas before deleting, for injection into system prompt
      const toolSchemas = body.tools as any[] | undefined;
      delete body.tools;
      delete body.tool_choice;
      if (Array.isArray(body.messages)) {
        // Check if system message already has content-mode tool instructions
        const sysMsg = body.messages.find((m: any) => m?.role === 'system');
        const hasToolInstructions =
          sysMsg?.content && /Available tools:/i.test(String(sysMsg.content));

        if (!hasToolInstructions && toolSchemas?.length && sysMsg) {
          // Mid-session auto-switch: inject tool descriptions into system prompt
          let toolBlock =
            '\n\nYou have access to the following tools. To call a tool, output a JSON block like:\n{"name": "tool_name", "arguments": {"param": "value"}}\nAvailable tools:\n';
          for (const t of toolSchemas) {
            const fn = (t as any)?.function;
            if (fn?.name) {
              const params = fn.parameters?.properties
                ? Object.entries(fn.parameters.properties)
                    .map(([k, v]: [string, any]) => `${k}: ${(v as any).type ?? 'any'}`)
                    .join(', ')
                : '';
              toolBlock += `- ${fn.name}(${params}): ${fn.description ?? ''}\n`;
            }
          }
          toolBlock += '\nOutput tool calls as JSON in your message content.';
          sysMsg.content = String(sysMsg.content) + toolBlock;
          this.log('Injected tool descriptions into system prompt for content-mode');
        }

        for (const m of body.messages) {
          if (m?.role === 'assistant' && Array.isArray((m as any).tool_calls)) {
            delete (m as any).tool_calls;
          }
          if (m?.role === 'tool' && 'tool_call_id' in (m as any)) {
            delete (m as any).tool_call_id;
            m.role = 'user';
            if (typeof m.content === 'string') {
              m.content = `[tool_result] ${m.content}`;
            }
          }
        }
      }
    }

    return body;
  }

  private buildBody(opts: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSchema[];
    tool_choice?: any;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    stream?: boolean;
    extra?: Record<string, unknown>;
  }): any {
    const body: any = {
      model: opts.model,
      messages: opts.messages.map((m) => ({ ...m })), // shallow copy to avoid mutating session state
      temperature: opts.temperature,
      top_p: opts.top_p,
      max_tokens: opts.max_tokens,
      tools: opts.tools,
      tool_choice: opts.tool_choice,
      stream: opts.stream ?? false,
      ...opts.extra,
    };

    // Ask streaming servers to include usage in the terminal SSE chunk.
    // llama.cpp emits this as a usage-only chunk (choices=[]), which we parse below.
    if (body.stream === true) {
      const so =
        body.stream_options && typeof body.stream_options === 'object' ? body.stream_options : {};
      if ((so as any).include_usage === undefined) {
        body.stream_options = { ...so, include_usage: true };
      }
    }

    for (const k of Object.keys(body)) {
      if (body[k] === undefined) delete body[k];
    }
    return this.sanitizeRequest(body);
  }

  /** Wrap fetch with a configurable connection/header timeout. */
  private async fetchWithConnTimeout(
    url: string,
    init: RequestInit,
    connTimeoutMs?: number
  ): Promise<Response> {
    // Default follows response timeout (or explicit connection_timeout), with a small floor.
    if (!connTimeoutMs) connTimeoutMs = Math.max(5_000, this.defaultConnectionTimeoutMs);

    const ac = new AbortController();
    const chainedAbort = init.signal;
    // If the caller's signal fires, propagate to our controller.
    const onCallerAbort = () => ac.abort();
    chainedAbort?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), connTimeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: ac.signal,
        // @ts-expect-error -- undici dispatcher is not in the standard RequestInit type
        dispatcher: pooledAgent,
      });
      clearTimeout(timer);
      return res;
    } catch (e: any) {
      clearTimeout(timer);
      // Distinguish connection timeout from caller abort.
      if (ac.signal.aborted && !chainedAbort?.aborted) {
        throw makeClientError(`Connection timeout (${connTimeoutMs}ms) to ${url}`, undefined, true);
      }
      throw asError(e, `connection failure to ${url}`);
    } finally {
      chainedAbort?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** Non-streaming chat with retry (ECONNREFUSED 3x/2s, 503 exponential backoff, response timeout) */
  async chat(opts: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSchema[];
    tool_choice?: any;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    stream?: boolean;
    extra?: Record<string, unknown>;
    signal?: AbortSignal;
    requestId?: string;
    responseTimeoutMs?: number;
  }): Promise<ChatCompletionResponse> {
    const url = `${this.endpoint}/chat/completions`;
    const clean = this.buildBody({ ...opts, stream: false });
    const responseTimeout = opts.responseTimeoutMs ?? this.defaultResponseTimeoutMs;

    this.log(`→ POST ${url} ${opts.requestId ? `(rid=${opts.requestId})` : ''}`);
    this.log(`request keys: ${Object.keys(clean).join(', ')}`);

    // Rate-limit delay (§6e: back off if too many 503s in rolling window)
    const rlDelay = this.rateLimiter.getDelay();
    if (rlDelay > 0) {
      this.log(
        `rate-limit backoff: waiting ${rlDelay}ms (${this.rateLimiter.recentCount} retryable errors in window)`
      );
      console.warn(
        `[warn] server returned 429/503 ${this.rateLimiter.recentCount} times in 60s, backing off ${(rlDelay / 1000).toFixed(1)}s`
      );
      await delay(getRetryDelayMs(rlDelay));
    }

    let lastErr: unknown = makeClientError(
      `POST /chat/completions failed without response`,
      503,
      true
    );
    const reqStart = Date.now();
    const seen5xxMessages: string[] = [];
    let switchedToContentModeThisCall = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      // Build a combined signal that fires on caller abort OR response timeout.
      const timeoutAc = new AbortController();
      const callerSignal = opts.signal;
      const onCallerAbort = () => timeoutAc.abort();
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
      const timer = setTimeout(() => timeoutAc.abort(), responseTimeout);

      try {
        const res = await this.fetchWithConnTimeout(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(clean),
          signal: timeoutAc.signal,
        });

        if (res.status === 503 || res.status === 429) {
          this.rateLimiter.recordRetryableError();
          const backoff = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
          this.log(`503 model loading, retrying in ${backoff}ms...`);
          lastErr = makeClientError(
            `POST /chat/completions returned 503 (model loading), attempt ${attempt + 1}/3`,
            503,
            true
          );
          if (attempt < 2) {
            await delay(getRetryDelayMs(backoff));
            continue;
          }
          throw lastErr;
        }

        if (res.status >= 500 && res.status <= 599) {
          const text = await res.text().catch(() => '');
          const errSig = `${res.status}:${text.slice(0, 500)}`;

          const compat = this.detectToolCallCompatFailure(text);
          if (compat) {
            if (switchedToContentModeThisCall) {
              throw makeClientError(
                `Tool-call compatibility failure persisted after content-mode switch (${compat.kind}).\n${text.slice(0, 2000)}`,
                res.status,
                false
              );
            }

            this.log(`Detected ${compat.reason} — switching to content-mode tool calls`);
            console.warn(
              `[warn] Server cannot parse tool_calls reliably (${compat.kind}). Switching to content-mode (tools in system prompt).`
            );
            this.contentModeToolCalls = true;
            this.compatTelemetry.autoSwitches += 1;
            switchedToContentModeThisCall = true;
            return this.chat(opts);
          }

          if (seen5xxMessages.includes(errSig)) {
            this.log(
              `Deterministic server error detected (same ${res.status} repeated) — not retrying`
            );
            throw makeClientError(
              `Server returns the same error repeatedly (${res.status}). This is likely a template or model compatibility issue, not a transient failure.\n${text.slice(0, 2000)}`,
              res.status,
              false
            );
          }
          seen5xxMessages.push(errSig);

          lastErr = makeClientError(
            `POST /chat/completions failed: ${res.status} ${res.statusText}${text ? `\n${text.slice(0, 2000)}` : ''}`,
            res.status,
            true
          );

          const backoff = Math.pow(2, attempt + 1) * 1000;
          this.log(`HTTP ${res.status} on non-stream request, retrying in ${backoff}ms...`);
          if (attempt < 2) {
            await delay(getRetryDelayMs(backoff));
            continue;
          }
          throw lastErr;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw makeClientError(
            `POST /chat/completions failed: ${res.status} ${res.statusText}${text ? `\n${text.slice(0, 2000)}` : ''}`,
            res.status,
            false
          );
        }

        const result = (await res.json()) as ChatCompletionResponse;
        const totalMs = Date.now() - reqStart;
        // Backpressure: track response time and warn on anomalies
        const bp = this.backpressure.record(totalMs);
        if (bp.warn) {
          const avgS = (bp.avg / 1000).toFixed(1);
          const curS = (bp.current / 1000).toFixed(1);
          this.log(
            `backpressure warning: response ${curS}s > ${this.backpressure.multiplier}× avg ${avgS}s — consider reducing context size`
          );
          console.warn(
            `[warn] server response time (${curS}s) exceeds ${this.backpressure.multiplier}× session average (${avgS}s) — consider reducing context size`
          );
        }
        (result as any).meta = { total_ms: totalMs, streamed: false };
        this.emitExchange({
          timestamp: new Date().toISOString(),
          request: clean,
          response: result as any,
          metrics: {
            total_ms: totalMs,
            prompt_tokens: result.usage?.prompt_tokens,
            completion_tokens: result.usage?.completion_tokens,
          },
        });
        return result;
      } catch (e: any) {
        lastErr = asError(e, `POST /chat/completions attempt ${attempt + 1} failed`);
        if (callerSignal?.aborted) {
          throw this.emitExchangeError(clean, lastErr, {
            attempt: attempt + 1,
            streamed: false,
            totalMs: Date.now() - reqStart,
          });
        }

        // Distinguish response timeout from other AbortErrors
        if (timeoutAc.signal.aborted && !callerSignal?.aborted) {
          const timeoutErr = makeClientError(
            `Response timeout (${responseTimeout}ms) waiting for ${url}`,
            undefined,
            true
          );
          throw this.emitExchangeError(clean, timeoutErr, {
            attempt: attempt + 1,
            streamed: false,
            totalMs: Date.now() - reqStart,
          });
        }

        if (isConnTimeout(e)) {
          // Spec: retry once on connection timeout (§11)
          if (attempt < 1) {
            this.log(`Connection timeout, retrying in 2s (attempt ${attempt + 1}/2)...`);
            await delay(getRetryDelayMs(2000));
            continue;
          }
          throw this.emitExchangeError(clean, lastErr, {
            attempt: attempt + 1,
            streamed: false,
            totalMs: Date.now() - reqStart,
          });
        }

        if (isConnRefused(e) || isFetchFailed(e)) {
          if (attempt < 2) {
            this.log(
              `Connection error (${e?.message ?? 'unknown'}), retrying in 2s (attempt ${attempt + 1}/3)...`
            );
            await delay(getRetryDelayMs(2000));
            continue;
          }
          const connErr = makeClientError(
            `Cannot reach ${this.endpoint}. Is llama-server running? (${e?.message ?? ''})`,
            undefined,
            true
          );
          throw this.emitExchangeError(clean, connErr, {
            attempt: attempt + 1,
            streamed: false,
            totalMs: Date.now() - reqStart,
          });
        }

        // Non-retryable errors (4xx, etc.)
        throw this.emitExchangeError(clean, lastErr, {
          attempt: attempt + 1,
          streamed: false,
          totalMs: Date.now() - reqStart,
        });
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
      }
    }

    throw this.emitExchangeError(clean, lastErr, {
      attempt: 3,
      streamed: false,
      totalMs: Date.now() - reqStart,
    });
  }

  /** Streaming chat with retry, read timeout, and 400→non-stream fallback */
  async chatStream(opts: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSchema[];
    tool_choice?: any;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    extra?: Record<string, unknown>;
    signal?: AbortSignal;
    requestId?: string;
    onToken?: (text: string) => void;
    onFirstDelta?: () => void;
    onToolCallDelta?: (delta: {
      index: number;
      id?: string;
      name?: string;
      argumentsChunk?: string;
      argumentsSoFar?: string;
      done?: boolean;
    }) => void;
    readTimeoutMs?: number; // default 30000 (§11: partial SSE frame timeout)
  }): Promise<ChatCompletionResponse> {
    const url = `${this.endpoint}/chat/completions`;
    const clean = this.buildBody({ ...opts, stream: true });
    const readTimeout =
      (Number.isFinite(Number(process.env.IDLEHANDS_READ_TIMEOUT_MS))
        ? Number(process.env.IDLEHANDS_READ_TIMEOUT_MS)
        : undefined) ??
      opts.readTimeoutMs ??
      30_000;

    this.log(`→ POST ${url} (stream) ${opts.requestId ? `(rid=${opts.requestId})` : ''}`);

    // Rate-limit delay (§6e: back off if too many 503s in rolling window)
    const rlDelay = this.rateLimiter.getDelay();
    if (rlDelay > 0) {
      this.log(
        `rate-limit backoff: waiting ${rlDelay}ms (${this.rateLimiter.recentCount} retryable errors in window)`
      );
      console.warn(
        `[warn] server returned 429/503 ${this.rateLimiter.recentCount} times in 60s, backing off ${(rlDelay / 1000).toFixed(1)}s`
      );
      await delay(getRetryDelayMs(rlDelay));
    }

    let lastErr: unknown = makeClientError(
      'POST /chat/completions (stream) failed without response',
      503,
      true
    );
    const reqStart = Date.now();
    const seen5xxMessages: string[] = []; // Track 5xx error messages to detect deterministic failures
    let switchedToContentModeThisCall = false;

    const fallbackToNonStream = async (
      attempt: number,
      reason: string,
      detail?: Record<string, unknown>
    ): Promise<ChatCompletionResponse> => {
      const fallback = await this.chat({ ...opts, stream: false });
      const priorMeta =
        fallback && typeof (fallback as any).meta === 'object' ? (fallback as any).meta : {};
      (fallback as any).meta = {
        ...priorMeta,
        stream_fallback: {
          reason,
          attempt: attempt + 1,
          endpoint: this.endpoint,
          ...(detail ?? {}),
        },
      };
      return fallback;
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      let res: Response;
      try {
        res = await this.fetchWithConnTimeout(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(clean),
          signal: opts.signal,
        });
      } catch (e: any) {
        lastErr = asError(e, `POST /chat/completions (stream) attempt ${attempt + 1} failed`);
        if (opts.signal?.aborted) {
          throw this.emitExchangeError(clean, lastErr, {
            attempt: attempt + 1,
            streamed: true,
            totalMs: Date.now() - reqStart,
          });
        }

        if (isConnTimeout(e)) {
          if (attempt < 1) {
            this.log(`Connection timeout, retrying in 2s (attempt ${attempt + 1}/2)...`);
            await delay(getRetryDelayMs(2000));
            continue;
          }
          throw this.emitExchangeError(clean, lastErr, {
            attempt: attempt + 1,
            streamed: true,
            totalMs: Date.now() - reqStart,
          });
        }

        if (isConnRefused(e) || isFetchFailed(e)) {
          if (attempt < 2) {
            this.log(
              `Connection error (${e?.message ?? 'unknown'}), retrying in 2s (attempt ${attempt + 1}/3)...`
            );
            await delay(getRetryDelayMs(2000));
            continue;
          }
          const connErr = makeClientError(
            `Cannot reach ${this.endpoint}. Is llama-server running? (${e?.message ?? ''})`,
            undefined,
            true
          );
          throw this.emitExchangeError(clean, connErr, {
            attempt: attempt + 1,
            streamed: true,
            totalMs: Date.now() - reqStart,
          });
        }
        throw this.emitExchangeError(clean, lastErr, {
          attempt: attempt + 1,
          streamed: true,
          totalMs: Date.now() - reqStart,
        });
      }

      // HTTP 400 on stream → fall back to non-streaming (server doesn't support it)
      if (res.status === 400) {
        this.log('HTTP 400 on stream request, falling back to non-streaming');
        return fallbackToNonStream(attempt, 'http_400', { status: 400 });
      }

      // HTTP 503 → retry with exponential backoff
      if (res.status === 503 || res.status === 429) {
        this.rateLimiter.recordRetryableError();
        const backoff = Math.pow(2, attempt + 1) * 1000;
        lastErr = makeClientError(
          `POST /chat/completions (stream) returned 503 (model loading), attempt ${attempt + 1}/3`,
          503,
          true
        );
        this.log(`503 model loading, retrying in ${backoff}ms...`);
        if (attempt < 2) {
          await delay(getRetryDelayMs(backoff));
          continue;
        }
        throw this.emitExchangeError(clean, lastErr, {
          attempt: attempt + 1,
          streamed: true,
          totalMs: Date.now() - reqStart,
        });
      }

      // HTTP 5xx on stream → retry (and optionally fall back to non-stream after repeated failures)
      if (res.status >= 500 && res.status <= 599) {
        const text = await res.text().catch(() => '');
        const errSig = `${res.status}:${text.slice(0, 500)}`;
        lastErr = makeClientError(
          `POST /chat/completions (stream) failed: ${res.status} ${res.statusText}${text ? `\n${text.slice(0, 2000)}` : ''}`,
          res.status,
          true
        );

        // Detect known tool-call compatibility failures and auto-switch to content mode.
        const compat = this.detectToolCallCompatFailure(text);
        if (compat) {
          if (switchedToContentModeThisCall) {
            const compatErr = makeClientError(
              `Tool-call compatibility failure persisted after content-mode switch (${compat.kind}). Aborting to avoid retry loop.\n${text.slice(0, 2000)}`,
              res.status,
              false
            );
            throw this.emitExchangeError(clean, compatErr, {
              attempt: attempt + 1,
              streamed: true,
              totalMs: Date.now() - reqStart,
            });
          }
          this.log(`Detected ${compat.reason} — switching to content-mode tool calls`);
          console.warn(
            `[warn] Server cannot parse tool_calls reliably (${compat.kind}). Switching to content-mode (tools in system prompt).`
          );
          this.contentModeToolCalls = true;
          this.compatTelemetry.autoSwitches += 1;
          switchedToContentModeThisCall = true;
          // Retry immediately with content mode (tools stripped from body)
          return this.chatStream(opts);
        }

        // Detect deterministic server errors (same error body repeated) — bail immediately
        if (seen5xxMessages.includes(errSig)) {
          this.log(
            `Deterministic server error detected (same ${res.status} repeated) — not retrying`
          );
          const deterministicErr = makeClientError(
            `Server returns the same error repeatedly (${res.status}). This is likely a template or model compatibility issue, not a transient failure.\n${text.slice(0, 2000)}`,
            res.status,
            false // not retryable
          );
          throw this.emitExchangeError(clean, deterministicErr, {
            attempt: attempt + 1,
            streamed: true,
            totalMs: Date.now() - reqStart,
          });
        }
        seen5xxMessages.push(errSig);

        // If we keep getting server errors, try a non-streaming request as a last resort.
        const allowFallback = (process.env.IDLEHANDS_STREAM_FALLBACK ?? '1') !== '0';
        if (allowFallback && attempt >= 1) {
          this.log(
            `HTTP ${res.status} on stream request, falling back to non-streaming (attempt ${attempt + 1}/3)`
          );
          return fallbackToNonStream(attempt, 'http_5xx_retries_exhausted', {
            status: res.status,
          });
        }

        const backoff = Math.pow(2, attempt + 1) * 1000;
        this.log(`HTTP ${res.status} on stream request, retrying in ${backoff}ms...`);
        await delay(getRetryDelayMs(backoff));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const httpErr = makeClientError(
          `POST /chat/completions (stream) failed: ${res.status} ${res.statusText}${text ? `\n${text.slice(0, 2000)}` : ''}`,
          res.status,
          false
        );
        throw this.emitExchangeError(clean, httpErr, {
          attempt: attempt + 1,
          streamed: true,
          totalMs: Date.now() - reqStart,
        });
      }

      // --- Parse SSE stream with read timeout ---
      const reader = res.body?.getReader();
      if (!reader) {
        throw this.emitExchangeError(clean, new Error('No response body to read (stream)'), {
          attempt: attempt + 1,
          streamed: true,
          totalMs: Date.now() - reqStart,
        });
      }

      const decoder = new TextDecoder();
      let buf = '';

      const agg: ChatCompletionResponse = {
        id: 'stream',
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
      const toolArgsByIndex: Record<number, string> = {};
      const toolNameByIndex: Record<number, string> = {};
      const toolIdByIndex: Record<number, string> = {};
      let sawDelta = false;
      let firstDeltaMs: number | undefined;
      let tokensReceived = 0;

      const emitFinalToolCallDeltas = (response: ChatCompletionResponse) => {
        if (!opts.onToolCallDelta) return;
        const toolCalls = response.choices?.[0]?.message?.tool_calls;
        if (!Array.isArray(toolCalls)) return;
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          opts.onToolCallDelta({
            index: i,
            id: tc?.id,
            name: tc?.function?.name,
            argumentsChunk: tc?.function?.arguments,
            argumentsSoFar: tc?.function?.arguments,
            done: true,
          });
        }
      };

      while (true) {
        // Race reader.read() against a cancellable read timeout.
        // Using AbortController avoids leaking dangling delay() timers on every chunk.
        const timeoutAc = new AbortController();
        const timeoutPromise = delay(readTimeout, undefined, { signal: timeoutAc.signal })
          .then(() => 'TIMEOUT' as const)
          .catch(() => 'CANCELLED' as const);
        const readPromise = reader.read().then((r) => {
          timeoutAc.abort();
          return r;
        });
        const result = await Promise.race([readPromise, timeoutPromise]);

        if (result === 'TIMEOUT') {
          reader.cancel().catch(() => {});

          // If we got *some* deltas, returning partial content is usually worse UX for tool-using agents:
          // it often leaves a truncated tool call / JSON args which then fails downstream.
          // Instead, prefer retry/fallback to non-streaming when enabled.
          const allowFallback = (process.env.IDLEHANDS_STREAM_FALLBACK ?? '1') !== '0';
          if (allowFallback) {
            if (sawDelta) {
              this.log(`read timeout after ${tokensReceived} tokens, retrying via non-streaming`);
            } else {
              this.log(`read timeout with no data, retrying via non-streaming`);
            }
            return fallbackToNonStream(attempt, 'stream_read_timeout', {
              read_timeout_ms: readTimeout,
              tokens_received: tokensReceived,
              had_delta: sawDelta,
            });
          }

          if (sawDelta) {
            this.log(`read timeout after ${tokensReceived} tokens, returning partial`);
            const partial = this.finalizeStreamAggregate(
              agg,
              toolIdByIndex,
              toolNameByIndex,
              toolArgsByIndex
            );
            const content = partial.choices?.[0]?.message?.content;
            if (content) {
              partial.choices[0].message!.content =
                content + `\n[connection lost after ${tokensReceived} tokens]`;
            }
            const totalMs = Date.now() - reqStart;
            emitFinalToolCallDeltas(partial);
            (partial as any).meta = {
              total_ms: totalMs,
              ttft_ms: firstDeltaMs,
              streamed: true,
              partial: true,
            };
            this.emitExchange({
              timestamp: new Date().toISOString(),
              request: clean,
              response: partial as any,
              metrics: {
                total_ms: totalMs,
                ttft_ms: firstDeltaMs,
                prompt_tokens: partial.usage?.prompt_tokens,
                completion_tokens: partial.usage?.completion_tokens,
              },
            });
            return partial;
          }

          const streamTimeoutErr = makeClientError(
            `Stream read timeout (${readTimeout}ms) with no data received`,
            undefined,
            true
          );
          throw this.emitExchangeError(clean, streamTimeoutErr, {
            attempt: attempt + 1,
            streamed: true,
            totalMs: Date.now() - reqStart,
          });
        }

        if (result === 'CANCELLED') continue; // timeout was cancelled, read won

        const { value, done } = result;
        if (done) break;

        // ── Optimized SSE parsing ──────────────────────────────────
        // Instead of buf += decoder.decode(value), which creates a new
        // string on every chunk, we check if the chunk contains a complete
        // frame boundary first. If the buffer is empty and the chunk
        // contains no frame boundary, we can skip the concat entirely
        // for partial-line chunks (common with fast local models).
        const decoded = decoder.decode(value, { stream: true });

        // Fast path: if buffer is empty and no frame boundary in this chunk,
        // just assign (avoid string concat allocation)
        if (buf.length === 0) {
          buf = decoded;
        } else {
          buf += decoded;
        }

        while (true) {
          const idx = buf.indexOf('\n\n');
          if (idx === -1) break;
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          // ── Fast SSE line parser ─────────────────────────────────
          // Parse `data: ...` lines without splitting the entire frame
          // into an array first. For single-data-line frames (the common
          // case), this avoids an array allocation entirely.
          let searchStart = 0;
          while (searchStart < frame.length) {
            const lineEnd = frame.indexOf('\n', searchStart);
            const line = lineEnd === -1 ? frame.slice(searchStart) : frame.slice(searchStart, lineEnd);
            searchStart = lineEnd === -1 ? frame.length : lineEnd + 1;

            // Only process "data: ..." lines (skip event:, id:, etc.)
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trimStart();
            if (data === '[DONE]') {
              const doneResult = this.finalizeStreamAggregate(
                agg,
                toolIdByIndex,
                toolNameByIndex,
                toolArgsByIndex
              );
              const totalMs = Date.now() - reqStart;
              emitFinalToolCallDeltas(doneResult);
              (doneResult as any).meta = {
                total_ms: totalMs,
                ttft_ms: firstDeltaMs,
                streamed: true,
              };
              this.emitExchange({
                timestamp: new Date().toISOString(),
                request: clean,
                response: doneResult as any,
                metrics: {
                  total_ms: totalMs,
                  ttft_ms: firstDeltaMs,
                  prompt_tokens: doneResult.usage?.prompt_tokens,
                  completion_tokens: doneResult.usage?.completion_tokens,
                },
              });
              return doneResult;
            }
            let chunk: ChatCompletionResponse;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }

            // Capture usage even when this is a usage-only terminal chunk
            // (e.g., llama.cpp with stream_options.include_usage=true has choices=[]).
            if (chunk.usage) {
              agg.usage = chunk.usage;
            }

            const c = chunk.choices?.[0];
            const d = c?.delta;

            // Some chunks have no delta (usage-only or finish-only chunks).
            // Keep finish_reason if present, then continue.
            if (!d) {
              if (c?.finish_reason) {
                agg.choices[0].finish_reason = c.finish_reason;
              }
              continue;
            }

            if (!sawDelta) {
              sawDelta = true;
              firstDeltaMs = Date.now() - reqStart;
              opts.onFirstDelta?.();
            }

            if (d.content) {
              tokensReceived++;
              agg.choices[0].delta!.content = (agg.choices[0].delta!.content ?? '') + d.content;
              opts.onToken?.(d.content);
            }

            // Handle reasoning tokens (Qwen3 thinking mode) — track progress but don't include in visible output
            if ((d as any).reasoning) {
              tokensReceived++;
              // Fire onToken with empty string to mark progress without adding visible content
              // This keeps the watchdog alive during reasoning phases
              opts.onToken?.('');
            }

            if (Array.isArray(d.tool_calls)) {
              let sawToolCallChunk = false;
              for (const tc of d.tool_calls) {
                const i = tc.index;
                if (i === undefined) continue;
                if (tc.id) toolIdByIndex[i] = tc.id;
                if (tc.function?.name) toolNameByIndex[i] = tc.function.name;
                if (tc.function?.arguments) {
                  toolArgsByIndex[i] = (toolArgsByIndex[i] ?? '') + tc.function.arguments;
                }

                sawToolCallChunk = true;
                opts.onToolCallDelta?.({
                  index: i,
                  id: toolIdByIndex[i],
                  name: toolNameByIndex[i],
                  argumentsChunk: tc.function?.arguments,
                  argumentsSoFar: toolArgsByIndex[i] ?? '',
                  done: false,
                });
              }

              // Keepalive progress ping: some models stream tool deltas without content tokens.
              if (sawToolCallChunk && !d.content) {
                opts.onToken?.('');
              }
            }

            if (c.finish_reason) {
              agg.choices[0].finish_reason = c.finish_reason;
            }
          }
        }
      }

      const streamResult = this.finalizeStreamAggregate(
        agg,
        toolIdByIndex,
        toolNameByIndex,
        toolArgsByIndex
      );
      emitFinalToolCallDeltas(streamResult);
      const totalMs = Date.now() - reqStart;
      // Backpressure: track streaming response time
      const bp = this.backpressure.record(totalMs);
      if (bp.warn) {
        const avgS = (bp.avg / 1000).toFixed(1);
        const curS = (bp.current / 1000).toFixed(1);
        this.log(
          `backpressure warning: response ${curS}s > ${this.backpressure.multiplier}× avg ${avgS}s — consider reducing context size`
        );
        console.warn(
          `[warn] server response time (${curS}s) exceeds ${this.backpressure.multiplier}× session average (${avgS}s) — consider reducing context size`
        );
      }
      (streamResult as any).meta = {
        total_ms: totalMs,
        ttft_ms: firstDeltaMs,
        streamed: true,
      };
      const tgSpeed = (() => {
        const completionTokens = streamResult.usage?.completion_tokens;
        if (completionTokens == null || !Number.isFinite(completionTokens) || totalMs <= 0)
          return undefined;
        const genMs = Math.max(1, totalMs - (firstDeltaMs ?? 0));
        return completionTokens / (genMs / 1000);
      })();
      this.emitExchange({
        timestamp: new Date().toISOString(),
        request: clean,
        response: streamResult as any,
        metrics: {
          total_ms: totalMs,
          ttft_ms: firstDeltaMs,
          tg_speed: tgSpeed,
          prompt_tokens: streamResult.usage?.prompt_tokens,
          completion_tokens: streamResult.usage?.completion_tokens,
        },
      });
      return streamResult;
    }

    throw this.emitExchangeError(clean, lastErr, {
      attempt: 3,
      streamed: true,
      totalMs: Date.now() - reqStart,
    });
  }

  /**
   * Quick smoke test: send a minimal tool-call round-trip to detect template errors.
   * Returns null on success, error message string on failure.
   */
  async smokeTestToolCalls(model: string): Promise<string | null> {
    const testMessages: ChatMessage[] = [
      { role: 'system', content: 'You are a test.' },
      { role: 'user', content: 'test' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'test_1',
            type: 'function',
            function: { name: 'test_tool', arguments: '{"key":"value"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'test_1', content: 'ok' },
    ];
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15_000);
      await this.chat({
        model,
        messages: testMessages,
        max_tokens: 1,
        temperature: 0,
        signal: ac.signal,
      });
      clearTimeout(timer);
      return null;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Only flag template/format errors (5xx with template keywords), not connection issues
      if (/500|template|filter|items|jinja/i.test(msg)) {
        return `Tool-call template error: ${msg.slice(0, 500)}`;
      }
      // Other errors (timeout, connection) — don't block startup
      return null;
    }
  }

  private finalizeStreamAggregate(
    agg: ChatCompletionResponse,
    toolIdByIndex: Record<number, string>,
    toolNameByIndex: Record<number, string>,
    toolArgsByIndex: Record<number, string>
  ): ChatCompletionResponse {
    const content = agg.choices[0].delta?.content ?? '';
    const toolCalls: any[] = [];

    const indices = Object.keys(toolNameByIndex)
      .map(Number)
      .sort((a, b) => a - b);
    for (const idx of indices) {
      toolCalls.push({
        id: toolIdByIndex[idx] ?? `call_${idx}`,
        type: 'function',
        function: {
          name: toolNameByIndex[idx],
          arguments: toolArgsByIndex[idx] ?? '',
        },
      });
    }

    agg.choices[0].message = {
      role: 'assistant',
      content: content.length ? content : null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    };

    delete agg.choices[0].delta;
    return agg;
  }
}
