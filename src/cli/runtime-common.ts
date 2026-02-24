import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type readline from 'node:readline/promises';

import { configDir } from '../utils.js';

export function runtimesFilePath(): string {
  return path.join(configDir(), 'runtimes.json');
}

export function isTTY(): boolean {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

export function printList<T>(items: T[]): void {
  if (process.stdout.isTTY) {
    console.table(items as any[]);
  } else {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n');
  }
}

export async function ask(rl: readline.Interface, prompt: string, fallback = ''): Promise<string> {
  const q = fallback ? `${prompt} [${fallback}]: ` : `${prompt}: `;
  const ans = (await rl.question(q)).trim();
  return ans || fallback;
}

export function runLocalCommand(
  command: string,
  timeoutSec = 5
): { ok: boolean; code: number | null; stdout: string; stderr: string } {
  const p = spawnSync('bash', ['-c', command], { encoding: 'utf8', timeout: timeoutSec * 1000 });
  return {
    ok: p.status === 0,
    code: p.status,
    stdout: p.stdout ?? '',
    stderr: p.stderr ?? '',
  };
}

export function usage(kind: 'hosts' | 'backends' | 'models'): void {
  console.log(
    `Usage:\n  idlehands ${kind}\n  idlehands ${kind} show <id>\n  idlehands ${kind} add\n  idlehands ${kind} edit <id>\n  idlehands ${kind} remove <id>\n  idlehands ${kind} validate\n  idlehands ${kind} test <id>\n  idlehands ${kind} doctor`
  );
}
