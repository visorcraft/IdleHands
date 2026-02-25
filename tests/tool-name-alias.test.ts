import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolAlias, defaultParamForTool } from '../dist/agent/tool-name-alias.js';
import { parseToolCallsFromContent } from '../dist/agent/tool-calls.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool Name Aliasing
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveToolAlias', () => {
  it('maps shell/bash/sh to exec', () => {
    assert.strictEqual(resolveToolAlias('shell').resolved, 'exec');
    assert.strictEqual(resolveToolAlias('bash').resolved, 'exec');
    assert.strictEqual(resolveToolAlias('sh').resolved, 'exec');
    assert.strictEqual(resolveToolAlias('command').resolved, 'exec');
    assert.strictEqual(resolveToolAlias('cmd').resolved, 'exec');
    assert.strictEqual(resolveToolAlias('run').resolved, 'exec');
  });

  it('maps file_read variants to read_file', () => {
    assert.strictEqual(resolveToolAlias('file_read').resolved, 'read_file');
    assert.strictEqual(resolveToolAlias('fileread').resolved, 'read_file');
    assert.strictEqual(resolveToolAlias('readfile').resolved, 'read_file');
    assert.strictEqual(resolveToolAlias('cat').resolved, 'read_file');
  });

  it('maps file_write variants to write_file', () => {
    assert.strictEqual(resolveToolAlias('file_write').resolved, 'write_file');
    assert.strictEqual(resolveToolAlias('filewrite').resolved, 'write_file');
    assert.strictEqual(resolveToolAlias('create_file').resolved, 'write_file');
  });

  it('maps file_edit variants to edit_file', () => {
    assert.strictEqual(resolveToolAlias('file_edit').resolved, 'edit_file');
    assert.strictEqual(resolveToolAlias('str_replace').resolved, 'edit_file');
    assert.strictEqual(resolveToolAlias('str_replace_editor').resolved, 'edit_file');
  });

  it('maps list variants to list_dir', () => {
    assert.strictEqual(resolveToolAlias('file_list').resolved, 'list_dir');
    assert.strictEqual(resolveToolAlias('ls').resolved, 'list_dir');
    assert.strictEqual(resolveToolAlias('list_files').resolved, 'list_dir');
  });

  it('maps search variants to search_files', () => {
    assert.strictEqual(resolveToolAlias('search').resolved, 'search_files');
    assert.strictEqual(resolveToolAlias('grep').resolved, 'search_files');
    assert.strictEqual(resolveToolAlias('rg').resolved, 'search_files');
  });

  it('maps memory tools to vault', () => {
    assert.strictEqual(resolveToolAlias('memory_recall').resolved, 'vault_search');
    assert.strictEqual(resolveToolAlias('memory_store').resolved, 'vault_note');
  });

  it('returns original name for unknown tools', () => {
    const result = resolveToolAlias('some_custom_mcp_tool');
    assert.strictEqual(result.resolved, 'some_custom_mcp_tool');
    assert.strictEqual(result.wasAliased, false);
  });

  it('is case-insensitive', () => {
    assert.strictEqual(resolveToolAlias('BASH').resolved, 'exec');
    assert.strictEqual(resolveToolAlias('Shell').resolved, 'exec');
    assert.strictEqual(resolveToolAlias('FILE_READ').resolved, 'read_file');
  });

  it('handles hyphens as underscores', () => {
    assert.strictEqual(resolveToolAlias('file-read').resolved, 'read_file');
    assert.strictEqual(resolveToolAlias('file-write').resolved, 'write_file');
    assert.strictEqual(resolveToolAlias('run-command').resolved, 'exec');
  });

  it('reports wasAliased correctly', () => {
    assert.strictEqual(resolveToolAlias('bash').wasAliased, true);
    assert.strictEqual(resolveToolAlias('exec').wasAliased, false);
    assert.strictEqual(resolveToolAlias('read_file').wasAliased, false);
  });

  it('does not alias canonical names', () => {
    // Canonical names should pass through unchanged
    for (const name of ['exec', 'read_file', 'write_file', 'edit_file', 'list_dir', 'search_files', 'apply_patch', 'spawn_task']) {
      const result = resolveToolAlias(name);
      assert.strictEqual(result.resolved, name);
      assert.strictEqual(result.wasAliased, false);
    }
  });
});

