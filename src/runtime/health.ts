import { sleep } from '../shared/async.js';
import type { RuntimeHost } from './types.js';

export type ProbeStatus = 'ready' | 'loading' | 'down' | 'unknown';

export type HostRunner = (
  command: string,
  host: {
    transport: string;
    connection: { host?: string; port?: number; user?: string; key_path?: string };
  },
  timeoutMs?: number
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface ModelsProbeResult {
  status: ProbeStatus;
  httpCode: number | null;
  modelIds: string[];
  body: string;
  stderr: string;
  exitCode: number;
}

export function parseCurlTagged(stdout: string): { code: number | null; body: string } {
  const m = stdout.match(/\n__HTTP__:(\d{3})\s*$/);
  if (!m) return { code: null, body: stdout.trim() };
  const code = Number(m[1]);
  const body = stdout.slice(0, m.index).trim();
  return { code: Number.isFinite(code) ? code : null, body };
}

export function classifyProbe(exitCode: number, httpCode: number | null): ProbeStatus {
  if (httpCode === 200) return 'ready';
  if (httpCode === 503) return 'loading';
  if (exitCode === 7 || exitCode === 28) return 'down';
  if (exitCode !== 0) return 'down';
  return 'unknown';
}

export async function probeModelsEndpoint(
  runOnHost: HostRunner,
  host: RuntimeHost,
  port: number,
  timeoutMs = 5000
): Promise<ModelsProbeResult> {
  const modelsCmd = `curl -sS -m 4 -o - -w "\\n__HTTP__:%{http_code}" http://127.0.0.1:${port}/v1/models`;
  const modelsRes = await runOnHost(modelsCmd, host, timeoutMs);
  const parsedModels = parseCurlTagged(modelsRes.stdout ?? '');
  let status = classifyProbe(modelsRes.exitCode, parsedModels.code);
  let httpCode = parsedModels.code;
  let modelIds: string[] = [];

  if (modelsRes.exitCode === 0 && parsedModels.code === 200) {
    try {
      const json = JSON.parse(parsedModels.body);
      modelIds = Array.isArray(json?.data)
        ? json.data.map((x: any) => String(x?.id ?? '')).filter(Boolean)
        : [];
    } catch {
      // keep empty model list; status remains ready due HTTP 200
    }
  }

  // Fallback to /health when /v1/models is inconclusive.
  if (status !== 'ready') {
    const healthCmd = `curl -sS -m 4 -o - -w "\\n__HTTP__:%{http_code}" http://127.0.0.1:${port}/health`;
    const healthRes = await runOnHost(healthCmd, host, timeoutMs);
    const parsedHealth = parseCurlTagged(healthRes.stdout ?? '');
    const healthStatus = classifyProbe(healthRes.exitCode, parsedHealth.code);

    if (healthStatus === 'ready' || healthStatus === 'loading') {
      status = healthStatus;
      httpCode = parsedHealth.code;
    } else if (status === 'unknown') {
      status = healthStatus;
      httpCode = parsedHealth.code;
    }
  }

  return {
    status,
    httpCode,
    modelIds,
    body: parsedModels.body,
    stderr: modelsRes.stderr ?? '',
    exitCode: modelsRes.exitCode,
  };
}

export async function waitForModelsReady(
  runOnHost: HostRunner,
  host: RuntimeHost,
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number; expectedModelId?: string } = {}
): Promise<{ ok: boolean; attempts: number; last: ModelsProbeResult; reason?: string }> {
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? 60_000);
  const intervalMs = Math.max(250, opts.intervalMs ?? 1500);
  const expectedModelId = opts.expectedModelId;

  const started = Date.now();
  let attempts = 0;
  let last: ModelsProbeResult = {
    status: 'down',
    httpCode: null,
    modelIds: [],
    body: '',
    stderr: '',
    exitCode: 1,
  };

  while (Date.now() - started < timeoutMs) {
    attempts += 1;
    last = await probeModelsEndpoint(runOnHost, host, port, Math.min(8000, timeoutMs));

    if (last.status === 'ready') {
      if (!expectedModelId) {
        return { ok: true, attempts, last };
      }
      if (last.modelIds.includes(expectedModelId) || last.modelIds.length === 0) {
        return { ok: true, attempts, last };
      }
      // Ready server but wrong model loaded; keep waiting for expected model.
    }

    await sleep(intervalMs);
  }

  const reasonParts = [
    `status=${last.status}`,
    last.httpCode != null ? `http=${last.httpCode}` : undefined,
    last.modelIds.length ? `models=${last.modelIds.join(',')}` : undefined,
    last.stderr?.trim() ? `stderr=${last.stderr.trim().split('\n')[0]}` : undefined,
  ].filter(Boolean);

  return {
    ok: false,
    attempts,
    last,
    reason: reasonParts.join(' '),
  };
}
