/**
 * Tests for the routing policy module.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyzeComplexity,
  classifyCommand,
  determineRouting,
  getModelForDecision,
  type ComplexityHeuristics,
  type CommandCategory,
  type RoutingConfig,
} from '../dist/routing/policy.js';

describe('analyzeComplexity', () => {
  it('should analyze a simple prompt', () => {
    const prompt = 'Hello, how are you?';
    const result = analyzeComplexity(prompt);

    assert.ok(result.promptLength > 0);
    assert.ok(result.wordCount > 0);
    assert.ok(result.estimatedTokens > 0);
    assert.equal(result.hasCodeBlocks, false);
    assert.equal(result.hasComplexInstructions, false);
    assert.equal(result.hasFileReferences, false);
    assert.equal(result.isTechnical, false);
  });

  it('should detect code blocks', () => {
    const prompt = '```ts\nconst x = 1;\n```\nSome text';
    const result = analyzeComplexity(prompt);

    assert.equal(result.hasCodeBlocks, true);
  });

  it('should detect complex instructions', () => {
    const prompt = `1. First step
2. Second step
3. Third step`;
    const result = analyzeComplexity(prompt);

    assert.equal(result.hasComplexInstructions, true);
  });

  it('should detect file references', () => {
    const prompt = 'Read the file at src/main.ts and update it';
    const result = analyzeComplexity(prompt);

    assert.equal(result.hasFileReferences, true);
  });

  it('should detect technical content', () => {
    const prompt = 'const x: string = "hello"; import { foo } from "bar";';
    const result = analyzeComplexity(prompt);

    assert.equal(result.isTechnical, true);
  });
});

describe('classifyCommand', () => {
  it('should classify code commands', () => {
    assert.equal(classifyCommand('Implement a function to add two numbers'), 'code');
    assert.equal(classifyCommand('Fix the bug in this code'), 'code');
  });

  it('should classify analysis commands', () => {
    assert.equal(classifyCommand('Analyze this code for performance issues'), 'analysis');
    assert.equal(classifyCommand('Review this implementation'), 'analysis');
  });

  it('should classify file commands', () => {
    assert.equal(classifyCommand('Read the file at /tmp/test.txt'), 'file');
  });

  it('should classify system commands', () => {
    assert.equal(classifyCommand('Setup the development environment'), 'system');
  });

  it('should classify query commands by default', () => {
    assert.equal(classifyCommand('What is TypeScript?'), 'query');
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
    assert.equal(result, 'auto-selected-fast');
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
    assert.equal(result, 'auto-selected-heavy');
  });

  it('should respect explicit fast mode', () => {
    const result = determineRouting('Hello', undefined, undefined, 'fast', undefined, defaultConfig);
    assert.equal(result, 'fast');
  });

  it('should respect explicit heavy mode', () => {
    const result = determineRouting('Hello', undefined, undefined, 'heavy', undefined, defaultConfig);
    assert.equal(result, 'heavy');
  });

  it('should return heavy when fast model is unavailable', () => {
    const result = determineRouting('Hello', undefined, undefined, 'auto', {
      fastAvailable: false,
      heavyAvailable: true,
      hasIssues: false,
    }, defaultConfig);
    assert.equal(result, 'heavy');
  });

  it('should return fast when heavy model is unavailable', () => {
    const result = determineRouting('Hello', undefined, undefined, 'auto', {
      fastAvailable: true,
      heavyAvailable: false,
      hasIssues: false,
    }, defaultConfig);
    assert.equal(result, 'fast');
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
    assert.equal(result, 'auto-selected-fast');
  });

  it('should use command category when provided', () => {
    const result = determineRouting('Hello', undefined, 'code' as CommandCategory, 'auto', undefined, defaultConfig);
    assert.equal(result, 'auto-selected-heavy');
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
    assert.equal(getModelForDecision('fast', config), 'fast-llama-3');
  });

  it('should return fast model for auto-selected-fast decision', () => {
    assert.equal(getModelForDecision('auto-selected-fast', config), 'fast-llama-3');
  });

  it('should return heavy model for heavy decision', () => {
    assert.equal(getModelForDecision('heavy', config), 'heavy-gpt-4');
  });

  it('should return heavy model for auto-selected-heavy decision', () => {
    assert.equal(getModelForDecision('auto-selected-heavy', config), 'heavy-gpt-4');
  });
});
