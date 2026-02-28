import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveIdSlot, resetSlotAffinityState } from '../dist/slot-affinity.js';

describe('slot-affinity', () => {
  beforeEach(() => {
    resetSlotAffinityState();
  });

  it('returns fixed id_slot when dynamic affinity disabled', () => {
    const slot = resolveIdSlot({
      sessionKey: 's1',
      id_slot: 3,
      slot_affinity: { enabled: false, num_slots: 8 },
    });

    assert.equal(slot, 3);
  });

  it('assigns stable slots per session when dynamic affinity enabled', () => {
    const s1a = resolveIdSlot({ sessionKey: 's1', slot_affinity: { enabled: true, num_slots: 2 } });
    const s2 = resolveIdSlot({ sessionKey: 's2', slot_affinity: { enabled: true, num_slots: 2 } });
    const s1b = resolveIdSlot({ sessionKey: 's1', slot_affinity: { enabled: true, num_slots: 2 } });

    assert.equal(s1a, 0);
    assert.equal(s2, 1);
    assert.equal(s1b, s1a);
  });

  it('evicts least recently used slot when full', () => {
    const s1 = resolveIdSlot({ sessionKey: 's1', slot_affinity: { enabled: true, num_slots: 2 } });
    const s2 = resolveIdSlot({ sessionKey: 's2', slot_affinity: { enabled: true, num_slots: 2 } });
    // Touch s1 so s2 becomes least recently used.
    resolveIdSlot({ sessionKey: 's1', slot_affinity: { enabled: true, num_slots: 2 } });

    const s3 = resolveIdSlot({ sessionKey: 's3', slot_affinity: { enabled: true, num_slots: 2 } });
    const s2Again = resolveIdSlot({ sessionKey: 's2', slot_affinity: { enabled: true, num_slots: 2 } });

    assert.equal(s1, 0);
    assert.equal(s2, 1);
    assert.equal(s3, 1);
    assert.equal(s2Again, 0);
  });
});
