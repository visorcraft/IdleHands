export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';
export const ENTER_ALT_SCREEN = '\x1b[?1049h';
export const LEAVE_ALT_SCREEN = '\x1b[?1049l';
export const CLEAR_SCREEN = '\x1b[2J\x1b[H';
export const ERASE_LINE = '\x1b[2K';

export interface TermCapabilities {
  altScreen: boolean;
  colors256: boolean;
  trueColor: boolean;
  unicode: boolean;
  rows: number;
  cols: number;
  term: string;
  isTmux: boolean;
  isScreen: boolean;
  isSsh: boolean;
}

export function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export function moveUp(n: number): string {
  return `\x1b[${n}A`;
}

export function probeTermCapabilities(): TermCapabilities {
  const term = process.env.TERM ?? '';
  const colorTerm = process.env.COLORTERM ?? '';
  return {
    altScreen: !term.startsWith('dumb'),
    colors256: term.includes('256color') || colorTerm !== '',
    trueColor: colorTerm === 'truecolor' || colorTerm === '24bit',
    unicode: !term.startsWith('dumb') && (process.env.LANG?.includes('UTF') ?? false),
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
    term,
    isTmux: !!process.env.TMUX,
    isScreen: term.startsWith('screen'),
    isSsh: !!process.env.SSH_TTY || !!process.env.SSH_CLIENT,
  };
}

export function validateTerminal(): { ok: boolean; reason?: string } {
  const caps = probeTermCapabilities();
  if (caps.term === 'dumb') return { ok: false, reason: 'dumb terminal — no cursor control' };
  if (caps.rows < 10) return { ok: false, reason: `terminal too short (${caps.rows} rows, need 10+)` };
  if (caps.cols < 40) return { ok: false, reason: `terminal too narrow (${caps.cols} cols, need 40+)` };
  return { ok: true };
}

export function enterFullScreen(): void {
  process.stdout.write(ENTER_ALT_SCREEN + CLEAR_SCREEN + HIDE_CURSOR);
}

export function leaveFullScreen(): void {
  process.stdout.write(SHOW_CURSOR + LEAVE_ALT_SCREEN);
}

export function clearScreen(): void {
  process.stdout.write(CLEAR_SCREEN);
}
