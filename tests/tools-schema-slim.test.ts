import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolsSchema } from '../dist/agent/tools-schema.js';

describe('buildToolsSchema slimFast', () => {
  it('full schema includes write/edit/patch/insert tools', () => {
    const full = buildToolsSchema();
    const names = full.map((t) => t.function.name);
    assert.ok(names.includes('write_file'));
    assert.ok(names.includes('edit_file'));
    assert.ok(names.includes('edit_range'));
    assert.ok(names.includes('apply_patch'));
    assert.ok(names.includes('insert_file'));
    assert.ok(names.includes('spawn_task'));
  });

  it('slim schema only includes read-only/lightweight tools', () => {
    const slim = buildToolsSchema({ slimFast: true });
    const names = slim.map((t) => t.function.name);
    // Should include read-only tools
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('read_files'));
    assert.ok(names.includes('list_dir'));
    assert.ok(names.includes('search_files'));
    assert.ok(names.includes('exec'));
    // Should NOT include mutating tools
    assert.ok(!names.includes('write_file'));
    assert.ok(!names.includes('edit_file'));
    assert.ok(!names.includes('edit_range'));
    assert.ok(!names.includes('apply_patch'));
    assert.ok(!names.includes('insert_file'));
    assert.ok(!names.includes('spawn_task'));
  });

  it('slim schema includes vault_search when active vault enabled', () => {
    const slim = buildToolsSchema({ slimFast: true, activeVaultTools: true });
    const names = slim.map((t) => t.function.name);
    assert.ok(names.includes('vault_search'));
    // vault_note is a write tool — should be filtered out
    assert.ok(!names.includes('vault_note'));
  });

  it('slim schema token count is significantly lower than full', () => {
    const full = buildToolsSchema();
    const slim = buildToolsSchema({ slimFast: true });
    const fullBytes = Buffer.byteLength(JSON.stringify(full), 'utf8');
    const slimBytes = Buffer.byteLength(JSON.stringify(slim), 'utf8');
    // Slim should be at least 30% smaller
    assert.ok(slimBytes < fullBytes * 0.7, `slim ${slimBytes} not <70% of full ${fullBytes}`);
  });
});
