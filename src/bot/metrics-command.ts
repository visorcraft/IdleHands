import type { CmdResult, ManagedLike } from './command-logic.js';

/**
 * /metrics — Show session performance metrics.
 */
export function metricsCommand(managed: ManagedLike): CmdResult {
  const session = managed.session;

  // Get perf summary if available
  const perf = typeof (session as any).getPerfSummary === 'function'
    ? (session as any).getPerfSummary()
    : null;

  const usage = session.usage;
  const model = session.model;
  const debug = (session as any).lastTurnDebug;

  const lines: string[] = [];

  if (perf) {
    const avgTurnMs = perf.turns > 0 ? Math.round(perf.totalWallMs / perf.turns) : 0;
    const avgTokensPerTurn = perf.turns > 0 ? Math.round(perf.totalTokens / perf.turns) : 0;
    const tokPerSec = perf.totalGenMs > 0
      ? ((perf.totalCompletionTokens / perf.totalGenMs) * 1000).toFixed(1)
      : '—';

    lines.push(
      `📊 Session Metrics`,
      '',
      `  Model: ${model}`,
      `  Turns: ${perf.turns}`,
      `  Tool calls: ${perf.totalToolCalls ?? '—'}`,
      '',
      `  ⏱ Timing`,
      `    Avg turn: ${fmtMs(avgTurnMs)}`,
      `    Total wall: ${fmtMs(perf.totalWallMs)}`,
      `    Total generation: ${fmtMs(perf.totalGenMs)}`,
      '',
      `  📝 Tokens`,
      `    Total: ${perf.totalTokens.toLocaleString()} (${perf.totalPromptTokens.toLocaleString()} in / ${perf.totalCompletionTokens.toLocaleString()} out)`,
      `    Avg/turn: ${avgTokensPerTurn.toLocaleString()}`,
      `    Gen speed: ${tokPerSec} tok/s`,
    );

    if (perf.compactions > 0) {
      lines.push(``, `  🗜 Compactions: ${perf.compactions}`);
    }

    if (perf.cacheHits > 0 || perf.cacheMisses > 0) {
      const total = perf.cacheHits + perf.cacheMisses;
      const hitRate = total > 0 ? Math.round((perf.cacheHits / total) * 100) : 0;
      lines.push(``, `  💾 Cache: ${hitRate}% hit (${perf.cacheHits}/${total})`);
    }
  } else {
    lines.push(
      `📊 Session Metrics`,
      '',
      `  Model: ${model}`,
      `  Tokens: ${usage.prompt.toLocaleString()} in / ${usage.completion.toLocaleString()} out`,
    );
  }

  if (debug) {
    lines.push(
      '',
      `  🔀 Last Route`,
      `    Mode: ${debug.selectedMode} (${debug.selectedModeSource})`,
      `    Hint: ${debug.classificationHint ?? 'none'}`,
      `    Provider: ${debug.provider}`,
      `    Tools: ${debug.toolCount ?? '—'}`,
    );
    if (debug.fastLaneToolless) lines.push(`    Fast-lane toolless: on`);
    if (debug.fastLaneSlimTools) lines.push(`    Fast-lane slim: on`);
    if (debug.compactPrelude) lines.push(`    Compact prelude: on`);
  }

  return { lines };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
