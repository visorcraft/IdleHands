/**
 * Platform-agnostic UX event model for IdleHands bots.
 *
 * This module defines a canonical event schema that both Telegram and Discord
 * handlers can consume to render consistent user experiences without duplicating
 * message composition logic.
 */

// ---------------------------------------------------------------------------
// Event Types
// ---------------------------------------------------------------------------

/**
 * Event category that determines how the message should be rendered and handled.
 */
export type UXEventCategory =
  | 'ACK' // Initial acknowledgment (≤1.5s SLA)
  | 'PROGRESS' // Ongoing progress update (≤5s first, ≤10s max gap)
  | 'WARNING' // Non-blocking issue requiring attention
  | 'ERROR' // Blocking error requiring user action
  | 'RESULT' // Final result of an operation
  | 'ACTIONS'; // Action buttons/commands available to user

/**
 * Unique identifier for an event within a session.
 */
export type UXEventId = string;

/**
 * Timestamp when the event occurred (milliseconds since epoch).
 */
export type UXEventTimestamp = number;

/**
 * Session identifier for correlating events.
 */
export type UXSessionId = string;

/**
 * User identifier (platform-specific).
 */
export type UXUserId = string;

// ---------------------------------------------------------------------------
// Base Event
// ---------------------------------------------------------------------------

/**
 * Base interface for all UX events.
 */
export type UXEventBase = {
  id: UXEventId;
  category: UXEventCategory;
  timestamp: UXEventTimestamp;
  sessionId: UXSessionId;
  userId: UXUserId;
  sequence: number; // Monotonically increasing per session
};

// ---------------------------------------------------------------------------
// ACK Event
// ---------------------------------------------------------------------------

/**
 * Initial acknowledgment message sent when a command is received.
 * Must be delivered within 1.5s SLA.
 */
export type UXEventACK = UXEventBase & {
  category: 'ACK';
  message: string;
  /** Optional estimated duration for long operations */
  estimatedDurationSec?: number;
  /** Optional model being used */
  model?: string;
};

// ---------------------------------------------------------------------------
// PROGRESS Event
// ---------------------------------------------------------------------------

/**
 * Progress update during an operation.
 * First progress should arrive within 5s, subsequent updates every ≤10s.
 */
export type UXEventPROGRESS = UXEventBase & {
  category: 'PROGRESS';
  message: string;
  /** Optional progress indicator (0.0 - 1.0) */
  progress?: number;
  /** Optional current phase */
  phase?: string;
  /** Optional tool being executed */
  toolName?: string;
  /** Optional tool call ID */
  toolId?: string;
};

// ---------------------------------------------------------------------------
// WARNING Event
// ---------------------------------------------------------------------------

/**
 * Non-blocking warning that requires user attention but doesn't stop execution.
 */
export type UXEventWARNING = UXEventBase & {
  category: 'WARNING';
  message: string;
  /** Optional warning code for programmatic handling */
  code?: string;
  /** Optional remediation guidance */
  guidance?: string;
};

// ---------------------------------------------------------------------------
// ERROR Event
// ---------------------------------------------------------------------------

/**
 * Blocking error that requires user intervention.
 */
export type UXEventERROR = UXEventBase & {
  category: 'ERROR';
  message: string;
  /** Optional error code for programmatic handling */
  code?: string;
  /** Optional detailed error info */
  details?: string;
  /** Whether the error is retryable */
  retryable?: boolean;
  /** Optional remediation guidance */
  guidance?: string;
};

// ---------------------------------------------------------------------------
// RESULT Event
// ---------------------------------------------------------------------------

/**
 * Final result of an operation.
 */
export type UXEventRESULT = UXEventBase & {
  category: 'RESULT';
  /** Result summary */
  summary: string;
  /** Optional structured result data */
  data?: Record<string, unknown>;
  /** Optional success flag (defaults to true if not specified) */
  success?: boolean;
  /** Optional metrics/stats */
  stats?: {
    durationMs?: number;
    tokensUsed?: number;
    toolsCalled?: number;
  };
};

// ---------------------------------------------------------------------------
// ACTIONS Event
// ---------------------------------------------------------------------------

/**
 * Available actions the user can take.
 * Typically sent with RESULT or ERROR events.
 */
export type UXActionType =
  | 'retry_fast' // Retry with fast model
  | 'retry_heavy' // Retry with heavy model
  | 'cancel' // Cancel current operation
  | 'show_diff' // Show diff for file changes
  | 'apply' // Apply suggested changes
  | 'anton_stop' // Stop anton autonomous agent
  | 'escalate' // Escalate to higher model
  | 'deescalate' // Deescalate to lower model
  | 'watchdog_compact' // Trigger watchdog compaction
  | 'custom'; // Custom action (requires label)

/**
 * A single actionable button/command.
 */
export type UXAction = {
  type: UXActionType;
  /** Label to display on the button */
  label: string;
  /** Payload to send when action is triggered */
  payload: Record<string, unknown>;
  /** Optional hint for the action */
  hint?: string;
};

