import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationBranch } from '../dist/agent/conversation-branch.js';

describe('ConversationBranch', () => {
  it('starts with no checkpoints', () => {
    const cb = new ConversationBranch();
    assert.equal(cb.depth, 0);
    assert.equal(cb.rollback(), null);
  });

  it('saves and restores checkpoints', () => {
    const cb = new ConversationBranch();
    cb.checkpoint(3, 'first turn');
    cb.checkpoint(7, 'second turn');
    assert.equal(cb.depth, 2);

    const cp = cb.rollback();
    assert.ok(cp);
    assert.equal(cp.messageCount, 7);
    assert.equal(cp.preview, 'second turn');
    assert.equal(cb.depth, 1);
  });

  it('list returns most recent first', () => {
    const cb = new ConversationBranch();
    cb.checkpoint(1, 'a');
    cb.checkpoint(3, 'b');
    cb.checkpoint(5, 'c');
    const list = cb.list();
    assert.equal(list.length, 3);
    assert.equal(list[0].preview, 'c');
    assert.equal(list[2].preview, 'a');
  });

  it('reset clears all checkpoints', () => {
    const cb = new ConversationBranch();
    cb.checkpoint(1, 'x');
    cb.checkpoint(2, 'y');
    cb.reset();
    assert.equal(cb.depth, 0);
    assert.equal(cb.rollback(), null);
  });

  it('respects maxCheckpoints limit', () => {
    const cb = new ConversationBranch(3);
    cb.checkpoint(1, 'a');
    cb.checkpoint(2, 'b');
    cb.checkpoint(3, 'c');
    cb.checkpoint(4, 'd'); // pushes 'a' out
    assert.equal(cb.depth, 3);
    const list = cb.list();
    assert.equal(list[2].preview, 'b'); // oldest remaining
  });

  it('truncates long previews', () => {
    const cb = new ConversationBranch();
    const long = 'x'.repeat(200);
    cb.checkpoint(1, long);
    const list = cb.list();
    assert.equal(list[0].preview.length, 100);
  });
});
