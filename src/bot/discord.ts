import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import { createSession, type AgentSession, type AgentHooks } from '../agent.js';
import type { ApprovalMode, BotDiscordConfig, IdlehandsConfig } from '../types.js';
import { DiscordConfirmProvider } from './confirm-discord.js';
import { projectDir } from '../utils.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runAnton } from '../anton/controller.js';
import { parseTaskFile } from '../anton/parser.js';
import { formatRunSummary, formatProgressBar, formatTaskStart, formatTaskEnd, formatTaskSkip } from '../anton/reporter.js';
import type { AntonRunConfig, AntonProgressCallback } from '../anton/types.js';

type SessionState = 'idle' | 'running' | 'canceling' | 'resetting';

type ManagedSession = {
  key: string;
  userId: string;
  channel: TextBasedChannel;
  session: AgentSession;
  confirmProvider: DiscordConfirmProvider;
  config: IdlehandsConfig;
  inFlight: boolean;
  pendingQueue: Message[];
  state: SessionState;
  activeTurnId: number;
  activeAbortController: AbortController | null;
  lastProgressAt: number;
  lastActivity: number;
  antonActive: boolean;
  antonAbortSignal: { aborted: boolean } | null;
  antonLastResult: import('../anton/types.js').AntonRunResult | null;
  antonProgress: import('../anton/types.js').AntonProgress | null;
};

function parseAllowedUsers(cfg: BotDiscordConfig): Set<string> {
  const fromEnv = process.env.IDLEHANDS_DISCORD_ALLOWED_USERS;
  if (fromEnv && fromEnv.trim()) {
    return new Set(
      fromEnv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  const values = Array.isArray(cfg.allowed_users) ? cfg.allowed_users : [];
  return new Set(values.map((v) => String(v).trim()).filter(Boolean));
}

function normalizeApprovalMode(mode: string | undefined, fallback: ApprovalMode): ApprovalMode {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'plan' || m === 'default' || m === 'auto-edit' || m === 'yolo') return m;
  return fallback;
}

function splitDiscord(text: string, limit = 1900): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + limit));
    i += limit;
  }
  return chunks;
}

function safeContent(text: string): string {
  const t = text.trim();
  return t.length ? t : '(empty response)';
}

function sessionKeyForMessage(msg: Message, allowGuilds: boolean): string {
  if (allowGuilds) {
    // Per-channel+user session in guilds so multiple users can safely coexist.
    return `${msg.channelId}:${msg.author.id}`;
  }
  // DM-only mode uses user id as session key.
  return msg.author.id;
}

