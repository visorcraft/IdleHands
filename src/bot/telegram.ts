/**
 * Idle Hands Telegram Bot — main entry point.
 * grammy-based long-polling bot that wraps the agent core.
 */

import { Bot, InputFile } from 'grammy';
import type { IdlehandsConfig, BotTelegramConfig, ToolCallEvent, ToolResultEvent, ModelEscalation } from '../types.js';
import type { AgentHooks } from '../agent.js';
import { SessionManager, type ManagedSession } from './session-manager.js';
import { markdownToTelegramHtml, splitMessage, escapeHtml, formatToolCallSummary } from './format.js';
import {
  handleStart, handleHelp, handleNew, handleCancel,
  handleStatus, handleWatchdog, handleDir, handleModel, handleCompact,
  handleApproval, handleMode, handleSubAgents, handleChanges, handleUndo, handleVault,
  handleAnton, handleAgent, handleAgents, handleEscalate, handleDeescalate,
} from './commands.js';
import { TelegramConfirmProvider } from './confirm-telegram.js';
import { formatWatchdogCancelMessage, resolveWatchdogSettings } from '../watchdog.js';

// ---------------------------------------------------------------------------
// Escalation helpers (mirrored from discord.ts)
// ---------------------------------------------------------------------------

/**
 * Check if the model response contains an escalation request.
 * Returns { escalate: true, reason: string } if escalation marker found at start of response.
 */
function detectEscalation(text: string): { escalate: boolean; reason?: string } {
  const trimmed = text.trim();
  const match = trimmed.match(/^\[ESCALATE:\s*([^\]]+)\]/i);
  if (match) {
    return { escalate: true, reason: match[1].trim() };
  }
  return { escalate: false };
}

/** Keyword presets for common escalation triggers */
const KEYWORD_PRESETS: Record<string, string[]> = {
  coding: ['build', 'implement', 'create', 'develop', 'architect', 'refactor', 'debug', 'fix', 'code', 'program', 'write'],
  planning: ['plan', 'design', 'roadmap', 'strategy', 'analyze', 'research', 'evaluate', 'compare'],
  complex: ['full', 'complete', 'comprehensive', 'multi-step', 'integrate', 'migration', 'overhaul', 'entire', 'whole'],
};

/**
 * Check if text matches a set of keywords.
 * Returns matched keywords or empty array if none match.
 */
function matchKeywords(text: string, keywords: string[], presets?: string[]): string[] {
  const allKeywords: string[] = [...keywords];
  
  // Add preset keywords
  if (presets) {
    for (const preset of presets) {
      const presetWords = KEYWORD_PRESETS[preset];
      if (presetWords) allKeywords.push(...presetWords);
    }
  }
  
  if (allKeywords.length === 0) return [];
  
  const lowerText = text.toLowerCase();
  const matched: string[] = [];
  
  for (const kw of allKeywords) {
    if (kw.startsWith('re:')) {
      // Regex pattern
      try {
        const regex = new RegExp(kw.slice(3), 'i');
        if (regex.test(text)) matched.push(kw);
      } catch {
        // Invalid regex, skip
      }
    } else {
      // Word boundary match (case-insensitive)
      const wordRegex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (wordRegex.test(lowerText)) matched.push(kw);
    }
  }
  
  return matched;
}

/**
 * Check if user message matches keyword escalation triggers.
 * Returns { escalate: true, tier: number, reason: string } if keywords match.
 * Tier indicates which model index to escalate to (highest matching tier wins).
 */
function checkKeywordEscalation(
  text: string,
  escalation: ModelEscalation | undefined
): { escalate: boolean; tier?: number; reason?: string } {
  if (!escalation) return { escalate: false };
  
  // Tiered keyword escalation
  if (escalation.tiers && escalation.tiers.length > 0) {
    let highestTier = -1;
    let highestReason = '';
    
    // Check each tier, highest matching tier wins
    for (let i = 0; i < escalation.tiers.length; i++) {
      const tier = escalation.tiers[i];
      const matched = matchKeywords(
        text,
        tier.keywords || [],
        tier.keyword_presets as string[] | undefined
      );
      
      if (matched.length > 0 && i > highestTier) {
        highestTier = i;
        highestReason = `tier ${i} keyword match: ${matched.slice(0, 3).join(', ')}${matched.length > 3 ? '...' : ''}`;
      }
    }
    
    if (highestTier >= 0) {
      return { escalate: true, tier: highestTier, reason: highestReason };
    }
    
    return { escalate: false };
  }
  
  // Legacy flat keywords (treated as tier 0)
  const matched = matchKeywords(
    text,
    escalation.keywords || [],
    escalation.keyword_presets as string[] | undefined
  );
  
  if (matched.length > 0) {
    return { 
      escalate: true,
      tier: 0,
      reason: `keyword match: ${matched.slice(0, 3).join(', ')}${matched.length > 3 ? '...' : ''}`
    };
  }
  
  return { escalate: false };
}

// ---------------------------------------------------------------------------
// Streaming message helper
// ---------------------------------------------------------------------------

class StreamingMessage {
  private buffer = '';
  private toolLines: string[] = [];
  private lastToolLine = "";
  private lastToolRepeat = 0;
  private messageId: number | null = null;
  private editTimer: ReturnType<typeof setInterval> | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private lastEditText = '';
  private finalized = false;
  private backoffMs = 0;

  constructor(
    private bot: Bot,
    private chatId: number,
    private editIntervalMs: number,
    private replyToId?: number,
    private fileThresholdChars: number = 8192
  ) {}

