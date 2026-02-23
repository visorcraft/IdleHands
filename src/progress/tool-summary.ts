export type AnyArgs = Record<string, any>;

function truncate(s: string, n: number): string {
  const t = String(s ?? '');
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + '…';
}

/**
 * Shared human summary for tool calls used by all UIs.
 * Keep this stable and short — it will appear in TUI status and bot updates.
 */
export function formatToolCallSummary(call: { name: string; args: AnyArgs }): string {
  const name = call?.name ?? 'unknown';
  const args = (call as any)?.args ?? {};

  switch (name) {
    case 'read_file': {
      const p = args.path ?? '?';
      const parts: string[] = [`read_file ${p}`];
      if (args.search) parts.push(`search=${truncate(args.search, 48)}`);
      if (args.format) parts.push(`format=${args.format}`);
      if (args.max_bytes != null) parts.push(`max_bytes=${args.max_bytes}`);
      if (args.offset != null) parts.push(`offset=${args.offset}`);
      if (args.limit != null) parts.push(`limit=${args.limit}`);
      return parts.join(' ');
    }
    case 'read_files': {
      const n = Array.isArray(args.requests) ? args.requests.length : '?';
      return `read_files (${n} files)`;
    }
    case 'apply_patch': {
      const size = typeof args.patch === 'string' ? args.patch.length : 0;
      return `apply_patch (${size.toLocaleString()} chars)`;
    }
    case 'edit_range':
      return `edit_range ${args.path || '?'} [${args.start_line ?? '?'}..${args.end_line ?? '?'}]`;

    case 'write_file':
      return `write_file ${args.path || '?'}`;

    case 'insert_file':
      return `insert_file ${args.path || '?'} (line ${args.line ?? '?'})`;

    case 'edit_file':
      return `edit_file ${args.path || '?'}`;

    case 'list_dir':
      return `list_dir ${args.path || '.'}${args.recursive ? ' (recursive)' : ''}`;

    case 'search_files':
      return `search_files "${truncate(args.pattern || '?', 48)}" in ${args.path || '.'}`;

    case 'exec': {
      const cmd = String(args.command || '?')
        .replace(/\s+/g, ' ')
        .trim();
      return `exec: ${truncate(cmd, 90)}`;
    }

    case 'vault_search':
      return `vault_search "${truncate(args.query || '?', 48)}"`;

    default:
      return name;
  }
}
