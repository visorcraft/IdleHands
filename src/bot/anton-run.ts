import {
  formatRunSummary,
  formatTaskStart,
  formatTaskEnd,
  formatTaskSkip,
  formatTaskHeartbeat,
  formatToolLoopEvent,
  formatCompactionEvent,
  formatVerificationDetail,
} from '../anton/reporter.js';
import type { AntonProgressCallback, AntonRunConfig } from '../anton/types.js';

export function buildAntonRunConfig(defaults: any, cwd: string, filePath: string): AntonRunConfig {
  return {
    taskFile: filePath,
    preflightEnabled: defaults.preflight?.enabled ?? false,
    preflightRequirementsReview: defaults.preflight?.requirements_review ?? true,
    preflightDiscoveryTimeoutSec:
      defaults.preflight?.discovery_timeout_sec ?? defaults.task_timeout_sec ?? 600,
    preflightReviewTimeoutSec:
      defaults.preflight?.review_timeout_sec ?? defaults.task_timeout_sec ?? 600,
    preflightMaxRetries: defaults.preflight?.max_retries ?? 2,
    preflightSessionMaxIterations: defaults.preflight?.session_max_iterations ?? 500,
    preflightSessionTimeoutSec:
      defaults.preflight?.session_timeout_sec ?? defaults.task_timeout_sec ?? 600,
    projectDir: defaults.project_dir || cwd,
    maxRetriesPerTask: defaults.max_retries ?? 3,
    maxIterations: defaults.max_iterations ?? 200,
    taskMaxIterations: defaults.task_max_iterations ?? 50,
    taskTimeoutSec: defaults.task_timeout_sec ?? 600,
    totalTimeoutSec: defaults.total_timeout_sec ?? 7200,
    maxTotalTokens: defaults.max_total_tokens ?? Infinity,
    maxPromptTokensPerAttempt: defaults.max_prompt_tokens_per_attempt ?? 999_999_999,
    autoCommit: defaults.auto_commit ?? true,
    branch: false,
    allowDirty: false,
    aggressiveCleanOnFail: false,
    verifyAi: defaults.verify_ai ?? true,
    verifyModel: undefined,
    decompose: defaults.decompose ?? true,
    maxDecomposeDepth: defaults.max_decompose_depth ?? 2,
    maxTotalTasks: defaults.max_total_tasks ?? 500,
    buildCommand: defaults.build_command ?? undefined,
    testCommand: defaults.test_command ?? undefined,
    lintCommand: defaults.lint_command ?? undefined,
    skipOnFail: defaults.skip_on_fail ?? false,
    skipOnBlocked: defaults.skip_on_blocked ?? true,
    rollbackOnFail: defaults.rollback_on_fail ?? false,
    maxIdenticalFailures: defaults.max_identical_failures ?? 3,
    approvalMode: (defaults.approval_mode ?? 'yolo') as AntonRunConfig['approvalMode'],
    verbose: false,
    dryRun: false,
  };
}

export function makeAntonProgress(
  managed: any,
  defaults: any,
  send: (text: string) => void,
  rateLimitMs: number
): AntonProgressCallback {
  const heartbeatSecRaw = Number(defaults.progress_heartbeat_sec ?? 30);
  const heartbeatIntervalMs = Number.isFinite(heartbeatSecRaw)
    ? Math.max(5000, Math.floor(heartbeatSecRaw * 1000))
    : 30_000;

  let lastProgressAt = 0;
  let lastHeartbeatNoticeAt = 0;
  let runStartMs = 0;
  let lastHeartbeatText = '';

  return {
    onTaskStart(task, attempt, prog) {
      const now = Date.now();
      if (!runStartMs) runStartMs = now;
      managed.antonProgress = prog;
      managed.lastActivity = now;
      lastProgressAt = now;
      send(formatTaskStart(task, attempt, prog));
    },
    onTaskEnd(task, result, prog) {
      const now = Date.now();
      managed.antonProgress = prog;
      managed.lastActivity = now;
      lastProgressAt = now;
      send(formatTaskEnd(task, result, prog));
    },
    onTaskSkip(task, reason) {
      managed.lastActivity = Date.now();
      send(formatTaskSkip(task, reason));
    },
    onRunComplete(result) {
      managed.lastActivity = Date.now();
      managed.antonLastResult = result;
      managed.antonActive = false;
      managed.antonAbortSignal = null;
      managed.antonProgress = null;
      runStartMs = 0;
      lastHeartbeatText = '';
      send(formatRunSummary(result));
    },
    onHeartbeat() {
      const now = Date.now();
      managed.lastActivity = now;

      if (defaults.progress_events === false) {
        // Debug: console.error('[anton-heartbeat] skipped: progress_events=false');
        return;
      }
      if (!managed.antonProgress?.currentTask) {
        // Debug: console.error('[anton-heartbeat] skipped: no currentTask');
        return;
      }
      if (now - lastProgressAt < rateLimitMs) {
        // Debug: console.error(`[anton-heartbeat] skipped: rate limit (${now - lastProgressAt}ms < ${rateLimitMs}ms)`);
        return;
      }
      if (now - lastHeartbeatNoticeAt < heartbeatIntervalMs) {
        // Debug: console.error(`[anton-heartbeat] skipped: heartbeat interval (${now - lastHeartbeatNoticeAt}ms < ${heartbeatIntervalMs}ms)`);
        return;
      }

      if (!runStartMs) runStartMs = now;
      managed.antonProgress = {
        ...managed.antonProgress,
        elapsedMs: now - runStartMs,
      };

      const hb = formatTaskHeartbeat(managed.antonProgress);
      if (hb === lastHeartbeatText) {
        // Debug: console.error('[anton-heartbeat] skipped: same text');
        return;
      }

      console.error(`[anton-heartbeat] sending update: ${hb.slice(0, 50)}...`);
      lastHeartbeatNoticeAt = now;
      lastHeartbeatText = hb;
      send(hb);
    },
    onToolLoop(taskText, event) {
      const now = Date.now();
      managed.lastActivity = now;

      const detail = String(event.message ?? '');
      const kind = /final loop failure|retries exhausted/i.test(detail)
        ? 'final-failure'
        : /auto-?recover|auto-?continu/i.test(detail)
          ? 'auto-recovered'
          : 'other';
      managed.antonLastLoopEvent = {
        kind,
        taskText,
        message: detail,
        at: now,
      };

      if (defaults.progress_events !== false) {
        send(formatToolLoopEvent(taskText, event));
      }
    },
    onCompaction(taskText, event) {
      managed.lastActivity = Date.now();
      if (defaults.progress_events !== false && event.droppedMessages >= 5) {
        send(formatCompactionEvent(taskText, event));
      }
    },
    onVerification(taskText, verification) {
      managed.lastActivity = Date.now();
      if (defaults.progress_events !== false) {
        send(formatVerificationDetail(taskText, verification));
      }
    },
    onStage(message) {
      managed.lastActivity = Date.now();
      if (defaults.progress_events !== false) {
        send(message);
      }
    },
  };
}
