import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, semanticRerank } from '../dist/agent/semantic-search.js';

describe('tokenize', () => {
  it('lowercases and splits', () => {
    const tokens = tokenize('Hello World Test');
    assert.ok((tokens).includes('hello'));
    assert.ok((tokens).includes('world'));
    assert.ok((tokens).includes('test'));
  });

  it('removes stop words', () => {
    const tokens = tokenize('the quick brown fox jumps over the lazy dog');
    assert.ok(!((tokens).includes('the')));
    assert.ok(!((tokens).includes('is')));
    assert.ok((tokens).includes('quick'));
    assert.ok((tokens).includes('brown'));
    assert.ok((tokens).includes('fox'));
  });

  it('removes short tokens', () => {
    const tokens = tokenize('a b c hello');
    assert.ok(!((tokens).includes('a')));
    assert.ok(!((tokens).includes('b')));
    assert.ok((tokens).includes('hello'));
  });

  it('returns unique tokens', () => {
    const tokens = tokenize('hello hello hello world');
    assert.strictEqual((tokens.filter((t) => t === 'hello')).length, 1);
  });

  it('handles code-like text', () => {
    const tokens = tokenize('function_name snake_case camelCase');
    assert.ok((tokens).includes('function_name'));
    assert.ok((tokens).includes('snake_case'));
  });
});

describe('semanticRerank', () => {
  it('returns empty for empty results', () => {
    assert.strictEqual((semanticRerank('query', [])).length, 0);
  });

  it('ranks exact matches higher', () => {
    const results = [
      { item: 'A', text: 'something about cats and dogs' },
      { item: 'B', text: 'websocket connection timeout after 30 seconds idle' },
      { item: 'C', text: 'random unrelated content about cooking' },
    ];

    const ranked = semanticRerank('websocket timeout bug', results);
    assert.strictEqual(ranked[0].item, 'B');
    assert.ok((ranked[0].semanticScore) > (0));
  });

  it('respects limit', () => {
    const results = [
      { item: 'A', text: 'text one' },
      { item: 'B', text: 'text two' },
      { item: 'C', text: 'text three' },
    ];
    const ranked = semanticRerank('text', results, { limit: 2 });
    assert.strictEqual((ranked).length, 2);
  });

  it('blends original scores with semantic scores', () => {
    const results = [
      { item: 'A', text: 'relevant keywords match here', originalScore: -1 },
      { item: 'B', text: 'completely unrelated gibberish xyz', originalScore: -0.5 },
    ];
    const ranked = semanticRerank('relevant keywords match', results, { semanticWeight: 0.8 });
    assert.strictEqual(ranked[0].item, 'A');
  });

  it('semantic scores are between 0 and 1', () => {
    const results = [
      { item: 'A', text: 'hello world programming code' },
    ];
    const ranked = semanticRerank('hello world', results);
    assert.ok((ranked[0].semanticScore) >= (0));
    assert.ok((ranked[0].semanticScore) <= (1));
  });

  it('handles identical query and document', () => {
    const query = 'websocket timeout debugging';
    const results = [{ item: 'A', text: query }];
    const ranked = semanticRerank(query, results);
    assert.ok(Math.abs((ranked[0].semanticScore) - (1)) < Math.pow(10, -(1)));
  });
});
