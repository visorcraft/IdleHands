import type { RuntimeHost, RuntimeModel } from '../runtime/types.js';

export function deriveProbeDefaultsFromSizeGiB(sizeGiB: number): {
  timeoutSec: number;
  intervalMs: number;
} {
  if (!Number.isFinite(sizeGiB) || sizeGiB <= 0) return { timeoutSec: 60, intervalMs: 1000 };
  if (sizeGiB <= 10) return { timeoutSec: 120, intervalMs: 1000 };
  if (sizeGiB <= 40) return { timeoutSec: 300, intervalMs: 1200 };
  if (sizeGiB <= 80) return { timeoutSec: 900, intervalMs: 2000 };
  if (sizeGiB <= 140) return { timeoutSec: 3600, intervalMs: 5000 };
  return { timeoutSec: 5400, intervalMs: 5000 };
}

async function estimateModelSizeGiBOnHost(
  modelSource: string,
  _host: RuntimeHost,
  _runOnHost: (
    command: string,
    host: RuntimeHost,
    timeoutMs: number
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
): Promise<number | null> {
  const src = modelSource.toLowerCase();

  const sizeHint = src.match(/(\d{2,4})b/);
  const paramsB = sizeHint ? Number(sizeHint[1]) : NaN;

  let bitsPerWeight = 16;
  if (/q8(_0|)/.test(src)) bitsPerWeight = 8;
  else if (/q6(_k|)/.test(src)) bitsPerWeight = 6;
  else if (/(q4|mxfp4|fp4)/.test(src)) bitsPerWeight = 4;
  else if (/q3/.test(src)) bitsPerWeight = 3;
  else if (/q2/.test(src)) bitsPerWeight = 2;

  if (!Number.isFinite(paramsB) || paramsB <= 0) return null;

  const approxGiB = paramsB * (bitsPerWeight / 8) * 1.08;
  return approxGiB;
}

export async function applyDynamicProbeDefaults(
  result: any,
  rtConfig: { hosts: RuntimeHost[]; models: RuntimeModel[] },
  runOnHost: (
    command: string,
    host: RuntimeHost,
    timeoutMs: number
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
): Promise<void> {
  if (!result?.ok || !Array.isArray(result?.steps)) return;

  const modelCfg = rtConfig.models.find((m) => m.id === result.model?.id);
  if (!modelCfg) return;

  const hasExplicitTimeout = modelCfg.launch?.probe_timeout_sec != null;
  const hasExplicitInterval = modelCfg.launch?.probe_interval_ms != null;
  if (hasExplicitTimeout && hasExplicitInterval) return;

  const hostId = result.hosts?.[0]?.id;
  if (!hostId) return;
  const hostCfg = rtConfig.hosts.find((h) => h.id === hostId);
  if (!hostCfg) return;

  const sizeGiB = await estimateModelSizeGiBOnHost(modelCfg.source, hostCfg, runOnHost);
  if (sizeGiB == null) return;

  const d = deriveProbeDefaultsFromSizeGiB(sizeGiB);
  for (const step of result.steps) {
    if (step.kind !== 'probe_health') continue;
    if (!hasExplicitTimeout) step.timeout_sec = d.timeoutSec;
    if (!hasExplicitInterval) step.probe_interval_ms = d.intervalMs;
  }
}
