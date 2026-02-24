const LSP_TOOL_NAMES = [
  'lsp_diagnostics',
  'lsp_symbols',
  'lsp_hover',
  'lsp_definition',
  'lsp_references',
] as const;

const LSP_TOOL_NAME_SET = new Set<string>(LSP_TOOL_NAMES);

const FILE_MUTATION_TOOL_SET = new Set([
  'edit_file',
  'edit_range',
  'apply_patch',
  'write_file',
  'insert_file',
]);

export function isLspTool(name: string): boolean {
  return LSP_TOOL_NAME_SET.has(name);
}

export function isReadOnlyTool(name: string): boolean {
  return (
    name === 'read_file' ||
    name === 'read_files' ||
    name === 'list_dir' ||
    name === 'search_files' ||
    name === 'vault_search' ||
    name === 'sys_context' ||
    isLspTool(name)
  );
}

export function isMutationTool(name: string): boolean {
  return FILE_MUTATION_TOOL_SET.has(name);
}

/** Human-readable summary of what a blocked tool call would do. */
export function planModeSummary(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'write_file':
      return `write ${args.path ?? 'unknown'} (${typeof args.content === 'string' ? args.content.split('\n').length : '?'} lines)`;
    case 'apply_patch':
      return `apply patch to ${Array.isArray(args.files) ? args.files.length : '?'} file(s)`;
    case 'edit_range':
      return `edit ${args.path ?? 'unknown'} lines ${args.start_line ?? '?'}-${args.end_line ?? '?'}`;
    case 'edit_file':
      return `edit ${args.path ?? 'unknown'} (replace ${typeof args.old_text === 'string' ? args.old_text.split('\n').length : '?'} lines)`;
    case 'insert_file':
      return `insert into ${args.path ?? 'unknown'} at line ${args.line ?? '?'}`;
    case 'exec':
      return `run: ${typeof args.command === 'string' ? args.command.slice(0, 80) : 'unknown'}`;
    case 'spawn_task':
      return `spawn sub-agent task: ${typeof args.task === 'string' ? args.task.slice(0, 80) : 'unknown'}`;
    case 'vault_note':
      return `vault note: ${args.key ?? 'unknown'}`;
    default:
      return `${name}(${Object.keys(args).join(', ')})`;
  }
}
