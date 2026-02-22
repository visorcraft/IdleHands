import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';

import { selectHarness, _resetHarnessCache } from '../dist/harnesses.js';

describe('selectHarness', () => {
  it('matches Qwen3-Coder models to qwen3-coder harness', () => {
    assert.equal(selectHarness('Qwen3-Coder-Next-Q4_K_M.gguf').id, 'qwen3-coder');
    assert.equal(selectHarness('qwen3-coder-32b').id, 'qwen3-coder');
  });

  it('matches Qwen3 non-coder to qwen3-moe harness', () => {
    assert.equal(selectHarness('Qwen3-MoE-30B').id, 'qwen3-moe');
    assert.equal(selectHarness('qwen3-32b').id, 'qwen3-moe');
  });

  it('matches generic Qwen models to qwen harness', () => {
    assert.equal(selectHarness('Qwen2.5-72B').id, 'qwen');
    assert.equal(selectHarness('qwen-7b').id, 'qwen');
  });

  it('matches Nemotron models to nemotron harness', () => {
    assert.equal(selectHarness('nemotron-3-nano').id, 'nemotron');
    assert.equal(selectHarness('Nemotron-Ultra-253B').id, 'nemotron');
  });

  it('matches Mistral models to mistral harness', () => {
    assert.equal(selectHarness('mistral-small-3.2').id, 'mistral');
    assert.equal(selectHarness('Mistral-24B').id, 'mistral');
  });

  it('matches GPT-OSS models to gpt-oss harness', () => {
    assert.equal(selectHarness('gpt-oss-120b').id, 'gpt-oss');
    assert.equal(selectHarness('GPT-OSS-v2').id, 'gpt-oss');
    assert.equal(selectHarness('gpt_oss_120b').id, 'gpt-oss');
  });

  it('matches Llama models', () => {
    assert.equal(selectHarness('Llama-3.1-70B').id, 'llama');
    assert.equal(selectHarness('llama-3-8b').id, 'llama');
  });

  it('falls back to generic for unknown models', () => {
    assert.equal(selectHarness('deepseek-v3').id, 'generic');
    assert.equal(selectHarness('phi-4').id, 'generic');
    assert.equal(selectHarness('gpt-4o').id, 'generic');
  });

  it('respects override', () => {
    assert.equal(selectHarness('whatever', 'llama').id, 'llama');
    assert.equal(selectHarness('Qwen3-Coder', 'generic').id, 'generic');
    assert.equal(selectHarness('nemotron-3', 'qwen3-coder').id, 'qwen3-coder');
  });

  it('falls back to auto-detect if override not found', () => {
    assert.equal(selectHarness('llama-3', 'nonexistent').id, 'llama');
  });

  // Behavioral config tests
  it('qwen3-coder has correct behavioral config', () => {
    const h = selectHarness('qwen3-coder-next');
    assert.equal(h.thinking.format, 'xml');
    assert.equal(h.thinking.strip, true);
    assert.equal(h.toolCalls.reliableToolCallsArray, false);
    assert.equal(h.toolCalls.contentFallbackLikely, true);
    assert.equal(h.toolCalls.retryOnMalformed, 3);
    assert.equal(h.quirks.loopsOnToolError, false);
    assert.equal(h.quirks.omitsRequiredParams, false);
    assert.equal(h.defaults?.max_tokens, 32768);
    assert.ok(h.systemPromptSuffix?.includes('write_file'));
  });

  it('nemotron has aggressive loop/retry limits', () => {
    const h = selectHarness('nemotron-3-nano');
    assert.equal(h.toolCalls.retryOnMalformed, 1);
    assert.equal(h.quirks.loopsOnToolError, true);
    assert.equal(h.quirks.omitsRequiredParams, true);
    assert.equal(h.quirks.needsExplicitToolCallFormatReminder, true);
    assert.equal(h.quirks.maxIterationsOverride, 10);
    assert.equal(h.toolCalls.reliableToolCallsArray, false);
    assert.equal(h.toolCalls.contentFallbackLikely, true);
  });

  it('gpt-oss has maxIterationsOverride', () => {
    const h = selectHarness('gpt-oss-120b');
    assert.equal(h.quirks.maxIterationsOverride, 10);
    assert.equal(h.toolCalls.reliableToolCallsArray, true);
  });

  it('generic harness has conservative defaults with all fallbacks', () => {
    const h = selectHarness('unknown-model-xyz');
    assert.equal(h.id, 'generic');
    assert.equal(h.thinking.strip, true);
    assert.equal(h.toolCalls.contentFallbackLikely, true);
    assert.equal(h.toolCalls.retryOnMalformed, 3);
    assert.equal(h.quirks.loopsOnToolError, false);
  });

  it('mistral has no thinking tokens', () => {
    const h = selectHarness('mistral-small');
    assert.equal(h.thinking.format, 'none');
    assert.equal(h.thinking.strip, false);
    assert.equal(h.toolCalls.reliableToolCallsArray, true);
  });

  it('llama and nemotron have parallelCalls=false', () => {
    assert.equal(selectHarness('llama-3').toolCalls.parallelCalls, false);
    assert.equal(selectHarness('nemotron-3').toolCalls.parallelCalls, false);
  });

  it('llama and nemotron have reliableToolCallsArray=false', () => {
    assert.equal(selectHarness('llama-3').toolCalls.reliableToolCallsArray, false);
    assert.equal(selectHarness('nemotron-3').toolCalls.reliableToolCallsArray, false);
  });
});

