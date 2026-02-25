import { describe, it, expect } from 'vitest';
import { resolveToolAlias, defaultParamForTool } from '../src/agent/tool-name-alias.js';
import { parseToolCallsFromContent } from '../src/agent/tool-calls.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool Name Aliasing
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveToolAlias', () => {
  it('maps shell/bash/sh to exec', () => {
    expect(resolveToolAlias('shell').resolved).toBe('exec');
    expect(resolveToolAlias('bash').resolved).toBe('exec');
    expect(resolveToolAlias('sh').resolved).toBe('exec');
    expect(resolveToolAlias('command').resolved).toBe('exec');
    expect(resolveToolAlias('cmd').resolved).toBe('exec');
    expect(resolveToolAlias('run').resolved).toBe('exec');
  });

  it('maps file_read variants to read_file', () => {
    expect(resolveToolAlias('file_read').resolved).toBe('read_file');
    expect(resolveToolAlias('fileread').resolved).toBe('read_file');
    expect(resolveToolAlias('readfile').resolved).toBe('read_file');
    expect(resolveToolAlias('cat').resolved).toBe('read_file');
  });

  it('maps file_write variants to write_file', () => {
    expect(resolveToolAlias('file_write').resolved).toBe('write_file');
    expect(resolveToolAlias('filewrite').resolved).toBe('write_file');
    expect(resolveToolAlias('create_file').resolved).toBe('write_file');
  });

  it('maps file_edit variants to edit_file', () => {
    expect(resolveToolAlias('file_edit').resolved).toBe('edit_file');
    expect(resolveToolAlias('str_replace').resolved).toBe('edit_file');
    expect(resolveToolAlias('str_replace_editor').resolved).toBe('edit_file');
  });

  it('maps list variants to list_dir', () => {
    expect(resolveToolAlias('file_list').resolved).toBe('list_dir');
    expect(resolveToolAlias('ls').resolved).toBe('list_dir');
    expect(resolveToolAlias('list_files').resolved).toBe('list_dir');
  });

  it('maps search variants to search_files', () => {
    expect(resolveToolAlias('search').resolved).toBe('search_files');
    expect(resolveToolAlias('grep').resolved).toBe('search_files');
    expect(resolveToolAlias('rg').resolved).toBe('search_files');
  });

  it('maps memory tools to vault', () => {
    expect(resolveToolAlias('memory_recall').resolved).toBe('vault_search');
    expect(resolveToolAlias('memory_store').resolved).toBe('vault_note');
  });

  it('returns original name for unknown tools', () => {
    const result = resolveToolAlias('some_custom_mcp_tool');
    expect(result.resolved).toBe('some_custom_mcp_tool');
    expect(result.wasAliased).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(resolveToolAlias('BASH').resolved).toBe('exec');
    expect(resolveToolAlias('Shell').resolved).toBe('exec');
    expect(resolveToolAlias('FILE_READ').resolved).toBe('read_file');
  });

  it('handles hyphens as underscores', () => {
    expect(resolveToolAlias('file-read').resolved).toBe('read_file');
    expect(resolveToolAlias('file-write').resolved).toBe('write_file');
    expect(resolveToolAlias('run-command').resolved).toBe('exec');
  });

  it('reports wasAliased correctly', () => {
    expect(resolveToolAlias('bash').wasAliased).toBe(true);
    expect(resolveToolAlias('exec').wasAliased).toBe(false);
    expect(resolveToolAlias('read_file').wasAliased).toBe(false);
  });

  it('does not alias canonical names', () => {
    // Canonical names should pass through unchanged
    for (const name of ['exec', 'read_file', 'write_file', 'edit_file', 'list_dir', 'search_files', 'apply_patch', 'spawn_task']) {
      const result = resolveToolAlias(name);
      expect(result.resolved).toBe(name);
      expect(result.wasAliased).toBe(false);
    }
  });
});

