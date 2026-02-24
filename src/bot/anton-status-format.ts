import type { ManagedLike } from './command-logic.js';

export function formatAgeShort(msAgo: number): string {
  if (msAgo < 60_000) return `${Math.max(1, Math.round(msAgo / 1000))}s ago`;
  if (msAgo < 3_600_000) return `${Math.round(msAgo / 60_000)}m ago`;
  return `${Math.round(msAgo / 3_600_000)}h ago`;
}

export function summarizeLoopEvent(ev: NonNullable<ManagedLike['antonLastLoopEvent']>): string {
  const emoji = ev.kind === 'final-failure' ? '🔴' : ev.kind === 'auto-recovered' ? '🟠' : '🟡';
  const kind =
    ev.kind === 'final-failure'
      ? 'final failure'
      : ev.kind === 'auto-recovered'
        ? 'auto-recovered'
        : 'loop event';
  const msg = ev.message.length > 120 ? ev.message.slice(0, 117) + '...' : ev.message;
  return `${emoji} Last loop: ${kind} (${formatAgeShort(Date.now() - ev.at)})\n${msg}`;
}
