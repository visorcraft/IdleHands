/**
 * Telegram bot command handlers.
 * Each handler receives the grammy Context and the SessionManager.
 *
 * Business logic lives in command-logic.ts; this file is a thin wrapper
 * that maps grammy Context → shared logic → HTML reply.
 */

import type { Context } from 'grammy';

import { firstToken } from '../cli/command-utils.js';
import type { BotTelegramConfig } from '../types.js';
import type { WatchdogSettings } from '../watchdog.js';

import { formatHtml } from './command-format.js';
import {
  versionCommand,
  startCommand,
  helpCommand,
  modelCommand,
  compactCommand,
  statusCommand,
  watchdogCommand,
  dirShowCommand,
  dirSetOk,
  dirSetFail,
  pinOk,
  pinFail,
  unpinOk,
  unpinNotPinned,
  unpinFail,
  approvalShowCommand,
  approvalSetCommand,
  modeShowCommand,
  modeSetCommand,
  subagentsShowCommand,
  subagentsSetCommand,
  changesCommand,
  undoCommand,
  vaultCommand,
  agentCommand,
  agentsCommand,
  escalateShowCommand,
  escalateSetCommand,
  deescalateCommand,
  gitStatusCommand,
  antonCommand,
  type ManagedLike,
} from './command-logic.js';
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

/** Send formatted CmdResult as Telegram HTML. */
async function reply(ctx: Context, result: ReturnType<typeof formatHtml> extends string ? Parameters<typeof formatHtml>[0] : never): Promise<void> {
  const text = formatHtml(result);
  if (!text) return;
  await ctx.reply(text, { parse_mode: 'HTML' });
}

export async function handleVersion({ ctx, botConfig }: CommandContext): Promise<void> {
  await reply(ctx, versionCommand({
    version: botConfig.version,
    model: botConfig.model,
    endpoint: botConfig.endpoint,
  }));
}

export async function handleStart({ ctx, botConfig }: CommandContext): Promise<void> {
  await reply(ctx, startCommand({
    version: botConfig.version,
    model: botConfig.model,
    endpoint: botConfig.endpoint,
    defaultDir: botConfig.defaultDir,
  }));
}

export async function handleHelp({ ctx }: CommandContext): Promise<void> {
  await reply(ctx, helpCommand('telegram'));
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
  await reply(ctx, statusCommand(managed as unknown as ManagedLike));
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
  await reply(
    ctx,
    watchdogCommand(
      managed as unknown as ManagedLike | undefined,
      botConfig.watchdog,
    ),
  );
}