export async function startDiscordBot(config: IdlehandsConfig, botConfig: BotDiscordConfig): Promise<void> {
  const token = process.env.IDLEHANDS_DISCORD_TOKEN || botConfig.token;
  if (!token) {
    console.error('[bot:discord] Missing token. Set IDLEHANDS_DISCORD_TOKEN or bot.discord.token.');
    process.exit(1);
  }

  const allowedUsers = parseAllowedUsers(botConfig);
  if (allowedUsers.size === 0) {
    console.error('[bot:discord] bot.discord.allowed_users is empty — refusing to start unauthenticated bot.');
    process.exit(1);
  }

  const allowGuilds = botConfig.allow_guilds ?? false;
  const guildId = botConfig.guild_id;
  const maxSessions = botConfig.max_sessions ?? 5;
  const maxQueue = botConfig.max_queue ?? 3;
  const sessionTimeoutMs = (botConfig.session_timeout_min ?? 30) * 60_000;
  const approvalMode = normalizeApprovalMode(botConfig.approval_mode, config.approval_mode ?? 'auto-edit');
  const defaultDir = botConfig.default_dir || projectDir(config);

  const sessions = new Map<string, ManagedSession>();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  async function getOrCreate(msg: Message): Promise<ManagedSession | null> {
    const key = sessionKeyForMessage(msg, allowGuilds);
    const existing = sessions.get(key);
    if (existing) {
      existing.lastActivity = Date.now();
      return existing;
    }

    if (sessions.size >= maxSessions) {
      return null;
    }

    const cfg: IdlehandsConfig = {
      ...config,
      dir: defaultDir,
      approval_mode: approvalMode,
      no_confirm: approvalMode === 'yolo',
    };

    const confirmProvider = new DiscordConfirmProvider(
      msg.channel,
      msg.author.id,
      botConfig.confirm_timeout_sec ?? 300,
    );

    const session = await createSession({
      config: cfg,
      confirmProvider,
      confirm: async () => true,
    });

    const managed: ManagedSession = {
      key,
      userId: msg.author.id,
      channel: msg.channel,
      session,
      confirmProvider,
      config: cfg,
      inFlight: false,
      pendingQueue: [],
      state: 'idle',
      activeTurnId: 0,
      activeAbortController: null,
      lastProgressAt: 0,
      lastActivity: Date.now(),
      antonActive: false,
      antonAbortSignal: null,
      antonLastResult: null,
      antonProgress: null,
    };
    sessions.set(key, managed);
    return managed;
  }

  function destroySession(key: string): void {
    const s = sessions.get(key);
    if (!s) return;
    s.state = 'resetting';
    s.pendingQueue = [];
    try { s.activeAbortController?.abort(); } catch {}
    try { s.session.cancel(); } catch {}
    sessions.delete(key);
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) {
      if (!s.inFlight && now - s.lastActivity > sessionTimeoutMs) {
        destroySession(key);
      }
    }
  }, 60_000);


  function beginTurn(managed: ManagedSession): { turnId: number; controller: AbortController } | null {
    if (managed.inFlight || managed.state === 'resetting') return null;
    const controller = new AbortController();
    managed.inFlight = true;
    managed.state = 'running';
    managed.activeTurnId += 1;
    managed.activeAbortController = controller;
    managed.lastProgressAt = Date.now();
    managed.lastActivity = Date.now();
    return { turnId: managed.activeTurnId, controller };
  }

  function isTurnActive(managed: ManagedSession, turnId: number): boolean {
    return managed.inFlight && managed.activeTurnId == turnId && managed.state !== 'resetting';
  }

  function markProgress(managed: ManagedSession, turnId: number): void {
    if (managed.activeTurnId !== turnId) return;
    managed.lastProgressAt = Date.now();
    managed.lastActivity = Date.now();
  }

  function finishTurn(managed: ManagedSession, turnId: number): void {
    if (managed.activeTurnId !== turnId) return;
    managed.inFlight = false;
    managed.state = 'idle';
    managed.activeAbortController = null;
    managed.lastActivity = Date.now();
  }

  function cancelActive(managed: ManagedSession): { ok: boolean; message: string } {
    if (!managed.inFlight) return { ok: false, message: 'Nothing running.' };
    managed.state = 'canceling';
    managed.pendingQueue = [];
    try { managed.activeAbortController?.abort(); } catch {}
    try { managed.session.cancel(); } catch {}
    managed.lastActivity = Date.now();
    return { ok: true, message: '⏹ Cancel requested. Stopping current turn...' };
  }

  async function processMessage(managed: ManagedSession, msg: Message): Promise<void> {
    const turn = beginTurn(managed);
    if (!turn) return;
    const turnId = turn.turnId;

    const placeholder = await msg.reply('⏳ Thinking...').catch(() => null);
    let streamed = '';

    const hooks: AgentHooks = {
      onToken: (t) => {
        if (!isTurnActive(managed, turnId)) return;
        markProgress(managed, turnId);
        streamed += t;
      },
    };

    const watchdogMs = 120_000;
    const watchdog = setInterval(() => {
      if (!isTurnActive(managed, turnId)) return;
      if (Date.now() - managed.lastProgressAt > watchdogMs) {
        console.error(`[bot:discord] ${managed.userId} watchdog timeout on turn ${turnId}`);
        cancelActive(managed);
      }
    }, 5_000);

    try {
      const result = await managed.session.ask(msg.content, { ...hooks, signal: turn.controller.signal });
      if (!isTurnActive(managed, turnId)) return;
      markProgress(managed, turnId);
      const finalText = safeContent(streamed || result.text);
      const chunks = splitDiscord(finalText);

      if (placeholder) {
        await placeholder.edit(chunks[0]).catch(() => {});
      } else {
        await msg.reply(chunks[0]).catch(() => {});
      }

      for (let i = 1; i < chunks.length && i < 10; i++) {
        if (!isTurnActive(managed, turnId)) break;
        await (msg.channel as any).send(chunks[i]).catch(() => {});
      }
      if (chunks.length > 10 && isTurnActive(managed, turnId)) {
        await (msg.channel as any).send('[truncated — response too long]').catch(() => {});
      }
    } catch (e: any) {
      const raw = String(e?.message ?? e ?? 'unknown error');
      if (!isTurnActive(managed, turnId)) return;
      if (raw.includes('AbortError') || raw.toLowerCase().includes('aborted')) {
        if (placeholder) await placeholder.edit('⏹ Cancelled.').catch(() => {});
        else await msg.reply('⏹ Cancelled.').catch(() => {});
      } else {
        const errMsg = raw.slice(0, 400);
        if (placeholder) {
          await placeholder.edit(`❌ ${errMsg}`).catch(() => {});
        } else {
          await msg.reply(`❌ ${errMsg}`).catch(() => {});
        }
      }
    } finally {
      clearInterval(watchdog);
      finishTurn(managed, turnId);

      const next = managed.pendingQueue.shift();
      if (next && managed.state === 'idle' && !managed.inFlight) {
        setTimeout(() => {
          if (managed.state !== 'idle' || managed.inFlight) return;
          void processMessage(managed, next);
        }, 200);
      }
    }
  }

  async function recreateSession(managed: ManagedSession, cfg: IdlehandsConfig): Promise<void> {
    managed.state = 'resetting';
    managed.pendingQueue = [];
    try { managed.activeAbortController?.abort(); } catch {}
    try { managed.session.cancel(); } catch {}

    const session = await createSession({
      config: cfg,
      confirmProvider: managed.confirmProvider,
      confirm: async () => true,
    });

    managed.session = session;
    managed.config = cfg;
    managed.inFlight = false;
    managed.state = 'idle';
    managed.activeAbortController = null;
    managed.lastProgressAt = 0;
    managed.lastActivity = Date.now();
  }

  client.on(Events.ClientReady, () => {
    console.error(`[bot:discord] Connected as ${client.user?.tag ?? 'unknown'}`);
    console.error(`[bot:discord] Allowed users: [${[...allowedUsers].join(', ')}]`);
    console.error(`[bot:discord] Default dir: ${defaultDir}`);
    console.error(`[bot:discord] Approval: ${approvalMode}`);
    if (allowGuilds) {
      console.error(`[bot:discord] Guild mode enabled${guildId ? ` (guild ${guildId})` : ''}`);
    }
  });

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    if (!allowedUsers.has(msg.author.id)) return;

    if (!allowGuilds && msg.guildId) return;
    if (allowGuilds && guildId && msg.guildId && msg.guildId !== guildId) return;

    const content = msg.content?.trim();
    if (!content) return;

    const key = sessionKeyForMessage(msg, allowGuilds);

    if (content === '/new') {
      destroySession(key);
      await msg.reply('✨ New session started. Send a message to begin.').catch(() => {});
      return;
    }

    const managed = await getOrCreate(msg);
    if (!managed) {
      await msg.reply('⚠️ Too many active sessions. Please retry later.').catch(() => {});
      return;
    }

    if (content === '/cancel') {
      const res = cancelActive(managed);
      await msg.reply(res.message).catch(() => {});
      return;
    }

    if (content === '/start') {
      const lines = [
        '🔧 Idle Hands — Local-first coding agent',
        '',
        `Model: \`${managed.session.model}\``,
        `Endpoint: \`${managed.config.endpoint || '?'}\``,
        `Default dir: \`${managed.config.dir || defaultDir}\``,
        '',
        'Send me a coding task, or use /help for commands.',
      ];
      await msg.reply(lines.join('\n')).catch(() => {});
      return;
    }

    if (content === '/help') {
      const lines = [
        'Commands:',
        '/start — Welcome + config summary',
        '/help — This message',
        '/new — Start a new session',
        '/cancel — Abort current generation',
        '/status — Session stats',
        '/dir [path] — Get/set working directory',
        '/model — Show current model',
        '/approval [mode] — Get/set approval mode',
        '/mode [code|sys] — Get/set mode',
        '/subagents [on|off] — Toggle sub-agents',
        '/compact — Trigger context compaction',
        '/changes — Show files modified this session',
        '/undo — Undo last edit',
        '/vault <query> — Search vault entries',
        '/anton <file> — Start autonomous task runner',
        '/anton status | /anton stop | /anton last',
      ];
      await msg.reply(lines.join('\n')).catch(() => {});
      return;
    }

    if (content === '/model') {
      await msg.reply(`Model: \`${managed.session.model}\`\nHarness: \`${managed.session.harness}\``).catch(() => {});
      return;
    }

    if (content === '/compact') {
      managed.session.reset();
      await msg.reply('🗜 Session context compacted (reset to system prompt).').catch(() => {});
      return;
    }

    if (content === '/dir' || content.startsWith('/dir ')) {
      const arg = content.slice('/dir'.length).trim();
      if (!arg) {
        await msg.reply(`Working directory: \`${managed.config.dir || defaultDir}\``).catch(() => {});
        return;
      }
      const allowedDirs = botConfig.allowed_dirs ?? ['~'];
      const homeDir = process.env.HOME || '/home';
      const resolvedDir = arg.replace(/^~/, homeDir);
      const allowed = allowedDirs.some((d) => resolvedDir.startsWith(d.replace(/^~/, homeDir)));
      if (!allowed) {
        await msg.reply('❌ Directory not allowed. Check bot.discord.allowed_dirs.').catch(() => {});
        return;
      }
      const cfg: IdlehandsConfig = {
        ...managed.config,
        dir: resolvedDir,
      };
      await recreateSession(managed, cfg);
      await msg.reply(`✅ Working directory set to \`${resolvedDir}\``).catch(() => {});
      return;
    }

    if (content === '/approval' || content.startsWith('/approval ')) {
      const arg = content.slice('/approval'.length).trim().toLowerCase();
      const modes = ['plan', 'default', 'auto-edit', 'yolo'] as const;
      if (!arg) {
        await msg.reply(`Approval mode: \`${managed.config.approval_mode || approvalMode}\`\nOptions: ${modes.join(', ')}`).catch(() => {});
        return;
      }
      if (!modes.includes(arg as any)) {
        await msg.reply(`Invalid mode. Options: ${modes.join(', ')}`).catch(() => {});
        return;
      }
      managed.config.approval_mode = arg as any;
      managed.config.no_confirm = arg === 'yolo';
      await msg.reply(`✅ Approval mode set to \`${arg}\``).catch(() => {});
      return;
    }

    if (content === '/mode' || content.startsWith('/mode ')) {
      const arg = content.slice('/mode'.length).trim().toLowerCase();
      if (!arg) {
        await msg.reply(`Mode: \`${managed.config.mode || 'code'}\``).catch(() => {});
        return;
      }
      if (arg !== 'code' && arg !== 'sys') {
        await msg.reply('Invalid mode. Options: code, sys').catch(() => {});
        return;
      }
      managed.config.mode = arg as any;
      if (arg === 'sys' && managed.config.approval_mode === 'auto-edit') {
        managed.config.approval_mode = 'default';
      }
      await msg.reply(`✅ Mode set to \`${arg}\``).catch(() => {});
      return;
    }

    if (content === '/subagents' || content.startsWith('/subagents ')) {
      const arg = content.slice('/subagents'.length).trim().toLowerCase();
      const current = managed.config.sub_agents?.enabled !== false;
      if (!arg) {
        await msg.reply(`Sub-agents: \`${current ? 'on' : 'off'}\`\nUsage: /subagents on | off`).catch(() => {});
        return;
      }
      if (arg !== 'on' && arg !== 'off') {
        await msg.reply('Invalid value. Usage: /subagents on | off').catch(() => {});
        return;
      }
      const enabled = arg === 'on';
      managed.config.sub_agents = { ...(managed.config.sub_agents ?? {}), enabled };
      await msg.reply(`✅ Sub-agents \`${enabled ? 'on' : 'off'}\`${!enabled ? ' — spawn_task disabled for this session' : ''}`).catch(() => {});
      return;
    }

    if (content === '/changes') {
      const replay = managed.session.replay;
      if (!replay) {
        await msg.reply('Replay is disabled. No change tracking available.').catch(() => {});
        return;
      }
      try {
        const checkpoints = await replay.list(50);
        if (!checkpoints.length) {
          await msg.reply('No file changes this session.').catch(() => {});
          return;
        }
        const byFile = new Map<string, number>();
        for (const cp of checkpoints) byFile.set(cp.filePath, (byFile.get(cp.filePath) ?? 0) + 1);
        const lines = [`Session changes (${byFile.size} files):`];
        for (const [fp, count] of byFile) lines.push(`✎ \`${fp}\` (${count} edit${count > 1 ? 's' : ''})`);
        await msg.reply(lines.join('\n')).catch(() => {});
      } catch (e: any) {
        await msg.reply(`Error listing changes: ${e?.message ?? String(e)}`).catch(() => {});
      }
      return;
    }

    if (content === '/undo') {
      const lastPath = managed.session.lastEditedPath;
      if (!lastPath) {
        await msg.reply('No recent edits to undo.').catch(() => {});
        return;
      }
      try {
        const { undo_path } = await import('../tools.js');
        const result = await undo_path({ cwd: managed.config.dir || defaultDir, noConfirm: true, dryRun: false } as any, { path: lastPath });
        await msg.reply(`✅ ${result}`).catch(() => {});
      } catch (e: any) {
        await msg.reply(`❌ Undo failed: ${e?.message ?? String(e)}`).catch(() => {});
      }
      return;
    }

    if (content === '/vault' || content.startsWith('/vault ')) {
      const query = content.slice('/vault'.length).trim();
      if (!query) {
        await msg.reply('Usage: /vault <search query>').catch(() => {});
        return;
      }
      const vault = managed.session.vault;
      if (!vault) {
        await msg.reply('Vault is disabled.').catch(() => {});
        return;
      }
      try {
        const results = await vault.search(query, 5);
        if (!results.length) {
          await msg.reply(`No vault results for "${query}"`).catch(() => {});
          return;
        }
        const lines = [`Vault results for "${query}":`];
        for (const r of results) {
          const title = r.kind === 'note' ? `note:${r.key}` : `tool:${r.tool || r.key || '?'}`;
          const body = (r.value ?? r.snippet ?? r.content ?? '').replace(/\s+/g, ' ').slice(0, 120);
          lines.push(`• ${title}: ${body}`);
        }
        await msg.reply(lines.join('\n')).catch(() => {});
      } catch (e: any) {
        await msg.reply(`Error searching vault: ${e?.message ?? String(e)}`).catch(() => {});
      }
      return;
    }

    if (content === '/status') {
      const used = managed.session.usage.prompt + managed.session.usage.completion;
      const pct = managed.session.contextWindow > 0
        ? ((used / managed.session.contextWindow) * 100).toFixed(1)
        : '?';
      await msg.reply(
        [
          `Mode: ${managed.config.mode ?? 'code'}`,
          `Approval: ${managed.config.approval_mode}`,
          `Model: ${managed.session.model}`,
          `Harness: ${managed.session.harness}`,
          `Context: ~${used}/${managed.session.contextWindow} (${pct}%)`,
          `State: ${managed.state}`,
          `Queue: ${managed.pendingQueue.length}/${maxQueue}`,
        ].join('\n'),
      ).catch(() => {});
      return;
    }

    if (content === '/hosts') {
      try {
        const { loadRuntimes, redactConfig } = await import('../runtime/store.js');
        const config = await loadRuntimes();
        const redacted = redactConfig(config);
        if (!redacted.hosts.length) {
          await msg.reply('No hosts configured. Use `idlehands hosts add` in CLI.').catch(() => {});
          return;
        }

        const lines = redacted.hosts.map((h) =>
          `${h.enabled ? '🟢' : '🔴'} ${h.display_name} (\`${h.id}\`)\n  Transport: ${h.transport}`,
        );

        const chunks = splitDiscord(lines.join('\n\n'));
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await msg.reply(chunk).catch(() => {});
          else await (msg.channel as any).send(chunk).catch(() => {});
        }
      } catch (e: any) {
        await msg.reply(`❌ Failed to load hosts: ${e?.message ?? String(e)}`).catch(() => {});
      }
      return;
    }

    if (content === '/backends') {
      try {
        const { loadRuntimes, redactConfig } = await import('../runtime/store.js');
        const config = await loadRuntimes();
        const redacted = redactConfig(config);
        if (!redacted.backends.length) {
          await msg.reply('No backends configured. Use `idlehands backends add` in CLI.').catch(() => {});
          return;
        }

        const lines = redacted.backends.map((b) =>
          `${b.enabled ? '🟢' : '🔴'} ${b.display_name} (\`${b.id}\`)\n  Type: ${b.type}`,
        );

        const chunks = splitDiscord(lines.join('\n\n'));
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await msg.reply(chunk).catch(() => {});
          else await (msg.channel as any).send(chunk).catch(() => {});
        }
      } catch (e: any) {
        await msg.reply(`❌ Failed to load backends: ${e?.message ?? String(e)}`).catch(() => {});
      }
      return;
    }

    if (content === '/rtmodels') {
      try {
        const { loadRuntimes } = await import('../runtime/store.js');
        const config = await loadRuntimes();
        if (!config.models.length) {
          await msg.reply('No runtime models configured.').catch(() => {});
          return;
        }

        const lines = config.models.map((m) =>
          `${m.enabled ? '🟢' : '🔴'} ${m.display_name} (\`${m.id}\`)\n  Source: \`${m.source}\``,
        );

        const chunks = splitDiscord(lines.join('\n\n'));
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await msg.reply(chunk).catch(() => {});
          else await (msg.channel as any).send(chunk).catch(() => {});
        }
      } catch (e: any) {
        await msg.reply(`❌ Failed to load runtime models: ${e?.message ?? String(e)}`).catch(() => {});
      }
      return;
    }

    if (content === '/rtstatus') {
      try {
        const { loadActiveRuntime } = await import('../runtime/executor.js');
        const active = await loadActiveRuntime();
        if (!active) {
          await msg.reply('No active runtime.').catch(() => {});
          return;
        }

        const lines = [
          'Active Runtime',
          `Model: \`${active.modelId}\``,
          `Backend: \`${active.backendId ?? 'none'}\``,
          `Hosts: ${active.hostIds.map((id) => `\`${id}\``).join(', ') || 'none'}`,
          `Healthy: ${active.healthy ? '✅ yes' : '❌ no'}`,
          `Endpoint: \`${active.endpoint ?? 'unknown'}\``,
          `Started: \`${active.startedAt}\``,
        ];

        const chunks = splitDiscord(lines.join('\n'));
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await msg.reply(chunk).catch(() => {});
          else await (msg.channel as any).send(chunk).catch(() => {});
        }
      } catch (e: any) {
        await msg.reply(`❌ Failed to read runtime status: ${e?.message ?? String(e)}`).catch(() => {});
      }
      return;
    }

    if (content === '/switch' || content.startsWith('/switch ')) {
      try {
        const modelId = content.slice('/switch'.length).trim();
        if (!modelId) {
          await msg.reply('Usage: /switch <model-id>').catch(() => {});
          return;
        }

        const { plan } = await import('../runtime/planner.js');
        const { execute, loadActiveRuntime } = await import('../runtime/executor.js');
        const { loadRuntimes } = await import('../runtime/store.js');

        const rtConfig = await loadRuntimes();
        const active = await loadActiveRuntime();
        const result = plan({ modelId, mode: 'live' }, rtConfig, active);

        if (!result.ok) {
          await msg.reply(`❌ Plan failed: ${result.reason}`).catch(() => {});
          return;
        }

        if (result.reuse) {
          await msg.reply('✅ Runtime already active and healthy.').catch(() => {});
          return;
        }

        const statusMsg = await msg.reply(`⏳ Switching to \`${result.model.display_name}\`...`).catch(() => null);

        const execResult = await execute(result, {
          onStep: async (step, status) => {
            if (status === 'done' && statusMsg) {
              await statusMsg.edit(`⏳ ${step.description}... ✓`).catch(() => {});
            }
          },
          confirm: async (prompt) => {
            await msg.reply(`⚠️ ${prompt}\nAuto-approving for bot context.`).catch(() => {});
            return true;
          },
        });

        if (execResult.ok) {
          if (statusMsg) {
            await statusMsg.edit(`✅ Switched to \`${result.model.display_name}\``).catch(() => {});
          } else {
            await msg.reply(`✅ Switched to \`${result.model.display_name}\``).catch(() => {});
          }
        } else {
          const err = `❌ Switch failed: ${execResult.error || 'unknown error'}`;
          if (statusMsg) {
            await statusMsg.edit(err).catch(() => {});
          } else {
            await msg.reply(err).catch(() => {});
          }
        }
      } catch (e: any) {
        await msg.reply(`❌ Switch failed: ${e?.message ?? String(e)}`).catch(() => {});
      }
      return;
    }

    // /anton command
    if (content === '/anton' || content.startsWith('/anton ')) {
      await handleDiscordAnton(managed, msg, content);
      return;
    }

    if (managed.inFlight) {
      if (managed.pendingQueue.length >= maxQueue) {
        await msg.reply(`⏳ Queue full (${managed.pendingQueue.length}/${maxQueue}). Use /cancel.`).catch(() => {});
        return;
      }
      managed.pendingQueue.push(msg);
      await msg.reply(`⏳ Queued (#${managed.pendingQueue.length}).`).catch(() => {});
      return;
    }

    console.error(`[bot:discord] ${msg.author.id}: ${content.slice(0, 50)}${content.length > 50 ? '…' : ''}`);
    await processMessage(managed, msg);
  });

  const DISCORD_RATE_LIMIT_MS = 15_000;

  async function handleDiscordAnton(managed: ManagedSession, msg: Message, content: string): Promise<void> {
    const args = content.replace(/^\/anton\s*/, '').trim();
    const sub = args.split(/\s+/)[0]?.toLowerCase() || '';

    if (!sub || sub === 'status') {
      if (!managed.antonActive) {
        await msg.reply('No Anton run in progress.').catch(() => {});
      } else if (managed.antonProgress) {
        await msg.reply(formatProgressBar(managed.antonProgress)).catch(() => {});
      } else {
        await msg.reply('🤖 Anton is running (no progress data yet).').catch(() => {});
      }
      return;
    }

    if (sub === 'stop') {
      if (!managed.antonActive || !managed.antonAbortSignal) {
        await msg.reply('No Anton run in progress.').catch(() => {});
        return;
      }
      managed.antonAbortSignal.aborted = true;
      await msg.reply('🛑 Anton stop requested.').catch(() => {});
      return;
    }

    if (sub === 'last') {
      if (!managed.antonLastResult) {
        await msg.reply('No previous Anton run.').catch(() => {});
        return;
      }
      await msg.reply(formatRunSummary(managed.antonLastResult)).catch(() => {});
      return;
    }

    const filePart = sub === 'run' ? args.replace(/^\S+\s*/, '').trim() : args;
    if (!filePart) {
      await msg.reply('/anton <file> — start | /anton status | /anton stop | /anton last').catch(() => {});
      return;
    }

    if (managed.antonActive) {
      await msg.reply('⚠️ Anton is already running. Use /anton stop first.').catch(() => {});
      return;
    }

    const cwd = managed.config.dir || process.cwd();
    const filePath = path.resolve(cwd, filePart);

    try { await fs.stat(filePath); } catch {
      await msg.reply(`File not found: ${filePath}`).catch(() => {});
      return;
    }

    const defaults = (managed.config as any).anton || {};
    const runConfig: AntonRunConfig = {
      taskFile: filePath, projectDir: cwd,
      maxRetriesPerTask: defaults.max_retries ?? 3,
      maxIterations: defaults.max_iterations ?? 200,
      taskTimeoutSec: defaults.task_timeout_sec ?? 600,
      totalTimeoutSec: defaults.total_timeout_sec ?? 7200,
      maxTotalTokens: defaults.max_total_tokens ?? Infinity,
      autoCommit: defaults.auto_commit ?? true,
      branch: false, allowDirty: false,
      aggressiveCleanOnFail: false,
      verifyAi: defaults.verify_ai ?? true,
      verifyModel: undefined,
      decompose: defaults.decompose ?? true,
      maxDecomposeDepth: defaults.max_decompose_depth ?? 2,
      maxTotalTasks: defaults.max_total_tasks ?? 500,
      buildCommand: undefined, testCommand: undefined, lintCommand: undefined,
      skipOnFail: defaults.skip_on_fail ?? true,
      approvalMode: (defaults.approval_mode ?? 'yolo') as AntonRunConfig['approvalMode'],
      verbose: false, dryRun: false,
    };

    const abortSignal = { aborted: false };
    managed.antonActive = true;
    managed.antonAbortSignal = abortSignal;
    managed.antonProgress = null;

    let lastProgressAt = 0;
    const channel = msg.channel as { send: (c: string) => Promise<any> };

    const progress: AntonProgressCallback = {
      onTaskStart(task, attempt, prog) {
        managed.antonProgress = prog;
        const now = Date.now();
        if (now - lastProgressAt >= DISCORD_RATE_LIMIT_MS) {
          lastProgressAt = now;
          channel.send(formatTaskStart(task, attempt, prog)).catch(() => {});
        }
      },
      onTaskEnd(task, result, prog) {
        managed.antonProgress = prog;
        const now = Date.now();
        if (now - lastProgressAt >= DISCORD_RATE_LIMIT_MS) {
          lastProgressAt = now;
          channel.send(formatTaskEnd(task, result, prog)).catch(() => {});
        }
      },
      onTaskSkip(task, reason) {
        channel.send(formatTaskSkip(task, reason)).catch(() => {});
      },
      onRunComplete(result) {
        managed.antonLastResult = result;
        managed.antonActive = false;
        managed.antonAbortSignal = null;
        managed.antonProgress = null;
        channel.send(formatRunSummary(result)).catch(() => {});
      },
    };

    let pendingCount = 0;
    try { const tf = await parseTaskFile(filePath); pendingCount = tf.pending.length; } catch {}

    await msg.reply(`🤖 Anton started on ${filePart} (${pendingCount} tasks pending)`).catch(() => {});

    runAnton({
      config: runConfig,
      idlehandsConfig: managed.config,
      progress,
      abortSignal,
      vault: managed.session.vault,
      lens: managed.session.lens,
    }).catch((err: Error) => {
      managed.antonActive = false;
      managed.antonAbortSignal = null;
      managed.antonProgress = null;
      channel.send(`Anton error: ${err.message}`).catch(() => {});
    });
  }

  const shutdown = async () => {
    clearInterval(cleanupTimer);
    for (const key of sessions.keys()) destroySession(key);
    await client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  await client.login(token);
}
