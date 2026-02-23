import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialTuiState, reduceTuiState } from '../../dist/tui/state.js';
import '../../dist/tui/events.js';

test('full streaming cycle updates stream state and transcript', () => {
  let s = createInitialTuiState();

  s = reduceTuiState(s, { type: 'AGENT_STREAM_START', id: 'stream-1' });
  assert.equal(s.isStreaming, true);
  assert.equal(s.streamTargetId, 'stream-1');
  assert.equal(s.transcript.length, 1);
  assert.equal(s.transcript[0]?.role, 'assistant_streaming');
  assert.equal(s.transcript[0]?.text, '');

  s = reduceTuiState(s, { type: 'AGENT_STREAM_TOKEN', id: 'stream-1', token: 'Hello' });
  assert.equal(s.transcript[0]?.text, 'Hello');

  s = reduceTuiState(s, { type: 'AGENT_STREAM_TOKEN', id: 'stream-1', token: ', world' });
  assert.equal(s.transcript[0]?.text, 'Hello, world');

  s = reduceTuiState(s, { type: 'AGENT_STREAM_DONE', id: 'stream-1' });
  assert.equal(s.isStreaming, false);
  assert.equal(s.streamTargetId, undefined);
  assert.equal(s.transcript[0]?.role, 'assistant');
  assert.equal(s.transcript[0]?.text, 'Hello, world');
});

test('tool events during streaming do not interrupt streaming state', () => {
  let s = createInitialTuiState();

  s = reduceTuiState(s, { type: 'AGENT_STREAM_START', id: 'stream-1' });
  s = reduceTuiState(s, { type: 'AGENT_STREAM_TOKEN', id: 'stream-1', token: 'partial' });
  s = reduceTuiState(s, {
    type: 'TOOL_START',
    id: 'tool-1',
    name: 'exec',
    summary: 'run',
    detail: 'npm test',
  });

  assert.equal(s.isStreaming, true);
  assert.equal(s.streamTargetId, 'stream-1');
  assert.equal(s.transcript.find((item) => item.id === 'stream-1')?.text, 'partial');
  assert.equal(s.toolEvents.length, 1);
  assert.equal(s.toolEvents[0]?.phase, 'start');
});

test('stream done after partial tokens preserves text and finalizes role', () => {
  let s = createInitialTuiState();

  s = reduceTuiState(s, { type: 'AGENT_STREAM_START', id: 'stream-1' });
  s = reduceTuiState(s, { type: 'AGENT_STREAM_TOKEN', id: 'stream-1', token: 'partial text' });
  s = reduceTuiState(s, { type: 'AGENT_STREAM_DONE', id: 'stream-1' });

  const item = s.transcript.find((t) => t.id === 'stream-1');
  assert.ok(item);
  assert.equal(item?.text, 'partial text');
  assert.equal(item?.role, 'assistant');
  assert.equal(s.isStreaming, false);
});

test('empty stream still creates transcript item', () => {
  let s = createInitialTuiState();

  s = reduceTuiState(s, { type: 'AGENT_STREAM_START', id: 'stream-empty' });
  s = reduceTuiState(s, { type: 'AGENT_STREAM_DONE', id: 'stream-empty' });

  const item = s.transcript.find((t) => t.id === 'stream-empty');
  assert.ok(item);
  assert.equal(item?.text, '');
  assert.equal(item?.role, 'assistant');
});

test('multiple sequential streams preserve prior transcript and append new items', () => {
  let s = createInitialTuiState();

  s = reduceTuiState(s, { type: 'AGENT_STREAM_START', id: 's1' });
  s = reduceTuiState(s, { type: 'AGENT_STREAM_TOKEN', id: 's1', token: 'first' });
  s = reduceTuiState(s, { type: 'AGENT_STREAM_DONE', id: 's1' });

  s = reduceTuiState(s, { type: 'AGENT_STREAM_START', id: 's2' });
  s = reduceTuiState(s, { type: 'AGENT_STREAM_TOKEN', id: 's2', token: 'second' });
  s = reduceTuiState(s, { type: 'AGENT_STREAM_DONE', id: 's2' });

  assert.equal(s.transcript.length, 2);
  assert.deepEqual(
    s.transcript.map((t) => ({ id: t.id, role: t.role, text: t.text })),
    [
      { id: 's1', role: 'assistant', text: 'first' },
      { id: 's2', role: 'assistant', text: 'second' },
    ]
  );
});

test('token for non-existent stream id leaves transcript unchanged', () => {
  let s = createInitialTuiState();
  s = reduceTuiState(s, { type: 'AGENT_STREAM_START', id: 's1' });

  const beforeTranscript = s.transcript;
  const beforeText = s.transcript[0]?.text;

  s = reduceTuiState(s, { type: 'AGENT_STREAM_TOKEN', id: 'missing', token: 'ignored' });

  assert.equal(s.transcript[0]?.text, beforeText);
  assert.deepEqual(s.transcript, beforeTranscript);
});

test('user input submit interleaved during streaming appends user transcript and keeps streaming state', () => {
  let s = createInitialTuiState();

  s = reduceTuiState(s, { type: 'AGENT_STREAM_START', id: 'stream-1' });
  s = reduceTuiState(s, { type: 'AGENT_STREAM_TOKEN', id: 'stream-1', token: 'hello' });

  s = reduceTuiState(s, { type: 'USER_INPUT_SUBMIT', text: 'user asks question' });

  assert.equal(s.isStreaming, true);
  assert.equal(s.streamTargetId, 'stream-1');
  assert.equal(s.transcript.length, 2);
  assert.equal(s.transcript[0]?.id, 'stream-1');
  assert.equal(s.transcript[0]?.role, 'assistant_streaming');
  assert.equal(s.transcript[0]?.text, 'hello');
  assert.equal(s.transcript[1]?.role, 'user');
  assert.equal(s.transcript[1]?.text, 'user asks question');
});
