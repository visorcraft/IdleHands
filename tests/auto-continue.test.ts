import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isToolLoopBreak, formatAutoContinueNotice, AUTO_CONTINUE_PROMPT } from '../dist/bot/auto-continue.js';

describe('auto-continue', () => {
  describe('isToolLoopBreak', () => {
    it('detects AgentLoopBreak by name', () => {
      const err = new Error('something went wrong');
      err.name = 'AgentLoopBreak';
      assert.equal(isToolLoopBreak(err), true);
    });

    it('detects tool-loop in message', () => {
      const err = new Error('critical tool-loop persisted after one tools-disabled recovery turn');
      assert.equal(isToolLoopBreak(err), true);
    });

    it('rejects non-tool-loop errors', () => {
      assert.equal(isToolLoopBreak(new Error('ECONNREFUSED')), false);
      assert.equal(isToolLoopBreak(new Error('AbortError')), false);
      assert.equal(isToolLoopBreak(null), false);
      assert.equal(isToolLoopBreak(undefined), false);
    });
  });

  describe('formatAutoContinueNotice', () => {
    it('includes retry count', () => {
      const notice = formatAutoContinueNotice('loop detected', 2, 5);
      assert.ok(notice.includes('retry 2 of 5'));
      assert.ok(notice.includes('loop detected'));
    });

    it('truncates long error messages', () => {
      const longMsg = 'x'.repeat(300);
      const notice = formatAutoContinueNotice(longMsg, 1, 5);
      assert.ok(notice.length < 400);
      assert.ok(notice.includes('...'));
    });
  });

  describe('AUTO_CONTINUE_PROMPT', () => {
    it('is a non-empty string', () => {
      assert.ok(AUTO_CONTINUE_PROMPT.length > 0);
      assert.ok(AUTO_CONTINUE_PROMPT.includes('Continue'));
    });
  });
});
