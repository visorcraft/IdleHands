import type { ExecResult } from '../types.js';
import { BASH_PATH } from '../utils.js';

import { stripAnsi, dedupeRepeats, collapseStackTraces, truncateBytes } from './text-utils.js';

export type ExecWithPtyArgs = {
  pty: any;
  command: string;
  cwd: string;
  timeout: number;
  maxBytes: number;
  captureLimit: number;
  signal?: AbortSignal;
  execCwdWarning?: string;
};

export async function execWithPty(args: ExecWithPtyArgs): Promise<string> {
  const { pty, command, cwd, timeout, maxBytes, captureLimit, signal, execCwdWarning } = args;

  const proc = pty.spawn(BASH_PATH, ['-c', command], {
    name: 'xterm-color',
    cwd,
    cols: 120,
    rows: 30,
    env: process.env,
  });

  const chunks: string[] = [];
  let seen = 0;
  let captured = 0;
  let killed = false;

  const onDataDisposable = proc.onData((data: string) => {
    if (process.stdout.isTTY) process.stdout.write(data);

    const n = Buffer.byteLength(data, 'utf8');
    seen += n;

    const remaining = captureLimit - captured;
    if (remaining <= 0) return;

    if (n <= remaining) {
      chunks.push(data);
      captured += n;
    } else {
      const buf = Buffer.from(data, 'utf8');
      const slice = buf.subarray(0, remaining).toString('utf8');
      chunks.push(slice);
      captured += Buffer.byteLength(slice, 'utf8');
    }
  });

  const kill = () => {
    killed = true;
    try {
      proc.kill();
    } catch {
      // ignore
    }
  };

  const killTimer = setTimeout(kill, Math.max(1, timeout) * 1000);
  const onAbort = () => kill();
  signal?.addEventListener('abort', onAbort, { once: true });

  const rc: number = await new Promise((resolve) => {
    proc.onExit((e: any) => resolve(Number(e?.exitCode ?? 0)));
  });

  clearTimeout(killTimer);
  signal?.removeEventListener('abort', onAbort);
  onDataDisposable?.dispose?.();

  const raw = stripAnsi(chunks.join(''));
  const lines = collapseStackTraces(dedupeRepeats(raw.split(/\r?\n/)))
    .join('\n')
    .trimEnd();
  const outT = truncateBytes(lines, maxBytes, seen);

  let outText = outT.text;
  const cap = seen > captured;

  if (cap && !outT.truncated) {
    outText = truncateBytes(
      outText + `\n[capture truncated, ${seen} bytes total]`,
      maxBytes,
      seen
    ).text;
  }

  let errText = '';
  if (killed) {
    errText = `[killed after ${timeout}s timeout]`;
  }

  if (!outText && !errText && !killed) {
    if (rc === 0) {
      outText =
        '[command completed successfully with no output. Do NOT retry — the command worked but produced no output. Move on to the next step.]';
    } else if (rc === 1) {
      outText =
        '[no matches found — the command returned zero results (exit code 1). Do NOT retry this command with the same arguments. The target simply has no matches. Move on or try different search terms/parameters.]';
    } else {
      outText = `[command exited with code ${rc} and produced no output. Do NOT retry with identical arguments — diagnose the issue or try a different approach.]`;
    }
  }

  const result: ExecResult = {
    rc,
    out: outText,
    err: errText,
    truncated: outT.truncated || cap || killed,
    ...(execCwdWarning && { warnings: [execCwdWarning.trim()] }),
  };
  return JSON.stringify(result);
}
