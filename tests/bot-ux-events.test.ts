import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createACKEvent,
  createPROGRESSEvent,
  createWARNINGEvent,
  createERROREvent,
  createRESULTEvent,
  createACTIONSEvent,
  isRetryable,
  getTimestamp,
  sameSession,
  isTerminal,
  nextSequence,
  type UXEventCategory,
} from '../dist/bot/ux/events.js';

// ============================================================================
// Event Category Tests
// ============================================================================

test('UXEventCategory types are properly defined', () => {
  const categories: UXEventCategory[] = [
    'ACK',
    'PROGRESS',
    'WARNING',
    'ERROR',
    'RESULT',
    'ACTIONS',
  ];
  assert.strictEqual(categories.length, 6);
  assert(categories.includes('ACK'));
  assert(categories.includes('PROGRESS'));
  assert(categories.includes('WARNING'));
  assert(categories.includes('ERROR'));
  assert(categories.includes('RESULT'));
  assert(categories.includes('ACTIONS'));
});

test('UXEvent union type narrowing works with category property', () => {
  const ackEvent = createACKEvent('session-1', 'user-1', 1, 'Test');
  const progressEvent = createPROGRESSEvent('session-1', 'user-1', 2, 'Test', { progress: 0.5 });
  const warningEvent = createWARNINGEvent('session-1', 'user-1', 3, 'Test');
  const errorEvent = createERROREvent('session-1', 'user-1', 4, 'Test');
  const resultEvent = createRESULTEvent('session-1', 'user-1', 5, 'Test');
  const actionsEvent = createACTIONSEvent('session-1', 'user-1', 6, [], { message: 'Test' });

  assert.strictEqual(ackEvent.category, 'ACK');
  assert.strictEqual(progressEvent.category, 'PROGRESS');
  assert.strictEqual(warningEvent.category, 'WARNING');
  assert.strictEqual(errorEvent.category, 'ERROR');
  assert.strictEqual(resultEvent.category, 'RESULT');
  assert.strictEqual(actionsEvent.category, 'ACTIONS');

  // Type narrowing
  if (ackEvent.category === 'ACK') {
    assert.ok('message' in ackEvent);
  }
});

// ============================================================================
// UXEventBase Tests
// ============================================================================

test('UXEventBase fields are present in all events', () => {
  const sessionId = 'test-session-123';
  const userId = 'test-user-456';
  const sequence = 42;

  const event = createACKEvent(sessionId, userId, sequence, 'Test');

  assert.ok(event.id);
  assert.strictEqual(event.category, 'ACK');
  assert.ok(event.timestamp);
  assert.strictEqual(event.sessionId, sessionId);
  assert.strictEqual(event.userId, userId);
  assert.strictEqual(event.sequence, sequence);
});

// ============================================================================
// createACKEvent Tests
// ============================================================================

test('createACKEvent creates event with required fields', () => {
  const event = createACKEvent('session-1', 'user-1', 1, 'Task started');

  assert.ok(event.id);
  assert.strictEqual(event.category, 'ACK');
  assert.strictEqual(event.message, 'Task started');
  assert.ok(event.timestamp);
  assert.ok(event.sequence);
});

test('createACKEvent supports optional fields', () => {
  const sessionId = 'session-123';
  const userId = 'user-456';
  const sequence = 10;
  const estimatedDurationSec = 30;
  const model = 'gpt-4';
  const timestamp = 1700000000000;

  const event = createACKEvent(sessionId, userId, sequence, 'Task started', {
    estimatedDurationSec,
    model,
    timestamp,
  });

  assert.strictEqual(event.sessionId, sessionId);
  assert.strictEqual(event.userId, userId);
  assert.strictEqual(event.sequence, sequence);
  assert.strictEqual(event.estimatedDurationSec, estimatedDurationSec);
  assert.strictEqual(event.model, model);
  assert.strictEqual(event.timestamp, timestamp);
});

test('createACKEvent generates unique IDs', () => {
  const event1 = createACKEvent('session-1', 'user-1', 1, 'Test');
  const event2 = createACKEvent('session-1', 'user-1', 2, 'Test');

  assert.ok(event1.id);
  assert.ok(event2.id);
  assert.notStrictEqual(event1.id, event2.id);
});

// ============================================================================
// createPROGRESSEvent Tests
// ============================================================================

test('createPROGRESSEvent creates event with progress', () => {
  const event = createPROGRESSEvent('session-1', 'user-1', 1, 'Processing...', { progress: 0.5 });

  assert.strictEqual(event.category, 'PROGRESS');
  assert.strictEqual(event.message, 'Processing...');
  assert.strictEqual(event.progress, 0.5);
});