describe('defaultParamForTool', () => {
  it('returns command for exec and its aliases', () => {
    assert.strictEqual(defaultParamForTool('exec'), 'command');
    assert.strictEqual(defaultParamForTool('shell'), 'command');
    assert.strictEqual(defaultParamForTool('bash'), 'command');
  });

  it('returns path for file tools', () => {
    assert.strictEqual(defaultParamForTool('read_file'), 'path');
    assert.strictEqual(defaultParamForTool('write_file'), 'path');
    assert.strictEqual(defaultParamForTool('list_dir'), 'path');
    assert.strictEqual(defaultParamForTool('file_read'), 'path');
  });

  it('returns pattern for search', () => {
    assert.strictEqual(defaultParamForTool('search_files'), 'pattern');
    assert.strictEqual(defaultParamForTool('grep'), 'pattern');
  });

  it('returns input for unknown tools', () => {
    assert.strictEqual(defaultParamForTool('custom_tool'), 'input');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content-Mode Parsers: Aliasing Integration
// ─────────────────────────────────────────────────────────────────────────────

describe('parseToolCallsFromContent with aliasing', () => {
  it('aliases tool names in JSON content', () => {
    const content = '{"name": "bash", "arguments": {"command": "ls"}}';
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 1);
    assert.strictEqual(calls![0].function.name, 'exec');
  });

  it('aliases tool names in JSON array content', () => {
    const content = '[{"name": "file_read", "arguments": {"path": "a.txt"}}, {"name": "shell", "arguments": {"command": "pwd"}}]';
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 2);
    assert.strictEqual(calls![0].function.name, 'read_file');
    assert.strictEqual(calls![1].function.name, 'exec');
  });

  it('aliases tool names in XML content', () => {
    const content = '<tool_call><function=bash><parameter=command>ls</parameter></function></tool_call>';
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 1);
    // Note: XML parser resolves at the wrapper level, so check name
    assert.strictEqual(calls![0].function.name, 'exec');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// New Parsers
// ─────────────────────────────────────────────────────────────────────────────

describe('parseToolCallsFromContent — markdown tool_call blocks', () => {
  it('parses ```tool_call with JSON body', () => {
    const content = '```tool_call\n{"name": "shell", "arguments": {"command": "ls"}}\n```';
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 1);
    assert.strictEqual(calls![0].function.name, 'exec');
    const args = JSON.parse(calls![0].function.arguments);
    assert.strictEqual(args.command, 'ls');
  });

  it('parses ```tool <name> with JSON args', () => {
    const content = '```tool shell\n{"command": "uname -a"}\n```';
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 1);
    assert.strictEqual(calls![0].function.name, 'exec');
    const args = JSON.parse(calls![0].function.arguments);
    assert.strictEqual(args.command, 'uname -a');
  });
});

describe('parseToolCallsFromContent — invoke tags', () => {
  it('parses <invoke name="..."> with <parameter> children', () => {
    const content = '<invoke name="shell"><parameter name="command">ls -la</parameter></invoke>';
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 1);
    assert.strictEqual(calls![0].function.name, 'exec');
    const args = JSON.parse(calls![0].function.arguments);
    assert.strictEqual(args.command, 'ls -la');
  });

  it('parses <invoke> with JSON body (no parameter tags)', () => {
    const content = '<invoke name="file_read">{"path": "src/main.ts"}</invoke>';
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 1);
    assert.strictEqual(calls![0].function.name, 'read_file');
    const args = JSON.parse(calls![0].function.arguments);
    assert.strictEqual(args.path, 'src/main.ts');
  });

  it('handles multiple invoke tags', () => {
    const content = `
<invoke name="file_read"><parameter name="path">a.txt</parameter></invoke>
<invoke name="file_read"><parameter name="path">b.txt</parameter></invoke>
    `.trim();
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 2);
  });

  it('aliases tool names in invoke tags', () => {
    const content = '<invoke name="bash"><parameter name="command">pwd</parameter></invoke>';
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 1);
    assert.strictEqual(calls![0].function.name, 'exec');
  });
});

describe('parseToolCallsFromContent — GLM shortened format', () => {
  it('parses tool/param>value format', () => {
    const content = 'shell/command>ls -la';
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 1);
    assert.strictEqual(calls![0].function.name, 'exec');
    const args = JSON.parse(calls![0].function.arguments);
    assert.strictEqual(args.command, 'ls -la');
  });

  it('parses tool>value with default param', () => {
    const content = 'shell>uname -a';
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 1);
    assert.strictEqual(calls![0].function.name, 'exec');
    const args = JSON.parse(calls![0].function.arguments);
    assert.strictEqual(args.command, 'uname -a');
  });

  it('parses tool>JSON with full JSON args', () => {
    const content = 'exec>{"command": "npm test", "timeout": 30}';
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 1);
    assert.strictEqual(calls![0].function.name, 'exec');
    const args = JSON.parse(calls![0].function.arguments);
    assert.strictEqual(args.command, 'npm test');
    assert.strictEqual(args.timeout, 30);
  });

  it('aliases tool names in GLM format', () => {
    const content = 'bash/command>pwd';
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 1);
    assert.strictEqual(calls![0].function.name, 'exec');
  });

  it('handles multiple GLM lines', () => {
    const content = 'file_read/path>a.txt\nfile_read/path>b.txt';
    const calls = parseToolCallsFromContent(content);
    assert.strictEqual((calls).length, 2);
    assert.strictEqual(calls![0].function.name, 'read_file');
    assert.strictEqual(calls![1].function.name, 'read_file');
  });
});
