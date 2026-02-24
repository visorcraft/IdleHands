import { runCommand } from '../runtime/executor.js';

/** Filter lint output to include only error-level lines + file headers/summary. */
export function filterLintErrorLines(output: string): string {
  const lines = output.split('\n');
  const result: string[] = [];
  let lastFilePath = '';

  for (const line of lines) {
    if (/^\/.*\.\w+$/.test(line.trim()) || /^[A-Z]:\\/.test(line.trim())) {
      lastFilePath = line;
      continue;
    }
    if (
      /\d+:\d+\s+error\s/.test(line) ||
      /\berror\s+TS\d+/.test(line) ||
      /\berror\[E\d+\]/.test(line)
    ) {
      if (lastFilePath && (result.length === 0 || result[result.length - 1] !== lastFilePath)) {
        result.push(lastFilePath);
      }
      result.push(line);
    }
    if (/^\u2716\s+\d+\s+problem/.test(line) || /^\d+\s+error/.test(line)) {
      result.push(line);
    }
  }

  return result.join('\n');
}

/** Count lint errors across common tool output formats. */
export function countLintErrors(output: string): number {
  const lines = output.split('\n');
  let count = 0;
  for (const line of lines) {
    if (/\d+:\d+\s+error\s/.test(line)) {
      count++;
      continue;
    }
    if (/\berror\s+TS\d+/.test(line)) {
      count++;
      continue;
    }
    if (/\berror\[E\d+\]/.test(line)) {
      count++;
      continue;
    }
  }
  return count;
}

/** Capture baseline lint error count before Anton starts editing files. */
export async function captureLintBaseline(
  lintCommand: string | undefined,
  projectDir: string
): Promise<number | undefined> {
  if (!lintCommand) return undefined;
  try {
    const result = await runCommand(lintCommand, 180_000, projectDir);
    if (result.exitCode === 0) return 0;
    const count = countLintErrors(result.stdout + '\n' + result.stderr);
    if (count > 0) {
      console.error(`[anton:baseline] pre-existing lint errors: ${count}`);
    }
    return count;
  } catch {
    return undefined;
  }
}
