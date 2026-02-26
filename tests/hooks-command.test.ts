import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hooksCommand } from '../dist/bot/hooks-command.js';

describe('hooks command', () => {
  function makeManaged(snapshot: any) {
    return {
      session: {
        hookManager: {
          getSnapshot: () => snapshot,
        },
      },
    } as any;
  }

  it('shows status mode by default', () => {
    const res = hooksCommand(
      makeManaged({
        enabled: true,
        strict: true,
        allowedCapabilities: ['observe', 'read'],
        plugins: [],
        handlers: [],
        eventCounts: { on_turn_end: 2, on_tool_call: 5 },
        recentErrors: ['error A'],
        recentSlowHandlers: [],
      }),
      undefined
    );

    assert.equal(res.title, 'Hook Status');
    assert.ok(res.lines!.some((l) => l.includes('Hooks Status: enabled')));
    assert.ok(res.lines!.some((l) => l.includes('Recent event counts')));
  });

  it('supports plugins mode', () => {
    const res = hooksCommand(
      makeManaged({
        enabled: true,
        strict: false,
        allowedCapabilities: ['observe'],
        plugins: [
          {
            name: 'p',
            source: 'local',
            grantedCapabilities: ['read'],
            deniedCapabilities: ['write'],
            requestedCapabilities: ['read', 'write'],
            configPath: '/tmp/p.json',
          },
        ],
        handlers: [{ source: 'local', event: 'on_tool_call' }],
        eventCounts: {},
        recentErrors: [],
        recentSlowHandlers: [],
      }),
      'plugins'
    );

    assert.equal(res.title, 'Hook Plugins');
    assert.ok(res.lines!.some((l) => l.includes('p @ local')));
  });

  it('supports errors mode', () => {
    const res = hooksCommand(
      makeManaged({
        enabled: false,
        strict: false,
        allowedCapabilities: ['observe'],
        plugins: [],
        handlers: [],
        eventCounts: {},
        recentErrors: ['first failure', 'second failure'],
        recentSlowHandlers: [],
      }),
      'errors'
    );

    assert.equal(res.title, 'Hook Errors');
    assert.ok(res.lines!.some((l) => l.includes('first failure')));
  });

  it('supports slow mode', () => {
    const res = hooksCommand(
      makeManaged({
        enabled: false,
        strict: false,
        allowedCapabilities: ['observe'],
        plugins: [],
        handlers: [],
        eventCounts: {},
        recentErrors: [],
        recentSlowHandlers: ['slow handler'],
      }),
      'slow'
    );

    assert.equal(res.title, 'Slow Hook Handlers');
    assert.ok(res.lines!.some((l) => l.includes('slow handler')));
  });

  it('returns usage error on invalid mode', () => {
    const res = hooksCommand(makeManaged({
      enabled: true,
      strict: true,
      allowedCapabilities: ['observe'],
      plugins: [],
      handlers: [],
      eventCounts: {},
      recentErrors: [],
      recentSlowHandlers: [],
    }),
    'nonsense');

    assert.ok(res.error);
    assert.ok(res.error!.includes('Usage'));
  });

  it('returns error when hook system unavailable', () => {
    const res = hooksCommand({ session: {} as any } as any, 'status');
    assert.ok(res.error);
  });
});
