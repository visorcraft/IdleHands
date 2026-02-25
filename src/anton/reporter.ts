/**
 * Anton autonomous task runner — display/format helpers.
 *
 * The controller NEVER builds display strings itself. All formatting happens here.
 */

import { formatDurationMs } from '../shared/format.js';

import type {
  AntonRunResult,
  AntonProgress,
  AntonTask,
  AntonAttempt,
  AntonTaskFile,
  AntonVerificationResult,
  DetectedCommands,
} from './types.js';

const formatDuration = formatDurationMs;

/**
 * Format tokens with k/M suffixes.
 */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1000000).toFixed(1)}M`;
}

/**
 * Format final run summary.
 */
export function formatRunSummary(result: AntonRunResult): string {
  const lines = [
    '🤖 Anton Complete',
    `  ✅ ${result.completed} tasks completed`,
    `  🧠 ${result.autoCompleted ?? 0} tasks already complete (preflight)`,
    `  ⏭️  ${result.skipped} tasks skipped`,
    `  ❌ ${result.failed} tasks failed`,
    `  📋 ${result.remaining} remaining`,
    `  ⏱️  ${formatDuration(result.totalDurationMs)}`,
    `  📊 ${formatTokens(result.totalTokens)} tokens`,
    `  💾 ${result.totalCommits} commits`,
    `  Stop: ${result.stopReason}`,
  ];
  return lines.join('\n');
}

/**
 * Format progress bar (20 chars wide).
 * [████████░░░░░░░░░░░░] 5/20 (25%)
 */
export function formatProgressBar(progress: AntonProgress): string {
  const completed = progress.completedSoFar;
  const total = progress.totalPending;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  const filled = Math.round((completed / total) * 20);
  const empty = 20 - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  return `[${bar}] ${completed}/${total} (${percent}%)`;
}

/**
 * Format task start message.
 */
export function formatTaskStart(task: AntonTask, attempt: number, progress: AntonProgress): string {
  const index = progress.completedSoFar + 1;
  const total = progress.totalPending;
  return `🔧 [${index}/${total}] ${task.text} (attempt ${attempt})`;
}

/**
 * Format periodic heartbeat message while a task is still in-flight.
 */
export function formatTaskHeartbeat(progress: AntonProgress): string {
  const bar = formatProgressBar(progress);
  const task = progress.currentTask ? progress.currentTask : 'unknown task';
  const attempt = progress.currentAttempt ?? 1;
  const elapsed = formatDuration(progress.elapsedMs);
  const eta =
    progress.estimatedRemainingMs !== undefined
      ? ` · ETA ~${formatDuration(progress.estimatedRemainingMs)}`
      : '';

  // Show turn progress if available
  const turn = progress.currentTurn ?? 0;
  const maxTurns = progress.maxTurns ?? 0;
  const turnInfo = maxTurns > 0 ? ` · Turn ${turn}/${maxTurns}` : '';
  const urgency = maxTurns > 0 && turn >= maxTurns - 5 ? ' ⚠️' : '';

  return `⏳ Still working: ${task} (attempt ${attempt}${turnInfo}${urgency})\n${bar}\nElapsed: ${elapsed}${eta}`;
}

/**
 * Format task end message.
 */
export function formatTaskEnd(
  task: AntonTask,
  result: AntonAttempt,
  _progress: AntonProgress
): string {
  const emoji =
    result.status === 'passed' ? '✅' : result.status === ('decomposed' as string) ? '🔀' : '❌';
  const duration = formatDuration(result.durationMs);
  const tokens = formatTokens(result.tokensUsed);

  let msg = `${emoji} ${task.text} — ${result.status} (${duration}, ${tokens} tokens)`;

  // Show verification failure details so user knows WHY it failed
  if (result.status === 'failed' && result.verification) {
    const v = result.verification;
    const failures: string[] = [];
    if (v.l1_build === false) failures.push('build');
    if (v.l1_test === false) failures.push('test');
    if (v.l1_lint === false) failures.push('lint');
    if (v.l2_ai === false) failures.push('AI review');
    if (failures.length > 0) {
      msg += `\n   Failed: ${failures.join(', ')}`;
    }
    if (v.summary) {
      // Show more of the error summary for actionable diagnostics
      const summary = v.summary.length > 500 ? v.summary.slice(0, 500) + '...' : v.summary;
      msg += `\n   ${summary}`;
    }
  }

  // Show error message if present
  if (result.error) {
    const err = result.error.length > 500 ? result.error.slice(0, 500) + '...' : result.error;
    msg += `\n   Error: ${err}`;
  }

  return msg;
}

/**
 * Format task skip message.
 */
export function formatTaskSkip(task: AntonTask, reason: string): string {
  return `⏭️  ${task.text} — skipped: ${reason}`;
}

/**
 * Format dry run plan summary.
 */
export function formatDryRunPlan(taskFile: AntonTaskFile, commands: DetectedCommands): string {
  const lines = [
    '🧪 Dry Run Plan',
    `  📋 ${taskFile.totalCount} total tasks`,
    `  ⏳ ${taskFile.pending.length} pending tasks`,
    `  ✅ ${taskFile.completed.length} already completed`,
  ];

  if (commands.build) {
    lines.push(`  🔨 Build: ${commands.build}`);
  }
  if (commands.test) {
    lines.push(`  🧪 Test: ${commands.test}`);
  }
  if (commands.lint) {
    lines.push(`  🔍 Lint: ${commands.lint}`);
  }

  lines.push('');
  lines.push('Pending tasks:');

  for (const task of taskFile.pending.slice(0, 10)) {
    const indent = '  '.repeat(task.depth + 1);
    lines.push(`${indent}• ${task.text}`);
  }

  if (taskFile.pending.length > 10) {
    lines.push(`  ... and ${taskFile.pending.length - 10} more tasks`);
  }

  return lines.join('\n');
}

/**
 * Format tool loop event message for chat status updates.
 */
export function formatToolLoopEvent(
  taskText: string,
  event: { level: string; toolName: string; count: number; message: string }
): string {
  const task = taskText.length > 60 ? taskText.slice(0, 60) + '...' : taskText;
  const detail = (event.message || '').trim();

  if (/auto-?continuing|auto-?recover/i.test(detail)) {
    return `🟠 Tool loop auto-recovered during "${task}" — ${detail}`;
  }

  if (/final loop failure|retries exhausted/i.test(detail)) {
    return `🔴 Tool loop final failure during "${task}" — ${detail}`;
  }

  const emoji = event.level === 'critical' ? '🔴' : '🟡';
  return `${emoji} Tool loop ${event.level}: \`${event.toolName}\` called ${event.count}x during "${task}"`;
}

