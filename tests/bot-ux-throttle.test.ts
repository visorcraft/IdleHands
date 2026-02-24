import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_PROGRESS_INTERVAL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  MAX_PROGRESS_SILENT_INTERVALS,
  createProgressThrottleState,
  checkProgressThrottle,
  checkHeartbeatRequired,
  recordProgressUpdate,
  recordHeartbeat,
  recordUserActivity,
  incrementSilentInterval,
  resetThrottleState,
  type ProgressThrottleConfig,
  type ProgressThrottleState,
  type ThrottleResult,
} from '../dist/bot/ux/progress-throttle.js';

// ============================================================================
// Configuration Tests
// ============================================================================

test('DEFAULT_PROGRESS_INTERVAL_MS is 3000', () => {
  assert.strictEqual(DEFAULT_PROGRESS_INTERVAL_MS, 3000);
});

test('DEFAULT_HEARTBEAT_INTERVAL_MS is 4000', () => {
  assert.strictEqual(DEFAULT_HEARTBEAT_INTERVAL_MS, 4000);
});

test('MAX_PROGRESS_SILENT_INTERVALS is 3', () => {
  assert.strictEqual(MAX_PROGRESS_SILENT_INTERVALS, 3);
});

// ============================================================================
// createProgressThrottleState Tests
// ============================================================================

test('createProgressThrottleState creates initial state with defaults', () => {
  const state = createProgressThrottleState();

  assert.ok(state.lastProgressAt);
  assert.ok(state.lastHeartbeatAt);
  assert.ok(state.lastUserActivityAt);
  assert.strictEqual(state.silentIntervals, 0);
  assert.strictEqual(state.isThrottled, false);
  assert.strictEqual(state.heartbeatRequired, false);
});

test('createProgressThrottleState uses custom config', () => {
  const now = () => 1700000000000;
  const config: ProgressThrottleConfig = {
    progressIntervalMs: 5000,
    heartbeatIntervalMs: 6000,
    maxSilentIntervals: 5,
    now,
  };

  const state = createProgressThrottleState(config);

  assert.strictEqual(state.lastProgressAt, 1700000000000);
  assert.strictEqual(state.lastHeartbeatAt, 1700000000000);
  assert.strictEqual(state.lastUserActivityAt, 1700000000000);
  assert.strictEqual(state.silentIntervals, 0);
  assert.strictEqual(state.isThrottled, false);
  assert.strictEqual(state.heartbeatRequired, false);
});

test('createProgressThrottleState initializes timestamps to now', () => {
  const nowValue = Date.now();
  const state = createProgressThrottleState({ now: () => nowValue });

  assert.strictEqual(state.lastProgressAt, nowValue);
  assert.strictEqual(state.lastHeartbeatAt, nowValue);
  assert.strictEqual(state.lastUserActivityAt, nowValue);
});

// ============================================================================
// checkProgressThrottle Tests
// ============================================================================

test('checkProgressThrottle allows initial call', () => {
  const state = createProgressThrottleState();
  const result = checkProgressThrottle(state);

  assert.strictEqual(result.allow, true);
  assert.strictEqual(result.reason, 'allowed');
  assert.strictEqual(result.retryAfter, undefined);
});

test('checkProgressThrottle throttles subsequent calls within interval', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });
  // Simulate time has passed but still within interval
  const later = () => 1700000001000; // 1 second later

  const result = checkProgressThrottle(state, { now: later });

  assert.strictEqual(result.allow, false);
  assert.strictEqual(result.reason, 'throttled');
  assert.ok(result.retryAfter);
  assert.ok(result.retryAfter > 0);
});

test('checkProgressThrottle allows after interval expires', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });
  // Simulate time has passed beyond interval
  const later = () => 1700000004000; // 4 seconds later (beyond 3s interval)

  const result = checkProgressThrottle(state, { now: later });

  assert.strictEqual(result.allow, true);
  assert.strictEqual(result.reason, 'allowed');
  assert.strictEqual(result.retryAfter, undefined);
});

