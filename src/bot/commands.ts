/**
 * Telegram bot command handlers.
 * Each handler receives the grammy Context and the SessionManager.
 */

import type { Context } from 'grammy';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { SessionManager } from './session-manager.js';
import { escapeHtml } from './format.js';
import { runAnton } from '../anton/controller.js';
import { parseTaskFile } from '../anton/parser.js';
import { formatRunSummary, formatProgressBar, formatTaskStart, formatTaskEnd, formatTaskSkip } from '../anton/reporter.js';
import type { AntonRunConfig, AntonProgressCallback } from '../anton/types.js';
import { projectDir } from '../utils.js';

type CommandContext = {
  ctx: Context;
  sessions: SessionManager;
  botConfig: {
    model?: string;
    endpoint?: string;
    defaultDir?: string;
  };
};

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
    '/dir [path] — Get/set working directory',
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
  const contextPct = s.contextWindow > 0
    ? ((s.usage.prompt + s.usage.completion) / s.contextWindow * 100).toFixed(1)
    : '?';
  const lines = [
    '<b>Session Status</b>',
    '',
    `<b>Model:</b> <code>${escapeHtml(s.model)}</code>`,
    `<b>Harness:</b> <code>${escapeHtml(s.harness)}</code>`,
    `<b>Dir:</b> <code>${escapeHtml(managed.workingDir)}</code>`,
    `<b>Context:</b> ~${(s.usage.prompt + s.usage.completion).toLocaleString()} / ${s.contextWindow.toLocaleString()} (${contextPct}%)`,
    `<b>Tokens:</b> prompt=${s.usage.prompt.toLocaleString()}, completion=${s.usage.completion.toLocaleString()}`,
    `<b>In-flight:</b> ${managed.inFlight ? 'yes' : 'no'}`,
    `<b>State:</b> ${managed.state}`,
    `<b>Queue:</b> ${managed.pendingQueue.length} pending`,
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleDir({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const text = ctx.message?.text ?? '';
  const arg = text.replace(/^\/dir\s*/, '').trim();

  const managed = sessions.get(chatId);

  if (!arg) {
    // Show current dir
    const dir = managed?.workingDir ?? '(no session)';
    await ctx.reply(`<b>Working directory:</b> <code>${escapeHtml(dir)}</code>`, { parse_mode: 'HTML' });
    return;
  }

  // Set new dir
  const ok = await sessions.setDir(chatId, arg);
  if (ok) {
    await ctx.reply(`✅ Working directory set to <code>${escapeHtml(arg)}</code>`, { parse_mode: 'HTML' });
  } else {
    await ctx.reply('❌ Directory not allowed or session error. Check bot.telegram.allowed_dirs config.');
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
    await ctx.reply(`<b>Approval mode:</b> <code>${escapeHtml(current)}</code>\n\nOptions: ${modes.join(', ')}`, { parse_mode: 'HTML' });
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
  await ctx.reply(`✅ Approval mode set to <code>${escapeHtml(arg)}</code>`, { parse_mode: 'HTML' });
}

export async function handleMode({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const text = ctx.message?.text ?? '';
  const arg = text.replace(/^\/mode\s*/, '').trim().toLowerCase();
  const managed = sessions.get(chatId);

  if (!managed) {
    await ctx.reply('No active session. Send a message to start one.');
    return;
  }

  if (!arg) {
    await ctx.reply(`<b>Mode:</b> <code>${escapeHtml(managed.config.mode ?? 'code')}</code>`, { parse_mode: 'HTML' });
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
  const arg = text.replace(/^\/subagents\s*/, '').trim().toLowerCase();
  const managed = sessions.get(chatId);

  if (!managed) {
    await ctx.reply('No active session. Send a message to start one.');
    return;
  }

  const current = managed.config.sub_agents?.enabled !== false;

  if (!arg) {
    await ctx.reply(
      `<b>Sub-agents:</b> <code>${current ? 'on' : 'off'}</code>\n\nUsage: /subagents on | off`,
      { parse_mode: 'HTML' },
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
    { parse_mode: 'HTML' },
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
  const sub = args.split(/\s+/)[0]?.toLowerCase() || '';

  const managed = sessions.get(chatId);

  // status
  if (!sub || sub === 'status') {
    if (!managed?.antonActive) {
      await ctx.reply('No Anton run in progress.');
      return;
    }
    if (managed.antonProgress) {
      await ctx.reply(formatProgressBar(managed.antonProgress));
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
    await ctx.reply([
      '<b>/anton</b> — Autonomous task runner',
      '',
      '/anton &lt;file&gt; — Start run',
      '/anton status — Show progress',
      '/anton stop — Stop running',
      '/anton last — Last run results',
    ].join('\n'), { parse_mode: 'HTML' });
    return;
  }

  // Ensure session exists
  const session = managed || await sessions.getOrCreate(chatId, userId);
  if (!session) {
    await ctx.reply('⚠️ Too many active sessions. Try again later or /reset.');
    return;
  }

  if (session.antonActive) {
    await ctx.reply('⚠️ Anton is already running. Use /anton stop first.');
    return;
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
    taskTimeoutSec: defaults.task_timeout_sec ?? 600,
    totalTimeoutSec: defaults.total_timeout_sec ?? 7200,
    maxTotalTokens: defaults.max_total_tokens ?? Infinity,
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
    skipOnFail: defaults.skip_on_fail ?? true,
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
      const now = Date.now();
      if (now - lastProgressAt >= ANTON_RATE_LIMIT_MS) {
        lastProgressAt = now;
        ctx.reply(formatTaskStart(task, attempt, prog)).catch(() => {});
      }
    },
    onTaskEnd(task, result, prog) {
      session.antonProgress = prog;
      const now = Date.now();
      if (now - lastProgressAt >= ANTON_RATE_LIMIT_MS) {
        lastProgressAt = now;
        ctx.reply(formatTaskEnd(task, result, prog)).catch(() => {});
      }
    },
    onTaskSkip(task, reason) {
      ctx.reply(formatTaskSkip(task, reason)).catch(() => {});
    },
    onRunComplete(result) {
      session.antonLastResult = result;
      session.antonActive = false;
      session.antonAbortSignal = null;
      session.antonProgress = null;
      ctx.reply(formatRunSummary(result)).catch(() => {});
    },
  };

  let pendingCount = 0;
  try {
    const tf = await parseTaskFile(filePath);
    pendingCount = tf.pending.length;
  } catch { /* non-fatal */ }

  await ctx.reply(`🤖 Anton started on ${escapeHtml(filePart)} (${pendingCount} tasks pending)`, { parse_mode: 'HTML' });

  runAnton({
    config: runConfig,
    idlehandsConfig: session.config,
    progress,
    abortSignal,
    vault: session.session.vault,
    lens: session.session.lens,
  }).catch((err: Error) => {
    session.antonActive = false;
    session.antonAbortSignal = null;
    session.antonProgress = null;
    ctx.reply(`Anton error: ${err.message}`).catch(() => {});
  });
}
