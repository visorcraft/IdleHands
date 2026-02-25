/**
 * Bridge module: converts ProgressPresenter state to UX events.
 *
 * This module provides utilities to convert the internal progress state
 * (used by ProgressPresenter) into the shared UX event model, enabling
 * consistent message composition across all platforms.
 */

import type { UXEventPROGRESS, UXEventACK, UXEventRESULT, UXEventERROR } from './events.js';
import type { UXAction } from './actions.js';
import { createRetryFastAction, createRetryHeavyAction } from './actions.js';
/**
 * Convert a TurnProgressSnapshot to a PROGRESS event.
 */
export function snapshotToProgressEvent(
  message: string,
  progress: number,
  sessionId: string,
  userId: string,
  sequence: number
): UXEventPROGRESS {
  return {
    category: 'PROGRESS',
    id: `progress-${sequence}`,
    timestamp: Date.now(),
    sessionId,
    userId,
    sequence,
    message,
    progress,
  };
}

/**
 * Create an ACK event for session initialization.
 */
export function createAckEvent(
  sessionId: string,
  userId: string,
  sequence: number,
  message?: string
): UXEventACK {
  return {
    category: 'ACK',
    id: `ack-${sequence}`,
    timestamp: Date.now(),
    sessionId,
    userId,
    sequence,
    message: message || 'Session initialized',
  };
}
/**
 * Create a RESULT event for turn completion.
 */
export function createResultEvent(
  sessionId: string,
  userId: string,
  sequence: number,
  summary: string,
  success?: boolean
): UXEventRESULT {
  const actions: UXAction[] = [
    createRetryFastAction('Retry (fast)'),
    createRetryHeavyAction('Retry (heavy)'),
  ];

  return {
    category: 'RESULT',
    id: `result-${sequence}`,
    timestamp: Date.now(),
    sessionId,
    userId,
    sequence,
    summary,
    success,
    actions,
  };
}
/**
 * Create an ERROR event for turn failures.
 */
export function createErrorEvent(
  sessionId: string,
  userId: string,
  sequence: number,
  message: string,
  code?: string
): UXEventERROR {
  const actions: UXAction[] = [
    createRetryFastAction('Retry (fast)'),
    createRetryHeavyAction('Retry (heavy)'),
  ];

  return {
    category: 'ERROR',
    id: `error-${sequence}`,
    timestamp: Date.now(),
    sessionId,
    userId,
    sequence,
    message,
    code,
    actions,
  };
}