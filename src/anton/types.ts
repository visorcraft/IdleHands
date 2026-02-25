/**
 * Anton autonomous task runner — type definitions.
 *
 * Zero runtime logic. Types/interfaces/enums only.
 */

import type { ApprovalMode } from '../types.js';

// ─── Task parsing ────────────────────────────────────────────────

/** Single task parsed from a markdown checkbox line. */
export interface AntonTask {
  /** Stable key hash derived from task identity fields. NOT a line number. */
  key: string;
  /** Task description text (after `- [ ] ` / `- [x] `). */
  text: string;
  /** Heading hierarchy leading to this task (e.g. ["Phase A", "Parser"]). */
  phasePath: string[];
  /** Nesting depth. 0 = top-level, 1 = sub-task, etc. */
  depth: number;
  /** Current 1-indexed line number (may shift between parses). */
  line: number;
  /** true if `[x]` or `[X]`, false if `[ ]`. */
  checked: boolean;
  /** Key of parent task, or undefined if top-level. */
  parentKey: string | undefined;
  /** Ordered child tasks. */
  children: AntonTask[];
}

/** Full parsed result from a task file. */
export interface AntonTaskFile {
  /** Absolute path to the source file. */
  filePath: string;
  /** All tasks in document order (flat). */
  allTasks: AntonTask[];
  /** Top-level tasks (depth 0) with nested children. */
  roots: AntonTask[];
  /** Unchecked tasks in execution order (depth-first). */
  pending: AntonTask[];
  /** Checked tasks. */
  completed: AntonTask[];
  /** Total count (checked + unchecked). */
  totalCount: number;
  /** sha256 hex of raw file content (for change detection). */
  contentHash: string;
}

// ─── Run configuration ──────────────────────────────────────────

/** Resolved configuration for an Anton run. All fields required (defaults applied). */
export interface AntonRunConfig {
  /** Absolute path to task file. */
  taskFile: string;
  /** Preflight task analysis/review stage before implementation. */
  preflightEnabled?: boolean;
  /** Run peer requirements review stage after discovery (when preflight is enabled). */
  preflightRequirementsReview?: boolean;
  /** Force separate review stage (by default, review is merged into discovery prompt). */
  preflightSeparateReview?: boolean;
  /** Discovery-stage timeout in seconds. Falls back to taskTimeoutSec. */
  preflightDiscoveryTimeoutSec?: number;
  /** Requirements-review-stage timeout in seconds. Falls back to taskTimeoutSec. */
  preflightReviewTimeoutSec?: number;
  /** Max retries for preflight pipeline before falling back to task retry policy. */
  preflightMaxRetries?: number;
  /** Max inner turns per preflight session (discovery/review). */
  preflightSessionMaxIterations?: number;
  /** Hard timeout cap (seconds) applied to each preflight session. */
  preflightSessionTimeoutSec?: number;
  /** Absolute path to project working directory. */
  projectDir: string;
  /** Max retries per individual task. */
  maxRetriesPerTask: number;
  /** Max total iterations across all tasks. */
  maxIterations: number;
  /** Max iterations per individual task attempt. */
  taskMaxIterations: number;
  /** Timeout per task attempt in seconds. */
  taskTimeoutSec: number;
  /** Total time budget in seconds. */
  totalTimeoutSec: number;
  /** Total token budget. Infinity = unlimited. */
  maxTotalTokens: number;
  /** Hard ceiling on estimated prompt tokens per attempt. */
  maxPromptTokensPerAttempt: number;
  /** Git commit after each successful task. */
  autoCommit: boolean;
  /** Create branch before starting. */
  branch: boolean;
  /** Allow dirty working tree. */
  allowDirty: boolean;
  /** Use git clean -fd on failed attempt rollback. */
  aggressiveCleanOnFail: boolean;
  /** Enable L2 AI verification. */
  verifyAi: boolean;
  /** Model override for L2 AI verifier. undefined = use session model. */
  verifyModel: string | undefined;
  /** Allow agent to decompose large tasks. */
  decompose: boolean;
  /** Max decomposition nesting depth. */
  maxDecomposeDepth: number;
  /** Max total tasks (prevents decomposition explosion). */
  maxTotalTasks: number;
  /** Custom build command override. undefined = auto-detect. */
  buildCommand: string | undefined;
  /** Custom test command override. undefined = auto-detect. */
  testCommand: string | undefined;
  /** Custom lint command override. undefined = auto-detect. */
  lintCommand: string | undefined;
  /** Max consecutive identical failures before giving up on a task (dedup guard). Default 3. */
  maxIdenticalFailures: number;
  /** Skip failed tasks and continue, or abort entirely. */
  skipOnFail: boolean;
  /** Skip blocked tasks and continue. */
  skipOnBlocked: boolean;
  /** Roll back changes on task failure. */
  rollbackOnFail: boolean;
  /** Approval mode for agent sessions. */
  approvalMode: ApprovalMode;
  /** Stream agent tokens to stderr. */
  verbose: boolean;
  /** Parse and print plan only, don't execute. */
  dryRun: boolean;
}

// ─── Verification ───────────────────────────────────────────────

/** Commands detected or overridden for verification. */
export interface DetectedCommands {
  build: string | undefined;
  test: string | undefined;
  lint: string | undefined;
}

