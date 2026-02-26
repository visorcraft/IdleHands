import { spawnSync } from 'node:child_process';
import type { CmdResult, ManagedLike } from './command-logic.js';

/**
 * /diff — Show a unified diff of uncommitted changes in the working directory.
 */
export function diffCommand(managed: ManagedLike): CmdResult {
  const cwd = managed.workingDir;

  // Check if it's a git repo
  const isGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    timeout: 5000,
    encoding: 'utf8',
  });
  if (isGit.status !== 0) {
    return { error: 'Not a git repository.' };
  }

  // Get diff (staged + unstaged)
  const diff = spawnSync('git', ['diff', 'HEAD', '--stat'], {
    cwd,
    timeout: 10000,
    encoding: 'utf8',
  });

  const output = (diff.stdout ?? '').trim();
  if (!output) {
    return { lines: ['No uncommitted changes.'] };
  }

  // Also get the full diff but cap it
  const fullDiff = spawnSync('git', ['diff', 'HEAD', '--no-color'], {
    cwd,
    timeout: 10000,
    encoding: 'utf8',
  });

  const fullOutput = (fullDiff.stdout ?? '').trim();
  const maxChars = 3000;
  const truncated = fullOutput.length > maxChars
    ? fullOutput.slice(0, maxChars) + '\n... (truncated)'
    : fullOutput;

  return {
    title: 'Uncommitted Changes',
    lines: [
      output,
      '',
      '```diff',
      truncated,
      '```',
    ],
  };
}
