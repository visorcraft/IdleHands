/**
 * Direct shell command execution and external editor prompt.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';

function pickEditor(configEditor?: string): string {
  const e = (configEditor || '').trim();
  if (e) return e;
  return process.env.EDITOR || process.env.VISUAL || 'nano';
}

export async function openEditorPrompt(initialText: string, configEditor?: string): Promise<{ ok: boolean; text?: string; reason?: string }> {
  const editor = pickEditor(configEditor);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-edit-'));
  const file = path.join(dir, 'prompt.md');
  await fs.writeFile(file, initialText, 'utf8');

  const res = spawnSync(editor, [file], { stdio: 'inherit' });

  const cleanup = async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  if (res.error) {
    await cleanup();
    return { ok: false, reason: `Failed to launch editor '${editor}': ${res.error.message}` };
  }
  if ((res.status ?? 0) !== 0) {
    await cleanup();
    return { ok: false, reason: `Editor exited with status ${res.status ?? 'unknown'}` };
  }

  const text = await fs.readFile(file, 'utf8').catch(() => '');
  await cleanup();

  if (!text.trim()) {
    return { ok: false, reason: 'Editor returned empty prompt. Cancelled.' };
  }
  return { ok: true, text };
}

export async function runDirectShellCommand(opts: {
  command: string;
  cwd: string;
  timeoutSec: number;
  onStart?: (proc: ChildProcessWithoutNullStreams) => void;
  onStop?: () => void;
}): Promise<{ rc: number; out: string; err: string; timedOut: boolean }> {
  const child = spawn('bash', ['-lc', opts.command], {
    cwd: opts.cwd,
    env: { ...process.env, IDLEHANDS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  opts.onStart?.(child);

  let out = '';
  let err = '';
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGKILL'); } catch {}
  }, Math.max(1, opts.timeoutSec) * 1000);

  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    out += text;
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    err += text;
    process.stderr.write(text);
  });

  return await new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.onStop?.();
      resolve({ rc: code ?? 1, out, err, timedOut });
    });
    child.on('error', (e: any) => {
      clearTimeout(timer);
      opts.onStop?.();
      err += `\n${String(e?.message ?? e)}`;
      resolve({ rc: 1, out, err, timedOut });
    });
  });
}
