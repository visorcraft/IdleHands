/**
 * Telegram bot command handlers.
 * Each handler receives the grammy Context and the SessionManager.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Context } from 'grammy';

import { runAnton } from '../anton/controller.js';
import { parseTaskFile } from '../anton/parser.js';
import {
  formatRunSummary,
  formatProgressBar,
  formatTaskStart,
  formatTaskEnd,
  formatTaskSkip,
  formatToolLoopEvent,
  formatCompactionEvent,
  formatVerificationDetail,
} from '../anton/reporter.js';
import type { AntonRunConfig, AntonProgressCallback } from '../anton/types.js';
import { firstToken } from '../cli/command-utils.js';
import type { BotTelegramConfig } from '../types.js';
import {
  WATCHDOG_RECOMMENDED_TUNING_TEXT,
  resolveWatchdogSettings,
  shouldRecommendWatchdogTuning,
  type WatchdogSettings,
} from '../watchdog.js';

import { escapeHtml } from './format.js';
import type { SessionManager } from './session-manager.js';

type CommandContext = {
  ctx: Context;
  sessions: SessionManager;
  botConfig: {
    model?: string;
    endpoint?: string;
    version?: string;
    defaultDir?: string;
    telegram?: BotTelegramConfig;
    watchdog?: WatchdogSettings;
  };
};

export async function handleVersion({ ctx, botConfig }: CommandContext): Promise<void> {
  const lines = [
    `<b>Idle Hands</b> v${botConfig.version || 'unknown'}`,
    '',
    `<b>Model:</b> <code>${escapeHtml(botConfig.model || 'auto')}</code>`,
    `<b>Endpoint:</b> <code>${escapeHtml(botConfig.endpoint || '?')}</code>`,
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleStart({ ctx, botConfig }: CommandContext): Promise<void> {
  const lines = [
    '<b>🔧 Idle Hands</b> — Local-first coding agent',
    '',
    `<b>Model:</b> <code>${escapeHtml(botConfig.model || 'auto')}</code>`,
    `<b>Endpoint:</b> <code>${escapeHtml(botConfig.endpoint || '?')}</code>`,
    `<b>Default dir:</b> <code>${escapeHtml(botConfig.defaultDir || '~')}</code>`,
    '',
    'Send me a coding task, or use /help for commands.',
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleHelp({ ctx }: CommandContext): Promise<void> {
  const lines = [
    '<b>Commands:</b>',
    '',
    '/start — Welcome + config summary',
    '/help — This message',
    '/new — Start a new session',
    '/cancel — Abort current generation',
    '/status — Session stats',
    '/watchdog [status] — Show active watchdog settings',
    '/agent — Show current agent info',
    '/agents — List all configured agents',
    '/escalate [model] — Use larger model for next message',
    '/deescalate — Return to base model',
     '/dir [path] — Get/set working directory',
     '/pin — Pin current working directory',
     '/model — Show current model',
    '/approval [mode] — Get/set approval mode',
    '/mode [code|sys] — Get/set mode',
    '/compact — Trigger context compaction',
    '/changes — Show files modified this session',
    '/undo — Undo last edit',
    '/subagents [on|off] — Toggle sub-agent delegation',
    '/vault [query] — Search vault entries',
    '/anton &lt;file&gt; — Start autonomous task runner',
    '/anton status — Show task runner progress',
    '/anton stop — Stop task runner',
    '/anton last — Show last run results',
    '/git_status — Show git status for working directory',
    '/restart_bot — Restart the bot service',
    '',
    'Or just send any text as a coding task.',
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleNew({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const res = sessions.resetSession(chatId);
  await ctx.reply(res.ok ? '✨ New session started. Send a message to begin.' : res.message);
}

export async function handleCancel({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const res = sessions.cancelActive(chatId);
  await ctx.reply(res.message);
}

export async function handleStatus({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session. Send a message to start one.');
    return;
  }
  const s = managed.session;
  const contextPct =
    s.contextWindow > 0
      ? Math.min(100, (s.currentContextTokens / s.contextWindow) * 100).toFixed(1)
      : '?';
  const lines = [
    '<b>Session Status</b>',
    '',
    `<b>Model:</b> <code>${escapeHtml(s.model)}</code>`,
    `<b>Harness:</b> <code>${escapeHtml(s.harness)}</code>`,
    `<b>Dir:</b> <code>${escapeHtml(managed.workingDir)}</code>`,
    `<b>Dir pinned:</b> ${managed.dirPinned ? 'yes' : 'no'}`,
    `<b>Context:</b> ~${s.currentContextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} (${contextPct}%)`,
    `<b>Tokens:</b> prompt=${s.usage.prompt.toLocaleString()}, completion=${s.usage.completion.toLocaleString()}`,
    `<b>In-flight:</b> ${managed.inFlight ? 'yes' : 'no'}`,
    `<b>State:</b> ${managed.state}`,
    `<b>Queue:</b> ${managed.pendingQueue.length} pending`,
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleWatchdog({ ctx, sessions, botConfig }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text ?? '';
  const arg = text
    .replace(/^\/watchdog\s*/i, '')
    .trim()
    .toLowerCase();
  if (arg && arg !== 'status') {
    await ctx.reply('Usage: /watchdog or /watchdog status');
    return;
  }

  const managed = sessions.get(chatId);
  const cfg = botConfig.watchdog ?? resolveWatchdogSettings();

  const lines = [
    '<b>Watchdog Status</b>',
    '',
    `<b>Timeout:</b> ${cfg.timeoutMs.toLocaleString()} ms (${Math.round(cfg.timeoutMs / 1000)}s)`,
    `<b>Max compactions:</b> ${cfg.maxCompactions}`,
    `<b>Grace windows:</b> ${cfg.idleGraceTimeouts}`,
    `<b>Debug abort reason:</b> ${cfg.debugAbortReason ? 'on' : 'off'}`,
  ];

  if (shouldRecommendWatchdogTuning(cfg)) {
    lines.push('');
    lines.push(`<b>Recommended tuning:</b> ${escapeHtml(WATCHDOG_RECOMMENDED_TUNING_TEXT)}`);
  }

  if (managed) {
    const idleSec =
      managed.lastProgressAt > 0
        ? ((Date.now() - managed.lastProgressAt) / 1000).toFixed(1)
        : 'n/a';
    lines.push('');
    lines.push(`<b>In-flight:</b> ${managed.inFlight ? 'yes' : 'no'}`);
    lines.push(`<b>State:</b> ${escapeHtml(managed.state)}`);
    lines.push(`<b>Compaction attempts (turn):</b> ${managed.watchdogCompactAttempts}`);
    lines.push(`<b>Idle since progress:</b> ${escapeHtml(idleSec)}s`);
  } else {
    lines.push('');
    lines.push('No active session yet. Send a message to start one.');
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleDir({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const text = ctx.message?.text ?? '';
  const arg = text.replace(/^\/dir\s*/, '').trim();

  const managed = sessions.get(chatId);

  if (!arg) {
    // Show current dir + pin state
    const dir = managed?.workingDir ?? '(no session)';
    const lines = [`<b>Working directory:</b> <code>${escapeHtml(dir)}</code>`];
    if (managed) {
      lines.push(`<b>Directory pinned:</b> ${managed.dirPinned ? 'yes' : 'no'}`);
      if (!managed.dirPinned && managed.repoCandidates.length > 1) {
        lines.push(
          '<b>Action required:</b> run <code>/dir &lt;repo-root&gt;</code> before file edits.'
        );
        const preview = managed.repoCandidates
          .slice(0, 5)
          .map((p) => `<code>${escapeHtml(p)}</code>`)
          .join(', ');
        lines.push(`<b>Detected repos:</b> ${preview}`);
      }
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    return;
  }

  // Set new dir
  const ok = await sessions.setDir(chatId, arg);
  if (ok) {
    const updated = sessions.get(chatId);
    const resolved = updated?.workingDir ?? arg;
    await ctx.reply(`✅ Working directory pinned to <code>${escapeHtml(resolved)}</code>`, {
      parse_mode: 'HTML',
    });
  } else {
    await ctx.reply(
      '❌ Directory not allowed or session error. Check bot.telegram.allowed_dirs / persona.allowed_dirs.'
    );
  }
}

export async function handlePin({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session. Send a message to start one.');
    return;
  }

  const currentDir = managed.workingDir;
  if (!currentDir) {
    await ctx.reply('No working directory set. Use /dir to set one first.');
    return;
  }

  // Re-use setDir logic to pin the current directory
  const ok = await sessions.setDir(chatId, currentDir);
  if (ok) {
    await ctx.reply(`✅ Working directory pinned to <code>${escapeHtml(currentDir)}</code>`, {
      parse_mode: 'HTML',
    });
  } else {
    await ctx.reply(
      '❌ Directory not allowed or session error. Check bot.telegram.allowed_dirs / persona.allowed_dirs.'
    );
  }
}

export async function handleModel({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session. Send a message to start one.');
    return;
  }
  await ctx.reply(
    `<b>Model:</b> <code>${escapeHtml(managed.session.model)}</code>\n<b>Harness:</b> <code>${escapeHtml(managed.session.harness)}</code>`,
    { parse_mode: 'HTML' }
  );
}

export async function handleCompact({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session.');
    return;
  }
  // Reset is the simplest form of compaction for now
  managed.session.reset();
  await ctx.reply('🗜 Session context compacted (reset to system prompt).');
}

export async function handleApproval({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const text = ctx.message?.text ?? '';
  const arg = text.replace(/^\/approval\s*/, '').trim();
  const modes = ['plan', 'default', 'auto-edit', 'yolo'] as const;

  const managed = sessions.get(chatId);

  if (!arg) {
    const current = managed?.approvalMode ?? 'auto-edit';
    await ctx.reply(
      `<b>Approval mode:</b> <code>${escapeHtml(current)}</code>\n\nOptions: ${modes.join(', ')}`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (!modes.includes(arg as any)) {
    await ctx.reply(`Invalid mode. Options: ${modes.join(', ')}`);
    return;
  }

  if (managed) {
    managed.approvalMode = arg as any;
    managed.config.approval_mode = arg as any;
    managed.config.no_confirm = arg === 'yolo';
  }
  await ctx.reply(`✅ Approval mode set to <code>${escapeHtml(arg)}</code>`, {
    parse_mode: 'HTML',
  });
}

export async function handleMode({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const text = ctx.message?.text ?? '';
  const arg = text
    .replace(/^\/mode\s*/, '')
    .trim()
    .toLowerCase();
  const managed = sessions.get(chatId);

  if (!managed) {
    await ctx.reply('No active session. Send a message to start one.');
    return;
  }

  if (!arg) {
    await ctx.reply(`<b>Mode:</b> <code>${escapeHtml(managed.config.mode ?? 'code')}</code>`, {
      parse_mode: 'HTML',
    });
    return;
  }

  if (arg !== 'code' && arg !== 'sys') {
    await ctx.reply('Invalid mode. Options: code, sys');
    return;
  }

  managed.config.mode = arg as any;
  if (arg === 'sys' && managed.config.approval_mode === 'auto-edit') {
    managed.config.approval_mode = 'default';
    managed.approvalMode = 'default';
  }

  await ctx.reply(`✅ Mode set to <code>${escapeHtml(arg)}</code>`, { parse_mode: 'HTML' });
}

export async function handleSubAgents({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const text = ctx.message?.text ?? '';
  const arg = text
    .replace(/^\/subagents\s*/, '')
    .trim()
    .toLowerCase();
  const managed = sessions.get(chatId);

  if (!managed) {
    await ctx.reply('No active session. Send a message to start one.');
    return;
  }

  const current = managed.config.sub_agents?.enabled !== false;

  if (!arg) {
    await ctx.reply(
      `<b>Sub-agents:</b> <code>${current ? 'on' : 'off'}</code>\n\nUsage: /subagents on | off`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (arg !== 'on' && arg !== 'off') {
    await ctx.reply('Invalid value. Usage: /subagents on | off');
    return;
  }

  const enabled = arg === 'on';
  managed.config.sub_agents = { ...(managed.config.sub_agents ?? {}), enabled };
  await ctx.reply(
    `✅ Sub-agents <code>${enabled ? 'on' : 'off'}</code>${!enabled ? ' — spawn_task disabled for this session' : ''}`,
    { parse_mode: 'HTML' }
  );
}

export async function handleChanges({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session.');
    return;
  }
  const replay = managed.session.replay;
  if (!replay) {
    await ctx.reply('Replay is disabled. No change tracking available.');
    return;
  }
  try {
    const checkpoints = await replay.list(50);
    if (!checkpoints.length) {
      await ctx.reply('No file changes this session.');
      return;
    }
    // Group by file path for diffstat
    const byFile = new Map<string, number>();
    for (const cp of checkpoints) {
      byFile.set(cp.filePath, (byFile.get(cp.filePath) ?? 0) + 1);
    }
    const lines = [`<b>Session changes (${byFile.size} files):</b>`, ''];
    for (const [fp, count] of byFile) {
      lines.push(`  ✎ <code>${escapeHtml(fp)}</code> (${count} edit${count > 1 ? 's' : ''})`);
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  } catch (e: any) {
    await ctx.reply(`Error listing changes: ${e?.message ?? e}`);
  }
}

export async function handleUndo({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session.');
    return;
  }
  const lastPath = managed.session.lastEditedPath;
  if (!lastPath) {
    await ctx.reply('No recent edits to undo.');
    return;
  }
  try {
    // Use the undo_path tool function
    const { undo_path } = await import('../tools.js');
    const ctx2 = {
      cwd: managed.workingDir,
      noConfirm: true,
      dryRun: false,
    };
    const result = await undo_path(ctx2 as any, { path: lastPath });
    await ctx.reply(`✅ ${result}`);
  } catch (e: any) {
    await ctx.reply(`❌ Undo failed: ${e?.message ?? e}`);
  }
}

export async function handleVault({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session.');
    return;
  }
  const vault = managed.session.vault;
  if (!vault) {
    await ctx.reply('Vault is disabled.');
    return;
  }
  const text = ctx.message?.text ?? '';
  const query = text.replace(/^\/vault\s*/, '').trim();
  if (!query) {
    await ctx.reply('Usage: /vault &lt;search query&gt;', { parse_mode: 'HTML' });
    return;
  }
  try {
    const results = await vault.search(query, 5);
    if (!results.length) {
      await ctx.reply(`No vault results for "${escapeHtml(query)}"`, { parse_mode: 'HTML' });
      return;
    }
    const lines = [`<b>Vault results for "${escapeHtml(query)}":</b>`, ''];
    for (const r of results) {
      const title = r.kind === 'note' ? `note:${r.key}` : `tool:${r.tool || r.key || '?'}`;
      const body = (r.value ?? r.snippet ?? r.content ?? '').replace(/\s+/g, ' ').slice(0, 120);
      lines.push(`• <b>${escapeHtml(title)}</b>: ${escapeHtml(body)}`);
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  } catch (e: any) {
    await ctx.reply(`Error searching vault: ${e?.message ?? e}`);
  }
}

// ── Anton ───────────────────────────────────────────────────────────

const ANTON_RATE_LIMIT_MS = 10_000; // min 10s between progress updates

export async function handleAnton({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId) return;

  const text = ctx.message?.text ?? '';
  const args = text.replace(/^\/anton\s*/, '').trim();
  const sub = firstToken(args);

  const managed = sessions.get(chatId);

  // status
  if (!sub || sub === 'status') {
    if (!managed?.antonActive) {
      await ctx.reply('No Anton run in progress.');
      return;
    }
    if (managed.antonAbortSignal?.aborted) {
      await ctx.reply('🛑 Anton is stopping. Please wait for the current attempt to unwind.');
      return;
    }
    if (managed.antonProgress) {
      const line1 = formatProgressBar(managed.antonProgress);
      if (managed.antonProgress.currentTask) {
        await ctx.reply(`${line1}\n\n<b>Working on:</b> <i>${escapeHtml(managed.antonProgress.currentTask)}</i> (Attempt ${managed.antonProgress.currentAttempt})`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(line1);
      }
    } else {
      await ctx.reply('🤖 Anton is running (no progress data yet).');
    }
    return;
  }

  // stop
  if (sub === 'stop') {
    if (!managed?.antonActive || !managed.antonAbortSignal) {
      await ctx.reply('No Anton run in progress.');
      return;
    }
    managed.lastActivity = Date.now();
    managed.antonAbortSignal.aborted = true;
    await ctx.reply('🛑 Anton stop requested. Run will halt after the current task.');
    return;
  }

  // last
  if (sub === 'last') {
    if (!managed?.antonLastResult) {
      await ctx.reply('No previous Anton run.');
      return;
    }
    await ctx.reply(formatRunSummary(managed.antonLastResult));
    return;
  }

  // start run — args is the file path (possibly with "run" prefix)
  const filePart = sub === 'run' ? args.replace(/^\S+\s*/, '').trim() : args;
  if (!filePart) {
    await ctx.reply(
      [
        '<b>/anton</b> — Autonomous task runner',
        '',
        '/anton &lt;file&gt; — Start run',
        '/anton status — Show progress',
        '/anton stop — Stop running',
        '/anton last — Last run results',
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Ensure session exists
  const session = managed || (await sessions.getOrCreate(chatId, userId));
  if (!session) {
    await ctx.reply(
      '⚠️ Too many active sessions. Try again later (or wait for an old session to expire).'
    );
    return;
  }

  if (session.antonActive) {
    const staleMs = Date.now() - session.lastActivity;
    if (staleMs > 120_000) {
      session.antonActive = false;
      session.antonAbortSignal = null;
      session.antonProgress = null;
      await ctx.reply('♻️ Recovered stale Anton run state. Starting a fresh run...');
    } else {
      const msg = session.antonAbortSignal?.aborted
        ? '🛑 Anton is still stopping. Please wait a moment, then try again.'
        : '⚠️ Anton is already running. Use /anton stop first.';
      await ctx.reply(msg);
      return;
    }
  }

  const cwd = session.workingDir;
  const filePath = path.resolve(cwd, filePart);

  try {
    await fs.stat(filePath);
  } catch {
    await ctx.reply(`File not found: ${escapeHtml(filePath)}`, { parse_mode: 'HTML' });
    return;
  }

  const defaults = session.config.anton || {};
  const runConfig: AntonRunConfig = {
    taskFile: filePath,
    projectDir: cwd,
    maxRetriesPerTask: defaults.max_retries ?? 3,
    maxIterations: defaults.max_iterations ?? 200,
    taskMaxIterations: defaults.task_max_iterations ?? 50,
    taskTimeoutSec: defaults.task_timeout_sec ?? 600,
    totalTimeoutSec: defaults.total_timeout_sec ?? 7200,
    maxTotalTokens: defaults.max_total_tokens ?? Infinity,
    maxPromptTokensPerAttempt: defaults.max_prompt_tokens_per_attempt ?? 128_000,
    autoCommit: defaults.auto_commit ?? true,
    branch: false,
    allowDirty: false,
    aggressiveCleanOnFail: false,
    verifyAi: defaults.verify_ai ?? true,
    verifyModel: undefined,
    decompose: defaults.decompose ?? true,
    maxDecomposeDepth: defaults.max_decompose_depth ?? 2,
    maxTotalTasks: defaults.max_total_tasks ?? 500,
    buildCommand: undefined,
    testCommand: undefined,
    lintCommand: undefined,
    skipOnFail: defaults.skip_on_fail ?? false,
    skipOnBlocked: defaults.skip_on_blocked ?? true,
    rollbackOnFail: defaults.rollback_on_fail ?? false,
    maxIdenticalFailures: defaults.max_identical_failures ?? 5,
    approvalMode: (defaults.approval_mode ?? 'yolo') as AntonRunConfig['approvalMode'],
    verbose: false,
    dryRun: false,
  };

  const abortSignal = { aborted: false };
  session.antonActive = true;
  session.antonAbortSignal = abortSignal;
  session.antonProgress = null;

  let lastProgressAt = 0;

  const progress: AntonProgressCallback = {
    onTaskStart(task, attempt, prog) {
      session.antonProgress = prog;
      session.lastActivity = Date.now();
      const now = Date.now();
      if (now - lastProgressAt >= ANTON_RATE_LIMIT_MS) {
        lastProgressAt = now;
        ctx.reply(formatTaskStart(task, attempt, prog)).catch(() => { });
      }
    },
    onTaskEnd(task, result, prog) {
      session.antonProgress = prog;
      session.lastActivity = Date.now();
      const now = Date.now();
      if (now - lastProgressAt >= ANTON_RATE_LIMIT_MS) {
        lastProgressAt = now;
        ctx.reply(formatTaskEnd(task, result, prog)).catch(() => { });
      }
    },
    onTaskSkip(task, reason) {
      session.lastActivity = Date.now();
      ctx.reply(formatTaskSkip(task, reason)).catch(() => { });
    },
    onRunComplete(result) {
      session.lastActivity = Date.now();
      session.antonLastResult = result;
      session.antonActive = false;
      session.antonAbortSignal = null;
      session.antonProgress = null;
      ctx.reply(formatRunSummary(result)).catch(() => { });
    },
    onHeartbeat() {
      session.lastActivity = Date.now();
    },
    onToolLoop(taskText, event) {
      session.lastActivity = Date.now();
      if (defaults.progress_events !== false) {
        ctx.reply(formatToolLoopEvent(taskText, event)).catch(() => { });
      }
    },
    onCompaction(taskText, event) {
      session.lastActivity = Date.now();
      if (defaults.progress_events !== false && event.droppedMessages >= 5) {
        ctx.reply(formatCompactionEvent(taskText, event)).catch(() => { });
      }
    },
    onVerification(taskText, verification) {
      session.lastActivity = Date.now();
      if (defaults.progress_events !== false && !verification.passed) {
        ctx.reply(formatVerificationDetail(taskText, verification)).catch(() => { });
      }
    },
  };

  let pendingCount = 0;
  try {
    const tf = await parseTaskFile(filePath);
    pendingCount = tf.pending.length;
  } catch {
    /* non-fatal */
  }

  await ctx.reply(`🤖 Anton started on ${escapeHtml(filePart)} (${pendingCount} tasks pending)`, {
    parse_mode: 'HTML',
  });

  runAnton({
    config: runConfig,
    idlehandsConfig: session.config,
    progress,
    abortSignal,
    vault: session.session.vault,
    lens: session.session.lens,
  }).catch((err: Error) => {
    session.lastActivity = Date.now();
    session.antonActive = false;
    session.antonAbortSignal = null;
    session.antonProgress = null;
    ctx.reply(`Anton error: ${err.message}`).catch(() => { });
  });
}

// ── Multi-agent commands ───────────────────────────────────────────────

export async function handleAgent({
  ctx,
  sessions,
  botConfig: _botConfig,
}: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const managed = sessions.get(chatId);

  if (!managed?.agentPersona) {
    await ctx.reply('No agent configured. Using global config.');
    return;
  }

  const p = managed.agentPersona;
  const lines = [
    `<b>Agent: ${escapeHtml(p.display_name || managed.agentId)}</b> (<code>${escapeHtml(managed.agentId)}</code>)`,
    ...(p.model ? [`<b>Model:</b> <code>${escapeHtml(p.model)}</code>`] : []),
    ...(p.endpoint ? [`<b>Endpoint:</b> <code>${escapeHtml(p.endpoint)}</code>`] : []),
    ...(p.approval_mode ? [`<b>Approval:</b> <code>${escapeHtml(p.approval_mode)}</code>`] : []),
    ...(p.default_dir ? [`<b>Default dir:</b> <code>${escapeHtml(p.default_dir)}</code>`] : []),
    ...(p.allowed_dirs?.length
      ? [
        `<b>Allowed dirs:</b> ${p.allowed_dirs.map((d) => `<code>${escapeHtml(d)}</code>`).join(', ')}`,
      ]
      : []),
  ];

  // Show escalation info if configured
  if (p.escalation?.models?.length) {
    lines.push('');
    lines.push(
      `<b>Escalation models:</b> ${p.escalation.models.map((m) => `<code>${escapeHtml(m)}</code>`).join(', ')}`
    );
    if (managed.currentModelIndex > 0) {
      lines.push(`<b>Current tier:</b> ${managed.currentModelIndex} (escalated)`);
    }
    if (managed.pendingEscalation) {
      lines.push(
        `<b>Pending escalation:</b> <code>${escapeHtml(managed.pendingEscalation)}</code>`
      );
    }
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleAgents({ ctx, sessions, botConfig }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const agents = botConfig.telegram?.agents;
  if (!agents || Object.keys(agents).length === 0) {
    await ctx.reply('No agents configured. Using global config.');
    return;
  }

  const managed = sessions.get(chatId);
  const currentAgentId = managed?.agentId;

  const lines = ['<b>Configured Agents:</b>', ''];
  for (const [id, agent] of Object.entries(agents)) {
    const current = id === currentAgentId ? ' ← current' : '';
    const model = agent.model ? ` (${escapeHtml(agent.model)})` : '';
    lines.push(
      `• <b>${escapeHtml(agent.display_name || id)}</b> (<code>${escapeHtml(id)}</code>)${model}${current}`
    );
  }

  // Show routing rules
  const routing = botConfig.telegram?.routing;
  if (routing) {
    lines.push('', '<b>Routing:</b>');
    if (routing.default) lines.push(`Default: <code>${escapeHtml(routing.default)}</code>`);
    if (routing.users && Object.keys(routing.users).length > 0) {
      lines.push(
        `Users: ${Object.entries(routing.users)
          .map(([u, a]) => `${u}→${escapeHtml(a)}`)
          .join(', ')}`
      );
    }
    if (routing.chats && Object.keys(routing.chats).length > 0) {
      lines.push(
        `Chats: ${Object.entries(routing.chats)
          .map(([c, a]) => `${c}→${escapeHtml(a)}`)
          .join(', ')}`
      );
    }
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleEscalate({ ctx, sessions, botConfig }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId) return;

  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session. Send a message first.');
    return;
  }

  const escalation = managed.agentPersona?.escalation;
  if (!escalation || !escalation.models?.length) {
    await ctx.reply('❌ No escalation models configured for this agent.');
    return;
  }

  const text = ctx.message?.text ?? '';
  const arg = text.replace(/^\/escalate\s*/, '').trim();

  // No arg: show available models and current state
  if (!arg) {
    const currentModel = managed.config.model || botConfig.model || 'default';
    const lines = [
      `<b>Current model:</b> <code>${escapeHtml(currentModel)}</code>`,
      `<b>Escalation models:</b> ${escalation.models.map((m) => `<code>${escapeHtml(m)}</code>`).join(', ')}`,
      '',
      'Usage: /escalate &lt;model&gt; or /escalate next',
      'Then send your message - it will use the escalated model.',
    ];
    if (managed.pendingEscalation) {
      lines.push(
        '',
        `⚡ <b>Pending escalation:</b> <code>${escapeHtml(managed.pendingEscalation)}</code> (next message will use this)`
      );
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    return;
  }

  // Handle 'next' - escalate to next model in chain
  let targetModel: string;
  let targetEndpoint: string | undefined;
  if (arg.toLowerCase() === 'next') {
    const nextIndex = Math.min(managed.currentModelIndex, escalation.models.length - 1);
    targetModel = escalation.models[nextIndex];
    targetEndpoint = escalation.tiers?.[nextIndex]?.endpoint;
  } else {
    // Specific model requested
    if (!escalation.models.includes(arg)) {
      await ctx.reply(
        `❌ Model <code>${escapeHtml(arg)}</code> not in escalation chain. Available: ${escalation.models.map((m) => `<code>${escapeHtml(m)}</code>`).join(', ')}`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    targetModel = arg;
    const idx = escalation.models.indexOf(arg);
    targetEndpoint = escalation.tiers?.[idx]?.endpoint;
  }

  managed.pendingEscalation = targetModel;
  managed.pendingEscalationEndpoint = targetEndpoint || null;
  await ctx.reply(
    `⚡ Next message will use <code>${escapeHtml(targetModel)}</code>. Send your request now.`,
    { parse_mode: 'HTML' }
  );
}

export async function handleDeescalate({
  ctx,
  sessions,
  botConfig,
}: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session.');
    return;
  }

  if (managed.currentModelIndex === 0 && !managed.pendingEscalation) {
    await ctx.reply('Already using base model.');
    return;
  }

  const baseModel = managed.agentPersona?.model || botConfig.model || 'default';
  managed.pendingEscalation = null;
  managed.pendingEscalationEndpoint = null;
  managed.currentModelIndex = 0;

  // Recreate session with base model
  try {
    await sessions.recreateSession(chatId, { model: baseModel });
    await ctx.reply(`✅ Returned to base model: <code>${escapeHtml(baseModel)}</code>`, {
      parse_mode: 'HTML',
    });
  } catch (e: any) {
    await ctx.reply(`❌ Failed to deescalate: ${e?.message ?? e}`);
  }
}

export async function handleRestartBot({ ctx }: CommandContext): Promise<void> {
  const { spawn } = await import('node:child_process');
  await ctx.reply('🔄 Restarting idlehands-bot service...');
  // Spawn detached process to restart after we return
  spawn('systemctl', ['--user', 'restart', 'idlehands-bot'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

export async function handleGitStatus({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session. Send a message to start one.');
    return;
  }

  const cwd = managed.workingDir;
  if (!cwd) {
    await ctx.reply('No working directory set. Use /dir to set one.');
    return;
  }

  const { spawnSync } = await import('node:child_process');

  // Run git status -s (short format)
  const statusResult = spawnSync('git', ['status', '-s'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });

  if (statusResult.status !== 0) {
    const err = String(statusResult.stderr || statusResult.error || 'Unknown error');
    if (err.includes('not a git repository') || err.includes('not in a git')) {
      await ctx.reply('❌ Not a git repository.');
    } else {
      await ctx.reply(`❌ git status failed: ${escapeHtml(err.slice(0, 200))}`);
    }
    return;
  }

  const statusOut = String(statusResult.stdout || '').trim();

  // Also get branch info
  const branchResult = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    timeout: 2000,
  });
  const branch = branchResult.status === 0 ? String(branchResult.stdout || '').trim() : 'unknown';

  if (!statusOut) {
    await ctx.reply(
      `📁 <b>${escapeHtml(cwd)}</b>\n🌿 Branch: <code>${escapeHtml(branch)}</code>\n\n✅ Working tree clean`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const lines = statusOut.split('\n').slice(0, 30); // Limit to 30 lines
  const truncated = statusOut.split('\n').length > 30;

  const formatted = lines
    .map((line) => {
      const code = line.slice(0, 2);
      const file = line.slice(3);
      return `<code>${escapeHtml(code)}</code> ${escapeHtml(file)}`;
    })
    .join('\n');

  await ctx.reply(
    `📁 <b>${escapeHtml(cwd)}</b>\n🌿 Branch: <code>${escapeHtml(branch)}</code>\n\n<pre>${formatted}${truncated ? '\n...' : ''}</pre>`,
    { parse_mode: 'HTML' }
  );
}
