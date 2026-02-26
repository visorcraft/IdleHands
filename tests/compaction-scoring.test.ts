import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMessage, selectDropCandidates } from '../dist/agent/compaction-scoring.js';

describe('compaction scoring', () => {
  it('system messages score 100', () => {
    const s = scoreMessage({ role: 'system', content: 'you are helpful' }, 0, 10);
    assert.equal(s.score, 100);
    assert.ok(s.reason.includes('system'));
  });

  it('recent user messages score high', () => {
    const s = scoreMessage({ role: 'user', content: 'fix the bug' }, 9, 10);
    assert.ok(s.score > 80, `score ${s.score} should be > 80`);
  });

  it('old tool results score low', () => {
    const s = scoreMessage({ role: 'tool', content: '[read_file] some content...' }, 2, 20);
    assert.ok(s.score < 50, `score ${s.score} should be < 50`);
  });

  it('assistant with code scores higher', () => {
    const withCode = scoreMessage(
      { role: 'assistant', content: '```ts\nconst x = 1;\n```' },
      5, 10
    );
    const withoutCode = scoreMessage(
      { role: 'assistant', content: 'Sure, I can help.' },
      5, 10
    );
    assert.ok(withCode.score > withoutCode.score);
  });

  it('error tool results are kept', () => {
    const error = scoreMessage(
      { role: 'tool', content: 'ERROR: file not found' },
      3, 10
    );
    const normal = scoreMessage(
      { role: 'tool', content: 'file contents here' },
      3, 10
    );
    assert.ok(error.score > normal.score);
  });

  it('active file relevance boosts score', () => {
    const relevant = scoreMessage(
      { role: 'tool', content: 'read agent.ts line 1-50' },
      3, 10,
      { activeFiles: new Set(['/project/src/agent.ts']) }
    );
    const irrelevant = scoreMessage(
      { role: 'tool', content: 'read agent.ts line 1-50' },
      3, 10,
      { activeFiles: new Set(['/project/src/config.ts']) }
    );
    assert.ok(relevant.score > irrelevant.score);
  });
});

describe('selectDropCandidates', () => {
  it('selects lowest-scoring messages first', () => {
    const scored = [
      { index: 1, score: 10, reason: 'low' },
      { index: 2, score: 80, reason: 'high' },
      { index: 3, score: 30, reason: 'med' },
      { index: 4, score: 5, reason: 'lowest' },
    ];
    const drops = selectDropCandidates(scored, { minIndex: 1, maxIndex: 4, targetDrop: 2 });
    assert.deepEqual(drops, [4, 1]); // lowest scores first
  });

  it('respects minIndex/maxIndex bounds', () => {
    const scored = [
      { index: 0, score: 100, reason: 'system' },
      { index: 1, score: 10, reason: 'low' },
      { index: 5, score: 5, reason: 'lowest but protected' },
    ];
    const drops = selectDropCandidates(scored, { minIndex: 1, maxIndex: 4, targetDrop: 2 });
    assert.equal(drops.length, 1); // only index 1 is in range
    assert.equal(drops[0], 1);
  });
});
