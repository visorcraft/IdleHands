import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  resolveWatchdogSettings,
  shouldRecommendWatchdogTuning,
  WATCHDOG_RECOMMENDED_TUNING_TEXT,
} from '../dist/watchdog.js';

describe('watchdog helpers', () => {
  it('resolves defaults and clamps values', () => {
    const cfg = resolveWatchdogSettings(
      {
        watchdog_timeout_ms: 1000,
        watchdog_max_compactions: -2,
        watchdog_idle_grace_timeouts: -1,
        debug_abort_reason: true,
      },
      undefined
    );

    assert.equal(cfg.timeoutMs, 30_000);
    assert.equal(cfg.maxCompactions, 0);
    assert.equal(cfg.idleGraceTimeouts, 0);
    assert.equal(cfg.debugAbortReason, true);
  });

  it('uses primary values over fallback values', () => {
    const cfg = resolveWatchdogSettings(
      {
        watchdog_timeout_ms: 180_000,
        watchdog_max_compactions: 5,
        watchdog_idle_grace_timeouts: 2,
        debug_abort_reason: false,
      },
      {
        watchdog_timeout_ms: 220_000,
        watchdog_max_compactions: 9,
        watchdog_idle_grace_timeouts: 4,
        debug_abort_reason: true,
      }
    );

    assert.equal(cfg.timeoutMs, 180_000);
    assert.equal(cfg.maxCompactions, 5);
    assert.equal(cfg.idleGraceTimeouts, 2);
    assert.equal(cfg.debugAbortReason, false);
  });

  it('flags aggressive settings and leaves sane settings alone', () => {
    const aggressive = resolveWatchdogSettings({
      watchdog_timeout_ms: 60_000,
      watchdog_max_compactions: 0,
      watchdog_idle_grace_timeouts: 0,
    });
    const sane = resolveWatchdogSettings({
      watchdog_timeout_ms: 180_000,
      watchdog_max_compactions: 4,
      watchdog_idle_grace_timeouts: 2,
    });

    assert.equal(shouldRecommendWatchdogTuning(aggressive), true);
    assert.equal(shouldRecommendWatchdogTuning(sane), false);
    assert.ok(WATCHDOG_RECOMMENDED_TUNING_TEXT.includes('watchdog_timeout_ms >= 120000'));
  });
});