test('createPROGRESSEvent supports optional phase', () => {
  const event = createPROGRESSEvent('session-1', 'user-1', 1, 'Processing...', {
    progress: 0.5,
    phase: 'compilation',
  });

  assert.strictEqual(event.phase, 'compilation');
});

test('createPROGRESSEvent supports optional toolName and toolId', () => {
  const event = createPROGRESSEvent('session-1', 'user-1', 1, 'Running tool...', {
    progress: 0.25,
    toolName: 'exec',
    toolId: 'exec-123',
  });

  assert.strictEqual(event.toolName, 'exec');
  assert.strictEqual(event.toolId, 'exec-123');
});

test('createPROGRESSEvent handles progress 0.0 and 1.0', () => {
  const startEvent = createPROGRESSEvent('session-1', 'user-1', 1, 'Starting...', {
    progress: 0.0,
  });
  const endEvent = createPROGRESSEvent('session-1', 'user-1', 2, 'Done!', { progress: 1.0 });

  assert.strictEqual(startEvent.progress, 0.0);
  assert.strictEqual(endEvent.progress, 1.0);
});

// ============================================================================
// createWARNINGEvent Tests
// ============================================================================

test('createWARNINGEvent creates event with required fields', () => {
  const event = createWARNINGEvent('session-1', 'user-1', 1, 'Low disk space');

  assert.strictEqual(event.category, 'WARNING');
  assert.strictEqual(event.message, 'Low disk space');
});

test('createWARNINGEvent supports optional code and hint', () => {
  const event = createWARNINGEvent('session-1', 'user-1', 1, 'Low disk space', {
    code: 'DISK_SPACE',
    hint: 'Free up some space',
  });

  assert.strictEqual(event.code, 'DISK_SPACE');
  assert.strictEqual(event.hint, 'Free up some space');
});

// ============================================================================
// createERROREvent Tests
// ============================================================================

test('createERROREvent creates event with required fields', () => {
  const event = createERROREvent('session-1', 'user-1', 1, 'Connection failed');

  assert.strictEqual(event.category, 'ERROR');
  assert.strictEqual(event.message, 'Connection failed');
});

test('createERROREvent supports optional code and details', () => {
  const event = createERROREvent('session-1', 'user-1', 1, 'Connection failed', {
    code: 'NET_ERR',
    details: 'Timeout after 30s',
  });

  assert.strictEqual(event.code, 'NET_ERR');
  assert.strictEqual(event.details, 'Timeout after 30s');
});

test('createERROREvent supports retryable flag', () => {
  const retryableEvent = createERROREvent('session-1', 'user-1', 1, 'Connection failed', {
    retryable: true,
  });

  const nonRetryableEvent = createERROREvent('session-1', 'user-1', 2, 'Connection failed', {
    retryable: false,
  });

  assert.strictEqual(retryableEvent.retryable, true);
  assert.strictEqual(nonRetryableEvent.retryable, false);
});

test('createERROREvent supports optional guidance', () => {
  const event = createERROREvent('session-1', 'user-1', 1, 'Connection failed', {
    guidance: 'Check your network connection',
  });

  assert.strictEqual(event.guidance, 'Check your network connection');
});

// ============================================================================
// createRESULTEvent Tests
// ============================================================================

test('createRESULTEvent creates event with required fields', () => {
  const event = createRESULTEvent('session-1', 'user-1', 1, 'Task completed');

  assert.strictEqual(event.category, 'RESULT');
  assert.strictEqual(event.summary, 'Task completed');
});

test('createRESULTEvent supports optional data and success', () => {
  const event = createRESULTEvent('session-1', 'user-1', 1, 'Task completed', {
    data: { result: 'success' },
    success: true,
  });

  assert.deepStrictEqual(event.data, { result: 'success' });
  assert.strictEqual(event.success, true);
});

test('createRESULTEvent supports optional stats', () => {
  const stats = {
    tokensUsed: 1234,
    promptTokens: 1000,
    completionTokens: 234,
    durationMs: 5000,
  };

  const event = createRESULTEvent('session-1', 'user-1', 1, 'Task completed', { stats });

  assert.deepStrictEqual(event.stats, stats);
});

// ============================================================================
// createACTIONSEvent Tests
// ============================================================================

test('createACTIONSEvent creates event with actions array', () => {
  const actions = [
    { label: 'Retry', action: 'retry' },
    { label: 'Cancel', action: 'cancel' },
  ];

  const event = createACTIONSEvent('session-1', 'user-1', 1, actions, {
    message: 'Choose an action',
  });

  assert.strictEqual(event.category, 'ACTIONS');
  assert.strictEqual(event.message, 'Choose an action');
  assert.deepStrictEqual(event.actions, actions);
});

test('createACTIONSEvent supports empty actions array', () => {
  const event = createACTIONSEvent('session-1', 'user-1', 1, [], {
    message: 'No actions available',
  });

  assert.deepStrictEqual(event.actions, []);
});

