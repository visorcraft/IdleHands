import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  routingModeShowCommand,
  routingModeSetCommand,
  routingModeStatusCommand,
} from '../dist/bot/session-settings.js';

function makeManagedLike(overrides: Record<string, any> = {}): any {
  return {
    session: { model: 'test-model', harness: 'default', currentContextTokens: 0, contextWindow: 131072, usage: { prompt: 0, completion: 0 } },
    config: { mode: 'code', routing_mode: 'auto', approval_mode: 'auto-edit', ...overrides.config },
    workingDir: '/tmp/test',
    dirPinned: false,
    repoCandidates: [],
    state: 'idle',
    pendingQueue: [],
    inFlight: false,
    agentId: 'default',
    antonActive: false,
    antonAbortSignal: null,
    antonProgress: null,
    antonLastResult: null,
    lastActivity: Date.now(),
    lastProgressAt: Date.now(),
    currentModelIndex: 0,
    allowedDirs: ['/tmp/test'],
  };
}

describe('routing command logic (session-settings)', () => {
  describe('routingModeShowCommand', () => {
    it('shows current routing mode', () => {
      const result = routingModeShowCommand(makeManagedLike({ config: { routing_mode: 'heavy' } }));
      assert.ok(result.kv);
      assert.equal(result.kv[0][1], 'heavy');
    });

    it('defaults to auto', () => {
      const result = routingModeShowCommand(makeManagedLike({ config: {} }));
      assert.ok(result.kv);
      assert.equal(result.kv[0][1], 'auto');
    });
  });

  describe('routingModeSetCommand', () => {
    it('sets routing mode to fast', () => {
      const managed = makeManagedLike();
      const result = routingModeSetCommand(managed, 'fast');
      assert.ok(result.success);
      assert.ok(result.success.includes('fast'));
      assert.equal(managed.config.routing_mode, 'fast');
    });

    it('sets routing mode to heavy', () => {
      const managed = makeManagedLike();
      const result = routingModeSetCommand(managed, 'heavy');
      assert.ok(result.success);
      assert.equal(managed.config.routing_mode, 'heavy');
    });

    it('sets routing mode to auto', () => {
      const managed = makeManagedLike({ config: { routing_mode: 'fast' } });
      const result = routingModeSetCommand(managed, 'auto');
      assert.ok(result.success);
      assert.equal(managed.config.routing_mode, 'auto');
    });

    it('rejects invalid values', () => {
      const managed = makeManagedLike();
      const result = routingModeSetCommand(managed, 'turbo');
      assert.ok(result.error);
      assert.ok(result.error.includes('Invalid'));
      assert.equal(managed.config.routing_mode, 'auto'); // unchanged
    });

    it('rejects code/sys (those belong to /mode)', () => {
      const managed = makeManagedLike();
      assert.ok(routingModeSetCommand(managed, 'code').error);
      assert.ok(routingModeSetCommand(managed, 'sys').error);
    });
  });

  describe('routingModeStatusCommand', () => {
    it('returns status lines', () => {
      const managed = makeManagedLike({
        config: {
          routing_mode: 'fast',
          routing: {
            defaultMode: 'auto',
            fastModel: 'gpt-4o-mini',
            heavyModel: 'gpt-4o',
          },
        },
      });
      const result = routingModeStatusCommand(managed);
      assert.ok(result.title);
      assert.ok(result.lines);
      assert.ok(result.lines.some((l: string) => l.includes('fast')));
      assert.ok(result.lines.some((l: string) => l.includes('gpt-4o-mini')));
    });
  });
});
