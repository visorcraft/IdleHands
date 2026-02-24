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
  formatDuration,
  blockToPlainText,
  blocksToPlainText,
} from '../dist/bot/ux/renderer.js';

const base = {
  id: 'e1',
  timestamp: 1,
  sessionId: 's1',
  userId: 'u1',
  sequence: 1,
} as const;

test('format helpers match current renderer behavior', () => {
  assert.strictEqual(formatProgressBar(0), '[░░░░░░░░░░░░░░░░░░░░] 0%');
  assert.strictEqual(formatProgressBar(0.5, 2), '[█░] 50%');
  assert.strictEqual(formatDuration(1000), '1.0s');
  assert.strictEqual(formatDuration(65000), '1.1m');
});

test('blocksToPlainText preserves block separation', () => {
  const out = blocksToPlainText([
    { type: 'text', content: 'Hello' } as any,
    { type: 'text', content: ' ' } as any,
    { type: 'text', content: 'World' } as any,
  ]);
  assert.strictEqual(out, 'Hello\n\n \n\nWorld');
});

test('renderACK returns message block array', () => {
  const blocks = renderACK({ ...base, category: 'ACK', message: 'Task started' } as any);
  assert.strictEqual((blocks[0] as any).type, 'message');
  assert.strictEqual((blocks[0] as any).category, 'ACK');
});

test('renderPROGRESS includes progress block when progress exists', () => {
  const blocks = renderPROGRESS({ ...base, category: 'PROGRESS', message: 'Processing', progress: 0.5 } as any);
  assert.ok(blocks.some((b: any) => b.type === 'progress'));
  assert.strictEqual((blocks[0] as any).type, 'progress');
});

test('renderWARNING/renderERROR/renderRESULT message-first', () => {
  assert.strictEqual((renderWARNING({ ...base, category: 'WARNING', message: 'warn' } as any)[0] as any).type, 'message');
  assert.strictEqual((renderERROR({ ...base, category: 'ERROR', message: 'err' } as any)[0] as any).type, 'message');
  assert.strictEqual((renderRESULT({ ...base, category: 'RESULT', summary: 'ok' } as any)[0] as any).type, 'message');
});

test('renderACTIONS emits action block with actions list', () => {
  const blocks = renderACTIONS({
    ...base,
    category: 'ACTIONS',
    message: 'Choose',
    actions: [{ id: 'a1', label: 'Retry' }],
  } as any);
  const actionBlock = blocks.find((b: any) => b.type === 'actions') as any;
  assert.ok(actionBlock);
  assert.strictEqual((actionBlock.actions || []).length, 1);
});

test('renderEvent dispatches to category renderer', () => {
  assert.strictEqual((renderEvent({ ...base, category: 'ACK', message: 'a' } as any)[0] as any).category, 'ACK');
  assert.ok(renderEvent({ ...base, category: 'PROGRESS', message: 'p', progress: 0.2 } as any).some((b: any) => b.type === 'progress'));
  assert.strictEqual((renderEvent({ ...base, category: 'ACTIONS', actions: [] } as any)[0] as any).type, 'actions');
});

test('blockToPlainText supports message/progress/actions blocks', () => {
  const msg = blockToPlainText(renderACK({ ...base, category: 'ACK', message: 'hello' } as any)[0] as any);
  assert.ok(msg.includes('hello'));
  assert.ok(blockToPlainText({ type: 'progress', progress: 0.5, message: 'Doing' } as any).includes('50%'));
  assert.ok(blockToPlainText({ type: 'actions', actions: [{ label: 'Retry' }] } as any).includes('Retry'));
});