describe('defaultParamForTool', () => {
  it('returns command for exec and its aliases', () => {
    expect(defaultParamForTool('exec')).toBe('command');
    expect(defaultParamForTool('shell')).toBe('command');
    expect(defaultParamForTool('bash')).toBe('command');
  });

  it('returns path for file tools', () => {
    expect(defaultParamForTool('read_file')).toBe('path');
    expect(defaultParamForTool('write_file')).toBe('path');
    expect(defaultParamForTool('list_dir')).toBe('path');
    expect(defaultParamForTool('file_read')).toBe('path');
  });

  it('returns pattern for search', () => {
    expect(defaultParamForTool('search_files')).toBe('pattern');
    expect(defaultParamForTool('grep')).toBe('pattern');
  });

  it('returns input for unknown tools', () => {
    expect(defaultParamForTool('custom_tool')).toBe('input');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content-Mode Parsers: Aliasing Integration
// ─────────────────────────────────────────────────────────────────────────────

describe('parseToolCallsFromContent with aliasing', () => {
  it('aliases tool names in JSON content', () => {
    const content = '{"name": "bash", "arguments": {"command": "ls"}}';
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(1);
    expect(calls![0].function.name).toBe('exec');
  });

  it('aliases tool names in JSON array content', () => {
    const content = '[{"name": "file_read", "arguments": {"path": "a.txt"}}, {"name": "shell", "arguments": {"command": "pwd"}}]';
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(2);
    expect(calls![0].function.name).toBe('read_file');
    expect(calls![1].function.name).toBe('exec');
  });

  it('aliases tool names in XML content', () => {
    const content = '<tool_call><function=bash><parameter=command>ls</parameter></function></tool_call>';
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(1);
    // Note: XML parser resolves at the wrapper level, so check name
    expect(calls![0].function.name).toBe('exec');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// New Parsers
// ─────────────────────────────────────────────────────────────────────────────

describe('parseToolCallsFromContent — markdown tool_call blocks', () => {
  it('parses ```tool_call with JSON body', () => {
    const content = '```tool_call\n{"name": "shell", "arguments": {"command": "ls"}}\n```';
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(1);
    expect(calls![0].function.name).toBe('exec');
    const args = JSON.parse(calls![0].function.arguments);
    expect(args.command).toBe('ls');
  });

  it('parses ```tool <name> with JSON args', () => {
    const content = '```tool shell\n{"command": "uname -a"}\n```';
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(1);
    expect(calls![0].function.name).toBe('exec');
    const args = JSON.parse(calls![0].function.arguments);
    expect(args.command).toBe('uname -a');
  });
});

describe('parseToolCallsFromContent — invoke tags', () => {
  it('parses <invoke name="..."> with <parameter> children', () => {
    const content = '<invoke name="shell"><parameter name="command">ls -la</parameter></invoke>';
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(1);
    expect(calls![0].function.name).toBe('exec');
    const args = JSON.parse(calls![0].function.arguments);
    expect(args.command).toBe('ls -la');
  });

  it('parses <invoke> with JSON body (no parameter tags)', () => {
    const content = '<invoke name="file_read">{"path": "src/main.ts"}</invoke>';
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(1);
    expect(calls![0].function.name).toBe('read_file');
    const args = JSON.parse(calls![0].function.arguments);
    expect(args.path).toBe('src/main.ts');
  });

  it('handles multiple invoke tags', () => {
    const content = `
<invoke name="file_read"><parameter name="path">a.txt</parameter></invoke>
<invoke name="file_read"><parameter name="path">b.txt</parameter></invoke>
    `.trim();
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(2);
  });

  it('aliases tool names in invoke tags', () => {
    const content = '<invoke name="bash"><parameter name="command">pwd</parameter></invoke>';
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(1);
    expect(calls![0].function.name).toBe('exec');
  });
});

describe('parseToolCallsFromContent — GLM shortened format', () => {
  it('parses tool/param>value format', () => {
    const content = 'shell/command>ls -la';
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(1);
    expect(calls![0].function.name).toBe('exec');
    const args = JSON.parse(calls![0].function.arguments);
    expect(args.command).toBe('ls -la');
  });

  it('parses tool>value with default param', () => {
    const content = 'shell>uname -a';
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(1);
    expect(calls![0].function.name).toBe('exec');
    const args = JSON.parse(calls![0].function.arguments);
    expect(args.command).toBe('uname -a');
  });

  it('parses tool>JSON with full JSON args', () => {
    const content = 'exec>{"command": "npm test", "timeout": 30}';
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(1);
    expect(calls![0].function.name).toBe('exec');
    const args = JSON.parse(calls![0].function.arguments);
    expect(args.command).toBe('npm test');
    expect(args.timeout).toBe(30);
  });

  it('aliases tool names in GLM format', () => {
    const content = 'bash/command>pwd';
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(1);
    expect(calls![0].function.name).toBe('exec');
  });

  it('handles multiple GLM lines', () => {
    const content = 'file_read/path>a.txt\nfile_read/path>b.txt';
    const calls = parseToolCallsFromContent(content);
    expect(calls).toHaveLength(2);
    expect(calls![0].function.name).toBe('read_file');
    expect(calls![1].function.name).toBe('read_file');
  });
});
