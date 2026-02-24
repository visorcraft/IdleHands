import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  renderACK,
  renderPROGRESS,
  renderWARNING,
  renderERROR,
  renderRESULT,
  renderACTIONS,
  renderEvent,
  formatProgressBar,
  formatTimestamp,
  formatDuration,
  blockToPlainText,
  blocksToPlainText,
} from '../dist/bot/ux/renderer.js';

import {
  createACKEvent,
  createPROGRESSEvent,
  createWARNINGEvent,
  createERROREvent,
  createRESULTEvent,
  createACTIONSEvent,
} from '../dist/bot/ux/events.js';

// ============================================================================
// formatProgressBar Tests
// ============================================================================

test('formatProgressBar returns empty string for progress 0.0', () => {
  const result = formatProgressBar(0.0);
  assert.strictEqual(result, '[────────────────────] 0%');
});

test('formatProgressBar returns filled bar for progress 1.0', () => {
  const result = formatProgressBar(1.0);
  assert.strictEqual(result, '[████████████████████] 100%');
});

test('formatProgressBar returns half-filled bar for progress 0.5', () => {
  const result = formatProgressBar(0.5);
  assert.strictEqual(result, '[██████████░░░░░░░░░░] 50%');
});

test('formatProgressBar supports custom width', () => {
  const result = formatProgressBar(0.5, 10);
  assert.strictEqual(result, '[█████░░░░░] 50%');
});

test('formatProgressBar handles edge case 0.0 with custom width', () => {
  const result = formatProgressBar(0.0, 5);
  assert.strictEqual(result, '[░░░░░] 0%');
});

test('formatProgressBar handles edge case 1.0 with custom width', () => {
  const result = formatProgressBar(1.0, 5);
  assert.strictEqual(result, '[█████] 100%');
});

test('formatProgressBar handles small width', () => {
  const result = formatProgressBar(0.5, 2);
  assert.strictEqual(result, '[░] 50%');
});

test('formatProgressBar handles large width', () => {
  const result = formatProgressBar(0.5, 50);
  assert.ok(result.includes('[████████████████████'));
  assert.ok(result.includes('50%'));
});

// ============================================================================
// formatTimestamp Tests
// ============================================================================

test('formatTimestamp returns ISO format string', () => {
  const timestamp = 1700000000000;
  const result = formatTimestamp(timestamp);

  assert.ok(result);
  assert.ok(result.includes('2023'));
});

test('formatTimestamp handles current time', () => {
  const now = Date.now();
  const result = formatTimestamp(now);

  assert.ok(result);
  assert.ok(result.length > 0);
});

// ============================================================================
// formatDuration Tests
// ============================================================================

test('formatDuration formats milliseconds under 1000', () => {
  assert.strictEqual(formatDuration(500), '500ms');
  assert.strictEqual(formatDuration(1), '1ms');
  assert.strictEqual(formatDuration(999), '999ms');
});

test('formatDuration formats seconds', () => {
  assert.strictEqual(formatDuration(1000), '1s');
  assert.strictEqual(formatDuration(5000), '5s');
  assert.strictEqual(formatDuration(60000), '60s');
});

test('formatDuration formats minutes and seconds', () => {
  assert.strictEqual(formatDuration(65000), '1m 5s');
  assert.strictEqual(formatDuration(125000), '2m 5s');
});

test('formatDuration formats hours, minutes, seconds', () => {
  assert.strictEqual(formatDuration(3600000), '1h');
  assert.strictEqual(formatDuration(3665000), '1h 1m 5s');
});

test('formatDuration handles zero', () => {
  assert.strictEqual(formatDuration(0), '0ms');
});

// ============================================================================
// blockToPlainText Tests
// ============================================================================

test('blockToPlainText extracts text from text block', () => {
  const block = {
    type: 'text',
    content: 'Hello World',
  };

  const result = blockToPlainText(block);
  assert.strictEqual(result, 'Hello World');
});

test('blockToPlainText handles text block with formatting', () => {
  const block = {
    type: 'text',
    content: 'Bold Text',
    format: { bold: true },
  };

  const result = blockToPlainText(block);
  assert.strictEqual(result, 'Bold Text');
});

test('blockToPlainText handles empty content', () => {
  const block = {
    type: 'text',
    content: '',
  };

  const result = blockToPlainText(block);
  assert.strictEqual(result, '');
});