/**
 * Event carrying available actions.
 */
export type UXEventACTIONS = UXEventBase & {
  category: 'ACTIONS';
  actions: UXAction[];
  /** Optional message to accompany actions */
  message?: string;
};

// ---------------------------------------------------------------------------
// Union Type
// ---------------------------------------------------------------------------

/**
 * All possible UX event types.
 */
export type UXEvent =
  | UXEventACK
  | UXEventPROGRESS
  | UXEventWARNING
  | UXEventERROR
  | UXEventRESULT
  | UXEventACTIONS;

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Create an ACK event.
 */
export function createACKEvent(
  sessionId: UXSessionId,
  userId: UXUserId,
  sequence: number,
  message: string,
  opts?: {
    estimatedDurationSec?: number;
    model?: string;
    timestamp?: number;
  }
): UXEventACK {
  return {
    id: `ack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category: 'ACK',
    timestamp: opts?.timestamp ?? Date.now(),
    sessionId,
    userId,
    sequence,
    message,
    estimatedDurationSec: opts?.estimatedDurationSec,
    model: opts?.model,
  };
}

/**
 * Create a PROGRESS event.
 */
export function createPROGRESSEvent(
  sessionId: UXSessionId,
  userId: UXUserId,
  sequence: number,
  message: string,
  opts?: {
    progress?: number;
    phase?: string;
    toolName?: string;
    toolId?: string;
    timestamp?: number;
  }
): UXEventPROGRESS {
  return {
    id: `progress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category: 'PROGRESS',
    timestamp: opts?.timestamp ?? Date.now(),
    sessionId,
    userId,
    sequence,
    message,
    progress: opts?.progress,
    phase: opts?.phase,
    toolName: opts?.toolName,
    toolId: opts?.toolId,
  };
}

/**
 * Create a WARNING event.
 */
export function createWARNINGEvent(
  sessionId: UXSessionId,
  userId: UXUserId,
  sequence: number,
  message: string,
  opts?: {
    code?: string;
    guidance?: string;
    timestamp?: number;
  }
): UXEventWARNING {
  return {
    id: `warning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category: 'WARNING',
    timestamp: opts?.timestamp ?? Date.now(),
    sessionId,
    userId,
    sequence,
    message,
    code: opts?.code,
    guidance: opts?.guidance,
  };
}

/**
 * Create an ERROR event.
 */
export function createERROREvent(
  sessionId: UXSessionId,
  userId: UXUserId,
  sequence: number,
  message: string,
  opts?: {
    code?: string;
    details?: string;
    retryable?: boolean;
    guidance?: string;
    timestamp?: number;
  }
): UXEventERROR {
  return {
    id: `error-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category: 'ERROR',
    timestamp: opts?.timestamp ?? Date.now(),
    sessionId,
    userId,
    sequence,
    message,
    code: opts?.code,
    details: opts?.details,
    retryable: opts?.retryable,
    guidance: opts?.guidance,
  };
}

/**
 * Create a RESULT event.
 */
export function createRESULTEvent(
  sessionId: UXSessionId,
  userId: UXUserId,
  sequence: number,
  summary: string,
  opts?: {
    data?: Record<string, unknown>;
    success?: boolean;
    stats?: {
      durationMs?: number;
      tokensUsed?: number;
      toolsCalled?: number;
    };
    timestamp?: number;
  }
): UXEventRESULT {
  return {
    id: `result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category: 'RESULT',
    timestamp: opts?.timestamp ?? Date.now(),
    sessionId,
    userId,
    sequence,
    summary,
    data: opts?.data,
    success: opts?.success,
    stats: opts?.stats,
  };
}

/**
 * Create an ACTIONS event.
 */
export function createACTIONSEvent(
  sessionId: UXSessionId,
  userId: UXUserId,
  sequence: number,
  actions: UXAction[],
  opts?: {
    message?: string;
    timestamp?: number;
  }
): UXEventACTIONS {
  return {
    id: `actions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category: 'ACTIONS',
    timestamp: opts?.timestamp ?? Date.now(),
    sessionId,
    userId,
    sequence,
    actions,
    message: opts?.message,
  };
}

/**
 * Check if an event is retryable.
 */
export function isRetryable(event: UXEvent): boolean {
  return (
    (event.category === 'ERROR' && event.retryable === true) ||
    (event.category === 'RESULT' && event.stats?.tokensUsed !== undefined)
  );
}

/**
 * Get the effective timestamp of an event (handles optional timestamp).
 */
export function getTimestamp(event: UXEvent): number {
  return event.timestamp;
}

/**
 * Check if two events belong to the same session.
 */
export function sameSession(a: UXEvent, b: UXEvent): boolean {
  return a.sessionId === b.sessionId;
}

/**
 * Check if event is a terminal event (no more updates expected).
 */
export function isTerminal(event: UXEvent): boolean {
  return event.category === 'RESULT' || event.category === 'ERROR';
}

/**
 * Get the next sequence number for a session.
 */
export function nextSequence(current: number): number {
  return current + 1;
}
