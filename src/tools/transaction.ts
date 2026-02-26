/**
 * Multi-file edit transaction — tracks files modified during a turn
 * and provides atomic rollback via the existing backup system.
 */
import type { ToolContext } from '../tools.js';

export class EditTransaction {
  private modifiedFiles: string[] = [];
  private committed = false;

  /** Record a file that was just modified (called after successful backup + write). */
  track(absPath: string): void {
    if (!this.modifiedFiles.includes(absPath)) {
      this.modifiedFiles.push(absPath);
    }
  }

  /** Mark the transaction as committed (all edits succeeded). */
  commit(): void {
    this.committed = true;
  }

  /** Get list of files modified in this transaction. */
  get files(): string[] {
    return [...this.modifiedFiles];
  }

  /** Whether the transaction has any tracked files. */
  get hasChanges(): boolean {
    return this.modifiedFiles.length > 0;
  }

  /** Whether the transaction was committed. */
  get isCommitted(): boolean {
    return this.committed;
  }

  /**
   * Roll back all modified files to their pre-transaction state.
   * Uses the existing undo system (each file already has a backup).
   * Returns array of results.
   */
  async rollback(ctx: ToolContext): Promise<Array<{ path: string; ok: boolean; error?: string }>> {
    if (this.committed) {
      return this.modifiedFiles.map((p) => ({
        path: p,
        ok: false,
        error: 'Transaction already committed',
      }));
    }

    // Dynamic import to avoid circular deps
    const { undo_path } = await import('../tools.js');
    const results: Array<{ path: string; ok: boolean; error?: string }> = [];

    // Roll back in reverse order (last modified first)
    for (const absPath of [...this.modifiedFiles].reverse()) {
      try {
        await undo_path(ctx, { path: absPath });
        results.push({ path: absPath, ok: true });
      } catch (e: any) {
        results.push({ path: absPath, ok: false, error: e?.message ?? String(e) });
      }
    }

    return results;
  }

  /** Reset the transaction (clear tracked files). */
  reset(): void {
    this.modifiedFiles = [];
    this.committed = false;
  }
}
