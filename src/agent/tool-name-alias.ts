/**
 * Tool Name Aliasing
 *
 * Local and third-party models frequently hallucinate tool names — calling
 * `bash` instead of `exec`, `file_read` instead of `read_file`, etc.
 * This module maps common aliases to the canonical Idle Hands tool names.
 *
 * Inspired by ZeroClaw's `map_tool_name_alias()`.
 */

const ALIAS_MAP: Record<string, string> = {
  // ── exec ──────────────────────────────────────────────────────────────
  shell: 'exec',
  bash: 'exec',
  sh: 'exec',
  command: 'exec',
  cmd: 'exec',
  run: 'exec',
  execute: 'exec',
  terminal: 'exec',
  run_command: 'exec',
  run_shell: 'exec',
  execute_command: 'exec',

  // ── read_file ─────────────────────────────────────────────────────────
  file_read: 'read_file',
  fileread: 'read_file',
  readfile: 'read_file',
  cat: 'read_file',
  view_file: 'read_file',
  open_file: 'read_file',
  get_file: 'read_file',
  show_file: 'read_file',

  // ── read_files ────────────────────────────────────────────────────────
  file_reads: 'read_files',
  batch_read: 'read_files',

  // ── write_file ────────────────────────────────────────────────────────
  file_write: 'write_file',
  filewrite: 'write_file',
  writefile: 'write_file',
  create_file: 'write_file',
  save_file: 'write_file',

  // ── edit_file ─────────────────────────────────────────────────────────
  file_edit: 'edit_file',
  fileedit: 'edit_file',
  editfile: 'edit_file',
  replace: 'edit_file',
  str_replace: 'edit_file',
  str_replace_editor: 'edit_file',
  search_replace: 'edit_file',

  // ── edit_range ────────────────────────────────────────────────────────
  range_edit: 'edit_range',
  replace_range: 'edit_range',
  replace_lines: 'edit_range',
  edit_lines: 'edit_range',

  // ── insert_file ───────────────────────────────────────────────────────
  file_insert: 'insert_file',
  insert: 'insert_file',
  append_file: 'insert_file',
  prepend_file: 'insert_file',

  // ── list_dir ──────────────────────────────────────────────────────────
  file_list: 'list_dir',
  filelist: 'list_dir',
  listfiles: 'list_dir',
  list_files: 'list_dir',
  ls: 'list_dir',
  listdir: 'list_dir',
  directory_list: 'list_dir',
  list_directory: 'list_dir',

  // ── search_files ──────────────────────────────────────────────────────
  search: 'search_files',
  grep: 'search_files',
  find_files: 'search_files',
  file_search: 'search_files',
  ripgrep: 'search_files',
  rg: 'search_files',

  // ── apply_patch ───────────────────────────────────────────────────────
  patch: 'apply_patch',
  diff: 'apply_patch',
  apply_diff: 'apply_patch',

  // ── spawn_task ────────────────────────────────────────────────────────
  delegate: 'spawn_task',
  sub_agent: 'spawn_task',
  subagent: 'spawn_task',

  // ── vault_search ──────────────────────────────────────────────────────
  memory_recall: 'vault_search',
  recall: 'vault_search',

  // ── vault_note ────────────────────────────────────────────────────────
  memory_store: 'vault_note',
  store: 'vault_note',
};

/**
 * Resolve a tool name alias to the canonical Idle Hands tool name.
 * Returns the canonical name if an alias is found, or the original name
 * if no alias matches (case-insensitive lookup).
 */
export function resolveToolAlias(name: string): { resolved: string; wasAliased: boolean } {
  const normalized = name.trim().toLowerCase();
  const canonical = ALIAS_MAP[normalized];
  if (canonical) {
    return { resolved: canonical, wasAliased: true };
  }
  // Also check with underscores/hyphens normalized
  const dehyphenated = normalized.replace(/-/g, '_');
  const canonical2 = ALIAS_MAP[dehyphenated];
  if (canonical2) {
    return { resolved: canonical2, wasAliased: true };
  }
  return { resolved: name, wasAliased: false };
}

/**
 * Default parameter name for a given tool, used when parsing shortened
 * tool call formats (e.g., `shell>ls` → `{command: "ls"}`).
 */
export function defaultParamForTool(toolName: string): string {
  const resolved = resolveToolAlias(toolName).resolved;
  switch (resolved) {
    case 'exec':
      return 'command';
    case 'read_file':
    case 'read_files':
    case 'write_file':
    case 'edit_file':
    case 'edit_range':
    case 'insert_file':
    case 'list_dir':
      return 'path';
    case 'search_files':
      return 'pattern';
    case 'apply_patch':
      return 'patch';
    case 'vault_search':
      return 'query';
    case 'vault_note':
      return 'key';
    case 'spawn_task':
      return 'task';
    default:
      return 'input';
  }
}