  async init(): Promise<void> {
    // Show "typing..." indicator immediately; repeat every 4s (Telegram auto-expires at ~5s)
    this.bot.api.sendChatAction(this.chatId, 'typing').catch(() => {});
    this.typingTimer = setInterval(() => {
      if (!this.finalized) {
        this.bot.api.sendChatAction(this.chatId, 'typing').catch(() => {});
      }
    }, 4_000);

    const msg = await this.bot.api.sendMessage(this.chatId, '⏳ Thinking...', {
      reply_to_message_id: this.replyToId,
    });
    this.messageId = msg.message_id;
    this.startEditLoop();
  }

  private stopTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  onToken(token: string): void {
    this.buffer += token;
  }

  onToolCall(call: ToolCallEvent): void {
    const summary = formatToolCallSummary(call);
    const line = `◆ ${summary}...`;
    if (this.lastToolLine === line && this.toolLines.length > 0) {
      this.lastToolRepeat += 1;
      this.toolLines[this.toolLines.length - 1] = `${line} (x${this.lastToolRepeat + 1})`;
      return;
    }
    this.lastToolLine = line;
    this.lastToolRepeat = 0;
    this.toolLines.push(line);
  }

  onToolResult(result: ToolResultEvent): void {
    this.lastToolLine = "";
    this.lastToolRepeat = 0;
    if (this.toolLines.length > 0) {
      const icon = result.success ? '✓' : '✗';
      this.toolLines[this.toolLines.length - 1] = `${icon} ${result.name}: ${result.summary}`;
    }
  }

  private startEditLoop(): void {
    this.editTimer = setInterval(() => this.flush(), this.editIntervalMs);
  }

  private async flush(): Promise<void> {
    if (!this.messageId || this.finalized) return;
    if (this.backoffMs > 0) {
      this.backoffMs = Math.max(0, this.backoffMs - this.editIntervalMs);
      return; // skip this edit cycle while backing off
    }
    const text = this.render();
    if (!text || text === this.lastEditText) return;
    this.lastEditText = text;
    try {
      await this.bot.api.editMessageText(this.chatId, this.messageId, text, {
        parse_mode: 'HTML',
      });
    } catch (e: any) {
      const desc = e?.description ?? e?.message ?? '';
      if (desc.includes('Too Many Requests') || desc.includes('429')) {
        // Exponential backoff on rate limit
        const retryAfter = (e?.parameters?.retry_after ?? 3) * 1000;
        this.backoffMs = Math.min(retryAfter * 2, 30_000);
        console.error(`[bot] rate limited, backing off ${this.backoffMs}ms`);
      } else if (!desc.includes('message is not modified') && !desc.includes('message to edit not found')) {
        console.error(`[bot] edit error: ${desc}`);
      }
    }
  }

  private render(): string {
    let out = '';
    if (this.toolLines.length) {
      out += `<pre>${escapeHtml(this.toolLines.join('\n'))}</pre>\n\n`;
    }
    if (this.buffer) {
      out += markdownToTelegramHtml(this.buffer);
    }
    if (!out.trim()) {
      out = '⏳ Thinking...';
    }
    return out.slice(0, 4096);
  }

  /** Finalize: stop the edit loop and send the final response. */
  async finalize(text: string): Promise<void> {
    this.finalized = true;
    this.stopTyping();
    if (this.editTimer) {
      clearInterval(this.editTimer);
      this.editTimer = null;
    }

    const html = this.renderFinal(text);

    // Large output fallback: send as .md file attachment
    if (text.length > this.fileThresholdChars) {
      // Edit placeholder to a summary
      const summary = text.slice(0, 200).replace(/\n/g, ' ').trim();
      const summaryHtml = `📄 Response is ${text.length.toLocaleString()} chars — sent as file.\n\n<i>${escapeHtml(summary)}…</i>`;
      if (this.messageId) {
        await this.bot.api.editMessageText(this.chatId, this.messageId, summaryHtml, {
          parse_mode: 'HTML',
        }).catch(() => {});
      }
      const fileContent = Buffer.from(text, 'utf-8');
      await this.bot.api.sendDocument(this.chatId, new InputFile(fileContent, 'response.md'), {
        caption: `Full response (${text.length.toLocaleString()} chars)`,
      }).catch((e: any) => {
        console.error(`[bot] sendDocument error: ${e?.message ?? e}`);
      });
      return;
    }

    const chunks = splitMessage(html, 4096);

    // Edit the first message with the first chunk
    if (this.messageId && chunks.length > 0) {
      try {
        await this.bot.api.editMessageText(this.chatId, this.messageId, chunks[0], {
          parse_mode: 'HTML',
        });
      } catch (e: any) {
        // If edit fails (too old, etc.), send as new message
        const desc = e?.description ?? '';
        if (desc.includes('message to edit not found')) {
          await this.bot.api.sendMessage(this.chatId, chunks[0], { parse_mode: 'HTML' }).catch(() => {});
        }
      }
    }

    // Send remaining chunks as new messages
    for (let i = 1; i < chunks.length && i < 10; i++) {
      try {
        await this.bot.api.sendMessage(this.chatId, chunks[i], { parse_mode: 'HTML' });
      } catch (e: any) {
        console.error(`[bot] send chunk ${i} error: ${e?.message ?? e}`);
        break;
      }
    }

    if (chunks.length > 10) {
      await this.bot.api.sendMessage(
        this.chatId,
        '[truncated — response too long]'
      ).catch(() => {});
    }
  }

  private renderFinal(text: string): string {
    let out = '';
    if (this.toolLines.length) {
      out += `<pre>${escapeHtml(this.toolLines.join('\n'))}</pre>\n\n`;
    }
    out += markdownToTelegramHtml(text);
    return out || '(empty response)';
  }

