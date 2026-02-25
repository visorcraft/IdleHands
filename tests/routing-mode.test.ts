import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROUTING_MODES,
  normalizeRoutingMode,
  getEffectiveRoutingMode,
  routingModeStatusLines,
} from '../dist/routing/mode.js';

describe('routing/mode', () => {
  describe('normalizeRoutingMode', () => {
    it('accepts auto/fast/heavy', () => {
      assert.equal(normalizeRoutingMode('auto'), 'auto');
      assert.equal(normalizeRoutingMode('fast'), 'fast');
      assert.equal(normalizeRoutingMode('heavy'), 'heavy');
    });

    it('is case-insensitive', () => {
      assert.equal(normalizeRoutingMode('FAST'), 'fast');
      assert.equal(normalizeRoutingMode('Heavy'), 'heavy');
      assert.equal(normalizeRoutingMode('AUTO'), 'auto');
    });

    it('trims whitespace', () => {
      assert.equal(normalizeRoutingMode('  fast  '), 'fast');
    });

    it('returns undefined for invalid input', () => {
      assert.equal(normalizeRoutingMode('code'), undefined);
      assert.equal(normalizeRoutingMode('sys'), undefined);
      assert.equal(normalizeRoutingMode(''), undefined);
      assert.equal(normalizeRoutingMode(null), undefined);
      assert.equal(normalizeRoutingMode(undefined), undefined);
      assert.equal(normalizeRoutingMode(42), undefined);
    });
  });

  describe('getEffectiveRoutingMode', () => {
    it('returns routing_mode when set', () => {
      assert.equal(getEffectiveRoutingMode({ routing_mode: 'heavy' }), 'heavy');
    });

    it('falls back to routing.defaultMode', () => {
      assert.equal(
        getEffectiveRoutingMode({ routing: { defaultMode: 'fast' } }),
        'fast',
      );
    });

    it('defaults to auto when nothing is set', () => {
      assert.equal(getEffectiveRoutingMode({}), 'auto');
    });

    it('routing_mode takes precedence over routing.defaultMode', () => {
      assert.equal(
        getEffectiveRoutingMode({ routing_mode: 'fast', routing: { defaultMode: 'heavy' } }),
        'fast',
      );
    });
  });

  describe('routingModeStatusLines', () => {
    it('includes current mode', () => {
      const lines = routingModeStatusLines({ routing_mode: 'fast' });
      assert.ok(lines[0].includes('fast'));
    });

    it('says not configured when no routing block', () => {
      const lines = routingModeStatusLines({});
      assert.ok(lines.some((l) => l.includes('not configured')));
    });

    it('shows fast/heavy model names', () => {
      const lines = routingModeStatusLines({
        routing_mode: 'auto',
        routing: {
          defaultMode: 'auto',
          fastModel: 'gpt-4o-mini',
          heavyModel: 'gpt-4o',
        },
      });
      assert.ok(lines.some((l) => l.includes('gpt-4o-mini')));
      assert.ok(lines.some((l) => l.includes('gpt-4o')));
    });
  });

  describe('ROUTING_MODES constant', () => {
    it('contains auto, fast, heavy', () => {
      assert.deepEqual(ROUTING_MODES, ['auto', 'fast', 'heavy']);
    });
  });
});
