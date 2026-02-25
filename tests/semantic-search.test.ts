import { describe, it, expect } from 'vitest';
import { tokenize, semanticRerank } from '../src/agent/semantic-search.js';

describe('tokenize', () => {
  it('lowercases and splits', () => {
    const tokens = tokenize('Hello World Test');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).toContain('test');
  });

  it('removes stop words', () => {
    const tokens = tokenize('the quick brown fox jumps over the lazy dog');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('is');
    expect(tokens).toContain('quick');
    expect(tokens).toContain('brown');
    expect(tokens).toContain('fox');
  });

  it('removes short tokens', () => {
    const tokens = tokenize('a b c hello');
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('b');
    expect(tokens).toContain('hello');
  });

  it('returns unique tokens', () => {
    const tokens = tokenize('hello hello hello world');
    expect(tokens.filter((t) => t === 'hello')).toHaveLength(1);
  });

  it('handles code-like text', () => {
    const tokens = tokenize('function_name snake_case camelCase');
    expect(tokens).toContain('function_name');
    expect(tokens).toContain('snake_case');
  });
});

describe('semanticRerank', () => {
  it('returns empty for empty results', () => {
    expect(semanticRerank('query', [])).toHaveLength(0);
  });

  it('ranks exact matches higher', () => {
    const results = [
      { item: 'A', text: 'something about cats and dogs' },
      { item: 'B', text: 'websocket connection timeout after 30 seconds idle' },
      { item: 'C', text: 'random unrelated content about cooking' },
    ];

    const ranked = semanticRerank('websocket timeout bug', results);
    expect(ranked[0].item).toBe('B');
    expect(ranked[0].semanticScore).toBeGreaterThan(0);
  });

  it('respects limit', () => {
    const results = [
      { item: 'A', text: 'text one' },
      { item: 'B', text: 'text two' },
      { item: 'C', text: 'text three' },
    ];
    const ranked = semanticRerank('text', results, { limit: 2 });
    expect(ranked).toHaveLength(2);
  });

  it('blends original scores with semantic scores', () => {
    const results = [
      { item: 'A', text: 'relevant keywords match here', originalScore: -1 },
      { item: 'B', text: 'completely unrelated gibberish xyz', originalScore: -0.5 },
    ];
    const ranked = semanticRerank('relevant keywords match', results, { semanticWeight: 0.8 });
    expect(ranked[0].item).toBe('A');
  });

  it('semantic scores are between 0 and 1', () => {
    const results = [
      { item: 'A', text: 'hello world programming code' },
    ];
    const ranked = semanticRerank('hello world', results);
    expect(ranked[0].semanticScore).toBeGreaterThanOrEqual(0);
    expect(ranked[0].semanticScore).toBeLessThanOrEqual(1);
  });

  it('handles identical query and document', () => {
    const query = 'websocket timeout debugging';
    const results = [{ item: 'A', text: query }];
    const ranked = semanticRerank(query, results);
    expect(ranked[0].semanticScore).toBeCloseTo(1, 1);
  });
});
