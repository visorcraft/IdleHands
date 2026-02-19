import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVimState, handleVimKeypress, type VimState } from '../dist/vim.js';

// Minimal readline stub for testing cursor/line manipulation
function createMockRl() {
  const rl: any = {
    line: '',
    cursor: 0,
    _refreshLine: () => {},
    write: (data: any, opts?: any) => {
      if (data === null && opts?.ctrl && opts?.name === 'u') {
        // Ctrl+U: clear line
        rl.line = '';
        rl.cursor = 0;
      } else if (typeof data === 'string') {
        rl.line += data;
        rl.cursor = rl.line.length;
      }
    },
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
    // After x: line should be 'hllo' (e deleted at pos 1)
    assert.equal(rl.line, 'hllo');
  });

  it('dd yanks and clears the line', () => {
    state.mode = 'normal';
    rl.line = 'hello world';
    rl.cursor = 3;
    handleVimKeypress(state, rl, 'd', {});
    assert.equal(state.pendingKey, 'd');
    handleVimKeypress(state, rl, 'd', {});
    assert.equal(state.yankBuffer, 'hello world');
    assert.equal(rl.line, '');
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
    assert.ok(rl.line.includes('XY'));
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