  /** Finalize with an error message. */
  async finalizeError(errMsg: string): Promise<void> {
    this.finalized = true;
    this.stopTyping();
    if (this.editTimer) {
      clearInterval(this.editTimer);
      this.editTimer = null;
    }

    let html = '';
    if (this.toolLines.length) {
      html += `<pre>${escapeHtml(this.toolLines.join('\n'))}</pre>\n\n`;
    }
    if (this.buffer.trim()) {
      html += markdownToTelegramHtml(this.buffer) + '\n\n';
    }
    html += `❌ ${escapeHtml(errMsg)}`;

    if (this.messageId) {
      try {
        await this.bot.api.editMessageText(this.chatId, this.messageId, html.slice(0, 4096), {
          parse_mode: 'HTML',
        });
        return;
      } catch {
        // fall through to send
      }
    }
    await this.bot.api.sendMessage(this.chatId, html.slice(0, 4096), { parse_mode: 'HTML' }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Bot startup
// ---------------------------------------------------------------------------

export async function startTelegramBot(config: IdlehandsConfig, botConfig: BotTelegramConfig): Promise<void> {
  // Validate config
  const token = process.env.IDLEHANDS_TG_TOKEN || botConfig.token;
  if (!token) {
    console.error('[bot] IDLEHANDS_TG_TOKEN not set and bot.telegram.token is empty.');
    process.exit(1);
  }

  const allowedUsersEnv = process.env.IDLEHANDS_TG_ALLOWED_USERS;
  const rawUsers = allowedUsersEnv
    ? allowedUsersEnv.split(',').map(Number).filter(Boolean)
    : Array.isArray(botConfig.allowed_users)
      ? botConfig.allowed_users
      : botConfig.allowed_users != null
        ? [Number(botConfig.allowed_users)].filter(Boolean)
        : [];
  const allowedUsers = new Set(rawUsers);
  if (allowedUsers.size === 0) {
    console.error('[bot] bot.telegram.allowed_users is empty — refusing to start an unauthenticated bot.');
    process.exit(1);
  }

  const bot = new Bot(token);
  const sessions = new SessionManager(
    config,
    botConfig,
    (chatId) => new TelegramConfirmProvider(bot, chatId, botConfig.confirm_timeout_sec ?? 300),
  );
  const editIntervalMs = botConfig.edit_interval_ms ?? 1500;
  const replyToUserMessages = botConfig.reply_to_user_messages === true;
  const watchdogSettings = resolveWatchdogSettings(botConfig, config);
  const watchdogMs = watchdogSettings.timeoutMs;
  const maxWatchdogCompacts = watchdogSettings.maxCompactions;
  const watchdogIdleGraceTimeouts = watchdogSettings.idleGraceTimeouts;
  const debugAbortReason = watchdogSettings.debugAbortReason;

  // Override default_dir from env
  if (process.env.IDLEHANDS_TG_DIR) {
    botConfig.default_dir = process.env.IDLEHANDS_TG_DIR;
  }

  const cmdCtx = (ctx: any) => ({
    ctx,
    sessions,
    botConfig: {
      model: config.model,
      endpoint: config.endpoint,
      defaultDir: botConfig.default_dir || config.dir,
      telegram: botConfig,
      watchdog: {
        timeoutMs: watchdogMs,
        maxCompactions: maxWatchdogCompacts,
        idleGraceTimeouts: watchdogIdleGraceTimeouts,
        debugAbortReason,
      },
    },
  });

  // ---------------------------------------------------------------------------
  // Auth middleware
  // ---------------------------------------------------------------------------

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !allowedUsers.has(userId)) {
      // Silent ignore — don't reveal the bot exists
      if (config.verbose) {
        console.error(`[bot] ignored message from unauthorized user ${userId}`);
      }
      return;
    }
    // Group chat guard
    if (!(botConfig.allow_groups ?? false)) {
      const chatType = ctx.chat?.type;
      if (chatType && chatType !== 'private') {
        return; // Silent ignore
      }
    }
    await next();
  });

  // ---------------------------------------------------------------------------
  // Command handlers
  // ---------------------------------------------------------------------------

  bot.command('start', (ctx) => handleStart(cmdCtx(ctx)));
  bot.command('help', (ctx) => handleHelp(cmdCtx(ctx)));
  bot.command('new', (ctx) => handleNew(cmdCtx(ctx)));
  bot.command('cancel', (ctx) => handleCancel(cmdCtx(ctx)));
  bot.command('status', (ctx) => handleStatus(cmdCtx(ctx)));
  bot.command('watchdog', (ctx) => handleWatchdog(cmdCtx(ctx)));
  bot.command('dir', (ctx) => handleDir(cmdCtx(ctx)));
  bot.command('model', (ctx) => handleModel(cmdCtx(ctx)));
  bot.command('compact', (ctx) => handleCompact(cmdCtx(ctx)));
  bot.command('approval', (ctx) => handleApproval(cmdCtx(ctx)));
  bot.command('mode', (ctx) => handleMode(cmdCtx(ctx)));
  bot.command('subagents', (ctx) => handleSubAgents(cmdCtx(ctx)));
  bot.command('changes', (ctx) => handleChanges(cmdCtx(ctx)));
  bot.command('undo', (ctx) => handleUndo(cmdCtx(ctx)));
  bot.command('vault', (ctx) => handleVault(cmdCtx(ctx)));
  bot.command('anton', (ctx) => handleAnton(cmdCtx(ctx)));
  bot.command('agent', (ctx) => handleAgent(cmdCtx(ctx)));
  bot.command('agents', (ctx) => handleAgents(cmdCtx(ctx)));
  bot.command('escalate', (ctx) => handleEscalate(cmdCtx(ctx)));
  bot.command('deescalate', (ctx) => handleDeescalate(cmdCtx(ctx)));