// ============================================================================
// blocksToPlainText Tests
// ============================================================================

test('blocksToPlainText concatenates multiple blocks', () => {
  const blocks = [
    { type: 'text', content: 'Hello' },
    { type: 'text', content: ' ' },
    { type: 'text', content: 'World' },
  ];

  const result = blocksToPlainText(blocks);
  assert.strictEqual(result, 'Hello World');
});

test('blocksToPlainText handles empty array', () => {
  const result = blocksToPlainText([]);
  assert.strictEqual(result, '');
});

test('blocksToPlainText handles single block', () => {
  const blocks = [{ type: 'text', content: 'Single' }];

  const result = blocksToPlainText(blocks);
  assert.strictEqual(result, 'Single');
});

// ============================================================================
// renderACK Tests
// ============================================================================

test('renderACK creates message block with bold text', () => {
  const event = createACKEvent({ message: 'Task started' });
  const result = renderACK(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'ACK');
  assert.ok(Array.isArray(result.content));
  assert.strictEqual(result.content.length, 1);
  assert.strictEqual(result.content[0].type, 'text');
  assert.strictEqual(result.content[0].content, 'Task started');
  assert.strictEqual(result.content[0].format?.bold, true);
});

test('renderACK includes optional estimatedDurationSec', () => {
  const event = createACKEvent({
    message: 'Task started',
    estimatedDurationSec: 30,
  });
  const result = renderACK(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'ACK');
});

test('renderACK includes optional model', () => {
  const event = createACKEvent({
    message: 'Task started',
    model: 'gpt-4',
  });
  const result = renderACK(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'ACK');
});

// ============================================================================
// renderPROGRESS Tests
// ============================================================================

test('renderPROGRESS creates progress block when progress present', () => {
  const event = createPROGRESSEvent({
    message: 'Processing...',
    progress: 0.5,
  });
  const result = renderPROGRESS(event);

  assert.strictEqual(result.type, 'progress');
  assert.strictEqual(result.progress, 0.5);
  assert.strictEqual(result.message, 'Processing...');
});

test('renderPROGRESS includes optional phase', () => {
  const event = createPROGRESSEvent({
    message: 'Processing...',
    progress: 0.5,
    phase: 'compilation',
  });
  const result = renderPROGRESS(event);

  assert.strictEqual(result.phase, 'compilation');
});

test('renderPROGRESS handles progress 0.0', () => {
  const event = createPROGRESSEvent({
    message: 'Starting...',
    progress: 0.0,
  });
  const result = renderPROGRESS(event);

  assert.strictEqual(result.progress, 0.0);
});

test('renderPROGRESS handles progress 1.0', () => {
  const event = createPROGRESSEvent({
    message: 'Done!',
    progress: 1.0,
  });
  const result = renderPROGRESS(event);

  assert.strictEqual(result.progress, 1.0);
});

// ============================================================================
// renderWARNING Tests
// ============================================================================

test('renderWARNING creates message block with warning content', () => {
  const event = createWARNINGEvent({ message: 'Low disk space' });
  const result = renderWARNING(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'WARNING');
  assert.ok(Array.isArray(result.content));
  assert.strictEqual(result.content[0].type, 'text');
  assert.strictEqual(result.content[0].content, 'Low disk space');
});

test('renderWARNING includes optional code', () => {
  const event = createWARNINGEvent({
    message: 'Low disk space',
    code: 'DISK_SPACE',
  });
  const result = renderWARNING(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'WARNING');
});

test('renderWARNING includes optional hint', () => {
  const event = createWARNINGEvent({
    message: 'Low disk space',
    hint: 'Free up some space',
  });
  const result = renderWARNING(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'WARNING');
});

// ============================================================================
// renderERROR Tests
// ============================================================================

test('renderERROR creates message block with error content', () => {
  const event = createERROREvent({ message: 'Connection failed' });
  const result = renderERROR(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'ERROR');
  assert.ok(Array.isArray(result.content));
  assert.strictEqual(result.content[0].type, 'text');
  assert.strictEqual(result.content[0].content, 'Connection failed');
});

test('renderERROR includes optional code', () => {
  const event = createERROREvent({
    message: 'Connection failed',
    code: 'NET_ERR',
  });
  const result = renderERROR(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'ERROR');
});

