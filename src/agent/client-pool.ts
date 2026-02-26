/**
 * ClientPool — Manages routed OpenAI-compatible clients for multi-endpoint routing.
 *
 * Caches clients per normalized endpoint, applies runtime options, and attaches
 * capture hooks. Extracted from agent.ts.
 */
import type { CaptureManager } from './capture.js';

export type ClientLike = {
  setResponseTimeout(ms: number): void;
  [key: string]: any;
};

export type ClientPoolConfig = {
  verbose?: boolean;
  response_timeout?: number;
  connection_timeout?: number;
  initial_connection_check?: boolean;
  initial_connection_timeout?: number;
};

export class ClientPool {
  private readonly routedClients = new Map<string, ClientLike>();
  private readonly probedEndpoints = new Set<string>();
  private readonly primary: ClientLike;
  private readonly primaryEndpoint: string;
  private readonly apiKey?: string;
  private readonly cfg: ClientPoolConfig;
  private readonly capture: CaptureManager;
  private readonly ClientCtor: new (endpoint: string, apiKey?: string, verbose?: boolean) => ClientLike;

  constructor(opts: {
    primary: ClientLike;
    primaryEndpoint: string;
    apiKey?: string;
    cfg: ClientPoolConfig;
    capture: CaptureManager;
    ClientCtor: new (endpoint: string, apiKey?: string, verbose?: boolean) => ClientLike;
  }) {
    this.primary = opts.primary;
    this.primaryEndpoint = opts.primaryEndpoint;
    this.apiKey = opts.apiKey;
    this.cfg = opts.cfg;
    this.capture = opts.capture;
    this.ClientCtor = opts.ClientCtor;
  }

  /** Get or create a client for the given endpoint. Returns primary if no endpoint or same as primary. */
  getForEndpoint(endpoint?: string): ClientLike {
    if (!endpoint) return this.primary;
    const normalized = this.normalize(endpoint);
    if (!normalized || normalized === this.normalize(this.primaryEndpoint)) return this.primary;

    const existing = this.routedClients.get(normalized);
    if (existing) return existing;

    const routed = new this.ClientCtor(normalized, this.apiKey, this.cfg.verbose);
    this.applyRuntimeOptions(routed);
    this.attachCaptureHook(routed);
    this.routedClients.set(normalized, routed);
    return routed;
  }

  /** Probe an endpoint's connection if not already probed. */
  async probeIfNeeded(endpoint: string): Promise<void> {
    const normalized = this.normalize(endpoint);
    if (!normalized || this.probedEndpoints.has(normalized)) return;
    const client = this.getForEndpoint(endpoint);
    if (typeof client.probeConnection === 'function') {
      try {
        await client.probeConnection();
      } catch {
        // best-effort
      }
      this.probedEndpoints.add(normalized);
    }
  }

  /** Attach capture hook to the primary client. */
  attachToPrimary(): void {
    this.attachCaptureHook(this.primary);
  }

  /** Clear all cached clients and probed endpoints (e.g. on endpoint change). */
  reset(): void {
    this.routedClients.clear();
    this.probedEndpoints.clear();
  }

  /** Mark an endpoint as already probed. */
  markProbed(endpoint: string): void {
    this.probedEndpoints.add(this.normalize(endpoint));
  }

  /** Check if an endpoint has been probed. */
  isProbed(endpoint: string): boolean {
    return this.probedEndpoints.has(this.normalize(endpoint));
  }

  /** Update the primary client reference (e.g. after setEndpoint). */
  setPrimary(client: ClientLike): void {
    (this as any).primary = client;
  }

  /** Close all routed clients. */
  async closeAll(): Promise<void> {
    for (const c of this.routedClients.values()) {
      if (typeof c.close === 'function') {
        try { await c.close(); } catch { /* ignore */ }
      }
    }
    this.routedClients.clear();
    this.probedEndpoints.clear();
  }

  private normalize(endpoint: string): string {
    return endpoint.trim().replace(/\/+$/, '');
  }

  private applyRuntimeOptions(target: ClientLike): void {
    if (typeof target.setVerbose === 'function') {
      target.setVerbose(this.cfg.verbose);
    }
    if (typeof this.cfg.response_timeout === 'number' && this.cfg.response_timeout > 0) {
      target.setResponseTimeout(this.cfg.response_timeout);
    }
    if (
      typeof target.setConnectionTimeout === 'function' &&
      typeof this.cfg.connection_timeout === 'number' &&
      this.cfg.connection_timeout > 0
    ) {
      target.setConnectionTimeout(this.cfg.connection_timeout);
    }
    if (
      typeof target.setInitialConnectionCheck === 'function' &&
      typeof this.cfg.initial_connection_check === 'boolean'
    ) {
      target.setInitialConnectionCheck(this.cfg.initial_connection_check);
    }
    if (
      typeof target.setInitialConnectionProbeTimeout === 'function' &&
      typeof this.cfg.initial_connection_timeout === 'number' &&
      this.cfg.initial_connection_timeout > 0
    ) {
      target.setInitialConnectionProbeTimeout(this.cfg.initial_connection_timeout);
    }
  }

  private attachCaptureHook(target: ClientLike): void {
    if (typeof target.setExchangeHook !== 'function') return;
    target.setExchangeHook(this.capture.createExchangeHook());
  }
}
