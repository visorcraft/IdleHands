/**
 * Built-in and custom theme system (Phase 14a).
 *
 * Themes are ANSI color palette mappings applied to the Styler.
 * Each theme remaps the Styler's color slots (red, yellow, green,
 * cyan, magenta, blue, dim, bold) to different picocolors functions.
 *
 * Built-in: default, dark, light, minimal, hacker
 * Custom:   ~/.config/idlehands/themes/<name>.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import pc from 'picocolors';

import { configDir } from './utils.js';

/** Color slot names that a theme can remap. */
type ColorSlot = 'dim' | 'bold' | 'red' | 'yellow' | 'green' | 'cyan' | 'magenta' | 'blue';

/** A resolved theme: each slot maps to an actual color function. */
export type ThemeFns = Record<ColorSlot, (s: string) => string>;

/**
 * Raw palette definition (JSON-safe).
 * Each key maps a Styler slot to a picocolors function name
 * or a composite like "bold+cyan".
 */
type ThemePalette = Partial<Record<ColorSlot, string>>;

// All supported picocolors primitives.
const PC: Record<string, (s: string) => string> = {
  dim: pc.dim,
  bold: pc.bold,
  italic: pc.italic,
  underline: pc.underline,
  inverse: pc.inverse,
  red: pc.red,
  yellow: pc.yellow,
  green: pc.green,
  cyan: pc.cyan,
  magenta: pc.magenta,
  blue: pc.blue,
  white: pc.white,
  gray: pc.gray,
  black: pc.black,
};

/** Resolve a palette string like "bold+cyan" to a composed function. */
function resolveColor(spec: string): ((s: string) => string) | undefined {
  const parts = spec.split('+').map((p) => p.trim().toLowerCase());
  const fns = parts.map((p) => PC[p]).filter(Boolean);
  if (fns.length === 0) return undefined;
  if (fns.length === 1) return fns[0];
  return (s: string) => fns.reduce((acc, fn) => fn(acc), s);
}

/** The default (identity) palette — no remapping. */
const DEFAULT_PALETTE: Required<ThemePalette> = {
  dim: 'dim',
  bold: 'bold',
  red: 'red',
  yellow: 'yellow',
  green: 'green',
  cyan: 'cyan',
  magenta: 'magenta',
  blue: 'blue',
};

const BUILTIN_PALETTES: Record<string, ThemePalette> = {
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

export const BUILTIN_THEME_NAMES = Object.keys(BUILTIN_PALETTES);

/** Resolve a raw palette to concrete functions, falling back to defaults. */
export function resolvePalette(palette: ThemePalette): ThemeFns {
  const out = {} as ThemeFns;
  for (const slot of Object.keys(DEFAULT_PALETTE) as ColorSlot[]) {
    const spec = palette[slot] ?? DEFAULT_PALETTE[slot];
    const fn = resolveColor(spec);
    out[slot] = fn ?? PC[DEFAULT_PALETTE[slot]];
  }
  return out;
}

/** Get a built-in theme's resolved functions. */
export function builtinTheme(name: string): ThemeFns | undefined {
  const p = BUILTIN_PALETTES[name];
  if (!p) return undefined;
  return resolvePalette(p);
}

/** Custom themes directory. */
export function customThemesDir(): string {
  return path.join(configDir(), 'themes');
}

/** Load a custom theme from ~/.config/idlehands/themes/<name>.json */
export async function loadCustomTheme(name: string): Promise<ThemeFns | undefined> {
  const filePath = path.join(customThemesDir(), `${name}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    return resolvePalette(parsed as ThemePalette);
  } catch {
    return undefined;
  }
}

/** Resolve a theme by name: built-in first, then custom file. */
export async function resolveTheme(name: string): Promise<ThemeFns | undefined> {
  const builtin = builtinTheme(name);
  if (builtin) return builtin;
  return loadCustomTheme(name);
}

/** List available theme names (built-in + custom). */
export async function listThemes(): Promise<{ builtin: string[]; custom: string[] }> {
  const builtin = [...BUILTIN_THEME_NAMES];
  const custom: string[] = [];
  try {
    const dir = customThemesDir();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.json')) {
        custom.push(e.name.replace(/\.json$/, ''));
      }
    }
  } catch {
    // no custom themes dir
  }
  return { builtin, custom };
}
