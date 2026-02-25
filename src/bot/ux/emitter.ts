/**
 * Shared UX event emitter for IdleHands bots.
 *
 * This module provides a unified event emitter that both Telegram and Discord
 * bots use to emit identical semantic events for the same workflow stages.
 * This ensures consistent event semantics across all platforms.
 */

import type { UXEvent, UXEventACK, UXEventPROGRESS, UXEventWARNING, UXEventERROR, UXEventRESULT, UXEventACTIONS, UXSessionId, UXUserId } from './events.js';
import { createACKEvent, createPROGRESSEvent, createWARNINGEvent, createERROREvent, createRESULTEvent, createACTIONSEvent } from './events.js';

/**
 * Event listener callback type.
 */
export type UXEventListener = (event: UXEvent) => void | Promise<void>;

/**
 * Event emitter state.
 */
export type UXEventEmitterState = {
  /** Session ID for this emitter */
  sessionId: UXSessionId;
  /** User ID for this emitter */
  userId: UXUserId;
  /** Current sequence number */
  sequence: number;
  /** Event buffer for recent events */
  buffer: UXEvent[];
  /** Maximum buffer size */
  maxBuffer?: number;
  /** Event listeners */
  listeners: UXEventListener[];
};

/**
 * Create a new event emitter state.
 */
export function createUXEventEmitterState(sessionId: UXSessionId, userId: UXUserId, opts?: { maxBuffer?: number }): UXEventEmitterState {
  return {
    sessionId,
    userId,
    sequence: 0,
    buffer: [],
    maxBuffer: opts?.maxBuffer,
    listeners: [],
  };
}

/**
 * Emit an event to all listeners.
 */
export function emit(state: UXEventEmitterState, event: UXEvent): void {
  // Update sequence number
  state.sequence = event.sequence ?? state.sequence + 1;
  event.sequence = state.sequence;
  event.sessionId = state.sessionId;
  event.userId = state.userId;

  // Add to buffer
  state.buffer.push(event);
  if (state.maxBuffer && state.buffer.length > state.maxBuffer) {
    state.buffer.shift();
  }

  // Notify listeners
  for (const listener of state.listeners) {
    void listener(event);
  }
}

/**
 * Add an event listener.
 */
export function on(state: UXEventEmitterState, listener: UXEventListener): () => void {
  state.listeners.push(listener);
  return () => {
    state.listeners = state.listeners.filter((l) => l !== listener);
  };
}

/**
 * Emit an ACK event.
 */
export function emitACK(state: UXEventEmitterState, message: string, opts?: { estimatedDurationSec?: number; model?: string; timestamp?: number }): void {
  const event = createACKEvent(state.sessionId, state.userId, state.sequence + 1, message, opts);
  emit(state, event);
}

/**
 * Emit a PROGRESS event.
 */
export function emitPROGRESS(state: UXEventEmitterState, message: string, progress: number, opts?: { phase?: string; toolName?: string; toolId?: string; timestamp?: number }): void {
  const event = createPROGRESSEvent(state.sessionId, state.userId, state.sequence + 1, message, { ...opts, progress });
  emit(state, event);
}
/**
 * Emit a WARNING event.
 */
export function emitWARNING(state: UXEventEmitterState, message: string, opts?: { timestamp?: number }): void {
  const event = createWARNINGEvent(state.sessionId, state.userId, state.sequence + 1, message, opts);
  emit(state, event);
}

/**
 * Emit an ERROR event.
 */
export function emitERROR(state: UXEventEmitterState, message: string, opts?: { code?: string; retryable?: boolean; timestamp?: number }): void {
  const event = createERROREvent(state.sessionId, state.userId, state.sequence + 1, message, opts);
  emit(state, event);
}

/**
 * Emit a RESULT event.
 */
export function emitRESULT(state: UXEventEmitterState, summary: string, opts?: { data?: Record<string, unknown>; success?: boolean; stats?: { durationMs?: number; tokensUsed?: number; toolsCalled?: number }; timestamp?: number }): void {
  const event = createRESULTEvent(state.sessionId, state.userId, state.sequence + 1, summary, opts);
  emit(state, event);
}

/**
 * Emit an ACTIONS event.
 */
export function emitACTIONS(state: UXEventEmitterState, actions: any[], opts?: { message?: string; timestamp?: number }): void {
  const event = createACTIONSEvent(state.sessionId, state.userId, state.sequence + 1, actions, opts);
  emit(state, event);
}

/**
 * Get the last N events from the buffer.
 */
export function getRecentEvents(state: UXEventEmitterState, count: number = 10): UXEvent[] {
  return state.buffer.slice(-count);
}

/**
 * Clear the event buffer.
 */
export function clearBuffer(state: UXEventEmitterState): void {
  state.buffer = [];
}
