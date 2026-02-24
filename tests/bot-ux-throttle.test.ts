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
} from '../dist/bot/ux/progress-throttle.js';

test('constants are stable', () => {
  assert.strictEqual(DEFAULT_PROGRESS_INTERVAL_MS, 3000);
  assert.strictEqual(DEFAULT_HEARTBEAT_INTERVAL_MS, 4000);
  assert.strictEqual(MAX_PROGRESS_SILENT_INTERVALS, 3);
});

test('createProgressThrottleState initializes timestamps/counters', () => {
  const state = createProgressThrottleState({ now: () => 1000 });
  assert.strictEqual(state.lastProgressAt, 1000);
  assert.strictEqual(state.lastHeartbeatAt, 1000);
  assert.strictEqual(state.lastUserActivityAt, 1000);
  assert.strictEqual(state.silentIntervals, 0);
});

test('checkProgressThrottle returns user_active when user recently active', () => {
  const state = createProgressThrottleState({ now: () => 1000 });
  const result = checkProgressThrottle(state, { now: () => 2000 });
  assert.strictEqual(result.allow, true);
  assert.strictEqual(result.reason, 'user_active');
});

test('checkProgressThrottle can throttle with retryAfter', () => {
  const state = createProgressThrottleState({ now: () => 1000 });
  state.lastUserActivityAt = -100000; // not user-active path
  const result = checkProgressThrottle(state, { now: () => 12000, progressIntervalMs: 30000, heartbeatIntervalMs: 20000 });
  assert.strictEqual(result.allow, false);
  assert.strictEqual(result.reason, 'throttled');
  assert.ok((result.retryAfter ?? 0) > 0);
});

test('checkProgressThrottle returns heartbeat_required when due', () => {
  const state = createProgressThrottleState({ now: () => 1000 });
  state.lastUserActivityAt = 0;
  const result = checkProgressThrottle(state, { now: () => 7000, heartbeatIntervalMs: 4000 });
  assert.strictEqual(result.allow, true);
  assert.strictEqual(result.reason, 'heartbeat_required');
});

test('checkHeartbeatRequired respects interval', () => {
  const state = createProgressThrottleState({ now: () => 1000 });
  assert.strictEqual(checkHeartbeatRequired(state, { now: () => 2000, heartbeatIntervalMs: 4000 }), false);
  assert.strictEqual(checkHeartbeatRequired(state, { now: () => 6000, heartbeatIntervalMs: 4000 }), true);
});

test('record* functions mutate state in place', () => {
  const state = createProgressThrottleState({ now: () => 1000 });
  recordProgressUpdate(state, { now: () => 5000 });
  assert.strictEqual(state.lastProgressAt, 5000);

  recordHeartbeat(state, { now: () => 6000 });
  assert.strictEqual(state.lastHeartbeatAt, 6000);

  state.silentIntervals = 2;
  recordUserActivity(state, { now: () => 7000 });
  assert.strictEqual(state.lastUserActivityAt, 7000);
  assert.strictEqual(state.silentIntervals, 0);
});

test('incrementSilentInterval + resetThrottleState mutate state', () => {
  const state = createProgressThrottleState({ now: () => 1000 });
  state.lastUserActivityAt = 0;
  incrementSilentInterval(state, { now: () => 6000, heartbeatIntervalMs: 4000 });
  incrementSilentInterval(state, { now: () => 7000, heartbeatIntervalMs: 4000 });
  assert.strictEqual(state.silentIntervals, 2);

  resetThrottleState(state, { now: () => 9000 });
  assert.strictEqual(state.lastProgressAt, 9000);
  assert.strictEqual(state.lastHeartbeatAt, 9000);
  assert.strictEqual(state.lastUserActivityAt, 9000);
  assert.strictEqual(state.silentIntervals, 0);
  assert.strictEqual(state.isThrottled, false);
});
