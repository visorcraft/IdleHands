/**
 * Surface-agnostic command logic shared by Telegram and Discord bots.
 *
 * Each function computes a command result without knowing the output format.
 * The Telegram and Discord wrappers format and send the result.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { AntonRunConfig, AntonProgressCallback } from '../anton/types.js';
import { runAnton } from '../anton/controller.js';
import { parseTaskFile } from '../anton/parser.js';
import {
  formatRunSummary,
  formatProgressBar,
  formatTaskStart,
  formatTaskEnd,
  formatTaskSkip,
  formatTaskHeartbeat,
  formatToolLoopEvent,
  formatCompactionEvent,
  formatVerificationDetail,
} from '../anton/reporter.js';
import { firstToken } from '../cli/command-utils.js';
import type { AgentPersona } from '../types.js';
import {
  WATCHDOG_RECOMMENDED_TUNING_TEXT,
  resolveWatchdogSettings,
  shouldRecommendWatchdogTuning,
  type WatchdogSettings,
} from '../watchdog.js';

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
    ['Default dir', info.defaultDir || '~', true],
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
      '/restart_bot — Restart the bot service',
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
    ],
  );

  return { title: 'Session Status', kv };
}

export function watchdogCommand(
  managed: ManagedLike | undefined,
  watchdogCfg: WatchdogSettings | undefined,
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
      ['Idle since progress', `${idleSec}s`],
    );
  } else {
    lines.push('', 'No active session yet. Send a message to start one.');
  }

  return { title: 'Watchdog Status', kv, lines };
}

// ── Dir / pin / unpin ───────────────────────────────────────────────

export function dirShowCommand(managed: ManagedLike | undefined): CmdResult {
  const dir = managed?.workingDir ?? '(no session)';
  const kv: KV[] = [['Working directory', dir, true]];
  const lines: string[] = [];

  if (managed) {
    kv.push(['Directory pinned', managed.dirPinned ? 'yes' : 'no']);
    if (!managed.dirPinned && managed.repoCandidates.length > 1) {
      lines.push('Action required: run /dir <repo-root> before file edits.');
      lines.push(`Detected repos: ${managed.repoCandidates.slice(0, 5).join(', ')}`);
    }
  }

  return { kv, lines: lines.length ? lines : undefined };
}

export function dirSetOk(resolvedDir: string): CmdResult {
  return { success: `✅ Working directory pinned to ${resolvedDir}` };
}

export function dirSetFail(): CmdResult {
  return {
    error:
      '❌ Directory not allowed or session error. Check bot.telegram.allowed_dirs / persona.allowed_dirs.',
  };
}

export function pinOk(dir: string): CmdResult {
  return { success: `✅ Working directory pinned to ${dir}` };
}

export function pinFail(): CmdResult {
  return dirSetFail();
}

export function unpinOk(dir: string): CmdResult {
  return { success: `✅ Directory unpinned. Working directory remains at ${dir}` };
}

export function unpinNotPinned(): CmdResult {
  return { error: 'Directory is not pinned.' };
}

export function unpinFail(): CmdResult {
  return { error: '❌ Failed to unpin directory.' };
}

// ── Approval / mode / subagents ─────────────────────────────────────

const APPROVAL_MODES = ['plan', 'default', 'auto-edit', 'yolo'] as const;

export function approvalShowCommand(managed: ManagedLike, fallback?: string): CmdResult {
  const current = managed.config.approval_mode ?? managed.approvalMode ?? fallback ?? 'auto-edit';
  return {
    kv: [['Approval mode', current, true]],
    lines: [`Options: ${APPROVAL_MODES.join(', ')}`],
  };
}

export function approvalSetCommand(
  managed: ManagedLike,
  arg: string,
): CmdResult | null {
  if (!APPROVAL_MODES.includes(arg as any)) {
    return { error: `Invalid mode. Options: ${APPROVAL_MODES.join(', ')}` };
  }
  managed.config.approval_mode = arg as any;
  managed.config.no_confirm = arg === 'yolo';
  if ('approvalMode' in managed) (managed as any).approvalMode = arg;
  return { success: `✅ Approval mode set to ${arg}` };
}

export function modeShowCommand(managed: ManagedLike): CmdResult {
  return { kv: [['Mode', managed.config.mode ?? 'code', true]] };
}

export function modeSetCommand(managed: ManagedLike, arg: string): CmdResult {
  if (arg !== 'code' && arg !== 'sys') {
    return { error: 'Invalid mode. Options: code, sys' };
  }
  managed.config.mode = arg;
  if (arg === 'sys' && managed.config.approval_mode === 'auto-edit') {
    managed.config.approval_mode = 'default';
    if ('approvalMode' in managed) (managed as any).approvalMode = 'default';
  }
  return { success: `✅ Mode set to ${arg}` };
}

export function subagentsShowCommand(managed: ManagedLike): CmdResult {
  const current = managed.config.sub_agents?.enabled !== false;
  return {
    kv: [['Sub-agents', current ? 'on' : 'off', true]],
    lines: ['Usage: /subagents on | off'],
  };
}

export function subagentsSetCommand(managed: ManagedLike, arg: string): CmdResult {
  if (arg !== 'on' && arg !== 'off') {
    return { error: 'Invalid value. Usage: /subagents on | off' };
  }
  const enabled = arg === 'on';
  managed.config.sub_agents = { ...(managed.config.sub_agents ?? {}), enabled };
  return {
    success: `✅ Sub-agents ${enabled ? 'on' : 'off'}${!enabled ? ' — spawn_task disabled for this session' : ''}`,
  };
}

// ── Changes / undo ──────────────────────────────────────────────────

export async function changesCommand(managed: ManagedLike): Promise<CmdResult> {
  const replay = managed.session.replay;
  if (!replay) return { error: 'Replay is disabled. No change tracking available.' };

  try {
    const checkpoints = await replay.list(50);
    if (!checkpoints.length) return { lines: ['No file changes this session.'] };

    const byFile = new Map<string, number>();
    for (const cp of checkpoints) {
      byFile.set(cp.filePath, (byFile.get(cp.filePath) ?? 0) + 1);
    }

    const lines: string[] = [];
    for (const [fp, count] of byFile) {
      lines.push(`  ✎ ${fp} (${count} edit${count > 1 ? 's' : ''})`);
    }

    return { title: `Session changes (${byFile.size} files)`, lines };
  } catch (e: any) {
    return { error: `Error listing changes: ${e?.message ?? e}` };
  }
}

export async function undoCommand(managed: ManagedLike): Promise<CmdResult> {
  const lastPath = managed.session.lastEditedPath;
  if (!lastPath) return { error: 'No recent edits to undo.' };

  try {
    const { undo_path } = await import('../tools.js');
    const ctx = { cwd: managed.workingDir, noConfirm: true, dryRun: false };
    const result = await undo_path(ctx as any, { path: lastPath });
    return { success: `✅ ${result}` };
  } catch (e: any) {
    return { error: `❌ Undo failed: ${e?.message ?? e}` };
  }
}

// ── Vault ───────────────────────────────────────────────────────────

export async function vaultCommand(managed: ManagedLike, query: string): Promise<CmdResult> {
  const vault = managed.session.vault;
  if (!vault) return { error: 'Vault is disabled.' };
  if (!query) return { lines: ['Usage: /vault <search query>'] };

  try {
    const results = await vault.search(query, 5);
    if (!results.length) return { lines: [`No vault results for "${query}"`] };

    const lines: string[] = [];
    for (const r of results) {
      const title = r.kind === 'note' ? `note:${r.key}` : `tool:${r.tool || r.key || '?'}`;
      const body = (r.value ?? r.snippet ?? r.content ?? '').replace(/\s+/g, ' ').slice(0, 120);
      lines.push(`• ${title}: ${body}`);
    }

    return { title: `Vault results for "${query}"`, lines };
  } catch (e: any) {
    return { error: `Error searching vault: ${e?.message ?? e}` };
  }
}

// ── Agent / agents ──────────────────────────────────────────────────

export function agentCommand(managed: ManagedLike): CmdResult {
  if (!managed.agentPersona) {
    return { lines: ['No agent configured. Using global config.'] };
  }

  const p = managed.agentPersona;
  const kv: KV[] = [];
  if (p.model) kv.push(['Model', p.model, true]);
  if (p.endpoint) kv.push(['Endpoint', p.endpoint, true]);
  if (p.approval_mode) kv.push(['Approval', p.approval_mode, true]);
  if (p.default_dir) kv.push(['Default dir', p.default_dir, true]);
  if (p.allowed_dirs?.length) kv.push(['Allowed dirs', p.allowed_dirs.join(', ')]);

  const lines: string[] = [];
  if (p.escalation?.models?.length) {
    lines.push('');
    kv.push(['Escalation models', p.escalation.models.join(', ')]);
    if (managed.currentModelIndex > 0) {
      kv.push(['Current tier', `${managed.currentModelIndex} (escalated)`]);
    }
    if (managed.pendingEscalation) {
      kv.push(['Pending escalation', managed.pendingEscalation]);
    }
  }

  return {
    title: `Agent: ${p.display_name || managed.agentId} (${managed.agentId})`,
    kv,
    lines: lines.length ? lines : undefined,
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

export function agentsCommand(managed: ManagedLike, surfaceConfig: AgentsConfig): CmdResult {
  const agents = surfaceConfig.agents;
  if (!agents || Object.keys(agents).length === 0) {
    return { lines: ['No agents configured. Using global config.'] };
  }

  const lines: string[] = [];
  for (const [id, agent] of Object.entries(agents)) {
    const current = id === managed.agentId ? ' <- current' : '';
    const model = agent.model ? ` (${agent.model})` : '';
    lines.push(`• ${agent.display_name || id} (${id})${model}${current}`);
  }

  const routing = surfaceConfig.routing;
  if (routing) {
    lines.push('', 'Routing:');
    if (routing.default) lines.push(`Default: ${routing.default}`);
    if (routing.users && Object.keys(routing.users).length > 0) {
      lines.push(
        `Users: ${Object.entries(routing.users)
          .map(([u, a]) => `${u}→${a}`)
          .join(', ')}`,
      );
    }
    if (routing.chats && Object.keys(routing.chats).length > 0) {
      lines.push(
        `Chats: ${Object.entries(routing.chats)
          .map(([c, a]) => `${c}→${a}`)
          .join(', ')}`,
      );
    }
    if (routing.channels && Object.keys(routing.channels).length > 0) {
      lines.push(
        `Channels: ${Object.entries(routing.channels)
          .map(([c, a]) => `${c}→${a}`)
          .join(', ')}`,
      );
    }
    if (routing.guilds && Object.keys(routing.guilds).length > 0) {
      lines.push(
        `Guilds: ${Object.entries(routing.guilds)
          .map(([g, a]) => `${g}→${a}`)
          .join(', ')}`,
      );
    }
  }

  return { title: 'Configured Agents', lines };
}

// ── Escalation / de-escalation ──────────────────────────────────────

export function escalateShowCommand(
  managed: ManagedLike,
  baseModel: string,
): CmdResult {
  const escalation = managed.agentPersona?.escalation;
  if (!escalation?.models?.length) {
    return { error: '❌ No escalation models configured for this agent.' };
  }

  const kv: KV[] = [
    ['Current model', baseModel, true],
    ['Escalation models', escalation.models.join(', ')],
  ];
  const lines = ['', 'Usage: /escalate <model> or /escalate next', 'Then send your message - it will use the escalated model.'];

  if (managed.pendingEscalation) {
    lines.push('', `⚡ Pending escalation: ${managed.pendingEscalation} (next message will use this)`);
  }

  return { kv, lines };
}

export function escalateSetCommand(
  managed: ManagedLike,
  arg: string,
): CmdResult {
  const escalation = managed.agentPersona?.escalation;
  if (!escalation?.models?.length) {
    return { error: '❌ No escalation models configured for this agent.' };
  }

  let targetModel: string;
  let targetEndpoint: string | undefined;

  if (arg.toLowerCase() === 'next') {
    const nextIndex = Math.min(managed.currentModelIndex, escalation.models.length - 1);
    targetModel = escalation.models[nextIndex];
    targetEndpoint = escalation.tiers?.[nextIndex]?.endpoint;
  } else {
    if (!escalation.models.includes(arg)) {
      return {
        error: `❌ Model ${arg} not in escalation chain. Available: ${escalation.models.join(', ')}`,
      };
    }
    targetModel = arg;
    const idx = escalation.models.indexOf(arg);
    targetEndpoint = escalation.tiers?.[idx]?.endpoint;
  }

  managed.pendingEscalation = targetModel;
  if ('pendingEscalationEndpoint' in managed) {
    (managed as any).pendingEscalationEndpoint = targetEndpoint || null;
  }

  return { success: `⚡ Next message will use ${targetModel}. Send your request now.` };
}

export function deescalateCommand(
  managed: ManagedLike,
  baseModel: string,
): CmdResult | 'recreate' {
  if (managed.currentModelIndex === 0 && !managed.pendingEscalation) {
    return { lines: ['Already using base model.'] };
  }

  managed.pendingEscalation = null;
  if ('pendingEscalationEndpoint' in managed) {
    (managed as any).pendingEscalationEndpoint = null;
  }
  managed.currentModelIndex = 0;

  // Caller must handle session recreation with baseModel
  return 'recreate';
}

// ── Git status ──────────────────────────────────────────────────────

export async function gitStatusCommand(cwd: string): Promise<CmdResult> {
  if (!cwd) return { error: 'No working directory set. Use /dir to set one.' };

  const { spawnSync } = await import('node:child_process');

  const statusResult = spawnSync('git', ['status', '-s'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });

  if (statusResult.status !== 0) {
    const err = String(statusResult.stderr || statusResult.error || 'Unknown error');
    if (err.includes('not a git repository') || err.includes('not in a git')) {
      return { error: '❌ Not a git repository.' };
    }
    return { error: `❌ git status failed: ${err.slice(0, 200)}` };
  }

  const statusOut = String(statusResult.stdout || '').trim();

  const branchResult = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    timeout: 2000,
  });
  const branch =
    branchResult.status === 0 ? String(branchResult.stdout || '').trim() : 'unknown';

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

// ── Anton ───────────────────────────────────────────────────────────

function formatAgeShort(msAgo: number): string {
  if (msAgo < 60_000) return `${Math.max(1, Math.round(msAgo / 1000))}s ago`;
  if (msAgo < 3_600_000) return `${Math.round(msAgo / 60_000)}m ago`;
  return `${Math.round(msAgo / 3_600_000)}h ago`;
}

function summarizeLoopEvent(
  ev: NonNullable<ManagedLike['antonLastLoopEvent']>
): string {
  const emoji = ev.kind === 'final-failure' ? '🔴' : ev.kind === 'auto-recovered' ? '🟠' : '🟡';
  const kind = ev.kind === 'final-failure'
    ? 'final failure'
    : ev.kind === 'auto-recovered'
      ? 'auto-recovered'
      : 'loop event';
  const msg = ev.message.length > 120 ? ev.message.slice(0, 117) + '...' : ev.message;
  return `${emoji} Last loop: ${kind} (${formatAgeShort(Date.now() - ev.at)})\n${msg}`;
}

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

export function buildAntonRunConfig(defaults: any, cwd: string, filePath: string): AntonRunConfig {
  return {
    taskFile: filePath,
    projectDir: defaults.project_dir || cwd,
    maxRetriesPerTask: defaults.max_retries ?? 3,
    maxIterations: defaults.max_iterations ?? 200,
    taskMaxIterations: defaults.task_max_iterations ?? 50,
    taskTimeoutSec: defaults.task_timeout_sec ?? 600,
    totalTimeoutSec: defaults.total_timeout_sec ?? 7200,
    maxTotalTokens: defaults.max_total_tokens ?? Infinity,
    maxPromptTokensPerAttempt: defaults.max_prompt_tokens_per_attempt ?? 64_000,
    autoCommit: defaults.auto_commit ?? true,
    branch: false,
    allowDirty: false,
    aggressiveCleanOnFail: false,
    verifyAi: defaults.verify_ai ?? true,
    verifyModel: undefined,
    decompose: defaults.decompose ?? true,
    maxDecomposeDepth: defaults.max_decompose_depth ?? 2,
    maxTotalTasks: defaults.max_total_tasks ?? 500,
    buildCommand: defaults.build_command ?? undefined,
    testCommand: defaults.test_command ?? undefined,
    lintCommand: defaults.lint_command ?? undefined,
    skipOnFail: defaults.skip_on_fail ?? false,
    skipOnBlocked: defaults.skip_on_blocked ?? true,
    rollbackOnFail: defaults.rollback_on_fail ?? false,
    maxIdenticalFailures: defaults.max_identical_failures ?? 3,
    approvalMode: (defaults.approval_mode ?? 'yolo') as AntonRunConfig['approvalMode'],
    verbose: false,
    dryRun: false,
  };
}

export function makeAntonProgress(
  managed: ManagedLike,
  defaults: any,
  send: (text: string) => void,
  rateLimitMs: number
): AntonProgressCallback {
  const heartbeatSecRaw = Number(defaults.progress_heartbeat_sec ?? 30);
  const heartbeatIntervalMs = Number.isFinite(heartbeatSecRaw)
    ? Math.max(5000, Math.floor(heartbeatSecRaw * 1000))
    : 30_000;

  let lastProgressAt = 0;
  let lastHeartbeatNoticeAt = 0;

  return {
    onTaskStart(task, attempt, prog) {
      const now = Date.now();
      managed.antonProgress = prog;
      managed.lastActivity = now;
      lastProgressAt = now;
      send(formatTaskStart(task, attempt, prog));
    },
    onTaskEnd(task, result, prog) {
      const now = Date.now();
      managed.antonProgress = prog;
      managed.lastActivity = now;
      lastProgressAt = now;
      send(formatTaskEnd(task, result, prog));
    },
    onTaskSkip(task, reason) {
      managed.lastActivity = Date.now();
      send(formatTaskSkip(task, reason));
    },
    onRunComplete(result) {
      managed.lastActivity = Date.now();
      managed.antonLastResult = result;
      managed.antonActive = false;
      managed.antonAbortSignal = null;
      managed.antonProgress = null;
      send(formatRunSummary(result));
    },
    onHeartbeat() {
      const now = Date.now();
      managed.lastActivity = now;

      if (defaults.progress_events === false) return;
      if (!managed.antonProgress?.currentTask) return;
      if (now - lastProgressAt < rateLimitMs) return;
      if (now - lastHeartbeatNoticeAt < heartbeatIntervalMs) return;

      lastHeartbeatNoticeAt = now;
      send(formatTaskHeartbeat(managed.antonProgress));
    },
    onToolLoop(taskText, event) {
      const now = Date.now();
      managed.lastActivity = now;

      const detail = String(event.message ?? '');
      const kind = /final loop failure|retries exhausted/i.test(detail)
        ? 'final-failure'
        : /auto-?recover|auto-?continu/i.test(detail)
          ? 'auto-recovered'
          : 'other';
      managed.antonLastLoopEvent = {
        kind,
        taskText,
        message: detail,
        at: now,
      };

      if (defaults.progress_events !== false) {
        send(formatToolLoopEvent(taskText, event));
      }
    },
    onCompaction(taskText, event) {
      managed.lastActivity = Date.now();
      if (defaults.progress_events !== false && event.droppedMessages >= 5) {
        send(formatCompactionEvent(taskText, event));
      }
    },
    onVerification(taskText, verification) {
      managed.lastActivity = Date.now();
      if (defaults.progress_events !== false) {
        send(formatVerificationDetail(taskText, verification));
      }
    },
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
  rateLimitMs: number,
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
  } catch { /* non-fatal */ }

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
  rateLimitMs: number,
): Promise<CmdResult> {
  const sub = firstToken(args);

  if (!sub || sub === 'status') return antonStatusCommand(managed);
  if (sub === 'stop') return antonStopCommand(managed);
  if (sub === 'last') return antonLastCommand(managed);

  return antonStartCommand(managed, args, send, rateLimitMs);
}
