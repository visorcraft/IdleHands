import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rollbackCommand, checkpointsCommand } from '../dist/bot/rollback-command.js';

function makeManaged(sessionOverrides: Record<string, any> = {}) {
  return {
    session: {
      model: 'x',
      harness: 'default',
      currentContextTokens: 0,
      contextWindow: 1024,
      usage: { prompt: 0, completion: 0 },
      reset: () => {},
      ...sessionOverrides,
    },
    config: { mode: 'code' },
    workingDir: '/tmp',
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
    allowedDirs: ['/tmp'],
  } as any;
}

describe('rollback command', () => {
  it('returns error when rollback not available', () => {
    const res = rollbackCommand(makeManaged());
    assert.ok(res.error);
  });

  it('returns error when nothing to roll back', () => {
    const res = rollbackCommand(makeManaged({ rollback: () => null }));
    assert.ok(res.error);
    assert.ok(res.error!.includes('Nothing'));
  });

  it('returns success with removed count', () => {
    const res = rollbackCommand(
      makeManaged({
        rollback: () => ({ preview: 'hello world', removedMessages: 4 }),
      })
    );
    assert.ok(res.success);
    assert.ok(res.success!.includes('4'));
    assert.ok(res.success!.includes('hello world'));
  });
});

describe('checkpoints command', () => {
  it('returns error when not available', () => {
    const res = checkpointsCommand(makeManaged());
    assert.ok(res.error);
  });

  it('shows empty message when no checkpoints', () => {
    const res = checkpointsCommand(makeManaged({ listCheckpoints: () => [] }));
    assert.ok(res.lines);
    assert.ok(res.lines!.some((l: string) => l.includes('No checkpoints')));
  });

  it('lists checkpoints with age', () => {
    const res = checkpointsCommand(
      makeManaged({
        listCheckpoints: () => [
          { messageCount: 5, createdAt: Date.now() - 30000, preview: 'fix the bug' },
          { messageCount: 2, createdAt: Date.now() - 120000, preview: 'initial setup' },
        ],
      })
    );
    assert.ok(res.title);
    assert.ok(res.lines);
    assert.equal(res.lines!.length, 2);
    assert.ok(res.lines![0].includes('fix the bug'));
  });
});
