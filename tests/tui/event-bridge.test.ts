import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentBridge } from '../../dist/tui/event-bridge.js';

test('onStreamStart dispatches AGENT_STREAM_START', () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const bridge = createAgentBridge(dispatch);

  bridge.onStreamStart('s1');

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'AGENT_STREAM_START', id: 's1' });
});

test('onStreamToken dispatches AGENT_STREAM_TOKEN', () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const bridge = createAgentBridge(dispatch);

  bridge.onStreamToken('s1', 'hello');

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'AGENT_STREAM_TOKEN', id: 's1', token: 'hello' });
});

test('onStreamDone dispatches AGENT_STREAM_DONE', () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const bridge = createAgentBridge(dispatch);

  bridge.onStreamDone('s1');

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'AGENT_STREAM_DONE', id: 's1' });
});

test('onToolCall dispatches TOOL_START with summary and truncated detail', () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const bridge = createAgentBridge(dispatch);

  const big = 'x'.repeat(300);
  bridge.onToolCall({ id: 't1', name: 'fetch', args: { big } });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'TOOL_START');
  assert.equal(events[0]?.id, 't1');
  assert.equal(events[0]?.name, 'fetch');
  assert.equal(events[0]?.summary, 'start fetch');
  assert.ok(typeof events[0]?.detail === 'string');
  assert.ok(events[0].detail.length <= 140);
});

test('onToolResult success dispatches TOOL_END with durationMs', () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const bridge = createAgentBridge(dispatch);

  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    bridge.onToolCall({ id: 't1', name: 'fetch', args: { q: 1 } });
    now = 1042;
    bridge.onToolResult({ id: 't1', name: 'fetch', success: true, summary: 'ok', result: 'done' });
  } finally {
    Date.now = originalNow;
  }

  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, 'TOOL_END');
  assert.equal(events[1]?.durationMs, 42);
  assert.equal(events[1]?.summary, 'ok');
  assert.equal(events[1]?.detail, 'done');
});

test('onToolResult failure dispatches TOOL_ERROR', () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const bridge = createAgentBridge(dispatch);

  bridge.onToolCall({ id: 't2', name: 'exec', args: {} });
  bridge.onToolResult({
    id: 't2',
    name: 'exec',
    success: false,
    summary: 'failed',
    result: 'boom',
  });

  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, 'TOOL_ERROR');
  assert.equal(events[1]?.id, 't2');
  assert.equal(events[1]?.name, 'exec');
  assert.equal(events[1]?.summary, 'failed');
  assert.equal(events[1]?.detail, 'boom');
});

test('onToolCall truncates large args detail', () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const bridge = createAgentBridge(dispatch);

  bridge.onToolCall({ id: 't3', name: 'long', args: { payload: 'y'.repeat(2000) } });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'TOOL_START');
  assert.ok(events[0].detail.length <= 140);
  assert.ok(events[0].detail.endsWith('…'));
});
