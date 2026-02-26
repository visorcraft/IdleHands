import type { CmdResult, ManagedLike } from './command-logic.js';
import type { HookStatsSnapshot } from '../hooks/index.js';

/**
 * /hooks — Inspect hook system snapshot and runtime stats.
 */
export function hooksCommand(managed: ManagedLike, arg?: string): CmdResult {
  const snapshot = managed.session.hookManager?.getSnapshot?.() as
    | HookStatsSnapshot
    | undefined;

  if (!snapshot) {
    return { error: 'Hook system unavailable for this session.' };
  }

  const mode = (arg || '').trim().toLowerCase();
  const normalizedMode =
    mode === '' || mode === 'status' ? 'status' : mode;

  const lines: string[] = [];

  if (!['status', 'errors', 'slow', 'plugins'].includes(normalizedMode)) {
    return {
      error: 'Usage: /hooks [status|plugins|errors|slow]',
    };
  }

  if (normalizedMode === 'plugins') {
    lines.push(`Hooks Status: ${snapshot.enabled ? 'enabled' : 'disabled'}`);
    lines.push(`Strict mode: ${snapshot.strict ? 'on' : 'off'}`);
    lines.push('');
    lines.push(`Plugins (${snapshot.plugins.length}):`);
    if (!snapshot.plugins.length) {
      lines.push('  • none');
    } else {
      for (const p of snapshot.plugins) {
        lines.push(`  • ${p.name} @ ${p.source}`);
        lines.push(`    granted: ${p.grantedCapabilities.join(', ') || 'none'}`);
        if (p.deniedCapabilities?.length) {
          lines.push(`    denied: ${p.deniedCapabilities.join(', ')}`);
        }
        if (p.requestedCapabilities?.length) {
          lines.push(`    requested: ${p.requestedCapabilities.join(', ')}`);
        }
      }
    }
    return { title: 'Hook Plugins', lines };
  }

  if (normalizedMode === 'errors') {
    lines.push(`Hook Errors: ${snapshot.recentErrors.length}`);
    if (!snapshot.recentErrors.length) {
      lines.push('  • none');
      return { title: 'Hook Errors', lines };
    }
    for (const e of snapshot.recentErrors.slice(-10)) {
      lines.push(`  • ${e}`);
    }
    return { title: 'Hook Errors', lines };
  }

  if (normalizedMode === 'slow') {
    lines.push(`Slow Handlers: ${snapshot.recentSlowHandlers.length}`);
    if (!snapshot.recentSlowHandlers.length) {
      lines.push('  • none');
      return { title: 'Slow Hook Handlers', lines };
    }
    for (const item of snapshot.recentSlowHandlers.slice(-10)) {
      lines.push(`  • ${item}`);
    }
    return { title: 'Slow Hook Handlers', lines };
  }

  // status mode
  const totalEvents = Object.entries(snapshot.eventCounts).reduce(
    (sum, [, count]) => sum + (Number.isFinite(Number(count)) ? Number(count) : 0),
    0
  );
  const events = Object.entries(snapshot.eventCounts)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));

  lines.push(`Hooks Status: ${snapshot.enabled ? 'enabled' : 'disabled'}`);
  lines.push(`Strict mode: ${snapshot.strict ? 'on' : 'off'}`);
  lines.push(`Allowed capabilities: ${snapshot.allowedCapabilities.join(', ') || 'observe'}`);
  lines.push(`Plugins: ${snapshot.plugins.length}`);
  lines.push(`Handlers: ${snapshot.handlers.length}`);
  lines.push(`Events observed: ${totalEvents}`);
  lines.push(`Recent errors: ${snapshot.recentErrors.length}`);
  lines.push(`Recent slow handlers: ${snapshot.recentSlowHandlers.length}`);

  if (events.length) {
    lines.push('');
    lines.push('Recent event counts:');
    for (const [event, count] of events.slice(0, 10)) {
      lines.push(`  • ${event}: ${count}`);
    }
  }

  return { title: 'Hook Status', lines };
}
