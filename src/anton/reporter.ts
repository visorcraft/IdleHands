/**
 * Anton autonomous task runner — display/format helpers.
 *
 * The controller NEVER builds display strings itself. All formatting happens here.
 */

import type { 
  AntonRunResult, 
  AntonProgress, 
  AntonTask, 
  AntonAttempt, 
  AntonTaskFile, 
  DetectedCommands 
} from './types.js';

/**
 * Format duration as human-readable string.
 * e.g. "2m 30s", "45s", "1h 5m"
 */
function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  if (min < 60) {
    return remainSec > 0 ? `${min}m ${remainSec}s` : `${min}m`;
  }
  
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  if (remainMin > 0) {
    return `${hr}h ${remainMin}m`;
  }
  return `${hr}h`;
}

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
 * Format task end message.
 */
export function formatTaskEnd(task: AntonTask, result: AntonAttempt, progress: AntonProgress): string {
  const emoji = result.status === 'passed' ? '✅' : '❌';
  const duration = formatDuration(result.durationMs);
  const tokens = formatTokens(result.tokensUsed);
  return `${emoji} ${task.text} — ${result.status} (${duration}, ${tokens} tokens)`;
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