/** Result of verification cascade for one attempt. */
export interface AntonVerificationResult {
  /** L0: Agent reported status=done in structured result. */
  l0_agentDone: boolean;
  /** L1: Build command succeeded. undefined if not configured. */
  l1_build: boolean | undefined;
  /** L1: Test command succeeded. undefined if not configured. */
  l1_test: boolean | undefined;
  /** L1: Lint command succeeded. undefined if not configured. */
  l1_lint: boolean | undefined;
  /** L2: AI verifier approved. undefined if disabled/skipped. */
  l2_ai: boolean | undefined;
  /** L2: AI verifier reasoning. */
  l2_reason: string | undefined;
  /** Overall pass/fail. */
  passed: boolean;
  /** Human-readable summary. */
  summary: string;
  /** Full command output (stdout+stderr) from failed L1 commands. */
  commandOutput: string | undefined;
}

// ─── Attempt tracking ───────────────────────────────────────────

export type AntonAttemptStatus =
  | 'passed'
  | 'failed'
  | 'decomposed'
  | 'blocked'
  | 'skipped'
  | 'timeout'
  | 'error';

/** Result of a single task attempt. */
export interface AntonAttempt {
  /** Task key. */
  taskKey: string;
  /** Task text (for display). */
  taskText: string;
  /** Attempt number (1-indexed). */
  attempt: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Tokens consumed (prompt + completion). */
  tokensUsed: number;
  /** Outcome status. */
  status: AntonAttemptStatus;
  /** Verification result (undefined if attempt errored before verification). */
  verification: AntonVerificationResult | undefined;
  /** Error message if status is 'error' or 'timeout'. */
  error: string | undefined;
  /** Git commit hash if commit was made. */
  commitHash: string | undefined;
}

// ─── Run result ─────────────────────────────────────────────────

export type AntonStopReason =
  | 'all_done'
  | 'max_iterations'
  | 'total_timeout'
  | 'token_budget'
  | 'abort'
  | 'fatal_error'
  | 'max_tasks_exceeded';

/** Final result of an entire Anton run. */
export interface AntonRunResult {
  /** Total tasks in file at start. */
  totalTasks: number;
  /** Tasks already checked at start (skipped). */
  preCompleted: number;
  /** Tasks completed during this run. */
  completed: number;
  /** Tasks auto-confirmed as already complete during preflight. */
  autoCompleted?: number;
  /** Tasks skipped after max retries. */
  skipped: number;
  /** Tasks that caused abort (only when skipOnFail=false). */
  failed: number;
  /** Tasks not attempted (remaining when run stopped early). */
  remaining: number;
  /** Per-attempt history. */
  attempts: AntonAttempt[];
  /** Preflight stage records per task/stage. */
  preflightRecords?: AntonPreflightRecord[];
  /** Total time in milliseconds. */
  totalDurationMs: number;
  /** Total tokens consumed. */
  totalTokens: number;
  /** Total git commits made. */
  totalCommits: number;
  /** Whether all tasks completed. */
  completedAll: boolean;
  /** Why the run stopped. */
  stopReason: AntonStopReason;
}

// ─── Progress callbacks ─────────────────────────────────────────

/** Progress snapshot. */
export interface AntonProgress {
  /** Current task index in pending queue. */
  currentIndex: number;
  /** Total pending at run start. */
  totalPending: number;
  /** Completed so far. */
  completedSoFar: number;
  /** Skipped so far. */
  skippedSoFar: number;
  /** Iterations consumed. */
  iterationsUsed: number;
  /** Elapsed milliseconds. */
  elapsedMs: number;
  /** Estimated remaining ms (undefined if not enough data). */
  estimatedRemainingMs: number | undefined;
  /** Currently active task being processed */
  currentTask?: string;
  /** Attempt number for the currently active task */
  currentAttempt?: number;
  /** Current turn within this attempt (1-indexed). */
  currentTurn?: number;
  /** Maximum turns allowed for this task. */
  maxTurns?: number;
}

/** Callback interface for progress reporting. */
export interface AntonProgressCallback {
  onTaskStart(task: AntonTask, attempt: number, progress: AntonProgress): void;
  onTaskEnd(task: AntonTask, result: AntonAttempt, progress: AntonProgress): void;
  onTaskSkip(task: AntonTask, reason: string, progress: AntonProgress): void;
  onRunComplete(result: AntonRunResult): void;
  onAgentToken?(token: string): void;
  onHeartbeat?(): void;
  /** Tool loop detected during task execution. */
  onToolLoop?(
    taskText: string,
    event: { level: string; toolName: string; count: number; message: string }
  ): void;
  /** Auto-compaction occurred during task execution. */
  onCompaction?(
    taskText: string,
    event: { droppedMessages: number; freedTokens: number; summaryUsed: boolean }
  ): void;
  /** Verification completed for a task attempt. */
  onVerification?(taskText: string, verification: AntonVerificationResult): void;
  onStage?(message: string): void;
}

// ─── Structured agent result ────────────────────────────────────

export type AntonAgentStatus = 'done' | 'blocked' | 'decompose' | 'failed';

export type AntonDiscoveryStatus = 'complete' | 'incomplete';

export interface AntonDiscoveryResult {
  status: AntonDiscoveryStatus;
  filename: string;
}

export interface AntonRequirementsReviewResult {
  status: 'ready';
  filename: string;
}

export interface AntonPreflightRecord {
  taskKey: string;
  stage: 'discovery' | 'requirements-review';
  durationMs: number;
  tokensUsed: number;
  status: 'complete' | 'incomplete' | 'ready' | 'error' | 'timeout';
  filename?: string;
  error?: string;
}

/** Parsed structured result from agent output. */
export interface AntonAgentResult {
  status: AntonAgentStatus;
  reason: string | undefined;
  subtasks: string[];
}
