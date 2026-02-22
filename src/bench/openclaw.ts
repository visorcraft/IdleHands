#!/usr/bin/env node
// NOTE: These utilities are intentionally duplicated from src/ to keep the
// benchmark harness self-contained and free of production import dependencies.

import { spawn } from 'node:child_process';

function nowMs() {
  return performance.now();
}

export async function runOpenclaw(opts: {
  workDir: string;
  instruction: string;
  timeoutSec: number;
  sessionId: string;
  local?: boolean;
  profile?: string;
}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  ttfrMs: number | null;
  ttcMs: number;
}> {
  const t0 = nowMs();
  let ttfr: number | null = null;

  const prefix =
    `Work in directory: ${opts.workDir}.\n` +
    `Use absolute paths OR set cwd explicitly when using exec.\n` +
    `Do not modify files outside that directory.\n\n`;

  const args = [
    'agent',
    ...(opts.local ? ['--local'] : []),
    '--agent',
    'main',
    '--channel',
    'last',
    '--thinking',
    'off',
    '--timeout',
    String(opts.timeoutSec),
    '--session-id',
    opts.sessionId,
    '--verbose',
    'off',
    '--json',
    '--message',
    prefix +
      `IMPORTANT: for ANY command execution, you MUST run it as:\n` +
      `  bash -lc 'cd ${opts.workDir} && <command>'\n` +
      `Do NOT run commands without the 'cd ${opts.workDir} &&' prefix.\n\n` +
      opts.instruction,
  ];

  const binArgs = [] as string[];
  if (opts.profile) {
    binArgs.push('--profile', opts.profile);
  }
  binArgs.push(...args);

  const child = spawn('openclaw', binArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Ensure the OpenClaw CLI uses the same pinned Halo model/provider.
      // (We generate this config in bench to keep apples-to-apples with Idle Hands.)
      OPENCLAW_CONFIG_PATH:
        process.env.OPENCLAW_CONFIG_PATH || '/home/user/.openclaw-idlehands-bench/openclaw.json',
    },
  });

  const killTimer = setTimeout(
    () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    },
    Math.max(1, opts.timeoutSec + 10) * 1000
  );

  const out: Buffer[] = [];
  const err: Buffer[] = [];

  const mark = () => {
    if (ttfr == null) ttfr = nowMs() - t0;
  };

  child.stdout.on('data', (d) => {
    mark();
    out.push(d);
  });
  child.stderr.on('data', (d) => {
    mark();
    err.push(d);
  });

  const exitCode = await new Promise<number>((resolve) =>
    child.on('close', (code) => resolve(code ?? 0))
  );
  clearTimeout(killTimer);
  const t1 = nowMs();

  const stdout = Buffer.concat(out).toString('utf8');
  const stderr = Buffer.concat(err).toString('utf8');

  return {
    exitCode,
    stdout,
    stderr,
    ttfrMs: ttfr,
    ttcMs: t1 - t0,
  };
}
