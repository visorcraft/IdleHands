/**
 * TUI command routing — handles slash commands and shell commands.
 * Extracted from controller.ts to stay within the 400-line TUI file cap.
 */

import type { AgentSession } from '../agent.js';
import { registerAll, findCommand, allCommandNames } from '../cli/command-registry.js';
import { antonCommands } from '../cli/commands/anton.js';
import { editingCommands } from '../cli/commands/editing.js';
import { modelCommands } from '../cli/commands/model.js';
import { projectCommands } from '../cli/commands/project.js';
import { runtimeCommands } from '../cli/commands/runtime.js';
import { sessionCommands } from '../cli/commands/session.js';
import { toolCommands } from '../cli/commands/tools.js';
import { trifectaCommands } from '../cli/commands/trifecta.js';
import type { ReplContext } from '../cli/repl-context.js';
import { makeStyler } from '../term.js';
import type { IdlehandsConfig } from '../types.js';
import { projectDir, PKG_VERSION } from '../utils.js';

let registered = false;

export function ensureCommandsRegistered(): void {
  if (registered) return;
  registered = true;
  registerAll([
    ...sessionCommands,
    ...runtimeCommands,
    ...modelCommands,
    ...editingCommands,
    ...projectCommands,
    ...trifectaCommands,
    ...toolCommands,
    ...antonCommands,
  ]);
}

export { allCommandNames };

/** Build a minimal ReplContext adapter for running slash commands in TUI. */
export function buildReplContext(
  session: AgentSession | null,
  config: IdlehandsConfig,
  cleanupFn: (() => Promise<void>) | null,
  saveFn: () => Promise<void>
): ReplContext {
  const noop = () => {},
    asyncNoop = async () => {};
  return {
    session,
    config,
    rl: { question: async () => '' } as any,
    S: makeStyler(true),
    version: PKG_VERSION,
    shellMode: false,
    activeShellProc: null,
    statusBarEnabled: false,
    statusBar: {} as any,
    lastStatusLine: '',
    lastAutoCommitOfferStat: '',
    sessionStartedMs: Date.now(),
    changesBaselineMs: Date.now(),
    lastRunnableInput: '',
    perfSamples: [],
    healthUnsupported: false,
    lastHealthWarning: '',
    lastHealthSnapshot: null,
    lastHealthSnapshotAt: 0,
    pendingTemplate: null,
    customCommands: new Map(),
    vimState: null,
    enabled: true,
    watchPaths: [],
    watchMaxIterationsPerTrigger: 3,
    watchActive: false,
    watchWatchers: [],
    watchDebounceTimer: null,
    watchPendingChanges: new Set(),
    watchRunInFlight: false,
    watchRunQueued: false,
    indexRunning: false,
    indexStartedAt: 0,
    indexProgress: { scanned: 0, indexed: 0, skipped: 0 },
    indexLastResult: null,
    indexLastError: '',
    antonActive: false,
    antonAbortSignal: null,
    antonLastResult: null,
    antonProgress: null,
    shutdown: async () => {
      if (cleanupFn) await cleanupFn();
    },
    readServerHealth: async () => null,
    maybePrintTurnMetrics: asyncNoop,
    maybeOfferAutoCommit: asyncNoop,
    saveCurrentSession: saveFn,
    startWatchMode: asyncNoop,
    stopWatchMode: noop,
    runWatchPrompt: asyncNoop,
    startIndexInBackground: asyncNoop,
    printIndexStats: asyncNoop,
    clearIndex: asyncNoop,
    confirm: async () => true,
  };
}

export interface CommandResult {
  handled: boolean;
  output?: string;
  alertLevel?: 'info' | 'warn' | 'error';
  alertText?: string;
  shouldQuit?: boolean;
}

/** Run a shell command (!cmd or !!cmd). Returns output text and whether to inject. */
export async function runShellCommand(
  line: string,
  config: IdlehandsConfig
): Promise<{ output: string; inject: boolean; rc: number; command: string }> {
  const inject = line.startsWith('!!');
  const command = line.slice(inject ? 2 : 1).trim();
  if (!command) return { output: '', inject: false, rc: 0, command: '' };

  const { spawn } = await import('node:child_process');
  const cwd = projectDir(config);
  const child = spawn('bash', ['-c', command], {
    cwd,
    env: { ...process.env, IDLEHANDS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '',
    err = '';
  const timeout = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  }, 30_000);
  child.stdout.on('data', (c) => {
    out += String(c);
  });
  child.stderr.on('data', (c) => {
    err += String(c);
  });
  const rc = await new Promise<number>((res) => {
    child.on('close', (code) => {
      clearTimeout(timeout);
      res(code ?? 1);
    });
    child.on('error', () => {
      clearTimeout(timeout);
      res(1);
    });
  });
  return { output: (out + err).slice(-4000).trimEnd(), inject, rc, command };
}

/**
 * Route a slash command through the registry.
 * Returns captured console output as a string.
 */
export async function runSlashCommand(
  line: string,
  session: AgentSession | null,
  config: IdlehandsConfig,
  cleanupFn: (() => Promise<void>) | null,
  saveFn: () => Promise<void>
): Promise<{ found: boolean; output: string }> {
  ensureCommandsRegistered();
  const cmd = findCommand(line);
  if (!cmd) return { found: false, output: '' };

  const captured: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => captured.push(args.map(String).join(' '));

  try {
    const ctx = buildReplContext(session, config, cleanupFn, saveFn);
    const args = line.replace(/^\S+\s*/, '');
    await cmd.execute(ctx, args, line);
  } catch (e: any) {
    captured.push(`Error: ${e?.message ?? String(e)}`);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }

  return { found: true, output: captured.join('\n') };
}
