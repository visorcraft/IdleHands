import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolsSchema, applyContextAwareToolDescriptions } from '../dist/agent/tools-schema.js';

describe('context-aware tool descriptions', () => {
  it('adds hints for read tools after edits', () => {
    const base = buildToolsSchema();
    const withContext = applyContextAwareToolDescriptions(base, {
      lastTool: 'edit_file',
      recentTools: ['search_files', 'read_file', 'edit_file'],
      recentPaths: ['src/agent.ts', 'src/tool.ts'],
    });

    const read = withContext.find((t) => t.function.name === 'read_file');
    const edit = withContext.find((t) => t.function.name === 'edit_range');

    assert.ok(read, 'read_file schema should exist');
    assert.ok(edit, 'edit_range schema should exist');
    assert.match(read!.function.description ?? '', /Context:/);
    assert.match(read!.function.description ?? '', /Recent targets/);
    assert.match(edit!.function.description ?? '', /Recent-file continuation|Scope edits from recent reads/);
  });

  it('adds different hints for mutating tools when no recent path exists', () => {
    const base = buildToolsSchema();
    const withContext = applyContextAwareToolDescriptions(base, {
      lastTool: 'list_dir',
      recentTools: ['list_dir'],
    });

    const write = withContext.find((t) => t.function.name === 'write_file');
    assert.ok(write, 'write_file schema should exist');
    assert.match(write!.function.description ?? '', /Context:/);
    assert.match(write!.function.description ?? '', /Read the exact target file first/);
  });

  it('returns base schema unchanged when no context is provided', () => {
    const base = buildToolsSchema();
    const withContext = applyContextAwareToolDescriptions(base);
    assert.equal(withContext, base);
  });
});
