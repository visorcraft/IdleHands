import { describe, it, expect } from 'vitest';
import {
  SystemPromptBuilder,
  IdentitySection,
  RulesSection,
  ToolFormatSection,
  VaultContextSection,
  DateTimeSection,
  RuntimeSection,
  buildDefaultSystemPrompt,
} from '../src/agent/prompt-builder.js';
import type { PromptSection, PromptContext } from '../src/agent/prompt-builder.js';

const baseCtx: PromptContext = {
  cwd: '/test/project',
  nativeToolCalls: true,
  contentModeToolCalls: false,
};

describe('SystemPromptBuilder', () => {
  it('builds with default sections', () => {
    const builder = SystemPromptBuilder.withDefaults();
    const prompt = builder.build(baseCtx);

    expect(prompt).toContain('coding agent');
    expect(prompt).toContain('Rules:');
    expect(prompt).toContain('tool_calls');
  });

  it('buildDefaultSystemPrompt produces a non-empty prompt', () => {
    const prompt = buildDefaultSystemPrompt({ cwd: '/test' });
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toContain('coding agent');
  });

  it('lists section names in order', () => {
    const builder = SystemPromptBuilder.withDefaults();
    const names = builder.sectionNames();
    expect(names).toContain('identity');
    expect(names).toContain('rules');
    expect(names).toContain('tool_format');
    expect(names.indexOf('identity')).toBeLessThan(names.indexOf('rules'));
  });

  it('addSection appends to the end', () => {
    const builder = SystemPromptBuilder.withDefaults();
    builder.addSection(new DateTimeSection());
    const names = builder.sectionNames();
    expect(names[names.length - 1]).toBe('datetime');
  });

  it('insertBefore places section correctly', () => {
    const builder = SystemPromptBuilder.withDefaults();
    builder.insertBefore('rules', new DateTimeSection());
    const names = builder.sectionNames();
    expect(names.indexOf('datetime')).toBeLessThan(names.indexOf('rules'));
  });

  it('insertAfter places section correctly', () => {
    const builder = SystemPromptBuilder.withDefaults();
    builder.insertAfter('identity', new RuntimeSection());
    const names = builder.sectionNames();
    expect(names.indexOf('runtime')).toBe(names.indexOf('identity') + 1);
  });

  it('replaceSection swaps section by name', () => {
    const custom: PromptSection = {
      name: 'identity',
      build: () => 'You are a custom bot.',
    };
    const builder = SystemPromptBuilder.withDefaults();
    builder.replaceSection('identity', custom);
    const prompt = builder.build(baseCtx);
    expect(prompt).toContain('custom bot');
    expect(prompt).not.toContain('coding agent');
  });

  it('removeSection removes a section', () => {
    const builder = SystemPromptBuilder.withDefaults();
    builder.removeSection('rules');
    const prompt = builder.build(baseCtx);
    expect(prompt).not.toContain('Rules:');
  });

  it('getSection returns section by name', () => {
    const builder = SystemPromptBuilder.withDefaults();
    const identity = builder.getSection<IdentitySection>('identity');
    expect(identity).toBeInstanceOf(IdentitySection);
  });

  it('skips empty sections', () => {
    const builder = new SystemPromptBuilder();
    const empty: PromptSection = { name: 'empty', build: () => '' };
    const nonempty: PromptSection = { name: 'nonempty', build: () => 'content' };
    builder.addSection(empty);
    builder.addSection(nonempty);
    const prompt = builder.build(baseCtx);
    expect(prompt).toBe('content');
  });
});

describe('ToolFormatSection', () => {
  it('uses tool_calls format for native mode', () => {
    const section = new ToolFormatSection();
    const text = section.build({ ...baseCtx, contentModeToolCalls: false });
    expect(text).toContain('Use tool_calls');
    expect(text).not.toContain('Output tool calls as JSON blocks');
  });

  it('uses content-mode format when contentModeToolCalls is true', () => {
    const section = new ToolFormatSection();
    const text = section.build({ ...baseCtx, contentModeToolCalls: true });
    expect(text).toContain('Output tool calls as JSON blocks');
    expect(text).not.toContain('Use tool_calls');
  });
});

describe('VaultContextSection', () => {
  it('returns empty when no entries', () => {
    const section = new VaultContextSection();
    expect(section.build(baseCtx)).toBe('');
  });

  it('formats entries when provided', () => {
    const section = new VaultContextSection(['- note: some context', '- note: other context']);
    const text = section.build(baseCtx);
    expect(text).toContain('[Relevant context from vault]');
    expect(text).toContain('some context');
    expect(text).toContain('other context');
  });

  it('setEntries updates dynamically', () => {
    const section = new VaultContextSection();
    expect(section.build(baseCtx)).toBe('');
    section.setEntries(['- new entry']);
    expect(section.build(baseCtx)).toContain('new entry');
  });
});

describe('RuntimeSection', () => {
  it('includes cwd and model', () => {
    const section = new RuntimeSection();
    const text = section.build({ ...baseCtx, cwd: '/my/project', model: 'qwen2.5-coder' });
    expect(text).toContain('/my/project');
    expect(text).toContain('qwen2.5-coder');
  });
});