/**
 * Format compaction event message for Discord.
 */
export function formatCompactionEvent(
  taskText: string,
  event: { droppedMessages: number; freedTokens: number; summaryUsed: boolean }
): string {
  const task = taskText.length > 60 ? taskText.slice(0, 60) + '...' : taskText;
  return `📦 Compacted ${event.droppedMessages} msgs (~${formatTokens(event.freedTokens)} tokens freed${event.summaryUsed ? ', summary injected' : ''}) during "${task}"`;
}

/**
 * Format verification detail message for Discord.
 */
export function formatVerificationDetail(taskText: string, v: AntonVerificationResult): string {
  const task = taskText.length > 60 ? taskText.slice(0, 60) + '...' : taskText;
  const parts: string[] = [];
  if (v.l1_build !== undefined) parts.push(`build:${v.l1_build ? '✅' : '❌'}`);
  if (v.l1_test !== undefined) parts.push(`test:${v.l1_test ? '✅' : '❌'}`);
  if (v.l1_lint !== undefined) parts.push(`lint:${v.l1_lint ? '✅' : '❌'}`);
  if (v.l2_ai !== undefined) parts.push(`AI:${v.l2_ai ? '✅' : '❌'}`);
  const emoji = v.passed ? '✅' : '❌';
  return `${emoji} Verify "${task}": ${parts.join(' ')}`;
}
