import {
  WATCHDOG_RECOMMENDED_TUNING_TEXT,
  resolveWatchdogSettings,
  shouldRecommendWatchdogTuning,
  type WatchdogSettings,
} from '../watchdog.js';

import type { CmdResult, KV, ManagedLike, StartInfo, VersionInfo } from './command-logic.js';

export function versionCommand(info: VersionInfo): CmdResult {
  return {
    title: `Idle Hands v${info.version || 'unknown'}`,
    kv: [
      ['Model', info.model || 'auto', true],
      ['Endpoint', info.endpoint || '?', true],
    ],
  };
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
  if (managed.agentPersona)
    kv.push(['Agent', managed.agentPersona.display_name || managed.agentId]);
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
