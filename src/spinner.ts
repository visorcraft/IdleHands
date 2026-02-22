/**
 * CLI spinner and tool call visualization (Phase 7).
 *
 * Shows an animated spinner while waiting for the first token,
 * then transitions to streaming text. Tool calls get one-line
 * summaries before and after execution.
 */

import type { Styler } from './term.js';
import type { ToolCallEvent, ToolResultEvent } from './types.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL = 80; // ms per frame

export class CliSpinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();
  private currentTool: string | null = null;
  private firstDelta = false;
  private enabled: boolean;
  private verbose: boolean;
  private S: Styler;

  constructor(opts: { styler: Styler; enabled?: boolean; verbose?: boolean }) {
    this.S = opts.styler;
    this.enabled = opts.enabled !== false && process.stdout.isTTY === true;
    this.verbose = opts.verbose ?? false;
  }

  /** Start the spinner. Call before ask(). */
  start(): void {
    if (!this.enabled) return;
    this.startTime = Date.now();
    this.frame = 0;
    this.firstDelta = false;
    this.currentTool = null;
    // In dumb terminals, print a single status line instead of animated frames
    if (process.env.TERM === 'dumb' || !process.stderr.isTTY) {
      process.stderr.write(this.S.dim('  Waiting for response...\n'));
      return;
    }
    this.timer = setInterval(() => this.render(), INTERVAL);
  }

  /** Called on first token — stop spinner, let streaming begin. */
  onFirstDelta(): void {
    if (this.firstDelta) return;
    this.firstDelta = true;
    this.clearLine();
    this.stopTimer();
  }

  /** Called before a tool executes. */
  onToolCall(event: ToolCallEvent): void {
    if (!this.enabled) {
      // Fallback for non-TTY
      process.stderr.write(`◆ ${event.name} ${this.argSummary(event)}\n`);
      return;
    }
    this.clearLine();
    this.stopTimer();

    const summary = this.argSummary(event);
    const dim = this.S.dim;
    process.stderr.write(dim(`  ◆ ${event.name} ${summary}`));
    process.stderr.write('\n');

    // Restart spinner for tool execution
    this.currentTool = event.name;
    this.startTime = Date.now();
    if (process.env.TERM !== 'dumb' && process.stderr.isTTY) {
      this.timer = setInterval(() => this.render(), INTERVAL);
    }
  }

  /** Called after a tool completes. */
  onToolResult(event: ToolResultEvent): void {
    this.clearLine();
    this.stopTimer();
    this.currentTool = null;

    if (!this.enabled) {
      const icon = event.success ? '✓' : '✗';
      process.stderr.write(`  ${icon} ${event.name}: ${event.summary}\n`);
      return;
    }

    const icon = event.success ? this.S.green('✓') : this.S.red('✗');
    const summary =
      event.summary.length > 120 ? event.summary.slice(0, 117) + '...' : event.summary;
    process.stderr.write(`  ${icon} ${this.S.dim(`${event.name}: ${summary}`)}\n`);

    // Phase 7: rich display (only in verbose mode or for key outputs)
    if (this.verbose) {
      this.renderRichOutput(event);
    } else {
      // In normal mode, show compact exec output and diffs
      if (event.diff) {
        this.renderDiff(event.diff);
      }
      if (event.execOutput) {
        this.renderExecOutput(event.execOutput, 5);
      }
      if (event.searchMatches?.length) {
        this.renderSearchMatches(event.searchMatches, 5);
      }
    }
  }

  /** Render rich output in verbose mode. */
  private renderRichOutput(event: ToolResultEvent): void {
    if (event.diff) {
      this.renderDiff(event.diff);
    }
    if (event.execOutput) {
      this.renderExecOutput(event.execOutput, 20);
    }
    if (event.searchMatches?.length) {
      this.renderSearchMatches(event.searchMatches, 20);
    }
  }

  /** Render an inline colored diff (unified format). */
  private renderDiff(diff: string): void {
    const lines = diff.split('\n');
    for (const line of lines) {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
        process.stderr.write(`    ${this.S.dim(line)}\n`);
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        process.stderr.write(`    ${this.S.green(line)}\n`);
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        process.stderr.write(`    ${this.S.red(line)}\n`);
      } else if (line.startsWith('[+')) {
        process.stderr.write(`    ${this.S.dim(line)}\n`);
      } else {
        process.stderr.write(`    ${this.S.dim(line)}\n`);
      }
    }
  }

  /** Render exec stdout (dimmed, limited lines). */
  private renderExecOutput(output: string, maxLines: number): void {
    const lines = output.split('\n');
    const show = lines.slice(0, maxLines);
    for (const line of show) {
      process.stderr.write(`    ${this.S.dim(line)}\n`);
    }
    if (lines.length > maxLines) {
      process.stderr.write(`    ${this.S.dim(`[+${lines.length - maxLines} more lines]`)}\n`);
    }
  }

  /** Render search matches with highlights. */
  private renderSearchMatches(matches: string[], maxLines: number): void {
    const show = matches.slice(0, maxLines);
    for (const match of show) {
      // Format: "file:line:content" — highlight the file:line prefix
      const idx = match.indexOf(':');
      if (idx > 0) {
        const nextIdx = match.indexOf(':', idx + 1);
        if (nextIdx > 0) {
          const prefix = match.slice(0, nextIdx + 1);
          const content = match.slice(nextIdx + 1);
          process.stderr.write(`    ${this.S.cyan(prefix)}${this.S.dim(content)}\n`);
          continue;
        }
      }
      process.stderr.write(`    ${this.S.dim(match)}\n`);
    }
    if (matches.length > maxLines) {
      process.stderr.write(`    ${this.S.dim(`[+${matches.length - maxLines} more matches]`)}\n`);
    }
  }

  /** Stop spinner completely. Call after ask() returns. */
  stop(): void {
    this.clearLine();
    this.stopTimer();
  }

  private render(): void {
    if (this.firstDelta && !this.currentTool) return;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const f = FRAMES[this.frame % FRAMES.length];
    this.frame++;

    let text: string;
    if (this.currentTool) {
      text = `${f} Running ${this.currentTool}... (${elapsed}s)`;
    } else {
      text = `${f} Thinking... (${elapsed}s)`;
    }

    process.stderr.write(`\r${this.S.dim(text)}`);
  }

  private clearLine(): void {
    if (!this.enabled) return;
    process.stderr.write('\r\x1b[K');
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private argSummary(event: ToolCallEvent): string {
    const a = event.args;
    switch (event.name) {
      case 'read_file': {
        const p = a.path ?? a.file_path ?? '';
        const range =
          a.offset && a.limit ? ` (lines ${a.offset}-${Number(a.offset) + Number(a.limit)})` : '';
        const search = a.search ? ` search="${a.search}"` : '';
        return `${p}${range}${search}`;
      }
      case 'write_file':
        return `${a.path ?? a.file_path ?? ''}`;
      case 'apply_patch': {
        const n = Array.isArray(a.files) ? a.files.length : '?';
        return `${n} file(s)`;
      }
      case 'edit_range': {
        const p = a.path ?? a.file_path ?? '';
        return `${p} lines ${a.start_line ?? '?'}-${a.end_line ?? '?'}`;
      }
      case 'edit_file': {
        const p = a.path ?? a.file_path ?? '';
        const old = typeof a.old_string === 'string' ? a.old_string : '';
        const lines = old.split('\n').length;
        return `${p} (replacing ${lines} line${lines !== 1 ? 's' : ''})`;
      }
      case 'insert_file':
        return `${a.path ?? a.file_path ?? ''} at line ${a.line ?? '?'}`;
      case 'exec': {
        const cmd = typeof a.command === 'string' ? a.command : '';
        return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
      }
      case 'list_dir':
        return `${a.path ?? '.'}`;
      case 'search_files':
        return `"${a.pattern ?? ''}" in ${a.path ?? '.'}`;
      case 'undo_path':
        return `${a.path ?? '(last edit)'}`;
      default:
        return Object.keys(a)
          .slice(0, 3)
          .map((k) => `${k}=${JSON.stringify(a[k]).slice(0, 30)}`)
          .join(' ');
    }
  }
}
