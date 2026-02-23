/**
 * Minimal vi-mode editing layer for the readline REPL (Phase 14b).
 *
 * Implements a small, predictable subset of vi keybindings:
 * - Normal/Insert mode toggle
 * - Movement: h, l, w, b, 0, $, ^
 * - Editing: x, dd, i, a, A, I
 * - Yank/Paste: yy, p
 * - Mode switching: Escape → Normal, i/a/A/I → Insert
 *
 * Works alongside readline by intercepting keypress events
 * in Normal mode and passing through in Insert mode.
 */

import type readline from 'node:readline';

type VimMode = 'normal' | 'insert';

export interface VimState {
  mode: VimMode;
  yankBuffer: string;
  pendingKey: string; // for multi-char commands like dd, yy
}

export function createVimState(): VimState {
  return { mode: 'insert', yankBuffer: '', pendingKey: '' };
}

/**
 * Handle a keypress event in vim mode.
 * Returns true if the key was consumed (should not propagate),
 * false if it should propagate to readline normally.
 */
export function handleVimKeypress(
  state: VimState,
  rl: readline.Interface,
  ch: string | undefined,
  key:
    | { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }
    | undefined
): boolean {
  // Escape always switches to normal mode
  if (key?.name === 'escape') {
    state.mode = 'normal';
    state.pendingKey = '';
    return true;
  }

  // In insert mode, pass everything through except Escape
  if (state.mode === 'insert') {
    return false;
  }

  // --- Normal mode ---
  const line = getLine(rl);
  const cursor = getCursor(rl);
  const k = ch ?? key?.sequence ?? key?.name ?? '';

  // Multi-key commands
  if (state.pendingKey) {
    const combo = state.pendingKey + k;
    state.pendingKey = '';

    if (combo === 'dd') {
      state.yankBuffer = line;
      setLine(rl, '', 0);
      return true;
    }
    if (combo === 'yy') {
      state.yankBuffer = line;
      return true;
    }
    // Unknown combo — ignore
    return true;
  }

  // Start of multi-key sequences
  if (k === 'd' || k === 'y') {
    state.pendingKey = k;
    return true;
  }

  // Movement
  if (k === 'h' || key?.name === 'left') {
    if (cursor > 0) setCursor(rl, cursor - 1);
    return true;
  }
  if (k === 'l' || key?.name === 'right') {
    if (cursor < line.length) setCursor(rl, cursor + 1);
    return true;
  }
  if (k === '0') {
    setCursor(rl, 0);
    return true;
  }
  if (k === '$') {
    setCursor(rl, line.length);
    return true;
  }
  if (k === '^') {
    const m = line.match(/^\s*/);
    setCursor(rl, m ? m[0].length : 0);
    return true;
  }
  if (k === 'w') {
    const after = line.slice(cursor);
    const m = after.match(/^\S*\s*/);
    const jump = m ? m[0].length : 0;
    setCursor(rl, Math.min(cursor + (jump || 1), line.length));
    return true;
  }
  if (k === 'b') {
    const before = line.slice(0, cursor);
    const m = before.match(/\s*\S*$/);
    const jump = m ? m[0].length : 0;
    setCursor(rl, Math.max(cursor - (jump || 1), 0));
    return true;
  }

  // Editing
  if (k === 'x') {
    if (cursor < line.length) {
      const newLine = line.slice(0, cursor) + line.slice(cursor + 1);
      // In vi, x at end of line moves cursor back to last char
      const newCursor = Math.min(cursor, Math.max(0, newLine.length - 1));
      setLine(rl, newLine, newCursor);
    }
    return true;
  }

  // Mode switches to insert
  if (k === 'i') {
    state.mode = 'insert';
    return true;
  }
  if (k === 'a') {
    state.mode = 'insert';
    if (cursor < line.length) setCursor(rl, cursor + 1);
    return true;
  }
  if (k === 'A') {
    state.mode = 'insert';
    setCursor(rl, line.length);
    return true;
  }
  if (k === 'I') {
    state.mode = 'insert';
    const m = line.match(/^\s*/);
    setCursor(rl, m ? m[0].length : 0);
    return true;
  }

  // Paste — vi `p` pastes after cursor, cursor lands on last pasted char
  if (k === 'p') {
    if (state.yankBuffer) {
      const newLine = line.slice(0, cursor + 1) + state.yankBuffer + line.slice(cursor + 1);
      const newCursor = cursor + state.yankBuffer.length;
      setLine(rl, newLine, newCursor);
    }
    return true;
  }

  // Unknown normal-mode key — consume silently
  return true;
}

// --- Internal readline manipulation ---

function getLine(rl: readline.Interface): string {
  return String((rl as any).line ?? '');
}

function getCursor(rl: readline.Interface): number {
  return (rl as any).cursor ?? 0;
}

/**
 * Set line content and cursor atomically by directly mutating readline
 * internals. Avoids rl.write() which emits synthetic keystrokes and can
 * race with the keypress listener.
 */
function setLine(rl: readline.Interface, text: string, cursorPos?: number): void {
  (rl as any).line = text;
  const pos = cursorPos ?? text.length;
  (rl as any).cursor = Math.max(0, Math.min(pos, text.length));
  try {
    (rl as any)._refreshLine?.();
  } catch {}
}

function setCursor(rl: readline.Interface, pos: number): void {
  (rl as any).cursor = Math.max(0, Math.min(pos, getLine(rl).length));
  // Force readline to refresh the display
  try {
    (rl as any)._refreshLine?.();
  } catch {}
}
