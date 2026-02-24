/**
 * Per-session UX state management for IdleHands bots.
 *
 * This module defines the canonical state structure for tracking user experience
 * across sessions, including last event timestamps, active actions, and stale
 * detection logic. Both Telegram and Discord handlers can use this shared
 * state management to avoid duplicating session tracking logic.
 */

import type { UXAction } from './actions.js';
import type { UXEvent, UXEventTimestamp } from './events.js';

// ---------------------------------------------------------------------------
// Session State Types
// ---------------------------------------------------------------------------

/**
 * Unique identifier for a UX session.
 */
export type UXSessionId = string;

/**
 * Timestamp threshold for stale session detection (milliseconds).
 * Sessions inactive for longer than this are considered stale.
 */
export const UX_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Timestamp threshold for stale event detection (milliseconds).
 * Events older than this may trigger stale detection warnings.
 */
export const UX_EVENT_STALE_THRESHOLD_MS = 30 * 1000; // 30 seconds

// ---------------------------------------------------------------------------
// Per-Session UX State
// ---------------------------------------------------------------------------

/**
 * Per-session UX state tracking event history and active actions.
 */
export type UXSessionState = {
  /** Session identifier */
  sessionId: UXSessionId;
  /** User identifier (platform-specific) */
  userId: string;
  /** Timestamp of the last event sent to the user */
  lastEventTimestamp: UXEventTimestamp;
  /** Timestamp of the last user activity (message received) */
  lastUserActivity: UXEventTimestamp;
  /** Sequence number for event ordering within session */
  sequence: number;
  /** Active actions available to the user */
  activeActions: UXAction[];
  /** Events sent during this session (for history/reference) */
  eventHistory: UXEvent[];
  /** Timestamp when the session was created */
  createdAt: UXEventTimestamp;
  /** Timestamp of the last stale check */
  lastStaleCheck: UXEventTimestamp;
  /** Whether the session is currently stale */
  isStale: boolean;
  /** Optional metadata about the session */
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Session State Factory
// ---------------------------------------------------------------------------

/**
 * Create a new UX session state.
 */
export function createUXSessionState(
  sessionId: UXSessionId,
  userId: string,
  metadata?: Record<string, unknown>
): UXSessionState {
  const now = Date.now();
  return {
    sessionId,
    userId,
    lastEventTimestamp: now,
    lastUserActivity: now,
    sequence: 0,
    activeActions: [],
    eventHistory: [],
    createdAt: now,
    lastStaleCheck: now,
    isStale: false,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// State Update Functions
// ---------------------------------------------------------------------------

/**
 * Update session state with a new event.
 */
export function updateWithEvent(state: UXSessionState, event: UXEvent): UXSessionState {
  const now = Date.now();
  return {
    ...state,
    lastEventTimestamp: now,
    sequence: state.sequence + 1,
    eventHistory: [...state.eventHistory, event],
    lastStaleCheck: now,
    isStale: false,
  };
}

/**
 * Update session state with active actions.
 */
export function updateActiveActions(state: UXSessionState, actions: UXAction[]): UXSessionState {
  return {
    ...state,
    activeActions: actions,
    lastEventTimestamp: Date.now(),
  };
}

/**
 * Clear active actions from session state.
 */
export function clearActiveActions(state: UXSessionState): UXSessionState {
  return {
    ...state,
    activeActions: [],
    lastEventTimestamp: Date.now(),
  };
}

/**
 * Mark user activity (e.g., when user sends a message).
 */
export function markUserActivity(state: UXSessionState): UXSessionState {
  return {
    ...state,
    lastUserActivity: Date.now(),
    lastStaleCheck: Date.now(),
    isStale: false,
  };
}

// ---------------------------------------------------------------------------
// Stale Detection
// ---------------------------------------------------------------------------

/**
 * Check if a session is stale based on inactivity.
 */
export function isSessionStale(
  state: UXSessionState,
  thresholdMs: number = UX_STALE_THRESHOLD_MS
): boolean {
  const now = Date.now();
  const inactiveMs = now - state.lastUserActivity;
  return inactiveMs > thresholdMs;
}

/**
 * Check if an event is stale (too old to be relevant).
 */
export function isEventStale(
  event: UXEvent,
  thresholdMs: number = UX_EVENT_STALE_THRESHOLD_MS
): boolean {
  const now = Date.now();
  const eventAge = now - event.timestamp;
  return eventAge > thresholdMs;
}

/**
 * Perform stale check and update session state if stale.
 * Returns the updated state and whether the session was stale.
 */
export function checkSessionStaleness(
  state: UXSessionState,
  thresholdMs: number = UX_STALE_THRESHOLD_MS
): { state: UXSessionState; wasStale: boolean } {
  const now = Date.now();
  const wasStale = isSessionStale(state, thresholdMs);

  return {
    state: {
      ...state,
      lastStaleCheck: now,
      isStale: wasStale,
    },
    wasStale,
  };
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Get the age of the session in milliseconds.
 */
export function getSessionAge(state: UXSessionState): number {
  return Date.now() - state.createdAt;
}

/**
 * Get the number of events sent in this session.
 */
export function getEventCount(state: UXSessionState): number {
  return state.eventHistory.length;
}

/**
 * Get the last event sent in this session.
 */
export function getLastEvent(state: UXSessionState): UXEvent | undefined {
  return state.eventHistory[state.eventHistory.length - 1];
}

/**
 * Check if the session has any active actions.
 */
export function hasActiveActions(state: UXSessionState): boolean {
  return state.activeActions.length > 0;
}

/**
 * Find an active action by type.
 */
export function findActiveAction(
  state: UXSessionState,
  actionType: UXAction['type']
): UXAction | undefined {
  return state.activeActions.find((action) => action.type === actionType);
}