export async function handleDir({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId) return;
  const text = ctx.message?.text ?? '';
  const arg = text.replace(/^\/dir\s*/, '').trim();

  let managed = sessions.get(chatId);

  if (!arg) {
    await reply(ctx, dirShowCommand(managed as unknown as ManagedLike | undefined));
    return;
  }

  // Auto-create session if none exists
  if (!managed && userId) {
    managed = (await sessions.getOrCreate(chatId, userId)) ?? undefined;
    if (!managed) {
      await ctx.reply('⚠️ Too many active sessions. Try again later.');
      return;
    }
  }
  if (!managed) {
    await ctx.reply('No active session. Send a message to start one.');
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
  const userId = ctx.from?.id;
  if (!chatId) return;

  let managed = sessions.get(chatId);

  // Auto-create session if none exists
  if (!managed && userId) {
    managed = (await sessions.getOrCreate(chatId, userId)) ?? undefined;
    if (!managed) {
      await ctx.reply('⚠️ Too many active sessions. Try again later.');
      return;
    }
  }
  if (!managed) {
    await ctx.reply('No active session. Send a message to start one.');
    return;
  }

  const currentDir = managed.workingDir;
  if (!currentDir) {
    await ctx.reply('No working directory set. Use /dir to set one first.');
    return;
  }

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

export async function handleUnpin({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session. Send a message to start one.');
    return;
  }

  if (!managed.dirPinned) {
    await ctx.reply('Directory is not pinned.');
    return;
  }

  const ok = await sessions.unpin(chatId);
  if (ok) {
    await ctx.reply(`✅ Directory unpinned. Working directory remains at <code>${escapeHtml(managed.workingDir)}</code>`, {
      parse_mode: 'HTML',
    });
  } else {
    await ctx.reply('❌ Failed to unpin directory.');
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
  await reply(ctx, modelCommand(managed as unknown as ManagedLike));
}

export async function handleCompact({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session.');
    return;
  }
  await reply(ctx, compactCommand(managed as unknown as ManagedLike));
}

export async function handleApproval({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const text = ctx.message?.text ?? '';
  const arg = text.replace(/^\/approval\s*/, '').trim();

  const managed = sessions.get(chatId);

  if (!arg) {
    if (!managed) {
      await ctx.reply('No active session.');
      return;
    }
    await reply(ctx, approvalShowCommand(managed as unknown as ManagedLike));
    return;
  }

  if (managed) {
    const result = approvalSetCommand(managed as unknown as ManagedLike, arg);
    if (result) {
      await reply(ctx, result);
      return;
    }
  }
  // If no managed session but arg given, still try to validate
  const modes = ['plan', 'default', 'auto-edit', 'yolo'];
  if (!modes.includes(arg)) {
    await ctx.reply(`Invalid mode. Options: ${modes.join(', ')}`);
    return;
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
    await reply(ctx, modeShowCommand(managed as unknown as ManagedLike));
    return;
  }

  await reply(ctx, modeSetCommand(managed as unknown as ManagedLike, arg));
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

  if (!arg) {
    await reply(ctx, subagentsShowCommand(managed as unknown as ManagedLike));
    return;
  }

  await reply(ctx, subagentsSetCommand(managed as unknown as ManagedLike, arg));
}

export async function handleChanges({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session.');
    return;
  }
  await reply(ctx, await changesCommand(managed as unknown as ManagedLike));
}

export async function handleUndo({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session.');
    return;
  }
  await reply(ctx, await undoCommand(managed as unknown as ManagedLike));
}

export async function handleVault({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No active session.');
    return;
  }
  const text = ctx.message?.text ?? '';
  const query = text.replace(/^\/vault\s*/, '').trim();
  await reply(ctx, await vaultCommand(managed as unknown as ManagedLike, query));
}

// ── Anton ───────────────────────────────────────────────────────────

const ANTON_RATE_LIMIT_MS = 3_000;

export async function handleAnton({ ctx, sessions }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId) return;

  const text = ctx.message?.text ?? '';
  const args = text.replace(/^\/anton\s*/, '').trim();
  const sub = firstToken(args);

  const sendAntonUpdate = (t: string) => {
    ctx.api.sendMessage(chatId, t).catch(() => {});
  };

  let managed = sessions.get(chatId);

  // For status/stop/last we need an existing session
  if (!sub || sub === 'status' || sub === 'stop' || sub === 'last') {
    if (!managed) {
      await ctx.reply('No active session.');
      return;
    }
    await reply(ctx, await antonCommand(
      managed as unknown as ManagedLike,
      args,
      sendAntonUpdate,
      ANTON_RATE_LIMIT_MS,
    ));
    return;
  }

  // For start — ensure session exists
  const session = managed || (await sessions.getOrCreate(chatId, userId));
  if (!session) {
    await ctx.reply(
      '⚠️ Too many active sessions. Try again later (or wait for an old session to expire).'
    );
    return;
  }

  await reply(ctx, await antonCommand(
    session as unknown as ManagedLike,
    args,
    sendAntonUpdate,
    ANTON_RATE_LIMIT_MS,
  ));
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
  if (!managed) {
    await ctx.reply('No agent configured. Using global config.');
    return;
  }
  await reply(ctx, agentCommand(managed as unknown as ManagedLike));
}

export async function handleAgents({ ctx, sessions, botConfig }: CommandContext): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const managed = sessions.get(chatId);
  if (!managed) {
    await ctx.reply('No agents configured. Using global config.');
    return;
  }

  await reply(
    ctx,
    agentsCommand(managed as unknown as ManagedLike, {
      agents: botConfig.telegram?.agents,
      routing: botConfig.telegram?.routing,
    }),
  );
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

  const m = managed as unknown as ManagedLike;
  const escalation = m.agentPersona?.escalation;
  if (!escalation || !escalation.models?.length) {
    await ctx.reply('❌ No escalation models configured for this agent.');
    return;
  }

  const text = ctx.message?.text ?? '';
  const arg = text.replace(/^\/escalate\s*/, '').trim();

  if (!arg) {
    const currentModel = managed.config.model || botConfig.model || 'default';
    await reply(ctx, escalateShowCommand(m, currentModel));
    return;
  }

  await reply(ctx, escalateSetCommand(m, arg));
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

  const m = managed as unknown as ManagedLike;
  const baseModel = m.agentPersona?.model || botConfig.model || 'default';
  const result = deescalateCommand(m, baseModel);

  if (result !== 'recreate') {
    await reply(ctx, result);
    return;
  }

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

  await reply(ctx, await gitStatusCommand(cwd));
}
