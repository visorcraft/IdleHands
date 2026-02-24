/**
 * Surface-agnostic command logic shared by Telegram and Discord bots.
 *
 * Each function computes a command result without knowing the output format.
 * The Telegram and Discord wrappers format and send the result.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { runAnton } from '../anton/controller.js';
import { parseTaskFile } from '../anton/parser.js';
import { formatRunSummary, formatProgressBar } from '../anton/reporter.js';
import { firstToken } from '../cli/command-utils.js';
import type { AgentPersona } from '../types.js';
import {
  WATCHDOG_RECOMMENDED_TUNING_TEXT,
  resolveWatchdogSettings,
  shouldRecommendWatchdogTuning,
  type WatchdogSettings,
} from '../watchdog.js';

import { buildAntonRunConfig, makeAntonProgress } from './anton-run.js';
import { summarizeLoopEvent } from './anton-status-format.js';
export {
  approvalSetCommand,
  approvalShowCommand,
  dirSetFail,
  dirSetOk,
  dirShowCommand,
  modeSetCommand,
  modeShowCommand,
  pinFail,
  pinOk,
  subagentsSetCommand,
  subagentsShowCommand,
  unpinFail,
  unpinNotPinned,
  unpinOk,
} from './session-settings.js';
export { changesCommand, undoCommand, vaultCommand } from './session-history.js';
export {
  agentCommand,
  agentsCommand,
  deescalateCommand,
  escalateSetCommand,
  escalateShowCommand,
} from './escalation-commands.js';
export { gitStatusCommand } from './git-status-command.js';

// ── Structured result types ─────────────────────────────────────────

/** A key-value pair: [label, value, isCode?] */
export type KV = [label: string, value: string, code?: boolean];

/**
 * Structured command result. Formatters turn this into HTML or Markdown.
 *
 * - `title`: optional bold header line
 * - `lines`: plain text lines (emitted as-is, no formatting)
 * - `kv`: key-value pairs rendered as "**label:** `value`" (or code if flag set)
 * - `error` / `success`: short status messages
 * - `preformatted`: code block content (rendered in <pre> or ```)
 */
export interface CmdResult {
  title?: string;
  lines?: string[];
  kv?: KV[];
  error?: string;
  success?: string;
  preformatted?: string;
}

// ── Minimal interfaces for decoupled access ─────────────────────────

export interface SessionLike {
  model: string;
  harness: string;
  currentContextTokens: number;
  contextWindow: number;
  usage: { prompt: number; completion: number };
  replay?: { list(n: number): Promise<{ filePath: string }[]> };
  vault?: { search(q: string, n: number): Promise<any[]> };
  lens?: any;
  lastEditedPath?: string;
  reset(): void;
}

export interface ManagedLike {
  session: SessionLike;
  config: any;
  workingDir: string;
  dirPinned: boolean;
  repoCandidates: string[];
  state: string;
  pendingQueue: any[];
  inFlight: boolean;
  agentPersona?: AgentPersona | null;
  agentId: string;
  antonActive: boolean;
  antonAbortSignal: { aborted: boolean } | null;
  antonProgress: any;
  antonLastResult: any;
  antonLastLoopEvent?: {
    kind: 'auto-recovered' | 'final-failure' | 'other';
    taskText: string;
    message: string;
    at: number;
  } | null;
  lastActivity: number;
  lastProgressAt: number;
  pendingEscalation?: string | null;
  pendingEscalationEndpoint?: string | null;
  currentModelIndex: number;
  escalationCount?: number;
  allowedDirs: string[];
  approvalMode?: string;
  watchdogCompactAttempts?: number;
}

// ── Simple / read-only commands ─────────────────────────────────────

export interface VersionInfo {
  version?: string;
  model?: string;
  endpoint?: string;
}

export function versionCommand(info: VersionInfo): CmdResult {
  return {
    title: `Idle Hands v${info.version || 'unknown'}`,
    kv: [
      ['Model', info.model || 'auto', true],
      ['Endpoint', info.endpoint || '?', true],
    ],
  };
}

export interface AgentsConfig {
  agents?: Record<string, AgentPersona>;
  routing?: {
    default?: string;
    users?: Record<string, string>;
    chats?: Record<string, string>;
    channels?: Record<string, string>;
    guilds?: Record<string, string>;
  };
}

export interface StartInfo extends VersionInfo {
  defaultDir?: string;
  agentName?: string;
}

export function startCommand(info: StartInfo): CmdResult {
  const kv: KV[] = [];
  if (info.agentName) kv.push(['Agent', info.agentName]);
  kv.push(
    ['Model', info.model || 'auto', true],
    ['Endpoint', info.endpoint || '?', true],
    ['Default dir', info.defaultDir || '~', true]
  );
  return {
    title: 'Idle Hands — Local-first coding agent',
    kv,
    lines: ['', 'Send me a coding task, or use /help for commands.'],
  };
}

