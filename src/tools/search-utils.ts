import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

import { BASH_PATH } from '../utils.js';

/** Check if ripgrep is available either at /usr/bin/rg or in PATH. */
export async function hasRg(): Promise<boolean> {
  const isWin = process.platform === 'win32';
  if (!isWin) {
    try {
      await fs.access('/usr/bin/rg');
      return true;
    } catch {
      /* skip */
    }
  }

  return await new Promise<boolean>((resolve) => {
    const selector = isWin ? 'where' : 'command -v';
    const sub = isWin ? ['rg'] : ['-c', `${selector} rg >/dev/null 2>&1`];
    const cmd = isWin ? selector : BASH_PATH;

    const c = spawn(cmd, sub, { stdio: 'ignore' });
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
  });
}

/** Sørensen-Dice coefficient on character bigrams. Returns 0–1. */
export function bigramSimilarity(a: string, b: string): number {
  if (a.length < 2 && b.length < 2) return a === b ? 1 : 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bi = s.slice(i, i + 2);
      m.set(bi, (m.get(bi) ?? 0) + 1);
    }
    return m;
  };
  const aB = bigrams(a);
  const bB = bigrams(b);
  let overlap = 0;
  for (const [k, v] of aB) {
    overlap += Math.min(v, bB.get(k) ?? 0);
  }
  const total = a.length - 1 + (b.length - 1);
  return total > 0 ? (2 * overlap) / total : 0;
}

/** Very small glob matcher supporting exact and '*.ext'. */
export function globishMatch(name: string, glob: string): boolean {
  if (glob === name) return true;
  const m = /^\*\.(.+)$/.exec(glob);
  if (m) return name.endsWith('.' + m[1]);
  return false;
}
