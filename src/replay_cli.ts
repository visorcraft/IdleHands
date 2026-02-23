import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Re-export atomicWrite from tools for use by index.ts /rewind command
export { atomicWrite } from './tools.js';

export async function unifiedDiffFromBuffers(before: Buffer, after: Buffer): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-diff-'));
  const aPath = path.join(tmpDir, 'before');
  const bPath = path.join(tmpDir, 'after');
  await fs.writeFile(aPath, before);
  await fs.writeFile(bPath, after);

  const out = await new Promise<string>((resolve) => {
    const p = spawn('git', ['diff', '--no-index', '--text', '--', aPath, bPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let s = '';
    p.stdout.on('data', (d) => (s += d.toString('utf8')));
    p.stderr.on('data', () => {}); // discard stderr (git warnings)
    p.on('close', () => resolve(s));
    p.on('error', () => resolve(''));
  });

  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  return out.trimEnd();
}
