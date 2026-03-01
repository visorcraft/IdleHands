/**
 * Anton configuration — autonomous task execution orchestrator.
 */

export type AntonPreflightConfig = {
  /** Enable two-phase preflight mode (discovery → review → implementation). */
  enabled?: boolean;
  /** Run requirements review phase after discovery. */
  requirementsReview?: boolean;
  /** Timeout for discovery phase (seconds). Default: 600. */
  discoveryTimeoutSec?: number;
  /** Timeout for review phase (seconds). Default: 600. */
  reviewTimeoutSec?: number;
  /** Max retries for preflight phases. Default: 2. */
  maxRetries?: number;
  /** Max iterations per preflight session. Default: 500. */
  sessionMaxIterations?: number;
  /** Timeout per preflight session (seconds). Default: same as taskTimeoutSec. */
  sessionTimeoutSec?: number;
};

export type AntonConfig = {
  /** Preflight (two-phase) configuration. */
  preflight?: AntonPreflightConfig;
  /** Mode: "direct" (immediate implementation) or "preflight" (discovery → implementation). */
  mode?: "direct" | "preflight";
  /** Per-task timeout (seconds). Default: 1200. */
  taskTimeoutSec?: number;
  /** Total orchestrator timeout (seconds). Default: 7200. */
  totalTimeoutSec?: number;
  /** Max retries for failed tasks. Default: 3. */
  maxRetries?: number;
  /** Max iterations per implementation task. Default: 50. */
  taskMaxIterations?: number;
  /** Auto-commit changes after successful task completion. Default: true. */
  autoCommit?: boolean;
  /** Run AI verification after implementation. Default: true. */
  verifyAi?: boolean;
  /** Decompose complex tasks into subtasks. Default: true. */
  decompose?: boolean;
  /** Skip on failure (continue to next task). Default: false. */
  skipOnFail?: boolean;
  /** Skip on blocked status. Default: true. */
  skipOnBlocked?: boolean;
  /** Rollback on failure. Default: false. */
  rollbackOnFail?: boolean;
  /** Scope guard level ("lax", "strict"). Default: "lax". */
  scopeGuard?: "lax" | "strict";
  /** Max identical failures before stopping. Default: 3. */
  maxIdenticalFailures?: number;
  /** Approval mode ("auto", "yolo"). Default: "auto". */
  approvalMode?: "auto" | "yolo";
  /** Progress heartbeat interval (seconds). Default: 30. */
  progressHeartbeatSec?: number;
  /** Enable progress events to chat. Default: true. */
  progressEvents?: boolean;
  /** Directory for task plan files. Default: .agents/tasks */
  planDir?: string;
};
