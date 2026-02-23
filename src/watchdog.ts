export type WatchdogConfigInput = {
  watchdog_timeout_ms?: number;
  watchdog_max_compactions?: number;
  watchdog_idle_grace_timeouts?: number;
  debug_abort_reason?: boolean;
};

export type WatchdogSettings = {
  timeoutMs: number;
  maxCompactions: number;
  idleGraceTimeouts: number;
  debugAbortReason: boolean;
  /** True when the configured timeout was clamped up to the 30s floor. */
  clamped: boolean;
};

export const WATCHDOG_RECOMMENDED_TUNING_TEXT =
  'watchdog_timeout_ms >= 120000, watchdog_idle_grace_timeouts >= 1, watchdog_max_compactions >= 2 for slow/large tasks.';

const TIMEOUT_FLOOR_MS = 30_000;

export function resolveWatchdogSettings(
  primary?: WatchdogConfigInput,
  fallback?: WatchdogConfigInput
): WatchdogSettings {
  const rawTimeout = Math.floor(
    primary?.watchdog_timeout_ms ?? fallback?.watchdog_timeout_ms ?? 120_000
  );
  const timeoutMs = Math.max(TIMEOUT_FLOOR_MS, rawTimeout);
  const clamped = rawTimeout < TIMEOUT_FLOOR_MS && rawTimeout !== 120_000;

  const maxCompactions = Math.max(
    0,
    Math.floor(primary?.watchdog_max_compactions ?? fallback?.watchdog_max_compactions ?? 3)
  );
  const idleGraceTimeouts = Math.max(
    0,
    Math.floor(primary?.watchdog_idle_grace_timeouts ?? fallback?.watchdog_idle_grace_timeouts ?? 1)
  );

  return {
    timeoutMs,
    maxCompactions,
    idleGraceTimeouts,
    debugAbortReason: (primary?.debug_abort_reason ?? fallback?.debug_abort_reason) === true,
    clamped,
  };
}

export function shouldRecommendWatchdogTuning(settings: WatchdogSettings): boolean {
  return (
    (settings.timeoutMs <= 90_000 && settings.idleGraceTimeouts === 0) ||
    settings.timeoutMs <= 60_000 ||
    settings.maxCompactions === 0
  );
}

export type WatchdogCancelMessageInput = {
  watchdogForcedCancel: boolean;
  maxCompactions: number;
  debugAbortReason: boolean;
  abortReason?: string | Error;
  prefix?: string;
};

export function formatWatchdogCancelMessage(input: WatchdogCancelMessageInput): string {
  const prefix = input.prefix ?? '';
  // Extract message from Error objects instead of getting [object Object]
  const rawReason = input.abortReason;
  const reasonStr = rawReason instanceof Error
    ? rawReason.message
    : String(rawReason ?? '');
  const reason = reasonStr.slice(0, 400);

  const base = input.watchdogForcedCancel
    ? `Cancelled by watchdog timeout after ${input.maxCompactions} compaction attempts. Try a smaller scope, a faster model, or increase watchdog timeout/compaction settings.`
    : 'Cancelled.';

  const withPrefix = `${prefix}${base}`;
  if (!input.debugAbortReason || !reason) return withPrefix;
  return `${withPrefix}\n\n[debug] ${reason}`;
}
