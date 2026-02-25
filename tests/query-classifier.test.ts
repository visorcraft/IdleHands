import { describe, it, expect } from 'vitest';
import { classify, classifyWithDecision, defaultClassificationRules } from '../src/agent/query-classifier.js';
import type { QueryClassificationConfig } from '../src/agent/query-classifier.js';

const config: QueryClassificationConfig = {
  enabled: true,
  rules: defaultClassificationRules(),
};

describe('classify', () => {
  it('returns null when disabled', () => {
    expect(classify({ enabled: false, rules: config.rules }, 'hello')).toBeNull();
  });

  it('returns null with empty rules', () => {
    expect(classify({ enabled: true, rules: [] }, 'hello')).toBeNull();
  });

  it('matches short greetings as fast', () => {
    expect(classify(config, 'hello')).toBe('fast');
    expect(classify(config, 'hey')).toBe('fast');
    expect(classify(config, 'thanks')).toBe('fast');
  });

  it('matches code keywords as code', () => {
    expect(classify(config, 'refactor the authentication module')).toBe('code');
    expect(classify(config, 'debug this function')).toBe('code');
  });

  it('matches code patterns', () => {
    expect(classify(config, 'fn main() { println!("hello"); }')).toBe('code');
    expect(classify(config, 'class UserService { constructor() {} }')).toBe('code');
  });

  it('matches reasoning for long analytical queries', () => {
    expect(classify(config, 'Can you explain why this architecture decision was made and analyze the tradeoffs?')).toBe('reasoning');
  });

  it('does not match reasoning for short messages', () => {
    expect(classify(config, 'explain')).not.toBe('reasoning');
  });

  it('returns null for unmatched messages', () => {
    expect(classify(config, 'the purple elephant danced quietly')).toBeNull();
  });

  it('is case-insensitive for keywords', () => {
    expect(classify(config, 'HELLO')).toBe('fast');
  });

  it('respects priority ordering', () => {
    // "code" has priority 5, "fast" has priority 1
    // A message matching both should pick "code"
    const result = classify(config, 'code');
    expect(result).toBe('code');
  });
});

describe('classifyWithDecision', () => {
  it('returns hint and priority', () => {
    const decision = classifyWithDecision(config, 'debug this function please');
    expect(decision).not.toBeNull();
    expect(decision!.hint).toBe('code');
    expect(decision!.priority).toBe(5);
  });

  it('returns null for no match', () => {
    expect(classifyWithDecision(config, 'random unrelated stuff here maybe')).toBeNull();
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
    expect(classify(custom, 'test')).toBe('short');
    expect(classify(custom, 'test this very long message here')).toBe('long');
  });

  it('supports case-sensitive patterns', () => {
    const custom: QueryClassificationConfig = {
      enabled: true,
      rules: [
        { hint: 'rust', keywords: [], patterns: ['fn '], priority: 5 },
      ],
    };
    expect(classify(custom, 'fn main()')).toBe('rust');
    expect(classify(custom, 'FN MAIN()')).toBeNull();
  });
});