describe('user-defined harnesses', () => {
  const realHome = os.homedir();
  const harnessDir = path.join(realHome, '.config', 'idlehands', 'harnesses');
  const testFile = path.join(harnessDir, '_test_custom_model.json');
  let createdDir = false;

  before(async () => {
    // Reset cache so user harnesses are reloaded
    _resetHarnessCache();
    try {
      await fs.mkdir(harnessDir, { recursive: true });
      createdDir = true;
    } catch {
      /* dir exists */
    }

    await fs.writeFile(
      testFile,
      JSON.stringify({
        id: 'test-custom',
        match: ['custom-model-xyz'],
        description: 'Test custom harness',
        params: { temperature: 0.1, max_tokens: 65536 },
        thinking: { format: 'none', strip: false },
        toolCalls: { reliableToolCallsArray: true, parallelCalls: false, retryOnMalformed: 5 },
        quirks: { loopsOnToolError: true, maxIterationsOverride: 5 },
      }),
      'utf8'
    );

    // Force reload
    _resetHarnessCache();
  });

  after(async () => {
    await fs.unlink(testFile).catch(() => {});
    _resetHarnessCache();
  });

  it('loads user-defined harness and matches by model name', () => {
    const h = selectHarness('custom-model-xyz-Q4');
    assert.equal(h.id, 'test-custom');
    assert.equal(h.defaults?.temperature, 0.1);
    assert.equal(h.defaults?.max_tokens, 65536);
    assert.equal(h.toolCalls.retryOnMalformed, 5);
    assert.equal(h.quirks.loopsOnToolError, true);
    assert.equal(h.quirks.maxIterationsOverride, 5);
    assert.equal(h.toolCalls.parallelCalls, false);
  });

  it('fills missing behavioral fields with defaults', () => {
    const h = selectHarness('custom-model-xyz');
    // quirks fields not in the JSON should get defaults
    assert.equal(h.quirks.omitsRequiredParams, false);
    assert.equal(h.quirks.emitsMarkdownInToolArgs, false);
    // contentFallbackLikely not specified — should get default (true)
    assert.equal(h.toolCalls.contentFallbackLikely, true);
  });

  it('built-in harnesses still work when user harness is loaded', () => {
    assert.equal(selectHarness('qwen3-coder-next').id, 'qwen3-coder');
    assert.equal(selectHarness('llama-3').id, 'llama');
  });
});
