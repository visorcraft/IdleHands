import type { CmdResult } from './command-logic.js';

export async function gitStatusCommand(cwd: string): Promise<CmdResult> {
  if (!cwd) return { error: 'No working directory set. Use /dir to set one.' };

  const { spawnSync } = await import('node:child_process');

  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  })
    .stdout?.trim()
    ?.replace(/^HEAD$/, '(detached)');

  const statusOut = spawnSync('git', ['status', '--short', '--branch'], {
    cwd,
    encoding: 'utf8',
  }).stdout;

  if (!statusOut) {
    return {
      lines: [`📁 ${cwd}`, `🌿 Branch: ${branch}`, '', '✅ Working tree clean'],
    };
  }

  const allLines = statusOut.split('\n');
  const lines = allLines.slice(0, 30);
  const truncated = allLines.length > 30;

  return {
    lines: [`📁 ${cwd}`, `🌿 Branch: ${branch}`],
    preformatted: lines.join('\n') + (truncated ? '\n...' : ''),
  };
}