test('renderERROR includes optional details', () => {
  const event = createERROREvent({
    message: 'Connection failed',
    details: 'Timeout after 30s',
  });
  const result = renderERROR(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'ERROR');
});

test('renderERROR includes optional retryable flag', () => {
  const event = createERROREvent({
    message: 'Connection failed',
    retryable: true,
  });
  const result = renderERROR(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'ERROR');
});

test('renderERROR includes optional guidance', () => {
  const event = createERROREvent({
    message: 'Connection failed',
    guidance: 'Check your network',
  });
  const result = renderERROR(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'ERROR');
});

// ============================================================================
// renderRESULT Tests
// ============================================================================

test('renderRESULT creates message block with result content', () => {
  const event = createRESULTEvent({ message: 'Task completed' });
  const result = renderRESULT(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'RESULT');
  assert.ok(Array.isArray(result.content));
  assert.strictEqual(result.content[0].type, 'text');
  assert.strictEqual(result.content[0].content, 'Task completed');
});

test('renderRESULT includes optional data', () => {
  const event = createRESULTEvent({
    message: 'Task completed',
    data: { result: 'success' },
  });
  const result = renderRESULT(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'RESULT');
});

test('renderRESULT includes optional success flag', () => {
  const event = createRESULTEvent({
    message: 'Task completed',
    success: true,
  });
  const result = renderRESULT(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'RESULT');
});

test('renderRESULT includes optional stats', () => {
  const stats = {
    tokensUsed: 1234,
    promptTokens: 1000,
    completionTokens: 234,
    durationMs: 5000,
  };

  const event = createRESULTEvent({
    message: 'Task completed',
    stats,
  });
  const result = renderRESULT(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'RESULT');
});

// ============================================================================
// renderACTIONS Tests
// ============================================================================

test('renderACTIONS creates action block with actions array', () => {
  const actions = [
    { label: 'Retry', action: 'retry' },
    { label: 'Cancel', action: 'cancel' },
  ];

  const event = createACTIONSEvent({ message: 'Choose an action', actions });
  const result = renderACTIONS(event);

  assert.strictEqual(result.type, 'actions');
  assert.strictEqual(result.message, 'Choose an action');
  assert.deepStrictEqual(result.actions, actions);
});

test('renderACTIONS handles empty actions array', () => {
  const event = createACTIONSEvent({ message: 'No actions', actions: [] });
  const result = renderACTIONS(event);

  assert.strictEqual(result.type, 'actions');
  assert.deepStrictEqual(result.actions, []);
});

// ============================================================================
// renderEvent Tests
// ============================================================================

test('renderEvent calls correct renderer for ACK', () => {
  const event = createACKEvent({ message: 'Ack' });
  const result = renderEvent(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'ACK');
});

test('renderEvent calls correct renderer for PROGRESS', () => {
  const event = createPROGRESSEvent({ message: 'Progress', progress: 0.5 });
  const result = renderEvent(event);

  assert.strictEqual(result.type, 'progress');
  assert.strictEqual(result.progress, 0.5);
});

test('renderEvent calls correct renderer for WARNING', () => {
  const event = createWARNINGEvent({ message: 'Warning' });
  const result = renderEvent(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'WARNING');
});

test('renderEvent calls correct renderer for ERROR', () => {
  const event = createERROREvent({ message: 'Error' });
  const result = renderEvent(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'ERROR');
});

test('renderEvent calls correct renderer for RESULT', () => {
  const event = createRESULTEvent({ message: 'Result' });
  const result = renderEvent(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'RESULT');
});

test('renderEvent calls correct renderer for ACTIONS', () => {
  const event = createACTIONSEvent({ message: 'Actions', actions: [] });
  const result = renderEvent(event);

  assert.strictEqual(result.type, 'actions');
});

// ============================================================================
// Edge Cases
// ============================================================================

test('renderPROGRESS handles missing progress value', () => {
  const event = createPROGRESSEvent({ message: 'Processing...' });
  const result = renderPROGRESS(event);

  assert.strictEqual(result.type, 'progress');
  assert.strictEqual(result.progress, undefined);
});

test('renderACK handles empty message', () => {
  const event = createACKEvent({ message: '' });
  const result = renderACK(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'ACK');
});

test('renderWARNING handles empty optional fields', () => {
  const event = createWARNINGEvent({ message: 'Test', code: '', hint: '' });
  const result = renderWARNING(event);

  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.category, 'WARNING');
});