import { execute, loadActiveRuntime, runOnHost } from '../runtime/executor.js';
import { waitForModelsReady } from '../runtime/health.js';
import { plan } from '../runtime/planner.js';
import { loadRuntimes } from '../runtime/store.js';
import type { IdlehandsConfig } from '../types.js';

function endpointBase(endpoint?: string): string | null {
  if (!endpoint) return null;
  const e = endpoint.trim().replace(/\/+$/, '');
  if (!e) return null;
  return e.endsWith('/v1') ? e : `${e}/v1`;
}

async function probeEndpointReady(endpoint?: string): Promise<{ ok: boolean; reason: string }> {
  const base = endpointBase(endpoint);
  if (!base) return { ok: false, reason: 'endpoint-not-configured' };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(`${base}/models`, { signal: ctrl.signal as any });
    if (res.status === 503) return { ok: false, reason: 'loading-http-503' };
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    return { ok: true, reason: 'ok' };
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    if (msg.includes('aborted')) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: msg.slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}

export function classifyInfraError(err: unknown): 'infra_down' | 'loading' | 'other' {
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
  if (!msg) return 'other';
  if (msg.includes('aborted') || msg.includes('cancel')) return 'other';

  if (msg.includes('503') || msg.includes('model is loading') || msg.includes('loading')) {
    return 'loading';
  }

  const infraPatterns = [
    'econnrefused',
    'could not connect',
    'connection refused',
    'enotfound',
    'fetch failed',
    'connect timeout',
    'socket hang up',
    'no models found',
    'endpoint',
  ];

  if (infraPatterns.some((p) => msg.includes(p))) {
    return 'infra_down';
  }

  return 'other';
}

export async function ensureAntonRuntimeReady(
  idlehandsConfig: IdlehandsConfig,
  opts: { forceRestart: boolean; timeoutMs?: number }
): Promise<{ ok: boolean; detail: string }> {
  const endpointProbe = await probeEndpointReady(idlehandsConfig.endpoint);
  if (endpointProbe.ok) return { ok: true, detail: 'endpoint-ready' };

  let rtConfig;
  try {
    rtConfig = await loadRuntimes();
  } catch {
    return {
      ok: false,
      detail: `endpoint-not-ready (${endpointProbe.reason}); runtimes-unavailable`,
    };
  }

  const active = await loadActiveRuntime();
  let targetModelId: string | undefined;

  if (active?.modelId && rtConfig.models.some((m) => m.id === active.modelId && m.enabled)) {
    targetModelId = active.modelId;
  } else if (
    typeof idlehandsConfig.model === 'string' &&
    rtConfig.models.some((m) => m.id === idlehandsConfig.model && m.enabled)
  ) {
    targetModelId = idlehandsConfig.model;
  }

  if (!targetModelId) {
    return {
      ok: false,
      detail: `endpoint-not-ready (${endpointProbe.reason}); no-runtime-model-mapping`,
    };
  }

  const planOut = plan(
    { modelId: targetModelId, mode: 'live', forceRestart: opts.forceRestart },
    rtConfig,
    active
  );
  if (!planOut.ok) {
    return { ok: false, detail: `runtime-plan-failed ${planOut.code}: ${planOut.reason}` };
  }

  const execRes = await execute(planOut, {
    force: true,
    confirm: async () => true,
  });

  if (!execRes.ok) {
    return { ok: false, detail: `runtime-exec-failed: ${execRes.error ?? 'unknown'}` };
  }

  const timeoutMs = Math.max(
    10_000,
    opts.timeoutMs ?? (planOut.model.launch.probe_timeout_sec ?? 600) * 1000
  );
  for (const resolvedHost of planOut.hosts) {
    const hostCfg = rtConfig.hosts.find((h) => h.id === resolvedHost.id);
    if (!hostCfg) continue;
    const ready = await waitForModelsReady(
      runOnHost as any,
      hostCfg,
      planOut.model.runtime_defaults?.port ?? 8080,
      {
        timeoutMs,
        intervalMs: planOut.model.launch.probe_interval_ms ?? 2000,
      }
    );
    if (!ready.ok) {
      return {
        ok: false,
        detail: `wait-ready failed on ${resolvedHost.id}: ${ready.reason ?? 'timeout'}`,
      };
    }
  }

  return { ok: true, detail: 'runtime-ready' };
}
