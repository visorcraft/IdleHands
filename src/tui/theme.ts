/**
 * TUI theme bridge — resolves the active theme into ANSI escape strings
 * for use by the raw-ANSI renderer (render.ts).
 *
 * The main theme system (src/themes.ts) uses picocolors functions.
 * TUI rendering uses raw escape codes for deterministic frame output.
 * This module bridges the two: it resolves the theme name, then maps
 * each slot to the corresponding ANSI SGR sequence.
 */

export interface TuiColors {
  dim: string;
  bold: string;
  red: string;
  yellow: string;
  green: string;
  cyan: string;
  magenta: string;
  blue: string;
  reset: string;
}

/** ANSI SGR codes for each color slot. */
const ANSI: Record<string, string> = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  inverse: '\x1b[7m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  black: '\x1b[30m',
};

/**
 * Theme palette definitions — mirrors the built-in palettes from src/themes.ts.
 * Each slot maps to one or more ANSI specifiers (joined with +).
 */
type Palette = Partial<Record<keyof Omit<TuiColors, 'reset'>, string>>;

const PALETTES: Record<string, Palette> = {
  default: {},
  dark: {
    cyan: 'bold+cyan',
    magenta: 'bold+magenta',
    blue: 'bold+blue',
  },
  light: {
    dim: 'gray',
    cyan: 'blue',
    blue: 'cyan',
  },
  minimal: {
    yellow: 'dim',
    green: 'dim',
    cyan: 'dim',
    magenta: 'dim',
    blue: 'dim',
  },
  hacker: {
    bold: 'bold+green',
    yellow: 'green',
    cyan: 'green',
    magenta: 'green',
    blue: 'green',
  },
};

const DEFAULTS: Record<keyof Omit<TuiColors, 'reset'>, string> = {
  dim: 'dim',
  bold: 'bold',
  red: 'red',
  yellow: 'yellow',
  green: 'green',
  cyan: 'cyan',
  magenta: 'magenta',
  blue: 'blue',
};

function resolveAnsi(spec: string): string {
  return spec
    .split('+')
    .map((p) => ANSI[p.trim()] ?? '')
    .join('');
}

/** Resolve a theme name to concrete ANSI escape strings. */
export function resolveTuiTheme(name?: string): TuiColors {
  const palette = PALETTES[name || 'default'] ?? PALETTES.default!;
  const colors = { reset: '\x1b[0m' } as TuiColors;
  for (const slot of Object.keys(DEFAULTS) as (keyof Omit<TuiColors, 'reset'>)[]) {
    colors[slot] = resolveAnsi(palette[slot] ?? DEFAULTS[slot]);
  }
  return colors;
}
