import pc from 'picocolors';

import type { ThemeFns } from './themes.js';

type ColorMode = 'auto' | 'always' | 'never';

export function resolveColorMode(mode: ColorMode): { enabled: boolean } {
  const env = process.env;

  // Standard opt-out
  if ('NO_COLOR' in env) return { enabled: false };

  // Explicit force/disable
  if (env.FORCE_COLOR === '0') return { enabled: false };
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return { enabled: true };

  if (mode === 'always') return { enabled: true };
  if (mode === 'never') return { enabled: false };

  // auto
  return { enabled: !!process.stdout.isTTY };
}

export type Styler = {
  enabled: boolean;
  dim: (s: string) => string;
  bold: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
  cyan: (s: string) => string;
  magenta: (s: string) => string;
  blue: (s: string) => string;
};

export function makeStyler(enabled: boolean, theme?: ThemeFns): Styler {
  const wrap = (fn: (s: string) => string) => (s: string) => (enabled ? fn(s) : s);
  const t = theme;
  return {
    enabled,
    dim: wrap(t?.dim ?? pc.dim),
    bold: wrap(t?.bold ?? pc.bold),
    red: wrap(t?.red ?? pc.red),
    yellow: wrap(t?.yellow ?? pc.yellow),
    green: wrap(t?.green ?? pc.green),
    cyan: wrap(t?.cyan ?? pc.cyan),
    magenta: wrap(t?.magenta ?? pc.magenta),
    blue: wrap(t?.blue ?? pc.blue),
  };
}

export function colorizeUnifiedDiff(diff: string, s: Styler): string {
  const out: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      out.push(s.dim(line));
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      out.push(s.green(line));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      out.push(s.red(line));
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

export function banner(title: string, s: Styler): string {
  return s.blue(s.bold(title));
}

export function warn(msg: string, s: Styler): string {
  return s.yellow('WARN') + s.dim(': ') + msg;
}

export function err(msg: string, s: Styler): string {
  return s.red('ERROR') + s.dim(': ') + msg;
}
