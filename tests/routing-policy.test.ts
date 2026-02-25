/**
 * Tests for the routing policy module.
 */

import { describe, it, expect } from 'vitest';

import {
  analyzeComplexity,
  classifyCommand,
  determineRouting,
  getModelForDecision,
  type ComplexityHeuristics,
  type CommandCategory,
  type RoutingConfig,
} from '../src/routing/policy.js';

describe('analyzeComplexity', () => {
  it('should analyze a simple prompt', () => {
    const prompt = 'Hello, how are you?';
    const result = analyzeComplexity(prompt);
    
    expect(result.promptLength).toBeGreaterThan(0);
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.hasCodeBlocks).toBe(false);
    expect(result.hasComplexInstructions).toBe(false);
    expect(result.hasFileReferences).toBe(false);
    expect(result.isTechnical).toBe(false);
  });

  it('should detect code blocks', () => {
    const prompt = '```ts\nconst x = 1;\n```\nSome text';
    const result = analyzeComplexity(prompt);
    
    expect(result.hasCodeBlocks).toBe(true);
  });

  it('should detect complex instructions', () => {
    const prompt = `1. First step
2. Second step
3. Third step`;
    const result = analyzeComplexity(prompt);
    
    expect(result.hasComplexInstructions).toBe(true);
  });

  it('should detect file references', () => {
    const prompt = 'Read the file at src/main.ts and update it';
    const result = analyzeComplexity(prompt);
    
    expect(result.hasFileReferences).toBe(true);
  });

  it('should detect technical content', () => {
    const prompt = 'const x: string = "hello"; import { foo } from "bar";';
    const result = analyzeComplexity(prompt);
    
    expect(result.isTechnical).toBe(true);
  });
});

describe('classifyCommand', () => {
  it('should classify code commands', () => {
    expect(classifyCommand('Implement a function to add two numbers')).toBe('code');
    expect(classifyCommand('Fix the bug in this code')).toBe('code');
  });

  it('should classify analysis commands', () => {
    expect(classifyCommand('Analyze this code for performance issues')).toBe('analysis');
    expect(classifyCommand('Review this implementation')).toBe('analysis');
  });

  it('should classify file commands', () => {
    expect(classifyCommand('Read the file at /tmp/test.txt')).toBe('file');
  });

  it('should classify system commands', () => {
    expect(classifyCommand('Setup the development environment')).toBe('system');
  });

  it('should classify query commands by default', () => {
    expect(classifyCommand('What is TypeScript?')).toBe('query');
  });
});

describe('determineRouting', () => {
  const defaultConfig: RoutingConfig = {
    defaultMode: 'auto',
    fastModel: 'fast-model',
    heavyModel: 'heavy-model',
    thresholds: {
      maxPromptLength: 500,
      maxTokens: 100,
      maxWords: 80,
    },
    autoEscalationRules: {
      codeBlocksThreshold: 1,
      fileReferencesThreshold: 3,
      complexInstructionsThreshold: 1,
    },
  };

  it('should return fast for simple prompts in auto mode', () => {
    const result = determineRouting('Hello, how are you?', undefined, undefined, 'auto', undefined, defaultConfig);
    expect(result).toBe('auto-selected-fast');
  });

  it('should return heavy for complex prompts in auto mode', () => {
    const complexPrompt = `Implement a complex feature:
1. Create a new component
2. Add state management
3. Implement API calls
4. Add tests

\`\`\`ts
const x = 1;
\`\`\``;
    const result = determineRouting(complexPrompt, undefined, undefined, 'auto', undefined, defaultConfig);
    expect(result).toBe('auto-selected-heavy');
  });

  it('should respect explicit fast mode', () => {
    const result = determineRouting('Hello', undefined, undefined, 'fast', undefined, defaultConfig);
    expect(result).toBe('fast');
  });

  it('should respect explicit heavy mode', () => {
    const result = determineRouting('Hello', undefined, undefined, 'heavy', undefined, defaultConfig);
    expect(result).toBe('heavy');
  });

  it('should return heavy when fast model is unavailable', () => {
    const result = determineRouting('Hello', undefined, undefined, 'auto', {
      fastAvailable: false,
      heavyAvailable: true,
      hasIssues: false,
    }, defaultConfig);
    expect(result).toBe('heavy');
  });

  it('should return fast when heavy model is unavailable', () => {
    const result = determineRouting('Hello', undefined, undefined, 'auto', {
      fastAvailable: true,
      heavyAvailable: false,
      hasIssues: false,
    }, defaultConfig);
    expect(result).toBe('fast');
  });

  it('should use complexity heuristics when provided', () => {
    const heuristics: ComplexityHeuristics = {
      promptLength: 100,
      wordCount: 15,
      estimatedTokens: 20,
      hasCodeBlocks: false,
      hasComplexInstructions: false,
      hasFileReferences: false,
      isTechnical: false,
    };
    
    const result = determineRouting('Hello', heuristics, undefined, 'auto', undefined, defaultConfig);
    expect(result).toBe('auto-selected-fast');
  });

  it('should use command category when provided', () => {
    const result = determineRouting('Hello', undefined, 'code' as CommandCategory, 'auto', undefined, defaultConfig);
    expect(result).toBe('auto-selected-heavy');
  });
});

describe('getModelForDecision', () => {
  const config: RoutingConfig = {
    defaultMode: 'auto',
    fastModel: 'fast-llama-3',
    heavyModel: 'heavy-gpt-4',
    thresholds: {
      maxPromptLength: 500,
      maxTokens: 100,
      maxWords: 80,
    },
    autoEscalationRules: {
      codeBlocksThreshold: 1,
      fileReferencesThreshold: 3,
      complexInstructionsThreshold: 1,
    },
  };

  it('should return fast model for fast decision', () => {
    expect(getModelForDecision('fast', config)).toBe('fast-llama-3');
  });

  it('should return fast model for auto-selected-fast decision', () => {
    expect(getModelForDecision('auto-selected-fast', config)).toBe('fast-llama-3');
  });

  it('should return heavy model for heavy decision', () => {
    expect(getModelForDecision('heavy', config)).toBe('heavy-gpt-4');
  });

  it('should return heavy model for auto-selected-heavy decision', () => {
    expect(getModelForDecision('auto-selected-heavy', config)).toBe('heavy-gpt-4');
  });
});