  bot.command('hosts', async (ctx) => {
    try {
      const { loadRuntimes, redactConfig } = await import('../runtime/store.js');
      const config = await loadRuntimes();
      const redacted = redactConfig(config);
      if (!redacted.hosts.length) {
        await ctx.reply('No hosts configured. Use `idlehands hosts add` in CLI.');
        return;
      }
      const lines = redacted.hosts.map((h) =>
        `${h.enabled ? '🟢' : '🔴'} *${h.display_name}* (\`${h.id}\`)\n  Transport: ${h.transport}`,
      );
      await ctx.reply(lines.join('\n\n'), { parse_mode: 'Markdown' });
    } catch (e: any) {
      await ctx.reply(`❌ Failed to load hosts: ${e?.message ?? String(e)}`);
    }
  });

  bot.command('backends', async (ctx) => {
    try {
      const { loadRuntimes, redactConfig } = await import('../runtime/store.js');
      const config = await loadRuntimes();
      const redacted = redactConfig(config);
      if (!redacted.backends.length) {
        await ctx.reply('No backends configured. Use `idlehands backends add` in CLI.');
        return;
      }
      const lines = redacted.backends.map((b) =>
        `${b.enabled ? '🟢' : '🔴'} *${b.display_name}* (\`${b.id}\`)\n  Type: ${b.type}`,
      );
      await ctx.reply(lines.join('\n\n'), { parse_mode: 'Markdown' });
    } catch (e: any) {
      await ctx.reply(`❌ Failed to load backends: ${e?.message ?? String(e)}`);
    }
  });

  bot.command('rtmodels', async (ctx) => {
    try {
      const { loadRuntimes } = await import('../runtime/store.js');
      const config = await loadRuntimes();
      if (!config.models.length) {
        await ctx.reply('No runtime models configured.');
        return;
      }
      const lines = config.models.map((m) =>
        `${m.enabled ? '🟢' : '🔴'} *${m.display_name}* (\`${m.id}\`)\n  Source: \`${m.source}\``,
      );
      await ctx.reply(lines.join('\n\n'), { parse_mode: 'Markdown' });
    } catch (e: any) {
      await ctx.reply(`❌ Failed to load runtime models: ${e?.message ?? String(e)}`);
    }
  });

