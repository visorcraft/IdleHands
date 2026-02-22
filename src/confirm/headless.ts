/**
 * HeadlessConfirmProvider — for CI/piped/non-interactive use.
 * Behavior depends on approval mode:
 *   - yolo: approve everything
 *   - auto-edit: approve file mutations, prompt-reject shell commands
 *   - reject: reject all mutating operations (--non-interactive)
 *   - default/plan: reject everything (can't prompt a non-interactive terminal)
 */

import type {
  ConfirmationProvider,
  ConfirmRequest,
  ApprovalMode,
  BlockedNotice,
} from '../types.js';

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'read_files',
  'list_dir',
  'search_files',
  'sys_context',
  'vault_search',
  'lsp_diagnostics',
  'lsp_symbols',
  'lsp_hover',
  'lsp_definition',
  'lsp_references',
]);

export class HeadlessConfirmProvider implements ConfirmationProvider {
  constructor(private mode: ApprovalMode) {}

  async confirm(opts: ConfirmRequest): Promise<boolean> {
    // Read-only tools are always approved
    if (READ_ONLY_TOOLS.has(opts.tool)) return true;

    switch (this.mode) {
      case 'yolo':
        return true;
      case 'auto-edit':
        // Auto-approve file edits/writes, reject shell commands
        return opts.tool !== 'exec';
      case 'reject':
        // Non-interactive reject mode: reject all mutating operations with a clear message
        console.error(
          `[non-interactive] rejected ${opts.tool}: ${opts.summary ?? '(no summary)'} — use --no-confirm to auto-approve`
        );
        return false;
      case 'default':
      case 'plan':
        // Non-interactive — can't prompt, so reject
        console.error(
          `[headless] rejected ${opts.tool}: ${opts.summary} (mode=${this.mode}, no TTY)`
        );
        return false;
    }
  }

  async showBlocked(opts: BlockedNotice): Promise<void> {
    console.error(`[headless] blocked ${opts.tool}: ${opts.reason}`);
  }
}
