/**
 * TerminalConfirmProvider — interactive readline-based confirmation.
 * Implements Phase 8c: diff preview, shell prompts, remembered decisions.
 */

import type { Interface as ReadlineInterface } from 'node:readline/promises';

import type { ConfirmationProvider, ConfirmRequest, BlockedNotice } from '../types.js';

export class TerminalConfirmProvider implements ConfirmationProvider {
  /**
   * Remembered decisions: keyed by tool+identifier.
   * If a user approves `exec:npm test` once, we auto-approve it for the rest of the session.
   */
  private remembered = new Map<string, boolean>();

  constructor(private rl: ReadlineInterface) {}

  async confirm(opts: ConfirmRequest): Promise<boolean> {
    // Check remembered decisions
    const memKey = this.memoryKey(opts);
    if (memKey && this.remembered.has(memKey)) {
      const decision = this.remembered.get(memKey)!;
      const tag = decision ? '✓' : '✗';
      console.error(`\x1b[2m[remembered ${tag}] ${opts.summary}\x1b[0m`);
      return decision;
    }

    const hasDiff = Boolean(opts.diff);
    const prompt = this.formatPrompt(opts, hasDiff);
    const ans = (await this.rl.question(prompt)).trim().toLowerCase();

    // Handle diff request
    if (hasDiff && (ans === 'd' || ans === 'diff')) {
      console.log(opts.diff);
      // Re-prompt after showing diff
      const ans2 = (await this.rl.question('Apply? [Y/n] ')).trim().toLowerCase();
      const approved = ans2 === '' || ans2 === 'y' || ans2 === 'yes';
      if (memKey) this.remembered.set(memKey, approved);
      return approved;
    }

    const approved = ans === '' || ans === 'y' || ans === 'yes';
    if (memKey) this.remembered.set(memKey, approved);
    return approved;
  }

  async showBlocked(opts: BlockedNotice): Promise<void> {
    console.error(`\x1b[31m[blocked]\x1b[0m ${opts.tool}: ${opts.reason}`);
  }

  /** Clear remembered decisions (e.g. on session reset). */
  clearRemembered(): void {
    this.remembered.clear();
  }

  /**
   * Generate a memory key for a tool+args combination.
   * - exec: keyed by command string
   * - file tools: keyed by path
   * - other: null (don't remember)
   */
  private memoryKey(opts: ConfirmRequest): string | null {
    if (opts.tool === 'exec') {
      const cmd = typeof opts.args.command === 'string' ? opts.args.command : '';
      return cmd ? `exec:${cmd}` : null;
    }
    if (opts.tool === 'edit_file' || opts.tool === 'write_file' || opts.tool === 'insert_file') {
      const p = typeof opts.args.path === 'string' ? opts.args.path : '';
      return p ? `${opts.tool}:${p}` : null;
    }
    return null;
  }

  private formatPrompt(opts: ConfirmRequest, hasDiff: boolean): string {
    if (opts.tool === 'exec') {
      const cmd = typeof opts.args.command === 'string' ? opts.args.command : opts.summary;
      return this.boxedPrompt(`Run: ${cmd}`, '[Y/n]');
    }
    if (hasDiff) {
      // Show summary with diff option
      return this.boxedPrompt(opts.summary, '[Y/n/diff]');
    }
    return this.boxedPrompt(opts.summary, '[Y/n]');
  }

  /** Format a boxed prompt: ┌─ summary ─┐ with action hints */
  private boxedPrompt(summary: string, suffix: string): string {
    const maxW = Math.min(process.stdout.columns ?? 80, 80);
    const inner = summary.length > maxW - 6 ? summary.slice(0, maxW - 9) + '...' : summary;
    const border = '─'.repeat(Math.max(inner.length + 2, 20));
    const lines = [`┌${border}┐`, `│ ${inner.padEnd(border.length - 1)}│`, `└${border}┘`];
    return `${lines.join('\n')}\n${suffix} `;
  }
}