test('checkProgressThrottle returns heartbeat_required when needed', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });
  // Simulate time beyond heartbeat interval
  const later = () => 1700000005000; // 5 seconds later (beyond 4s heartbeat)

  const result = checkProgressThrottle(state, { now: later });

  assert.strictEqual(result.allow, true);
  assert.strictEqual(result.reason, 'heartbeat_required');
});

test('checkProgressThrottle respects custom progressIntervalMs', () => {
  const now = () => 1700000000000;
  const config: ProgressThrottleConfig = {
    progressIntervalMs: 10000, // 10 seconds
    now,
  };
  const state = createProgressThrottleState(config);
  // Simulate time has passed but still within custom interval
  const later = () => 1700000005000; // 5 seconds later

  const result = checkProgressThrottle(state, { now: later });

  assert.strictEqual(result.allow, false);
  assert.strictEqual(result.reason, 'throttled');
});

test('checkProgressThrottle respects custom heartbeatIntervalMs', () => {
  const now = () => 1700000000000;
  const config: ProgressThrottleConfig = {
    heartbeatIntervalMs: 10000, // 10 seconds
    now,
  };
  const state = createProgressThrottleState(config);
  // Simulate time has passed but still within custom heartbeat interval
  const later = () => 1700000005000; // 5 seconds later

  const result = checkProgressThrottle(state, { now: later });

  assert.strictEqual(result.allow, true);
  assert.strictEqual(result.reason, 'allowed');
});

// ============================================================================
// checkHeartbeatRequired Tests
// ============================================================================

test('checkHeartbeatRequired returns true when heartbeat interval exceeded', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });
  const later = () => 1700000005000; // 5 seconds later (beyond 4s default)

  const result = checkHeartbeatRequired(state, { now: later });

  assert.strictEqual(result, true);
});

test('checkHeartbeatRequired returns false when within interval', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });
  const later = () => 1700000002000; // 2 seconds later (within 4s default)

  const result = checkHeartbeatRequired(state, { now: later });

  assert.strictEqual(result, false);
});

test('checkHeartbeatRequired respects custom heartbeatIntervalMs', () => {
  const now = () => 1700000000000;
  const config: ProgressThrottleConfig = {
    heartbeatIntervalMs: 10000, // 10 seconds
    now,
  };
  const state = createProgressThrottleState(config);
  const later = () => 1700000005000; // 5 seconds later (within 10s custom)

  const result = checkHeartbeatRequired(state, { now: later });

  assert.strictEqual(result, false);
});

// ============================================================================
// recordProgressUpdate Tests
// ============================================================================

test('recordProgressUpdate updates lastProgressAt', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });
  const later = () => 1700000005000;

  const newState = recordProgressUpdate(state, { now: later });

  assert.strictEqual(newState.lastProgressAt, 1700000005000);
});

test('recordProgressUpdate resets isThrottled', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });
  const later = () => 1700000005000;

  const newState = recordProgressUpdate(state, { now: later });

  assert.strictEqual(newState.isThrottled, false);
});

// ============================================================================
// recordHeartbeat Tests
// ============================================================================

test('recordHeartbeat updates lastHeartbeatAt', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });
  const later = () => 1700000005000;

  const newState = recordHeartbeat(state, { now: later });

  assert.strictEqual(newState.lastHeartbeatAt, 1700000005000);
});

// ============================================================================
// recordUserActivity Tests
// ============================================================================

test('recordUserActivity updates lastUserActivityAt', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });
  const later = () => 1700000005000;

  const newState = recordUserActivity(state, { now: later });

  assert.strictEqual(newState.lastUserActivityAt, 1700000005000);
});

test('recordUserActivity resets silentIntervals', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });
  // Increment silent intervals
  let newState = incrementSilentInterval(state);
  newState = incrementSilentInterval(newState);
  newState = incrementSilentInterval(newState);

  assert.strictEqual(newState.silentIntervals, 3);

  // Record user activity
  const later = () => 1700000005000;
  newState = recordUserActivity(newState, { now: later });

  assert.strictEqual(newState.silentIntervals, 0);
});

// ============================================================================
// incrementSilentInterval Tests
// ============================================================================

