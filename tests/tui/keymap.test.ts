import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeRawInput, resolveAction } from '../../dist/tui/keymap.js';

test('keymap resolves core actions', () => {
  assert.equal(resolveAction('enter'), 'send');
  assert.equal(resolveAction('C-c'), 'cancel');
  assert.equal(resolveAction('C-d'), 'quit');
  assert.equal(resolveAction('tab'), 'tab_complete');
  assert.equal(resolveAction('C-g'), 'open_step_navigator');
  assert.equal(resolveAction('C-o'), 'open_settings');
  assert.equal(resolveAction('up'), 'history_prev');
  assert.equal(resolveAction('down'), 'history_next');
  assert.equal(resolveAction('unknown'), null);
});

test('decodeRawInput maps arrow keys and text', () => {
  assert.deepEqual(decodeRawInput('\u001b[A\u001b[Bx'), ['up', 'down', 'text:x']);
});

// TODO(src): decodeRawInput currently does not handle CSI 5~/6~ sequences.
test('decodeRawInput maps PageUp/PageDown', () => {
  assert.deepEqual(decodeRawInput('\u001b[5~'), ['pageup']);
  assert.deepEqual(decodeRawInput('\u001b[6~'), ['pagedown']);
});

test('decodeRawInput maps Ctrl+J to C-j', () => {
  assert.deepEqual(decodeRawInput('\n'), ['C-j']);
});

test('decodeRawInput maps Ctrl+G/Ctrl+O', () => {
  assert.deepEqual(decodeRawInput('\u0007\u000f'), ['C-g', 'C-o']);
});

test('decodeRawInput maps Alt+Enter to M-enter', () => {
  assert.deepEqual(decodeRawInput('\u001b\r'), ['M-enter']);
});

test('decodeRawInput decodes multiple keys in one chunk', () => {
  assert.deepEqual(decodeRawInput('abc'), ['text:a', 'text:b', 'text:c']);
});

test('decodeRawInput maps DEL (0x7f) to backspace', () => {
  assert.deepEqual(decodeRawInput('\u007f'), ['backspace']);
});

test('decodeRawInput drops unknown escape prefix without crashing', () => {
  assert.doesNotThrow(() => decodeRawInput('\u001b[9~'));
  // Unknown CSI ~-terminated sequences are consumed silently, only trailing text survives
  assert.deepEqual(decodeRawInput('\u001b[9~x'), ['text:x']);
});

test('resolveAction returns null for unknown keys', () => {
  assert.equal(resolveAction('definitely-unknown-key'), null);
});

test('decodeRawInput maps standalone escape', () => {
  assert.deepEqual(decodeRawInput('\u001b'), ['esc']);
  assert.equal(resolveAction('esc'), 'cancel');
});