  bot.command('rtstatus', async (ctx) => {
    try {
      const { loadActiveRuntime } = await import('../runtime/executor.js');
      const active = await loadActiveRuntime();
      if (!active) {
        await ctx.reply('No active runtime.');
        return;
      }

      const lines = [
        '*Active Runtime*',
        `Model: \`${active.modelId}\``,
        `Backend: \`${active.backendId ?? 'none'}\``,
        `Hosts: ${active.hostIds.map((id) => `\`${id}\``).join(', ') || 'none'}`,
        `Healthy: ${active.healthy ? '✅ yes' : '❌ no'}`,
        `Endpoint: \`${active.endpoint ?? 'unknown'}\``,
        `Started: \`${active.startedAt}\``,
      ];
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (e: any) {
      await ctx.reply(`❌ Failed to read runtime status: ${e?.message ?? String(e)}`);
    }
  });

  bot.command('switch', async (ctx) => {
    try {
      const modelId = ctx.match?.trim();
      if (!modelId) {
        await ctx.reply('Usage: /switch <model-id>');
        return;
      }

      const { plan } = await import('../runtime/planner.js');
      const { execute, loadActiveRuntime } = await import('../runtime/executor.js');
      const { loadRuntimes } = await import('../runtime/store.js');

      const rtConfig = await loadRuntimes();
      const active = await loadActiveRuntime();
      const result = plan({ modelId, mode: 'live' }, rtConfig, active);

      if (!result.ok) {
        await ctx.reply(`❌ Plan failed: ${result.reason}`);
        return;
      }

      if (result.reuse) {
        await ctx.reply('✅ Runtime already active and healthy.');
        return;
      }

      const statusMsg = await ctx.reply(`⏳ Switching to *${result.model.display_name}*...`, { parse_mode: 'Markdown' });

      const execResult = await execute(result, {
        onStep: async (step, status) => {
          if (status === 'done') {
            await ctx.api.editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              `⏳ ${step.description}... ✓`,
            ).catch(() => {});
          }
        },
        confirm: async (prompt) => {
          await ctx.reply(`⚠️ ${prompt}\nAuto-approving for bot context.`);
          return true;
        },
      });

      if (execResult.ok) {
        await ctx.reply(`✅ Switched to *${result.model.display_name}*`, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply(`❌ Switch failed: ${execResult.error || 'unknown error'}`);
      }
    } catch (e: any) {
      await ctx.reply(`❌ Switch failed: ${e?.message ?? String(e)}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Callback query handler (inline button presses for confirmations)
  // ---------------------------------------------------------------------------

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const managed = sessions.get(chatId);
    if (!managed?.confirmProvider) {
      await ctx.answerCallbackQuery({ text: 'No active session.' }).catch(() => {});
      return;
    }

    const provider = managed.confirmProvider as TelegramConfirmProvider;
    const handled = await provider.handleCallback(data);
    await ctx.answerCallbackQuery(handled ? undefined : { text: 'Unknown action.' }).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // Message handler (core flow)
  // ---------------------------------------------------------------------------

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    let text = ctx.message.text;

    // Skip commands (already handled above)
    if (text.startsWith('/')) return;

    // Check if this chat requires @mention to respond
    const requireMentionChats = botConfig.routing?.require_mention_chats ?? [];
    if (requireMentionChats.includes(String(chatId))) {
      const botUsername = ctx.me.username;
      const mentionPattern = botUsername ? new RegExp(`@${botUsername}\\b`, 'i') : null;
      const isMentioned = mentionPattern && mentionPattern.test(text);
      if (!isMentioned) return; // Silently ignore messages without mention

      // Strip the bot mention from text so the agent sees clean input
      if (mentionPattern) text = text.replace(mentionPattern, '').trim();
      if (!text) return; // Nothing left after stripping mention
    }

    const msgPreview = text.length > 50 ? text.slice(0, 47) + '...' : text;
    console.error(`[bot] ${chatId} ${ctx.from.username ?? userId}: "${msgPreview}"`);

    // Get or create session
    const managed = await sessions.getOrCreate(chatId, userId);
    if (!managed) {
      await ctx.reply('⚠️ Too many active sessions. Try again later (or wait for an old session to expire).');
      return;
    }

    // Concurrency guard
    if (managed.inFlight) {
      if (managed.pendingQueue.length >= sessions.maxQueue) {
        await ctx.reply(`⏳ Queued (${managed.pendingQueue.length} pending). Use /cancel to abort the current task.`);
        return;
      }
      managed.pendingQueue.push(text);
      await ctx.reply(`⏳ Queued (#${managed.pendingQueue.length}). Still working on the previous request.`);
      return;
    }

    const fileThreshold = botConfig.file_threshold_chars ?? 8192;
    await processMessage(
      bot,
      sessions,
      managed,
      text,
      editIntervalMs,
      fileThreshold,
      replyToUserMessages ? ctx.message.message_id : undefined,
      config,
      {
        timeoutMs: watchdogMs,
        maxCompactions: maxWatchdogCompacts,
        idleGraceTimeouts: watchdogIdleGraceTimeouts,
        debugAbortReason,
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Session cleanup on timeout
  // ---------------------------------------------------------------------------

  const origCleanup = sessions.cleanupExpired.bind(sessions);
  const wrappedCleanup = () => {
    const expired = origCleanup();
    for (const chatId of expired) {
      console.error(`[bot] session ${chatId} expired`);
      bot.api.sendMessage(chatId, '⏱ Session expired due to inactivity. Send a new message to start fresh.').catch(() => {});
    }
  };
  // Override the internal cleanup to also notify users
  // (The SessionManager calls cleanupExpired internally on interval;
  //  we handle notification here on the bot level.)
  const cleanupInterval = setInterval(wrappedCleanup, 60_000);

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  const shutdown = () => {
    console.error('[bot] Shutting down...');
    clearInterval(cleanupInterval);
    sessions.stop();
    bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ---------------------------------------------------------------------------
  // Register commands with Telegram
  // ---------------------------------------------------------------------------

  const telegramCommands = [
    { command: 'start', description: 'Welcome + config summary' },
    { command: 'help', description: 'List commands' },
    { command: 'new', description: 'Start a new session' },
    { command: 'cancel', description: 'Abort current generation' },
    { command: 'status', description: 'Session stats' },
    { command: 'watchdog', description: 'Show watchdog settings/status' },
    { command: 'agent', description: 'Show current agent info' },
    { command: 'agents', description: 'List all configured agents' },
    { command: 'escalate', description: 'Use larger model for next message' },
    { command: 'deescalate', description: 'Return to base model' },
    { command: 'dir', description: 'Get/set working directory' },
    { command: 'model', description: 'Show current model' },
    { command: 'compact', description: 'Compact context' },
    { command: 'approval', description: 'Get/set approval mode' },
    { command: 'mode', description: 'Get/set mode (code/sys)' },
    { command: 'subagents', description: 'Toggle sub-agents on/off' },
    { command: 'changes', description: 'Files modified this session' },
    { command: 'undo', description: 'Undo last edit' },
    { command: 'vault', description: 'Search vault entries' },
    { command: 'hosts', description: 'List runtime hosts' },
    { command: 'backends', description: 'List runtime backends' },
    { command: 'rtmodels', description: 'List runtime models' },
    { command: 'rtstatus', description: 'Show active runtime status' },
    { command: 'switch', description: 'Switch runtime model' },
    { command: 'anton', description: 'Autonomous task runner' },
  ];

  // Clear stale command scopes (default/private + optional language variants)
  // so renamed commands (e.g. /reset -> /new) reliably propagate.
  const commandScopes: Array<{ scope?: any; language_code?: string }> = [
    {},
    { scope: { type: 'all_private_chats' } },
    { language_code: 'en' },
    { scope: { type: 'all_private_chats' }, language_code: 'en' },
  ];

  for (const opts of commandScopes) {
    await bot.api.deleteMyCommands(opts as any).catch(() => {});
    await bot.api.setMyCommands(telegramCommands, opts as any)
      .catch((e) => console.error(`[bot] setMyCommands failed (${JSON.stringify(opts)}): ${e?.message}`));
  }

  // ---------------------------------------------------------------------------
  // Start polling
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // BotFather hardening check
  // ---------------------------------------------------------------------------

  try {
    const botInfo = await bot.api.getMe();
    if (botInfo.can_join_groups) {
      console.error('[bot] ⚠️  WARNING: Bot has "Allow Groups" enabled in BotFather.');
      console.error('[bot]    Groups are blocked in code, but disable at the source:');
      console.error('[bot]    → Open @BotFather → /mybots → select bot → Bot Settings → Allow Groups → Turn OFF');
    }
    if (botInfo.can_read_all_group_messages) {
      console.error('[bot] ⚠️  WARNING: Bot has "Group Privacy" disabled (can read all messages).');
      console.error('[bot]    → Open @BotFather → /mybots → select bot → Bot Settings → Group Privacy → Turn ON');
    }
  } catch (e: any) {
    console.error(`[bot] getMe() failed: ${e?.message ?? e}`);
  }

  // ---------------------------------------------------------------------------
  // Start polling
  // ---------------------------------------------------------------------------

  sessions.start();
  // ---------------------------------------------------------------------------
  // Global error handler — catches unhandled errors in middleware/handlers
  // ---------------------------------------------------------------------------

  bot.catch(async (err: any) => {
    const desc = err?.error?.message ?? err?.message ?? String(err);
    console.error(`[bot] unhandled error: ${desc}`);

    const chatId = err?.ctx?.chat?.id;
    if (!chatId) return;

    const userMsg = desc.length > 300 ? desc.slice(0, 297) + '...' : desc;
    await bot.api.sendMessage(chatId, `⚠️ Bot error: ${userMsg}`).catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // Start polling
  // ---------------------------------------------------------------------------

  console.error(`[bot] Telegram bot started (polling)`);
  console.error(`[bot] Model: ${config.model || 'auto'} | Endpoint: ${config.endpoint}`);
  console.error(`[bot] Allowed users: [${[...allowedUsers].join(', ')}]`);
  console.error(`[bot] Default dir: ${botConfig.default_dir || config.dir || '~'}`);
  console.error(`[bot] Watchdog: timeout=${watchdogMs}ms compactions=${maxWatchdogCompacts} grace=${watchdogIdleGraceTimeouts}`);
  
  // Log multi-agent config
  const agents = botConfig.agents;
  if (agents && Object.keys(agents).length > 0) {
    const agentIds = Object.keys(agents);
    console.error(`[bot] Multi-agent mode: ${agentIds.length} agents configured [${agentIds.join(', ')}]`);
    const routing = botConfig.routing;
    if (routing?.default) {
      console.error(`[bot] Default agent: ${routing.default}`);
    }
  }

  bot.start({
    onStart: () => console.error('[bot] Polling active'),
  });
}


async function probeModelEndpoint(endpoint: string): Promise<boolean> {
  const base = endpoint.replace(/\/$/, '');
  const healthUrl = base.replace(/\/v1$/, '') + '/health';
  const modelsUrl = base.replace(/\/$/, '') + '/models';
  try {
    const h = await fetch(healthUrl, { method: 'GET' as const });
    if (!h.ok) return false;
    const m = await fetch(modelsUrl, { method: 'GET' as const });
    return m.ok;
  } catch {
    return false;
  }
}

async function waitForModelEndpoint(endpoint: string, totalMs = 60_000, stepMs = 2_500): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < totalMs) {
    if (await probeModelEndpoint(endpoint)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core: process a user message through the agent
// ---------------------------------------------------------------------------

async function processMessage(
  bot: Bot,
  sessions: SessionManager,
  managed: ManagedSession,
  text: string,
  editIntervalMs: number,
  fileThresholdChars: number,
  replyToId?: number,
  baseConfig?: IdlehandsConfig,
  watchdogOptions?: {
    timeoutMs?: number;
    maxCompactions?: number;
    idleGraceTimeouts?: number;
    debugAbortReason?: boolean;
  },
): Promise<void> {
  let turn = sessions.beginTurn(managed.chatId);
  if (!turn) return;
  let turnId = turn.turnId;

  // Handle pending escalation - switch model before processing
  if (managed.pendingEscalation) {
    const targetModel = managed.pendingEscalation;
    const targetEndpoint = managed.pendingEscalationEndpoint;
    managed.pendingEscalation = null;
    managed.pendingEscalationEndpoint = null;
    
    // Find the model index in escalation chain
    const escalation = managed.agentPersona?.escalation;
    if (escalation?.models) {
      const idx = escalation.models.indexOf(targetModel);
      if (idx !== -1) {
        managed.currentModelIndex = idx + 1;  // +1 because 0 is base model
        managed.escalationCount += 1;
      }
    }
    
    // Recreate session with escalated model
    try {
      await sessions.recreateSession(managed.chatId, {
        model: targetModel,
        ...(targetEndpoint && { endpoint: targetEndpoint }),
      });
      console.error(`[bot:telegram] ${managed.userId} escalated to ${targetModel}`);
    } catch (e: any) {
      console.error(`[bot:telegram] escalation failed: ${e?.message ?? e}`);
      // Continue with current model if escalation fails
    }
    
    // Re-acquire turn after recreation - must update turnId!
    const newTurn = sessions.beginTurn(managed.chatId);
    if (!newTurn) {
      // Queue the message for retry instead of dropping
      managed.pendingQueue.unshift(text);
      return;
    }
    turn = newTurn;
    turnId = newTurn.turnId;
    // Re-fetch managed session after recreation
    const refreshed = sessions.get(managed.chatId);
    if (refreshed) Object.assign(managed, refreshed);
  }

  // Check for keyword-based escalation BEFORE calling the model
  const escalation = managed.agentPersona?.escalation;
  if (escalation?.models?.length) {
    const kwResult = checkKeywordEscalation(text, escalation);
    if (kwResult.escalate && kwResult.tier !== undefined) {
      // Use the tier to select the target model
      const targetModelIndex = Math.min(kwResult.tier, escalation.models.length - 1);
      const currentTier = managed.currentModelIndex - 1;  // -1 because 0 is base model
      if (targetModelIndex > currentTier) {
        const targetModel = escalation.models[targetModelIndex];
        const tierEndpoint = escalation.tiers?.[targetModelIndex]?.endpoint;
        console.error(`[bot:telegram] ${managed.userId} keyword escalation: ${kwResult.reason} → ${targetModel}${tierEndpoint ? ` @ ${tierEndpoint}` : ''}`);
        
        // Set up escalation
        managed.currentModelIndex = targetModelIndex + 1;
        managed.escalationCount += 1;
        
        // Recreate session with escalated model
        try {
          await sessions.recreateSession(managed.chatId, {
            model: targetModel,
            ...(tierEndpoint && { endpoint: tierEndpoint }),
          });
          // Re-acquire turn after recreation
          const newTurn = sessions.beginTurn(managed.chatId);
          if (!newTurn) {
            managed.pendingQueue.unshift(text);
            return;
          }
          turn = newTurn;
          turnId = newTurn.turnId;
          const refreshed = sessions.get(managed.chatId);
          if (refreshed) Object.assign(managed, refreshed);
        } catch (e: any) {
          console.error(`[bot:telegram] keyword escalation failed: ${e?.message ?? e}`);
        }
      }
    }
  }

  const streaming = new StreamingMessage(bot, managed.chatId, editIntervalMs, replyToId, fileThresholdChars);
  await streaming.init();

  const hooks: AgentHooks = {
    onToken: (t) => {
      if (!sessions.isTurnActive(managed.chatId, turnId)) return;
      sessions.markProgress(managed.chatId, turnId);
      watchdogGraceUsed = 0;
      streaming.onToken(t);
    },
    onToolCall: (call) => {
      if (!sessions.isTurnActive(managed.chatId, turnId)) return;
      sessions.markProgress(managed.chatId, turnId);
      watchdogGraceUsed = 0;
      streaming.onToolCall(call);
    },
    onToolResult: (result) => {
      if (!sessions.isTurnActive(managed.chatId, turnId)) return;
      sessions.markProgress(managed.chatId, turnId);
      watchdogGraceUsed = 0;
      streaming.onToolResult(result);
    },
    onTurnEnd: () => {
      if (!sessions.isTurnActive(managed.chatId, turnId)) return;
      sessions.markProgress(managed.chatId, turnId);
      watchdogGraceUsed = 0;
    },
  };

  const resolvedWatchdog = resolveWatchdogSettings(
    {
      watchdog_timeout_ms: watchdogOptions?.timeoutMs,
      watchdog_max_compactions: watchdogOptions?.maxCompactions,
      watchdog_idle_grace_timeouts: watchdogOptions?.idleGraceTimeouts,
      debug_abort_reason: watchdogOptions?.debugAbortReason,
    },
    baseConfig,
  );
  const watchdogMs = resolvedWatchdog.timeoutMs;
  const maxWatchdogCompacts = resolvedWatchdog.maxCompactions;
  const watchdogIdleGraceTimeouts = resolvedWatchdog.idleGraceTimeouts;
  const debugAbortReason = resolvedWatchdog.debugAbortReason;
  let watchdogCompactPending = false;
  let watchdogGraceUsed = 0;
  let watchdogForcedCancel = false;
  const watchdog = setInterval(() => {
    const current = sessions.get(managed.chatId);
    if (!current || current.activeTurnId !== turnId || !current.inFlight) return;
    if (watchdogCompactPending) return;
    if (Date.now() - current.lastProgressAt > watchdogMs) {
      if (watchdogGraceUsed < watchdogIdleGraceTimeouts) {
        watchdogGraceUsed += 1;
        current.lastProgressAt = Date.now();
        console.error(`[bot:telegram] ${managed.chatId} watchdog inactivity on turn ${turnId} — applying grace period (${watchdogGraceUsed}/${watchdogIdleGraceTimeouts})`);
        return;
      }

      if (current.watchdogCompactAttempts < maxWatchdogCompacts) {
        current.watchdogCompactAttempts++;
        watchdogCompactPending = true;
        console.error(`[bot:telegram] ${managed.chatId} watchdog timeout on turn ${turnId} — compacting and retrying (attempt ${current.watchdogCompactAttempts}/${maxWatchdogCompacts})`);
        try { current.activeAbortController?.abort(); } catch {}
        current.session.compactHistory({ force: true }).then((result) => {
          console.error(`[bot:telegram] ${managed.chatId} watchdog compaction: freed ${result.freedTokens} tokens, dropped ${result.droppedMessages} messages`);
          current.lastProgressAt = Date.now();
          watchdogCompactPending = false;
        }).catch((e: any) => {
          console.error(`[bot:telegram] ${managed.chatId} watchdog compaction failed: ${e?.message ?? e}`);
          watchdogCompactPending = false;
        });
      } else {
        console.error(`[bot:telegram] ${managed.chatId} watchdog timeout on turn ${turnId} — max compaction attempts reached, cancelling`);
        watchdogForcedCancel = true;
        sessions.cancelActive(managed.chatId);
      }
    }
  }, 5_000);

  const startTime = Date.now();

  try {
    let askComplete = false;
    let isRetryAfterCompaction = false;
    while (!askComplete) {
      const attemptController = new AbortController();
      managed.activeAbortController = attemptController;
      turn.controller = attemptController;

      const askText = isRetryAfterCompaction
        ? 'Continue working on the task from where you left off. Context was compacted to free memory — do NOT restart from the beginning.'
        : text;

      try {
        const result = await managed.session.ask(askText, { ...hooks, signal: attemptController.signal });
        askComplete = true;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`[bot] ${managed.chatId} ask() completed: ${result.turns} turns, ${result.toolCalls} tool calls, ${elapsed}s`);

        // Check for auto-escalation request in response
        const escalation = managed.agentPersona?.escalation;
        const autoEscalate = escalation?.auto !== false && escalation?.models?.length;
        const maxEscalations = escalation?.max_escalations ?? 2;

        if (autoEscalate && managed.escalationCount < maxEscalations) {
          const escResult = detectEscalation(result.text);
          if (escResult.escalate) {
            // Determine next model in escalation chain
            const nextIndex = Math.min(managed.currentModelIndex, escalation!.models!.length - 1);
            const targetModel = escalation!.models![nextIndex];
            const tierEndpoint = escalation!.tiers?.[nextIndex]?.endpoint;

            console.error(`[bot:telegram] ${managed.userId} auto-escalation requested: ${escResult.reason}${tierEndpoint ? ` @ ${tierEndpoint}` : ''}`);

            // Notify user about escalation
            await streaming.finalizeError(`⚡ Escalating to \`${targetModel}\` (${escResult.reason})...`);

            // Set up escalation for re-run
            managed.pendingEscalation = targetModel;
            managed.pendingEscalationEndpoint = tierEndpoint || null;
            managed.currentModelIndex = nextIndex + 1;
            managed.escalationCount += 1;

            // Recreate session with escalated model
            await sessions.recreateSession(managed.chatId, {
              model: targetModel,
              ...(tierEndpoint && { endpoint: tierEndpoint }),
            });

            // Finish this turn and re-run with escalated model
            clearInterval(watchdog);
            sessions.finishTurn(managed.chatId, turnId);

            // Re-process the original message with the escalated model
            const refreshed = sessions.get(managed.chatId);
            if (refreshed) {
              await processMessage(
                bot,
                sessions,
                refreshed,
                text,
                editIntervalMs,
                fileThresholdChars,
                undefined,
                baseConfig,
                {
                  timeoutMs: watchdogMs,
                  maxCompactions: maxWatchdogCompacts,
                  idleGraceTimeouts: watchdogIdleGraceTimeouts,
                  debugAbortReason,
                },
              );
            }
            return;
          }
        }

        if (sessions.isTurnActive(managed.chatId, turnId)) await streaming.finalize(result.text);
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        const isAbort = msg.includes('AbortError') || msg.toLowerCase().includes('aborted');

        // If aborted by watchdog compaction, wait for compaction to finish then retry
        if (isAbort && watchdogCompactPending) {
          console.error(`[bot:telegram] ${managed.chatId} ask() aborted by watchdog compaction — waiting for compaction to finish`);
          while (watchdogCompactPending) {
            await new Promise((r) => setTimeout(r, 500));
          }
          isRetryAfterCompaction = true;
          continue; // retry the ask with continuation prompt
        }

        askComplete = true;
        console.error(`[bot] ${managed.chatId} ask() error: ${msg}`);

        if (isAbort) {
          if (sessions.isTurnActive(managed.chatId, turnId)) {
            const detail = formatWatchdogCancelMessage({
              watchdogForcedCancel,
              maxCompactions: maxWatchdogCompacts,
              debugAbortReason,
              abortReason: msg,
            });
            await streaming.finalizeError(detail);
          }
        } else if (msg.includes('ECONNREFUSED') || msg.includes('Connection timeout') || msg.includes('503') || msg.includes('model loading')) {
          const endpoint = (managed.session as any)?.endpoint || '';
          const recovered = endpoint ? await waitForModelEndpoint(endpoint, 60_000, 2_500) : false;
          if (recovered) {
            try {
              const retry = await managed.session.ask(text, { ...hooks, signal: turn.controller.signal });
              if (sessions.isTurnActive(managed.chatId, turnId)) await streaming.finalize(retry.text);
              return;
            } catch (retryErr: any) {
              const retryMsg = retryErr?.message ?? String(retryErr);
              if (sessions.isTurnActive(managed.chatId, turnId)) await streaming.finalizeError(`Model server came back but retry failed: ${retryMsg.length > 140 ? retryMsg.slice(0, 137) + '...' : retryMsg}`);
              return;
            }
          }
          if (sessions.isTurnActive(managed.chatId, turnId)) await streaming.finalizeError('Model server is starting up or restarting. I waited up to 60s but it is still unavailable — please retry shortly.');
        } else {
          if (sessions.isTurnActive(managed.chatId, turnId)) await streaming.finalizeError(msg.length > 200 ? msg.slice(0, 197) + '...' : msg);
        }
      }
    }
  } finally {
    clearInterval(watchdog);
    const current = sessions.finishTurn(managed.chatId, turnId);
    if (!current) return;

    // Auto-deescalate back to base model after each request
    if (current.currentModelIndex > 0 && current.agentPersona?.escalation) {
      const baseModel = current.agentPersona.model || baseConfig?.model || 'default';
      current.currentModelIndex = 0;
      current.escalationCount = 0;
      
      try {
        await sessions.recreateSession(current.chatId, { model: baseModel });
        console.error(`[bot:telegram] ${current.userId} auto-deescalated to ${baseModel}`);
      } catch (e: any) {
        console.error(`[bot:telegram] auto-deescalation failed: ${e?.message ?? e}`);
      }
    }

    // Process queued messages only if this session still exists and is idle.
    const next = sessions.dequeueNext(managed.chatId);
    if (next && current.state === 'idle' && !current.inFlight) {
      setTimeout(() => {
        const fresh = sessions.get(managed.chatId);
        if (!fresh) return;
        void processMessage(
          bot,
          sessions,
          fresh,
          next,
          editIntervalMs,
          fileThresholdChars,
          undefined,
          baseConfig,
          {
            timeoutMs: watchdogMs,
            maxCompactions: maxWatchdogCompacts,
            idleGraceTimeouts: watchdogIdleGraceTimeouts,
            debugAbortReason,
          },
        );
      }, 500);
    }
  }
}