// ============================================================================
// Utility Function Tests
// ============================================================================

test('isRetryable returns true for ERROR with retryable=true', () => {
  const event = createERROREvent('session-1', 'user-1', 1, 'Error', { retryable: true });
  assert.strictEqual(isRetryable(event), true);
});

test('isRetryable returns false for ERROR with retryable=false', () => {
  const event = createERROREvent('session-1', 'user-1', 1, 'Error', { retryable: false });
  assert.strictEqual(isRetryable(event), false);
});

test('isRetryable returns false for ERROR without retryable flag', () => {
  const event = createERROREvent('session-1', 'user-1', 1, 'Error');
  assert.strictEqual(isRetryable(event), false);
});

test('isRetryable returns true for RESULT with tokensUsed', () => {
  const event = createRESULTEvent('session-1', 'user-1', 1, 'Done', {
    stats: { tokensUsed: 100 },
  });
  assert.strictEqual(isRetryable(event), true);
});

test('isRetryable returns false for non-terminal events', () => {
  const ackEvent = createACKEvent('session-1', 'user-1', 1, 'Ack');
  const progressEvent = createPROGRESSEvent('session-1', 'user-1', 2, 'Progress', {
    progress: 0.5,
  });
  const warningEvent = createWARNINGEvent('session-1', 'user-1', 3, 'Warning');
  const actionsEvent = createACTIONSEvent('session-1', 'user-1', 4, [], { message: 'Actions' });

  assert.strictEqual(isRetryable(ackEvent), false);
  assert.strictEqual(isRetryable(progressEvent), false);
  assert.strictEqual(isRetryable(warningEvent), false);
  assert.strictEqual(isRetryable(actionsEvent), false);
});

test('getTimestamp returns event.timestamp', () => {
  const timestamp = 1700000000000;
  const event = createACKEvent('session-1', 'user-1', 1, 'Test', { timestamp });
  assert.strictEqual(getTimestamp(event), timestamp);
});

test('sameSession returns true for same sessionId', () => {
  const sessionId = 'session-123';
  const event1 = createACKEvent(sessionId, 'user-1', 1, 'Test1');
  const event2 = createPROGRESSEvent(sessionId, 'user-1', 2, 'Test2');

  assert.strictEqual(sameSession(event1, event2), true);
});

test('sameSession returns false for different sessionId', () => {
  const event1 = createACKEvent('session-1', 'user-1', 1, 'Test1');
  const event2 = createPROGRESSEvent('session-2', 'user-1', 2, 'Test2');

  assert.strictEqual(sameSession(event1, event2), false);
});

test('isTerminal returns true for RESULT and ERROR', () => {
  const resultEvent = createRESULTEvent('session-1', 'user-1', 1, 'Done');
  const errorEvent = createERROREvent('session-1', 'user-1', 2, 'Error');

  assert.strictEqual(isTerminal(resultEvent), true);
  assert.strictEqual(isTerminal(errorEvent), true);
});

test('isTerminal returns false for non-terminal events', () => {
  const ackEvent = createACKEvent('session-1', 'user-1', 1, 'Ack');
  const progressEvent = createPROGRESSEvent('session-1', 'user-1', 2, 'Progress', {
    progress: 0.5,
  });
  const warningEvent = createWARNINGEvent('session-1', 'user-1', 3, 'Warning');
  const actionsEvent = createACTIONSEvent('session-1', 'user-1', 4, [], { message: 'Actions' });

  assert.strictEqual(isTerminal(ackEvent), false);
  assert.strictEqual(isTerminal(progressEvent), false);
  assert.strictEqual(isTerminal(warningEvent), false);
  assert.strictEqual(isTerminal(actionsEvent), false);
});

test('nextSequence increments by 1', () => {
  assert.strictEqual(nextSequence(0), 1);
  assert.strictEqual(nextSequence(1), 2);
  assert.strictEqual(nextSequence(42), 43);
  assert.strictEqual(nextSequence(999), 1000);
});

// ============================================================================
// Edge Cases
// ============================================================================

test('Events handle empty strings for optional fields', () => {
  const event = createWARNINGEvent('session-1', 'user-1', 1, 'Test', {
    code: '',
    hint: '',
  });

  assert.strictEqual(event.code, '');
  assert.strictEqual(event.hint, '');
});

test('Events handle zero/null/undefined for optional numeric fields', () => {
  const event = createPROGRESSEvent('session-1', 'user-1', 1, 'Test', {
    progress: 0,
  });

  assert.strictEqual(event.progress, 0);
});

test('Events handle undefined optional fields', () => {
  const event = createACKEvent('session-1', 'user-1', 1, 'Test');

  assert.strictEqual(event.estimatedDurationSec, undefined);
  assert.strictEqual(event.model, undefined);
});
