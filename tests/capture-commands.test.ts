import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  captureSetCommand,
  captureShowCommand,
} from '../dist/bot/capture-commands.js';

function makeManaged(overrides: Record<string, any> = {}) {
  return {
    session: {
      model: 'x',
      harness: 'default',
      currentContextTokens: 0,
      contextWindow: 1024,
      usage: { prompt: 0, completion: 0 },
      capturePath: undefined,
      captureOn: async (p?: string) => p || '/tmp/capture.jsonl',
      captureOff: () => {},
      captureLast: async (p?: string) => p || '/tmp/last.jsonl',
      reset: () => {},
      ...overrides.session,
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
    ...overrides,
  } as any;
}

describe('capture command logic', () => {
  it('shows capture status', () => {
    const res = captureShowCommand(makeManaged({ session: { capturePath: '/tmp/a.jsonl' } }));
    assert.ok(res.kv);
    assert.ok(String(res.kv[0][1]).includes('/tmp/a.jsonl'));
  });

  it('enables capture', async () => {
    const res = await captureSetCommand(makeManaged(), 'on', '/tmp/out.jsonl');
    assert.ok(res.success);
    assert.ok(res.success?.includes('/tmp/out.jsonl'));
  });

  it('disables capture', async () => {
    let called = false;
    const res = await captureSetCommand(
      makeManaged({ session: { captureOff: () => { called = true; } } }),
      'off'
    );
    assert.equal(called, true);
    assert.ok(res.success);
  });

  it('writes last capture', async () => {
    const res = await captureSetCommand(makeManaged(), 'last', '/tmp/last.jsonl');
    assert.ok(res.success);
    assert.ok(res.success?.includes('/tmp/last.jsonl'));
  });

  it('returns error when captureLast fails', async () => {
    const res = await captureSetCommand(
      makeManaged({ session: { captureLast: async () => { throw new Error('no capture'); } } }),
      'last'
    );
    assert.ok(res.error);
    assert.ok(res.error?.includes('no capture'));
  });

  it('shows usage for invalid mode', async () => {
    const res = await captureSetCommand(makeManaged(), 'wat');
    assert.ok(res.lines?.some((l: string) => l.includes('Usage: /capture')));
  });
});
