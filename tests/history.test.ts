import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  stripThinking,
  estimateTokensFromMessages,
  enforceContextBudget,
  estimateToolSchemaTokens,
} from '../dist/history.js';

describe('stripThinking', () => {
  it('strips single-line <think> blocks', () => {
    const r = stripThinking('hello <think>some thought</think> world');
    assert.equal(r.visible, 'hello  world');
    assert.equal(r.thinking, 'some thought');
  });

  it('strips multi-line <think> blocks', () => {
    const r = stripThinking('<think>line 1\nline 2\nline 3</think>answer here');
    assert.equal(r.visible, 'answer here');
    assert.equal(r.thinking, 'line 1\nline 2\nline 3');
  });

  it('strips <thinking> tags', () => {
    const r = stripThinking('<thinking>deep thought</thinking>result');
    assert.equal(r.visible, 'result');
    assert.equal(r.thinking, 'deep thought');
  });

  it('strips multiple think blocks', () => {
    const r = stripThinking('<think>a</think>middle<think>b</think>end');
    assert.equal(r.visible, 'middleend');
    assert.equal(r.thinking, 'a\n\nb');
  });

  it('returns text unchanged when no think blocks', () => {
    const r = stripThinking('no thinking here');
    assert.equal(r.visible, 'no thinking here');
    assert.equal(r.thinking, '');
  });

  it('handles empty think blocks', () => {
    const r = stripThinking('<think></think>answer');
    assert.equal(r.visible, 'answer');
  });
});

describe('estimateTokensFromMessages', () => {
  it('estimates based on content length', () => {
    const msgs = [
      { role: 'system' as const, content: 'You are helpful.' },
      { role: 'user' as const, content: 'Hello world' },
    ];
    const est = estimateTokensFromMessages(msgs);
    assert.ok(est > 0);
    assert.ok(est < 100);
  });
});

describe('estimateToolSchemaTokens', () => {
  it('returns 0 for undefined/empty tools', () => {
    assert.equal(estimateToolSchemaTokens(undefined), 0);
    assert.equal(estimateToolSchemaTokens([]), 0);
  });

  it('estimates tokens from tool schema JSON', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read file contents',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'exec',
          description: 'Run a shell command',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      },
    ];
    const tokens = estimateToolSchemaTokens(tools);
    assert.ok(tokens > 0, 'should produce positive token estimate');
    assert.ok(tokens < 500, `schema for 2 small tools should be modest, got ${tokens}`);
  });

  it('scales with tool count', () => {
    const smallSet = [{ type: 'function', function: { name: 'a', parameters: {} } }];
    const largeSet = Array.from({ length: 10 }, (_, i) => ({
      type: 'function',
      function: {
        name: `tool_${i}`,
        description: 'A tool that does things with parameters and descriptions that add tokens',
        parameters: { type: 'object', properties: { arg: { type: 'string' } } },
      },
    }));
    assert.ok(estimateToolSchemaTokens(largeSet) > estimateToolSchemaTokens(smallSet));
  });
});

describe('enforceContextBudget', () => {
  it('keeps messages when under budget', () => {
    const msgs = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
    ];
    const result = enforceContextBudget({
      messages: msgs,
      contextWindow: 131072,
      maxTokens: 16384,
    });
    assert.equal(result.length, 3);
  });

  it('drops old messages when over budget', () => {
    const msgs: any[] = [{ role: 'system', content: 'sys' }];
    // Add many large messages to exceed budget
    for (let i = 0; i < 100; i++) {
      msgs.push({ role: 'user', content: 'x'.repeat(4000) });
      msgs.push({ role: 'assistant', content: 'y'.repeat(4000) });
    }
    const result = enforceContextBudget({ messages: msgs, contextWindow: 8192, maxTokens: 2048 });
    assert.ok(result.length < msgs.length);
    assert.equal(result[0].role, 'system');
  });

  it('drops tool-result messages before user/assistant messages', () => {
    const msgs: any[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      {
        role: 'assistant',
        content: 'a1',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'x'.repeat(8000), tool_call_id: 'c1' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u2' },
      {
        role: 'assistant',
        content: 'a3',
        tool_calls: [
          { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'y'.repeat(8000), tool_call_id: 'c2' },
      { role: 'assistant', content: 'a4' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a5' },
    ];
    // Budget small enough that we need to drop something
    const result = enforceContextBudget({
      messages: msgs,
      contextWindow: 8192,
      maxTokens: 2048,
      minTailMessages: 4,
    });
    // Tool messages should be dropped first
    const toolMsgs = result.filter((m: any) => m.role === 'tool');
    const userMsgs = result.filter((m: any) => m.role === 'user');
    // More user msgs preserved than tool msgs (tools dropped first)
    assert.ok(
      toolMsgs.length <= userMsgs.length,
      `tool msgs (${toolMsgs.length}) should be <= user msgs (${userMsgs.length})`
    );
  });

  it('drops assistant+tool groups together (no orphaned tool_calls)', () => {
    const msgs: any[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      {
        role: 'assistant',
        content: 'a1',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'x'.repeat(8000), tool_call_id: 'c1' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a3' },
    ];
    const result = enforceContextBudget({
      messages: msgs,
      contextWindow: 8192,
      maxTokens: 2048,
      minTailMessages: 3,
    });

    // Verify: if tool result c1 was dropped, its paired assistant (with tool_calls) must also be dropped.
    const hasToolResult = result.some((m: any) => m.role === 'tool' && m.tool_call_id === 'c1');
    const hasAssistantWithToolCalls = result.some(
      (m: any) => m.role === 'assistant' && m.tool_calls?.length
    );
    // They must either both be present or both be absent.
    assert.equal(
      hasToolResult,
      hasAssistantWithToolCalls,
      'assistant message with tool_calls and its tool results must be dropped/kept together'
    );
  });

  it('triggers compaction at 80% of budget', () => {
    const msgs: any[] = [{ role: 'system', content: 'sys' }];
    // 131072 - 16384 - 2048 = 112640 budget, 80% = 90112
    // Add messages that exceed 80% but stay under 100%
    for (let i = 0; i < 45; i++) {
      msgs.push({ role: 'user', content: 'x'.repeat(4000) });
      msgs.push({ role: 'assistant', content: 'y'.repeat(4000) });
    }
    // ~91 messages × ~(4000+20)/4 ≈ ~91000 tokens, budget 112640, 80% = 90112
    const result = enforceContextBudget({
      messages: msgs,
      contextWindow: 131072,
      maxTokens: 16384,
    });
    // Should have compacted because we're over 80%
    assert.ok(
      result.length < msgs.length,
      `Should have compacted: ${result.length} < ${msgs.length}`
    );
  });

  it('toolSchemaTokens tightens the budget', () => {
    const msgs: any[] = [{ role: 'system', content: 'sys' }];
    // Create messages that fit with default 800 tool overhead but not with 5000
    for (let i = 0; i < 45; i++) {
      msgs.push({ role: 'user', content: 'x'.repeat(4000) });
      msgs.push({ role: 'assistant', content: 'y'.repeat(4000) });
    }
    const withDefault = enforceContextBudget({
      messages: msgs,
      contextWindow: 131072,
      maxTokens: 16384,
    });
    const withLargeSchema = enforceContextBudget({
      messages: msgs,
      contextWindow: 131072,
      maxTokens: 16384,
      toolSchemaTokens: 5000,
    });
    // Larger tool schema overhead means tighter budget → more aggressive compaction
    assert.ok(
      withLargeSchema.length <= withDefault.length,
      `large schema (${withLargeSchema.length}) should compact at least as aggressively as default (${withDefault.length})`
    );
  });
});