export function helpCommand(surface: 'telegram' | 'discord'): CmdResult {
  const lines = [
    '/start — Welcome + config summary',
    '/help — This message',
    '/version — Show version',
    '/new — Start a new session',
    '/cancel — Abort current generation',
    '/status — Session stats',
    '/watchdog [status] — Show watchdog settings/status',
    '/agent — Show current agent',
    '/agents — List all configured agents',
    '/escalate [model] — Use larger model for next message',
    '/deescalate — Return to base model',
    '/dir [path] — Get/set working directory',
    '/pin — Pin current working directory',
    '/unpin — Unpin working directory',
    '/model — Show current model',
    '/approval [mode] — Get/set approval mode',
    '/mode [code|sys] — Get/set mode',
    '/compact — Trigger context compaction',
    '/changes — Show files modified this session',
    '/undo — Undo last edit',
    '/subagents [on|off] — Toggle sub-agents',
    '/vault <query> — Search vault entries',
    '/anton <file> — Start autonomous task runner',
    '/anton status | /anton stop | /anton last',
  ];

  if (surface === 'telegram') {
    lines.push(
      '/git_status — Show git status for working directory',
      '/restart_bot — Restart the bot service'
    );
  }

  lines.push('', 'Or just send any text as a coding task.');

  return { title: 'Commands', lines };
}

export function modelCommand(managed: ManagedLike): CmdResult {
  return {
    kv: [
      ['Model', managed.session.model, true],
      ['Harness', managed.session.harness, true],
    ],
  };
}

export function compactCommand(managed: ManagedLike): CmdResult {
  managed.session.reset();
  return { success: '🗜 Session context compacted (reset to system prompt).' };
}

export function statusCommand(managed: ManagedLike, extra?: { maxQueue?: number }): CmdResult {
  const s = managed.session;
  const contextPct =
    s.contextWindow > 0
      ? Math.min(100, (s.currentContextTokens / s.contextWindow) * 100).toFixed(1)
      : '?';

  const kv: KV[] = [];
  if (managed.agentPersona) {
    kv.push(['Agent', managed.agentPersona.display_name || managed.agentId]);
  }
  kv.push(
    ['Mode', managed.config.mode ?? 'code'],
    ['Approval', managed.config.approval_mode ?? managed.approvalMode ?? 'auto-edit'],
    ['Model', s.model, true],
    ['Harness', s.harness, true],
    ['Dir', managed.workingDir, true],
    ['Dir pinned', managed.dirPinned ? 'yes' : 'no'],
    [
      'Context',
      `~${s.currentContextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} (${contextPct}%)`,
    ],
    [
      'Tokens',
      `prompt=${s.usage.prompt.toLocaleString()}, completion=${s.usage.completion.toLocaleString()}`,
    ],
    ['In-flight', managed.inFlight ? 'yes' : 'no'],
    ['State', managed.state],
    [
      'Queue',
      extra?.maxQueue != null
        ? `${managed.pendingQueue.length}/${extra.maxQueue}`
        : `${managed.pendingQueue.length} pending`,
    ]
  );

  return { title: 'Session Status', kv };
}

export function watchdogCommand(
  managed: ManagedLike | undefined,
  watchdogCfg: WatchdogSettings | undefined
): CmdResult {
  const cfg = watchdogCfg ?? resolveWatchdogSettings();
  const kv: KV[] = [
    ['Timeout', `${cfg.timeoutMs.toLocaleString()} ms (${Math.round(cfg.timeoutMs / 1000)}s)`],
    ['Max compactions', String(cfg.maxCompactions)],
    ['Grace windows', String(cfg.idleGraceTimeouts)],
    ['Debug abort reason', cfg.debugAbortReason ? 'on' : 'off'],
  ];

  const lines: string[] = [];

  if (shouldRecommendWatchdogTuning(cfg)) {
    lines.push('');
    kv.push(['Recommended tuning', WATCHDOG_RECOMMENDED_TUNING_TEXT]);
  }

  if (managed) {
    const idleSec =
      managed.lastProgressAt > 0
        ? ((Date.now() - managed.lastProgressAt) / 1000).toFixed(1)
        : 'n/a';
    lines.push('');
    kv.push(
      ['In-flight', managed.inFlight ? 'yes' : 'no'],
      ['State', managed.state],
      ['Compaction attempts (turn)', String(managed.watchdogCompactAttempts ?? 0)],
      ['Idle since progress', `${idleSec}s`]
    );
  } else {
    lines.push('', 'No active session yet. Send a message to start one.');
  }

  return { title: 'Watchdog Status', kv, lines };
}

// ── Anton ───────────────────────────────────────────────────────────

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

  // Check stale run
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

  // Fire and forget — the run proceeds in the background
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

/**
 * Route an /anton command to the appropriate handler.
 */
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
