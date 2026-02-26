import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RouteHysteresis } from '../dist/routing/hysteresis.js';

describe('RouteHysteresis', () => {
  it('allows first selection unconditionally', () => {
    const h = new RouteHysteresis({ minDwell: 2 });
    const r = h.apply('fast', 'classifier');
    assert.equal(r.lane, 'fast');
    assert.equal(r.suppressed, false);
  });

  it('allows same-lane selections without constraint', () => {
    const h = new RouteHysteresis({ minDwell: 3 });
    h.apply('fast', 'classifier');
    const r2 = h.apply('fast', 'classifier');
    assert.equal(r2.lane, 'fast');
    assert.equal(r2.suppressed, false);
  });

  it('suppresses lane switch when dwell not met', () => {
    const h = new RouteHysteresis({ minDwell: 3 });
    h.apply('fast', 'classifier');      // dwell=1
    const r = h.apply('heavy', 'classifier');  // dwell=2 (not enough)
    assert.equal(r.lane, 'fast');        // stays fast
    assert.equal(r.suppressed, true);
  });

  it('allows lane switch once dwell is met', () => {
    const h = new RouteHysteresis({ minDwell: 2 });
    h.apply('fast', 'classifier');       // dwell=1
    h.apply('fast', 'classifier');       // dwell=2
    const r = h.apply('heavy', 'classifier');  // dwell >= minDwell, switch allowed
    assert.equal(r.lane, 'heavy');
    assert.equal(r.suppressed, false);
  });

  it('override bypasses hysteresis always', () => {
    const h = new RouteHysteresis({ minDwell: 10 });
    h.apply('fast', 'classifier');
    const r = h.apply('heavy', 'override');
    assert.equal(r.lane, 'heavy');
    assert.equal(r.suppressed, false);
  });

  it('disabled hysteresis passes through all changes', () => {
    const h = new RouteHysteresis({ minDwell: 10, enabled: false });
    h.apply('fast', 'classifier');
    const r = h.apply('heavy', 'classifier');
    assert.equal(r.lane, 'heavy');
    assert.equal(r.suppressed, false);
  });

  it('reset clears state', () => {
    const h = new RouteHysteresis({ minDwell: 5 });
    h.apply('fast', 'classifier');
    h.reset();
    // After reset, first selection is unconditional again
    const r = h.apply('heavy', 'classifier');
    assert.equal(r.lane, 'heavy');
    assert.equal(r.suppressed, false);
  });

  it('state getter returns current tracking', () => {
    const h = new RouteHysteresis({ minDwell: 3 });
    h.apply('fast', 'heuristic');
    h.apply('fast', 'heuristic');
    const s = h.state;
    assert.equal(s.currentLane, 'fast');
    assert.equal(s.dwellCount, 2);
    assert.equal(s.minDwell, 3);
    assert.equal(s.enabled, true);
  });

  it('suppressed switch still increments dwell of current lane', () => {
    const h = new RouteHysteresis({ minDwell: 3 });
    h.apply('fast', 'classifier');       // dwell=1
    h.apply('heavy', 'classifier');      // suppressed, dwell=2
    h.apply('heavy', 'classifier');      // suppressed, dwell=3
    // Now dwell >= minDwell for 'fast', next heavy should switch
    const r = h.apply('heavy', 'classifier');
    assert.equal(r.lane, 'heavy');
    assert.equal(r.suppressed, false);
  });
});
