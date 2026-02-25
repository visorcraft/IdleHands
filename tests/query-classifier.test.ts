import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classify, classifyWithDecision, defaultClassificationRules } from '../dist/agent/query-classifier.js';
import type { QueryClassificationConfig } from '../dist/agent/query-classifier.js';

const config: QueryClassificationConfig = {
  enabled: true,
  rules: defaultClassificationRules(),
};

describe('classify', () => {
  it('returns null when disabled', () => {
    assert.strictEqual(classify({ enabled: false, rules: config.rules }, 'hello'), null);
  });

  it('returns null with empty rules', () => {
    assert.strictEqual(classify({ enabled: true, rules: [] }, 'hello'), null);
  });

  it('matches short greetings as fast', () => {
    assert.strictEqual(classify(config, 'hello'), 'fast');
    assert.strictEqual(classify(config, 'hey'), 'fast');
    assert.strictEqual(classify(config, 'thanks'), 'fast');
  });

  it('matches code keywords as code', () => {
    assert.strictEqual(classify(config, 'refactor the authentication module'), 'code');
    assert.strictEqual(classify(config, 'debug this function'), 'code');
  });

  it('matches code patterns', () => {
    assert.strictEqual(classify(config, 'fn main() { println!("hello"); }'), 'code');
    assert.strictEqual(classify(config, 'class UserService { constructor() {} }'), 'code');
  });

  it('matches reasoning for long analytical queries', () => {
    assert.strictEqual(classify(config, 'Can you explain why this architecture decision was made and analyze the tradeoffs?'), 'reasoning');
  });

  it('does not match reasoning for short messages', () => {
    assert.notStrictEqual(classify(config, 'explain'), 'reasoning');
  });

  it('returns null for unmatched messages', () => {
    assert.strictEqual(classify(config, 'the purple elephant danced quietly'), null);
  });

  it('is case-insensitive for keywords', () => {
    assert.strictEqual(classify(config, 'HELLO'), 'fast');
  });

  it('respects priority ordering', () => {
    // "code" has priority 5, "fast" has priority 1
    // A message matching both should pick "code"
    const result = classify(config, 'code');
    assert.strictEqual(result, 'code');
  });
});

describe('classifyWithDecision', () => {
  it('returns hint and priority', () => {
    const decision = classifyWithDecision(config, 'debug this function please');
    assert.notStrictEqual(decision, null);
    assert.strictEqual(decision!.hint, 'code');
    assert.strictEqual(decision!.priority, 5);
  });

  it('returns null for no match', () => {
    assert.strictEqual(classifyWithDecision(config, 'random unrelated stuff here maybe'), null);
  });
});

describe('custom rules', () => {
  it('supports length constraints', () => {
    const custom: QueryClassificationConfig = {
      enabled: true,
      rules: [
        { hint: 'short', keywords: ['test'], patterns: [], priority: 1, maxLength: 10 },
        { hint: 'long', keywords: ['test'], patterns: [], priority: 1, minLength: 20 },
      ],
    };
    assert.strictEqual(classify(custom, 'test'), 'short');
    assert.strictEqual(classify(custom, 'test this very long message here'), 'long');
  });

  it('supports case-sensitive patterns', () => {
    const custom: QueryClassificationConfig = {
      enabled: true,
      rules: [
        { hint: 'rust', keywords: [], patterns: ['fn '], priority: 5 },
      ],
    };
    assert.strictEqual(classify(custom, 'fn main()'), 'rust');
    assert.strictEqual(classify(custom, 'FN MAIN()'), null);
  });
});
