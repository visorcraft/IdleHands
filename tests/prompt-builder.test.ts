import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SystemPromptBuilder,
  IdentitySection,
  RulesSection,
  ToolFormatSection,
  VaultContextSection,
  DateTimeSection,
  RuntimeSection,
  buildDefaultSystemPrompt,
} from '../dist/agent/prompt-builder.js';
import type { PromptSection, PromptContext } from '../dist/agent/prompt-builder.js';

const baseCtx: PromptContext = {
  cwd: '/test/project',
  nativeToolCalls: true,
  contentModeToolCalls: false,
};

describe('SystemPromptBuilder', () => {
  it('builds with default sections', () => {
    const builder = SystemPromptBuilder.withDefaults();
    const prompt = builder.build(baseCtx);

    assert.ok((prompt).includes('coding agent'));
    assert.ok((prompt).includes('Rules:'));
    assert.ok((prompt).includes('tool_calls'));
  });

  it('buildDefaultSystemPrompt produces a non-empty prompt', () => {
    const prompt = buildDefaultSystemPrompt({ cwd: '/test' });
    assert.ok((prompt.length) > (100));
    assert.ok((prompt).includes('coding agent'));
  });

  it('lists section names in order', () => {
    const builder = SystemPromptBuilder.withDefaults();
    const names = builder.sectionNames();
    assert.ok((names).includes('identity'));
    assert.ok((names).includes('rules'));
    assert.ok((names).includes('tool_format'));
    assert.ok((names.indexOf('identity')) < (names.indexOf('rules')));
  });

  it('addSection appends to the end', () => {
    const builder = SystemPromptBuilder.withDefaults();
    builder.addSection(new DateTimeSection());
    const names = builder.sectionNames();
    assert.strictEqual(names[names.length - 1], 'datetime');
  });

  it('insertBefore places section correctly', () => {
    const builder = SystemPromptBuilder.withDefaults();
    builder.insertBefore('rules', new DateTimeSection());
    const names = builder.sectionNames();
    assert.ok((names.indexOf('datetime')) < (names.indexOf('rules')));
  });

  it('insertAfter places section correctly', () => {
    const builder = SystemPromptBuilder.withDefaults();
    builder.insertAfter('identity', new RuntimeSection());
    const names = builder.sectionNames();
    assert.strictEqual(names.indexOf('runtime'), names.indexOf('identity') + 1);
  });

  it('replaceSection swaps section by name', () => {
    const custom: PromptSection = {
      name: 'identity',
      build: () => 'You are a custom bot.',
    };
    const builder = SystemPromptBuilder.withDefaults();
    builder.replaceSection('identity', custom);
    const prompt = builder.build(baseCtx);
    assert.ok((prompt).includes('custom bot'));
    assert.ok(!((prompt).includes('coding agent')));
  });

  it('removeSection removes a section', () => {
    const builder = SystemPromptBuilder.withDefaults();
    builder.removeSection('rules');
    const prompt = builder.build(baseCtx);
    assert.ok(!((prompt).includes('Rules:')));
  });

  it('getSection returns section by name', () => {
    const builder = SystemPromptBuilder.withDefaults();
    const identity = builder.getSection<IdentitySection>('identity');
    assert.ok((identity) instanceof (IdentitySection));
  });

  it('skips empty sections', () => {
    const builder = new SystemPromptBuilder();
    const empty: PromptSection = { name: 'empty', build: () => '' };
    const nonempty: PromptSection = { name: 'nonempty', build: () => 'content' };
    builder.addSection(empty);
    builder.addSection(nonempty);
    const prompt = builder.build(baseCtx);
    assert.strictEqual(prompt, 'content');
  });
});

describe('ToolFormatSection', () => {
  it('uses tool_calls format for native mode', () => {
    const section = new ToolFormatSection();
    const text = section.build({ ...baseCtx, contentModeToolCalls: false });
    assert.ok((text).includes('Use tool_calls'));
    assert.ok(!((text).includes('Output tool calls as JSON blocks')));
  });

  it('uses content-mode format when contentModeToolCalls is true', () => {
    const section = new ToolFormatSection();
    const text = section.build({ ...baseCtx, contentModeToolCalls: true });
    assert.ok((text).includes('Output tool calls as JSON blocks'));
    assert.ok(!((text).includes('Use tool_calls')));
  });
});

describe('VaultContextSection', () => {
  it('returns empty when no entries', () => {
    const section = new VaultContextSection();
    assert.strictEqual(section.build(baseCtx), '');
  });

  it('formats entries when provided', () => {
    const section = new VaultContextSection(['- note: some context', '- note: other context']);
    const text = section.build(baseCtx);
    assert.ok((text).includes('[Relevant context from vault]'));
    assert.ok((text).includes('some context'));
    assert.ok((text).includes('other context'));
  });

  it('setEntries updates dynamically', () => {
    const section = new VaultContextSection();
    assert.strictEqual(section.build(baseCtx), '');
    section.setEntries(['- new entry']);
    assert.ok((section.build(baseCtx)).includes('new entry'));
  });
});

describe('RuntimeSection', () => {
  it('includes cwd and model', () => {
    const section = new RuntimeSection();
    const text = section.build({ ...baseCtx, cwd: '/my/project', model: 'qwen2.5-coder' });
    assert.ok((text).includes('/my/project'));
    assert.ok((text).includes('qwen2.5-coder'));
  });
});
