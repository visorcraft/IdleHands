import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { createVimState, handleVimKeypress, type VimState } from '../dist/vim.js';

// Minimal readline stub — setLine now mutates .line/.cursor directly
function createMockRl() {
  const rl: any = {
    line: '',
    cursor: 0,
    _refreshLine: () => {},
  };
  return rl;
}

describe('vim mode', () => {
  let state: VimState;
  let rl: any;

  beforeEach(() => {
    state = createVimState();
    rl = createMockRl();
  });

  it('starts in insert mode', () => {
    assert.equal(state.mode, 'insert');
  });

  it('Escape switches to normal mode', () => {
    const consumed = handleVimKeypress(state, rl, undefined, { name: 'escape' });
    assert.equal(consumed, true);
    assert.equal(state.mode, 'normal');
  });

  it('passes keys through in insert mode', () => {
    state.mode = 'insert';
    const consumed = handleVimKeypress(state, rl, 'a', { name: 'a' });
    assert.equal(consumed, false);
  });

  it('i switches from normal to insert mode', () => {
    state.mode = 'normal';
    rl.line = 'hello';
    rl.cursor = 2;
    const consumed = handleVimKeypress(state, rl, 'i', {});
    assert.equal(consumed, true);
    assert.equal(state.mode, 'insert');
  });

  it('a switches to insert mode and moves cursor right', () => {
    state.mode = 'normal';
    rl.line = 'hello';
    rl.cursor = 2;
    handleVimKeypress(state, rl, 'a', {});
    assert.equal(state.mode, 'insert');
    assert.equal(rl.cursor, 3);
  });

  it('A switches to insert mode at end of line', () => {
    state.mode = 'normal';
    rl.line = 'hello';
    rl.cursor = 1;
    handleVimKeypress(state, rl, 'A', {});
    assert.equal(state.mode, 'insert');
    assert.equal(rl.cursor, 5);
  });

  it('0 moves cursor to beginning', () => {
    state.mode = 'normal';
    rl.line = 'hello world';
    rl.cursor = 5;
    handleVimKeypress(state, rl, '0', {});
    assert.equal(rl.cursor, 0);
  });

  it('$ moves cursor to end', () => {
    state.mode = 'normal';
    rl.line = 'hello world';
    rl.cursor = 2;
    handleVimKeypress(state, rl, '$', {});
    assert.equal(rl.cursor, 11);
  });

  it('x deletes character under cursor', () => {
    state.mode = 'normal';
    rl.line = 'hello';
    rl.cursor = 1;
    handleVimKeypress(state, rl, 'x', {});
    assert.equal(rl.line, 'hllo');
    assert.equal(rl.cursor, 1);
  });

  it('x at last character moves cursor back', () => {
    state.mode = 'normal';
    rl.line = 'hello';
    rl.cursor = 4; // on 'o'
    handleVimKeypress(state, rl, 'x', {});
    assert.equal(rl.line, 'hell');
    // vi moves cursor to last char of remaining line
    assert.equal(rl.cursor, 3);
  });

  it('x on single-char line results in empty line with cursor at 0', () => {
    state.mode = 'normal';
    rl.line = 'a';
    rl.cursor = 0;
    handleVimKeypress(state, rl, 'x', {});
    assert.equal(rl.line, '');
    assert.equal(rl.cursor, 0);
  });

  it('dd yanks and clears the line with cursor at 0', () => {
    state.mode = 'normal';
    rl.line = 'hello world';
    rl.cursor = 3;
    handleVimKeypress(state, rl, 'd', {});
    assert.equal(state.pendingKey, 'd');
    handleVimKeypress(state, rl, 'd', {});
    assert.equal(state.yankBuffer, 'hello world');
    assert.equal(rl.line, '');
    assert.equal(rl.cursor, 0);
  });

  it('yy yanks line without clearing', () => {
    state.mode = 'normal';
    rl.line = 'test line';
    handleVimKeypress(state, rl, 'y', {});
    handleVimKeypress(state, rl, 'y', {});
    assert.equal(state.yankBuffer, 'test line');
    assert.equal(rl.line, 'test line');
  });

  it('p pastes yank buffer after cursor', () => {
    state.mode = 'normal';
    rl.line = 'ab';
    rl.cursor = 0;
    state.yankBuffer = 'XY';
    handleVimKeypress(state, rl, 'p', {});
    assert.equal(rl.line, 'aXYb');
    // Cursor lands on last pasted char (position 2, the 'Y')
    assert.equal(rl.cursor, 2);
  });

  it('p with empty yank buffer does nothing', () => {
    state.mode = 'normal';
    rl.line = 'ab';
    rl.cursor = 0;
    state.yankBuffer = '';
    handleVimKeypress(state, rl, 'p', {});
    assert.equal(rl.line, 'ab');
    assert.equal(rl.cursor, 0);
  });

  it('h moves cursor left', () => {
    state.mode = 'normal';
    rl.line = 'abc';
    rl.cursor = 2;
    handleVimKeypress(state, rl, 'h', {});
    assert.equal(rl.cursor, 1);
  });

  it('h does not go below 0', () => {
    state.mode = 'normal';
    rl.line = 'abc';
    rl.cursor = 0;
    handleVimKeypress(state, rl, 'h', {});
    assert.equal(rl.cursor, 0);
  });

  it('l moves cursor right', () => {
    state.mode = 'normal';
    rl.line = 'abc';
    rl.cursor = 1;
    handleVimKeypress(state, rl, 'l', {});
    assert.equal(rl.cursor, 2);
  });

  it('unknown normal-mode keys are consumed silently', () => {
    state.mode = 'normal';
    const consumed = handleVimKeypress(state, rl, 'z', {});
    assert.equal(consumed, true);
  });

  it('Escape in insert mode returns to normal', () => {
    state.mode = 'insert';
    const consumed = handleVimKeypress(state, rl, undefined, { name: 'escape' });
    assert.equal(consumed, true);
    assert.equal(state.mode, 'normal');
  });
});
