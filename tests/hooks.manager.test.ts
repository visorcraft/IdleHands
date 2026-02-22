import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HookManager } from '../dist/hooks/manager.js';

describe('hooks manager', () => {
  it('dispatches handlers in registration order and supports async handlers', async () => {
    const events: string[] = [];
    const manager = new HookManager({
      context: () => ({
        sessionId: 's1',
        cwd: '/tmp',
        model: 'm1',
        harness: 'h1',
        endpoint: 'http://localhost:8080/v1',
      }),
    });

    manager.on(
      'ask_start',
      async ({ askId }) => {
        await new Promise((r) => setTimeout(r, 5));
        events.push(`a:${askId}`);
      },
      't1'
    );
    manager.on(
      'ask_start',
      ({ askId }) => {
        events.push(`b:${askId}`);
      },
      't2'
    );

    await manager.emit('ask_start', { askId: 'x1', instruction: 'hello' });

    assert.deepEqual(events, ['a:x1', 'b:x1']);
  });

  it('isolates handler errors in non-strict mode', async () => {
    const manager = new HookManager({
      strict: false,
      logger: () => {},
      context: () => ({
        sessionId: 's1',
        cwd: '/tmp',
        model: 'm1',
        harness: 'h1',
        endpoint: 'http://localhost:8080/v1',
      }),
    });

    let called = false;
    manager.on(
      'turn_start',
      () => {
        throw new Error('boom');
      },
      'broken'
    );
    manager.on(
      'turn_start',
      () => {
        called = true;
      },
      'next'
    );

    await manager.emit('turn_start', { askId: 'a1', turn: 1 });
    assert.equal(called, true);
  });

  it('throws on handler errors in strict mode', async () => {
    const manager = new HookManager({
      strict: true,
      context: () => ({
        sessionId: 's1',
        cwd: '/tmp',
        model: 'm1',
        harness: 'h1',
        endpoint: 'http://localhost:8080/v1',
      }),
    });

    manager.on(
      'turn_start',
      () => {
        throw new Error('boom');
      },
      'broken'
    );

    await assert.rejects(manager.emit('turn_start', { askId: 'a1', turn: 1 }), /handler failed/i);
  });

  it('redacts gated payload fields when capabilities are not allowed', async () => {
    const captured: any[] = [];
    const manager = new HookManager({
      strict: false,
      logger: () => {},
      allowedCapabilities: ['observe'],
      context: () => ({
        sessionId: 's1',
        cwd: '/tmp',
        model: 'm1',
        harness: 'h1',
        endpoint: 'http://localhost:8080/v1',
      }),
    });

    await manager.registerPlugin(
      {
        name: 'caps-test',
        capabilities: ['observe', 'read_prompts', 'read_tool_args', 'read_tool_results'],
        hooks: {
          ask_start: (payload) => captured.push(payload),
          tool_call: (payload) => captured.push(payload),
          tool_result: (payload) => captured.push(payload),
        },
      },
      'caps-test'
    );

    await manager.emit('ask_start', { askId: 'a1', instruction: 'secret prompt' });
    await manager.emit('tool_call', {
      askId: 'a1',
      turn: 1,
      call: { id: 'c1', name: 'exec', args: { command: 'echo secret' } },
    });
    await manager.emit('tool_result', {
      askId: 'a1',
      turn: 1,
      result: {
        id: 'c1',
        name: 'exec',
        success: true,
        summary: 'ok',
        result: 'very secret result',
      },
    });

    assert.equal(captured[0]?.instruction, '[redacted: missing read_prompts capability]');
    assert.deepEqual(captured[1]?.call?.args, {});
    assert.equal(captured[2]?.result?.result, '[redacted: missing read_tool_results capability]');

    const snapshot = manager.getSnapshot();
    assert.equal(snapshot.plugins.length, 1);
    assert.equal(snapshot.plugins[0]?.deniedCapabilities.includes('read_prompts'), true);
    assert.equal(snapshot.eventCounts.ask_start, 1);
  });
});