test('incrementSilentInterval increments counter', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });

  let newState = incrementSilentInterval(state);
  assert.strictEqual(newState.silentIntervals, 1);

  newState = incrementSilentInterval(newState);
  assert.strictEqual(newState.silentIntervals, 2);

  newState = incrementSilentInterval(newState);
  assert.strictEqual(newState.silentIntervals, 3);
});

// ============================================================================
// resetThrottleState Tests
// ============================================================================

test('resetThrottleState resets all timestamps and counters', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });

  // Modify state
  let newState = recordProgressUpdate(state, { now: () => 1700000005000 });
  newState = incrementSilentInterval(newState);
  newState = incrementSilentInterval(newState);

  assert.notStrictEqual(newState.lastProgressAt, state.lastProgressAt);
  assert.strictEqual(newState.silentIntervals, 2);

  // Reset
  const later = () => 1700000010000;
  newState = resetThrottleState(newState, { now: later });

  assert.strictEqual(newState.lastProgressAt, 1700000010000);
  assert.strictEqual(newState.lastHeartbeatAt, 1700000010000);
  assert.strictEqual(newState.lastUserActivityAt, 1700000010000);
  assert.strictEqual(newState.silentIntervals, 0);
  assert.strictEqual(newState.isThrottled, false);
  assert.strictEqual(newState.heartbeatRequired, false);
});

// ============================================================================
// ThrottleResult Tests
// ============================================================================

test('ThrottleResult includes retryAfter when throttled', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });
  const later = () => 1700000001000; // 1 second later

  const result = checkProgressThrottle(state, { now: later });

  assert.ok(result.retryAfter);
  assert.ok(result.retryAfter > 0);
});

test('ThrottleResult retryAfter is within expected range', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });
  const later = () => 1700000001000; // 1 second later

  const result = checkProgressThrottle(state, { now: later });

  // Should be roughly 2000ms (3000 - 1000)
  assert.ok(result.retryAfter);
  assert.ok(result.retryAfter! >= 1500);
  assert.ok(result.retryAfter! <= 3000);
});

// ============================================================================
// Edge Cases
// ============================================================================

test('Throttle handles zero/negative intervals gracefully', () => {
  const now = () => 1700000000000;
  const config: ProgressThrottleConfig = {
    progressIntervalMs: 0,
    heartbeatIntervalMs: 0,
    now,
  };
  const state = createProgressThrottleState(config);

  const result = checkProgressThrottle(state);

  // With zero interval, should allow immediately
  assert.strictEqual(result.allow, true);
  assert.strictEqual(result.reason, 'allowed');
});

test('Throttle handles very large timestamps', () => {
  const now = () => 1700000000000000;
  const state = createProgressThrottleState({ now });

  assert.ok(state.lastProgressAt);
  assert.ok(state.lastHeartbeatAt);
  assert.ok(state.lastUserActivityAt);
});

test('Throttle handles rapid successive calls', () => {
  const now = () => 1700000000000;
  const state = createProgressThrottleState({ now });

  // First call
  const result1 = checkProgressThrottle(state);
  assert.strictEqual(result1.allow, true);

  // Rapid subsequent calls
  const result2 = checkProgressThrottle(state, { now: () => 1700000000100 });
  assert.strictEqual(result2.allow, false);

  const result3 = checkProgressThrottle(state, { now: () => 1700000000200 });
  assert.strictEqual(result3.allow, false);
});

test('Throttle time source manipulation for deterministic testing', () => {
  const baseTime = 1700000000000;
  let currentTime = baseTime;

  const now = () => currentTime;

  const state = createProgressThrottleState({ now });

  // First call should be allowed
  let result = checkProgressThrottle(state);
  assert.strictEqual(result.allow, true);

  // Move time forward by 1 second (within 3s interval)
  currentTime += 1000;
  result = checkProgressThrottle(state);
  assert.strictEqual(result.allow, false);

  // Move time forward by 3 more seconds (beyond 3s interval)
  currentTime += 3000;
  result = checkProgressThrottle(state);
  assert.strictEqual(result.allow, true);
});