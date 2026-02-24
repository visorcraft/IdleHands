import fs from 'node:fs/promises';
import path from 'node:path';

import { runAnton } from '../anton/controller.js';
import { parseTaskFile } from '../anton/parser.js';
import { formatRunSummary, formatProgressBar } from '../anton/reporter.js';
import { firstToken } from '../cli/command-utils.js';

import { buildAntonRunConfig, makeAntonProgress } from './anton-run.js';
import { summarizeLoopEvent } from './anton-status-format.js';
import type { CmdResult, ManagedLike } from './command-logic.js';

export function antonStatusCommand(managed: ManagedLike): CmdResult {
  if (!managed.antonActive) return { lines: ['No Anton run in progress.'] };

  if (managed.antonAbortSignal?.aborted) {
    return { lines: ['🛑 Anton is stopping. Please wait for the current attempt to unwind.'] };
  }

  if (managed.antonProgress) {
    const line1 = formatProgressBar(managed.antonProgress);
    const lines = [line1];

    if (managed.antonProgress.currentTask) {
      lines.push(
        '',
        `Working on: ${managed.antonProgress.currentTask} (Attempt ${managed.antonProgress.currentAttempt})`
      );
    }

    if (managed.antonLastLoopEvent) {
      lines.push('', summarizeLoopEvent(managed.antonLastLoopEvent));
    }

    return { lines };
  }

  if (managed.antonLastLoopEvent) {
    return {
      lines: [
        '🤖 Anton is running (no progress data yet).',
        '',
        summarizeLoopEvent(managed.antonLastLoopEvent),
      ],
    };
  }

  return { lines: ['🤖 Anton is running (no progress data yet).'] };
}

export function antonStopCommand(managed: ManagedLike): CmdResult {
  if (!managed.antonActive || !managed.antonAbortSignal) {
    return { lines: ['No Anton run in progress.'] };
  }
  managed.lastActivity = Date.now();
  managed.antonAbortSignal.aborted = true;
  return { success: '🛑 Anton stop requested. Run will halt after the current task.' };
}

export function antonLastCommand(managed: ManagedLike): CmdResult {
  if (!managed.antonLastResult) return { lines: ['No previous Anton run.'] };
  return { lines: [formatRunSummary(managed.antonLastResult)] };
}

export function antonHelpCommand(): CmdResult {
  return {
    title: '/anton — Autonomous task runner',
    lines: [
      '/anton <file> — Start run',
      '/anton status — Show progress',
      '/anton stop — Stop running',
      '/anton last — Last run results',
    ],
  };
}

/**
 * Prepare and start an Anton run. Returns a CmdResult for the initial message,
 * or an error CmdResult. The run itself proceeds asynchronously.
 */
export async function antonStartCommand(
  managed: ManagedLike,
  args: string,
  send: (text: string) => void,
  rateLimitMs: number
): Promise<CmdResult> {
  const sub = firstToken(args);
  const filePart = sub === 'run' ? args.replace(/^\S+\s*/, '').trim() : args;

  if (!filePart) return antonHelpCommand();

  if (managed.antonActive) {
    const staleMs = Date.now() - managed.lastActivity;
    if (staleMs > 120_000) {
      managed.antonActive = false;
      managed.antonAbortSignal = null;
      managed.antonProgress = null;
      managed.antonLastLoopEvent = null;
      send('♻️ Recovered stale Anton run state. Starting a fresh run...');
    } else {
      const msg = managed.antonAbortSignal?.aborted
        ? '🛑 Anton is still stopping. Please wait a moment, then try again.'
        : '⚠️ Anton is already running. Use /anton stop first.';
      return { error: msg };
    }
  }

  const cwd = managed.workingDir || managed.config.dir || process.cwd();
  const filePath = path.resolve(cwd, filePart);

  try {
    await fs.stat(filePath);
  } catch {
    return { error: `File not found: ${filePath}` };
  }

  const defaults = managed.config.anton || {};
  const runConfig = buildAntonRunConfig(defaults, cwd, filePath);

  const abortSignal = { aborted: false };
  managed.antonActive = true;
  managed.antonAbortSignal = abortSignal;
  managed.antonProgress = null;
  managed.antonLastLoopEvent = null;

  const progress = makeAntonProgress(managed, defaults, send, rateLimitMs);

  let pendingCount = 0;
  try {
    const tf = await parseTaskFile(filePath);
    pendingCount = tf.pending.length;
  } catch {
    /* non-fatal */
  }

  runAnton({
    config: runConfig,
    idlehandsConfig: managed.config,
    progress,
    abortSignal,
    vault: managed.session.vault as any,
    lens: managed.session.lens as any,
  }).catch((err: Error) => {
    managed.lastActivity = Date.now();
    managed.antonActive = false;
    managed.antonAbortSignal = null;
    managed.antonProgress = null;
    send(`Anton error: ${err.message}`);
  });

  return { success: `🤖 Anton started on ${filePart} (${pendingCount} tasks pending)` };
}

/** Route an /anton command to the appropriate handler. */
export async function antonCommand(
  managed: ManagedLike,
  args: string,
  send: (text: string) => void,
  rateLimitMs: number
): Promise<CmdResult> {
  const sub = firstToken(args);

  if (!sub || sub === 'status') return antonStatusCommand(managed);
  if (sub === 'stop') return antonStopCommand(managed);
  if (sub === 'last') return antonLastCommand(managed);

  return antonStartCommand(managed, args, send, rateLimitMs);
}
