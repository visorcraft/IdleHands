import {
  HOOK_CAPABILITIES,
  type HookCapability,
  type HookDispatchContext,
  type HookEventMap,
  type HookEventName,
  type HookHandler,
  type HookLog,
  type HookPlugin,
  type HookPluginInfo,
  type HookStatsSnapshot,
} from './types.js';

const defaultLogger: HookLog = (message) => {
  if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
    console.warn(message);
  }
};

type HookManagerOptions = {
  enabled?: boolean;
  strict?: boolean;
  warnMs?: number;
  logger?: HookLog;
  allowedCapabilities?: HookCapability[];
  context: () => HookDispatchContext;
};

type RegisteredHandler = {
  source: string;
  fn: HookHandler<any>;
  capabilities: Set<HookCapability>;
};

function clampCapabilities(caps: HookCapability[] | undefined): HookCapability[] {
  const raw: HookCapability[] = Array.isArray(caps) && caps.length ? caps : ['observe'];
  const allowed = new Set<HookCapability>(HOOK_CAPABILITIES);
  const uniq = new Set<HookCapability>();
  for (const cap of raw) {
    if (allowed.has(cap)) uniq.add(cap);
  }
  if (uniq.size === 0) uniq.add('observe');
  return [...uniq];
}

function pushLimited(list: string[], value: string, max = 25): void {
  list.push(value);
  if (list.length > max) list.splice(0, list.length - max);
}

function redactPayload<E extends HookEventName>(
  event: E,
  payload: HookEventMap[E],
  caps: Set<HookCapability>
): HookEventMap[E] {
  const out: any = JSON.parse(JSON.stringify(payload));

  if (event === 'ask_start' && !caps.has('read_prompts')) {
    out.instruction = '[redacted: missing read_prompts capability]';
  }

  if (event === 'ask_end' && !caps.has('read_responses')) {
    out.text = '[redacted: missing read_responses capability]';
  }

  if (event === 'tool_call' && !caps.has('read_tool_args')) {
    if (out.call && typeof out.call === 'object') {
      out.call.args = {};
    }
  }

  if (event === 'tool_result' && !caps.has('read_tool_results')) {
    if (out.result && typeof out.result === 'object') {
      out.result.result = '[redacted: missing read_tool_results capability]';
    }
  }

  if (event === 'tool_stream' && !caps.has('read_tool_results')) {
    if (out.stream && typeof out.stream === 'object') {
      out.stream.chunk = '[redacted: missing read_tool_results capability]';
    }
  }

  return out;
}

export class HookManager {
  private readonly handlers = new Map<HookEventName, RegisteredHandler[]>();
  private readonly enabled: boolean;
  private readonly strict: boolean;
  private readonly warnMs: number;
  private readonly logger: HookLog;
  private readonly getContext: () => HookDispatchContext;
  private readonly allowedCapabilities: Set<HookCapability>;

  private readonly eventCounts = new Map<HookEventName, number>();
  private readonly recentErrors: string[] = [];
  private readonly recentSlowHandlers: string[] = [];
  private readonly plugins: HookPluginInfo[] = [];

  constructor(opts: HookManagerOptions) {
    this.enabled = opts.enabled !== false;
    this.strict = opts.strict === true;
    this.warnMs = Math.max(0, Math.floor(opts.warnMs ?? 250));
    this.logger = opts.logger ?? defaultLogger;
    this.getContext = opts.context;

    const allowed = clampCapabilities(opts.allowedCapabilities);
    this.allowedCapabilities = new Set(allowed);
    if (!this.allowedCapabilities.has('observe')) {
      this.allowedCapabilities.add('observe');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getSnapshot(): HookStatsSnapshot {
    const handlers: HookStatsSnapshot['handlers'] = [];
    for (const [event, list] of this.handlers) {
      for (const item of list) {
        handlers.push({ source: item.source, event });
      }
    }

    const counts: Partial<Record<HookEventName, number>> = {};
    for (const [event, count] of this.eventCounts) {
      counts[event] = count;
    }

    return {
      enabled: this.enabled,
      strict: this.strict,
      allowedCapabilities: [...this.allowedCapabilities],
      plugins: [...this.plugins],
      handlers,
      eventCounts: counts,
      recentErrors: [...this.recentErrors],
      recentSlowHandlers: [...this.recentSlowHandlers],
    };
  }

  on<E extends HookEventName>(
    event: E,
    handler: HookHandler<E>,
    source = 'runtime',
    capabilities?: HookCapability[]
  ): void {
    if (!this.enabled) return;
    const list = this.handlers.get(event) ?? [];
    list.push({
      source,
      fn: handler as HookHandler<any>,
      capabilities: new Set(clampCapabilities(capabilities)),
    });
    this.handlers.set(event, list);
  }

  async registerPlugin(plugin: HookPlugin, source: string): Promise<void> {
    if (!this.enabled) return;

    const requested = clampCapabilities(plugin.capabilities);
    const granted = requested.filter((c) => this.allowedCapabilities.has(c));
    const denied = requested.filter((c) => !this.allowedCapabilities.has(c));

    if (granted.length === 0) {
      granted.push('observe');
    }

    if (denied.length > 0) {
      const msg = `[hooks] plugin ${source} requested denied capabilities: ${denied.join(', ')}`;
      if (this.strict) throw new Error(msg);
      this.logger(msg);
    }

    this.plugins.push({
      source,
      name: plugin.name || source,
      requestedCapabilities: requested,
      grantedCapabilities: granted,
      deniedCapabilities: denied,
    });

    if (plugin.hooks && typeof plugin.hooks === 'object') {
      for (const [event, value] of Object.entries(plugin.hooks) as Array<
        [HookEventName, HookHandler<any> | HookHandler<any>[]]
      >) {
        const list = Array.isArray(value) ? value : [value];
        for (const fn of list) {
          if (typeof fn === 'function') {
            this.on(event, fn as any, source, granted);
          }
        }
      }
    }

    if (typeof plugin.setup === 'function') {
      await plugin.setup({
        on: (event, handler) => this.on(event, handler, source, granted),
        context: this.getContext(),
      });
    }
  }

  async emit<E extends HookEventName>(event: E, payload: HookEventMap[E]): Promise<void> {
    if (!this.enabled) return;

    const list = this.handlers.get(event);
    if (!list || list.length === 0) return;

    this.eventCounts.set(event, (this.eventCounts.get(event) ?? 0) + 1);
    const ctx = this.getContext();

    for (const handler of list) {
      const started = Date.now();
      try {
        const safePayload = redactPayload(event, payload, handler.capabilities);
        await handler.fn(safePayload, ctx);
      } catch (error: any) {
        const msg = `[hooks] ${event} handler failed (${handler.source}): ${error?.message ?? String(error)}`;
        pushLimited(this.recentErrors, msg);
        if (this.strict) throw new Error(msg);
        this.logger(msg);
      } finally {
        const elapsed = Date.now() - started;
        if (this.warnMs > 0 && elapsed >= this.warnMs) {
          const slow = `[hooks] ${event} handler slow (${handler.source}): ${elapsed}ms`;
          pushLimited(this.recentSlowHandlers, slow);
          this.logger(slow);
        }
      }
    }
  }
}
