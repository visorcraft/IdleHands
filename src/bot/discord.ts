import fs from 'node:fs/promises';
import path from 'node:path';

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type Message,
  type TextBasedChannel,
} from 'discord.js';

import { createSession, type AgentSession, type AgentHooks } from '../agent.js';
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
import { chainAgentHooks } from '../progress/agent-hooks.js';
import type { ApprovalMode, BotDiscordConfig, IdlehandsConfig, AgentPersona } from '../types.js';
import { projectDir, PKG_VERSION } from '../utils.js';
import {
  WATCHDOG_RECOMMENDED_TUNING_TEXT,
  formatWatchdogCancelMessage,
  resolveWatchdogSettings,
  shouldRecommendWatchdogTuning,
} from '../watchdog.js';

import { DiscordConfirmProvider } from './confirm-discord.js';
import {
  detectRepoCandidates,
  expandHome,
  isPathAllowed,
  normalizeAllowedDirs,
} from './dir-guard.js';
import {
  parseAllowedUsers,
  normalizeApprovalMode,
  splitDiscord,
  safeContent,
  detectEscalation,
  checkKeywordEscalation,
  resolveAgentForMessage,
  sessionKeyForMessage,
} from './discord-routing.js';
import { DiscordStreamingMessage } from './discord-streaming.js';

type SessionState = 'idle' | 'running' | 'canceling' | 'resetting';

type ManagedSession = {
  key: string;
  userId: string;
  agentId: string;
  agentPersona: AgentPersona | null;
  channel: TextBasedChannel;
  session: AgentSession;
  confirmProvider: DiscordConfirmProvider;
  config: IdlehandsConfig;
  allowedDirs: string[];
  dirPinned: boolean;
  repoCandidates: string[];
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
  // Escalation tracking
  currentModelIndex: number; // 0 = base model, 1+ = escalated
  escalationCount: number; // how many times escalated this turn
  pendingEscalation: string | null; // model to escalate to on next message
  // Watchdog compaction recovery
  watchdogCompactAttempts: number; // how many times watchdog has compacted this turn
};

export async function startDiscordBot(
  config: IdlehandsConfig,
  botConfig: BotDiscordConfig
): Promise<void> {
  const token = process.env.IDLEHANDS_DISCORD_TOKEN || botConfig.token;
  if (!token) {
    console.error('[bot:discord] Missing token. Set IDLEHANDS_DISCORD_TOKEN or bot.discord.token.');
    process.exit(1);
  }

  const allowedUsers = parseAllowedUsers(botConfig);
  if (allowedUsers.size === 0) {
    console.error(
      '[bot:discord] bot.discord.allowed_users is empty — refusing to start unauthenticated bot.'
    );
    process.exit(1);
  }

  const allowGuilds = botConfig.allow_guilds ?? false;
  const guildId = botConfig.guild_id;
  const maxSessions = botConfig.max_sessions ?? 5;
  const maxQueue = botConfig.max_queue ?? 3;
  const sessionTimeoutMs = (botConfig.session_timeout_min ?? 30) * 60_000;
  const approvalMode = normalizeApprovalMode(
    botConfig.approval_mode,
    config.approval_mode ?? 'auto-edit'
  );
  const defaultDir = botConfig.default_dir || projectDir(config);
  const replyToUserMessages = botConfig.reply_to_user_messages === true;
  const watchdogSettings = resolveWatchdogSettings(botConfig, config);
  const watchdogMs = watchdogSettings.timeoutMs;
  const maxWatchdogCompacts = watchdogSettings.maxCompactions;
  const watchdogIdleGraceTimeouts = watchdogSettings.idleGraceTimeouts;
  const debugAbortReason = watchdogSettings.debugAbortReason;

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

  const sendUserVisible = async (msg: Message, content: string) => {
    if (replyToUserMessages) return await msg.reply(content);
    return await (msg.channel as any).send(content);
  };

  const watchdogStatusText = (managed?: ManagedSession): string => {
    const lines = [
      '**Watchdog Status**',
      `Timeout: ${watchdogMs.toLocaleString()} ms (${Math.round(watchdogMs / 1000)}s)`,
      `Max compactions: ${maxWatchdogCompacts}`,
      `Grace windows: ${watchdogIdleGraceTimeouts}`,
      `Debug abort reason: ${debugAbortReason ? 'on' : 'off'}`,
    ];

    if (shouldRecommendWatchdogTuning(watchdogSettings)) {
      lines.push('');
      lines.push(`Recommended tuning: ${WATCHDOG_RECOMMENDED_TUNING_TEXT}`);
    }

    if (managed) {
      const idleSec =
        managed.lastProgressAt > 0
          ? ((Date.now() - managed.lastProgressAt) / 1000).toFixed(1)
          : 'n/a';
      lines.push('');
      lines.push(`In-flight: ${managed.inFlight ? 'yes' : 'no'}`);
      lines.push(`State: ${managed.state}`);
      lines.push(`Compaction attempts (turn): ${managed.watchdogCompactAttempts}`);
      lines.push(`Idle since progress: ${idleSec}s`);
    } else {
      lines.push('');
      lines.push('No active session yet. Send a message to start one.');
    }

    return lines.join('\n');
  };

  async function getOrCreate(msg: Message): Promise<ManagedSession | null> {
    // Resolve which agent should handle this message
    const { agentId, persona } = resolveAgentForMessage(msg, botConfig.agents, botConfig.routing);
    const key = sessionKeyForMessage(msg, allowGuilds, agentId);

    const existing = sessions.get(key);
    if (existing) {
      existing.lastActivity = Date.now();
      return existing;
    }

    if (sessions.size >= maxSessions) {
      return null;
    }

    // Build config with agent-specific overrides
    const allowedDirs = normalizeAllowedDirs(persona?.allowed_dirs ?? botConfig.allowed_dirs);
    const agentDir = path.resolve(
      expandHome(persona?.default_dir || persona?.allowed_dirs?.[0] || defaultDir)
    );
    const agentApproval = persona?.approval_mode
      ? normalizeApprovalMode(persona.approval_mode, approvalMode)
      : approvalMode;

    const repoCandidates = await detectRepoCandidates(agentDir, allowedDirs).catch(
      () => [] as string[]
    );
    const requireDirPinForMutations = repoCandidates.length > 1;
    const dirPinned = !requireDirPinForMutations;

    // Build system prompt with escalation instructions if configured
    let systemPrompt = persona?.system_prompt;
    if (persona?.escalation?.models?.length && persona?.escalation?.auto !== false) {
      const escalationModels = persona.escalation.models.join(', ');
      const escalationInstructions = `

[AUTO-ESCALATION]
You have access to more powerful models when needed: ${escalationModels}
If you encounter a task that is too complex, requires deeper reasoning, or you're struggling to solve, 
you can escalate by including this exact marker at the START of your response:
[ESCALATE: brief reason]

Examples:
- [ESCALATE: complex algorithm requiring multi-step reasoning]
- [ESCALATE: need larger context window for this codebase analysis]
- [ESCALATE: struggling with this optimization problem]

Only escalate when genuinely needed. Most tasks should be handled by your current model.
When you escalate, your request will be re-run on a more capable model.`;

      systemPrompt = (systemPrompt || '') + escalationInstructions;
    }

    const cfg: IdlehandsConfig = {
      ...config,
      dir: agentDir,
      approval_mode: agentApproval,
      no_confirm: agentApproval === 'yolo',
      allowed_write_roots: allowedDirs,
      require_dir_pin_for_mutations: requireDirPinForMutations,
      dir_pinned: dirPinned,
      repo_candidates: repoCandidates,
      // Agent-specific overrides
      ...(persona?.model && { model: persona.model }),
      ...(persona?.endpoint && { endpoint: persona.endpoint }),
      ...(systemPrompt && { system_prompt_override: systemPrompt }),
      ...(persona?.max_tokens && { max_tokens: persona.max_tokens }),
      ...(persona?.temperature !== undefined && { temperature: persona.temperature }),
      ...(persona?.top_p !== undefined && { top_p: persona.top_p }),
    };

    const confirmProvider = new DiscordConfirmProvider(
      msg.channel,
      msg.author.id,
      botConfig.confirm_timeout_sec ?? 300
    );

    const session = await createSession({
      config: cfg,
      confirmProvider,
      confirm: async () => true,
    });

    const managed: ManagedSession = {
      key,
      userId: msg.author.id,
      agentId,
      agentPersona: persona,
      channel: msg.channel,
      session,
      confirmProvider,
      config: cfg,
      allowedDirs,
      dirPinned,
      repoCandidates,
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
      currentModelIndex: 0,
      escalationCount: 0,
      pendingEscalation: null,
      watchdogCompactAttempts: 0,
    };
    sessions.set(key, managed);

    // Log agent assignment for debugging
    if (persona) {
      console.error(
        `[bot:discord] ${msg.author.id} → agent:${agentId} (${persona.display_name || agentId})`
      );
    }

    return managed;
  }

  function destroySession(key: string): void {
    const s = sessions.get(key);
    if (!s) return;
    s.state = 'resetting';
    s.pendingQueue = [];
    if (s.antonAbortSignal) s.antonAbortSignal.aborted = true;
    s.antonActive = false;
    s.antonAbortSignal = null;
    s.antonProgress = null;
    try {
      s.activeAbortController?.abort();
    } catch { }
    try {
      s.session.cancel();
    } catch { }
    sessions.delete(key);
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) {
      if (!s.inFlight && !s.antonActive && now - s.lastActivity > sessionTimeoutMs) {
        destroySession(key);
      }
    }
  }, 60_000);

  function beginTurn(
    managed: ManagedSession
  ): { turnId: number; controller: AbortController } | null {
    if (managed.inFlight || managed.state === 'resetting') return null;
    const controller = new AbortController();
    managed.inFlight = true;
    managed.state = 'running';
    managed.activeTurnId += 1;
    managed.activeAbortController = controller;
    managed.lastProgressAt = Date.now();
    managed.lastActivity = Date.now();
    managed.watchdogCompactAttempts = 0;
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
    const wasRunning = managed.inFlight;
    const queueSize = managed.pendingQueue.length;

    if (!wasRunning && queueSize === 0) {
      return { ok: false, message: 'Nothing to cancel.' };
    }

    // Always clear queued work.
    managed.pendingQueue = [];

    if (wasRunning) {
      managed.state = 'canceling';
      try {
        managed.activeAbortController?.abort();
      } catch { }
      try {
        managed.session.cancel();
      } catch { }
    }

    managed.lastActivity = Date.now();

    const parts: string[] = [];
    if (wasRunning) parts.push('stopping current task');
    if (queueSize > 0) parts.push(`cleared ${queueSize} queued task${queueSize > 1 ? 's' : ''}`);

    return { ok: true, message: `⏹ Cancelled: ${parts.join(', ')}.` };
  }

  async function processMessage(managed: ManagedSession, msg: Message): Promise<void> {
    let turn = beginTurn(managed);
    if (!turn) return;
    let turnId = turn.turnId;

    // Handle pending escalation - switch model before processing
    if (managed.pendingEscalation) {
      const targetModel = managed.pendingEscalation;
      managed.pendingEscalation = null;

      // Find the model index in escalation chain
      const escalation = managed.agentPersona?.escalation;
      if (escalation?.models) {
        const idx = escalation.models.indexOf(targetModel);
        if (idx !== -1) {
          managed.currentModelIndex = idx + 1; // +1 because 0 is base model
          managed.escalationCount += 1;
        }
      }

      // Recreate session with escalated model
      const cfg: IdlehandsConfig = {
        ...managed.config,
        model: targetModel,
      };

      try {
        await recreateSession(managed, cfg);
        console.error(`[bot:discord] ${managed.userId} escalated to ${targetModel}`);
      } catch (e: any) {
        console.error(`[bot:discord] escalation failed: ${e?.message ?? e}`);
        // Continue with current model if escalation fails
      }

      // Re-acquire turn after recreation - must update turnId!
      const newTurn = beginTurn(managed);
      if (!newTurn) return;
      turn = newTurn;
      turnId = newTurn.turnId;
    }

    // Check for keyword-based escalation BEFORE calling the model
    // Allow escalation to higher tiers even if already escalated
    const escalation = managed.agentPersona?.escalation;
    if (escalation?.models?.length) {
      const kwResult = checkKeywordEscalation(msg.content, escalation);
      if (kwResult.escalate && kwResult.tier !== undefined) {
        // Use the tier to select the target model (tier 0 → models[0], tier 1 → models[1], etc.)
        const targetModelIndex = Math.min(kwResult.tier, escalation.models.length - 1);
        // Only escalate if target tier is higher than current (currentModelIndex 0 = base, 1 = models[0], etc.)
        const currentTier = managed.currentModelIndex - 1; // -1 because 0 is base model
        if (targetModelIndex > currentTier) {
          const targetModel = escalation.models[targetModelIndex];
          // Get endpoint from tier if defined
          const tierEndpoint = escalation.tiers?.[targetModelIndex]?.endpoint;
          console.error(
            `[bot:discord] ${managed.userId} keyword escalation: ${kwResult.reason} → ${targetModel}${tierEndpoint ? ` @ ${tierEndpoint}` : ''}`
          );

          // Set up escalation
          managed.currentModelIndex = targetModelIndex + 1; // +1 because 0 is base model
          managed.escalationCount += 1;

          // Recreate session with escalated model and optional endpoint override
          const cfg: IdlehandsConfig = {
            ...managed.config,
            model: targetModel,
            ...(tierEndpoint && { endpoint: tierEndpoint }),
          };

          try {
            await recreateSession(managed, cfg);
            // Re-acquire turn after recreation - must update turnId!
            const newTurn = beginTurn(managed);
            if (!newTurn) return;
            turn = newTurn;
            turnId = newTurn.turnId;
          } catch (e: any) {
            console.error(`[bot:discord] keyword escalation failed: ${e?.message ?? e}`);
            // Continue with current model if escalation fails
          }
        }
      }
    }

    const placeholder = await sendUserVisible(msg, '⏳ Thinking...').catch(() => null);
    const streamer = new DiscordStreamingMessage(placeholder, msg.channel, {
      editIntervalMs: 1500,
    });
    streamer.start();

    const baseHooks: AgentHooks = {
      onToken: () => {
        if (!isTurnActive(managed, turnId)) return;
        markProgress(managed, turnId);
        watchdogGraceUsed = 0;
      },
      onToolCall: () => {
        if (!isTurnActive(managed, turnId)) return;
        markProgress(managed, turnId);
        watchdogGraceUsed = 0;
      },
      onToolStream: () => {
        if (!isTurnActive(managed, turnId)) return;
        markProgress(managed, turnId);
        watchdogGraceUsed = 0;
      },
      onToolResult: () => {
        if (!isTurnActive(managed, turnId)) return;
        markProgress(managed, turnId);
        watchdogGraceUsed = 0;
      },
      onTurnEnd: () => {
        if (!isTurnActive(managed, turnId)) return;
        markProgress(managed, turnId);
        watchdogGraceUsed = 0;
      },
    };

    let watchdogCompactPending = false;
    let watchdogGraceUsed = 0;
    let watchdogForcedCancel = false;
    const watchdog = setInterval(() => {
      if (!isTurnActive(managed, turnId)) return;
      if (watchdogCompactPending) return;
      if (Date.now() - managed.lastProgressAt > watchdogMs) {
        if (watchdogGraceUsed < watchdogIdleGraceTimeouts) {
          watchdogGraceUsed += 1;
          managed.lastProgressAt = Date.now();
          console.error(
            `[bot:discord] ${managed.userId} watchdog inactivity on turn ${turnId} — applying grace period (${watchdogGraceUsed}/${watchdogIdleGraceTimeouts})`
          );
          streamer.setBanner('⏳ Still working... model is taking longer than usual.');
          return;
        }

        if (managed.watchdogCompactAttempts < maxWatchdogCompacts) {
          managed.watchdogCompactAttempts++;
          watchdogCompactPending = true;
          console.error(
            `[bot:discord] ${managed.userId} watchdog timeout on turn ${turnId} — compacting and retrying (attempt ${managed.watchdogCompactAttempts}/${maxWatchdogCompacts})`
          );
          // Cancel current request, compact, and re-send
          try {
            managed.activeAbortController?.abort();
          } catch { }
          managed.session
            .compactHistory({ force: true })
            .then((result) => {
              console.error(
                `[bot:discord] ${managed.userId} watchdog compaction: freed ${result.freedTokens} tokens, dropped ${result.droppedMessages} messages`
              );
              managed.lastProgressAt = Date.now();
              watchdogCompactPending = false;
            })
            .catch((e) => {
              console.error(
                `[bot:discord] ${managed.userId} watchdog compaction failed: ${e?.message ?? e}`
              );
              watchdogCompactPending = false;
            });
        } else {
          console.error(
            `[bot:discord] ${managed.userId} watchdog timeout on turn ${turnId} — max compaction attempts reached, cancelling`
          );
          watchdogForcedCancel = true;
          cancelActive(managed);
        }
      }
    }, 5_000);

    try {
      let askComplete = false;
      let isRetryAfterCompaction = false;
      while (!askComplete) {
        // Create a fresh AbortController for each attempt (watchdog compaction aborts the previous one)
        const attemptController = new AbortController();
        managed.activeAbortController = attemptController;
        turn.controller = attemptController;

        let askText = isRetryAfterCompaction
          ? 'Continue working on the task from where you left off. Context was compacted to free memory — do NOT restart from the beginning.'
          : msg.content;

        if (managed.antonActive) {
          askText = `${askText}\n\n[System Runtime Context: Anton task runner is CURRENTLY ACTIVE and running autonomously in the background for this project.]`;
        }

        const hooks = chainAgentHooks(
          { signal: attemptController.signal },
          baseHooks,
          streamer.hooks()
        );

        try {
          const result = await managed.session.ask(askText, hooks);
          askComplete = true;
          if (!isTurnActive(managed, turnId)) return;
          markProgress(managed, turnId);
          const finalText = safeContent(result.text);

          // Check for auto-escalation request in response
          const escalation = managed.agentPersona?.escalation;
          const autoEscalate = escalation?.auto !== false && escalation?.models?.length;
          const maxEscalations = escalation?.max_escalations ?? 2;

          if (autoEscalate && managed.escalationCount < maxEscalations) {
            const escResult = detectEscalation(finalText);
            if (escResult.escalate) {
              // Determine next model in escalation chain
              const nextIndex = Math.min(managed.currentModelIndex, escalation!.models!.length - 1);
              const targetModel = escalation!.models![nextIndex];
              // Get endpoint from tier if defined
              const tierEndpoint = escalation!.tiers?.[nextIndex]?.endpoint;

              console.error(
                `[bot:discord] ${managed.userId} auto-escalation requested: ${escResult.reason}${tierEndpoint ? ` @ ${tierEndpoint}` : ''}`
              );

              await streamer.finalizeError(
                `⚡ Escalating to \`${targetModel}\` (${escResult.reason})...`
              );

              // Set up escalation for re-run
              managed.pendingEscalation = targetModel;
              managed.currentModelIndex = nextIndex + 1;
              managed.escalationCount += 1;

              // Recreate session with escalated model and optional endpoint override
              const cfg: IdlehandsConfig = {
                ...managed.config,
                model: targetModel,
                ...(tierEndpoint && { endpoint: tierEndpoint }),
              };
              await recreateSession(managed, cfg);

              // Finish this turn and re-run with escalated model
              clearInterval(watchdog);
              finishTurn(managed, turnId);

              // Re-process the original message with the escalated model
              await processMessage(managed, msg);
              return;
            }
          }

          await streamer.finalize(finalText);
        } catch (e: any) {
          const raw = String(e?.message ?? e ?? 'unknown error');
          const isAbort = raw.includes('AbortError') || raw.toLowerCase().includes('aborted');

          // If aborted by watchdog compaction, wait for compaction to finish then retry
          if (isAbort && watchdogCompactPending) {
            streamer.setBanner(
              `🔄 Context too large — compacting and retrying (attempt ${managed.watchdogCompactAttempts}/${maxWatchdogCompacts})...`
            );
            // Wait for the async compaction to complete
            while (watchdogCompactPending) {
              await new Promise((r) => setTimeout(r, 500));
            }
            // Loop back to retry the ask with continuation prompt
            isRetryAfterCompaction = true;
            continue;
          }

          // If aborted by watchdog after max compaction attempts, it's a real cancel
          if (!isTurnActive(managed, turnId)) return;
          if (isAbort) {
            const cancelMsg = formatWatchdogCancelMessage({
              watchdogForcedCancel,
              maxCompactions: maxWatchdogCompacts,
              debugAbortReason,
              abortReason: raw,
              prefix: '⏹ ',
            });
            await streamer.finalizeError(cancelMsg);
          } else {
            const errMsg = raw.slice(0, 400);
            await streamer.finalizeError(errMsg);
          }
          askComplete = true;
        }
      }
    } finally {
      clearInterval(watchdog);
      streamer.stop();
      finishTurn(managed, turnId);

      // Auto-deescalate back to base model after each request
      if (managed.currentModelIndex > 0 && managed.agentPersona?.escalation) {
        const baseModel = managed.agentPersona.model || config.model || 'default';
        managed.currentModelIndex = 0;
        managed.escalationCount = 0;

        const cfg: IdlehandsConfig = {
          ...managed.config,
          model: baseModel,
        };

        try {
          await recreateSession(managed, cfg);
          console.error(`[bot:discord] ${managed.userId} auto-deescalated to ${baseModel}`);
        } catch (e: any) {
          console.error(`[bot:discord] auto-deescalation failed: ${e?.message ?? e}`);
        }
      }

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
    try {
      managed.activeAbortController?.abort();
    } catch { }

    // Preserve conversation history before destroying the old session
    const oldMessages = managed.session.messages.slice();

    try {
      managed.session.cancel();
    } catch { }

    const session = await createSession({
      config: cfg,
      confirmProvider: managed.confirmProvider,
      confirm: async () => true,
    });

    // Restore conversation history to the new session
    if (oldMessages.length > 0) {
      try {
        session.restore(oldMessages);
      } catch (e) {
        console.error(
          `[bot:discord] Failed to restore ${oldMessages.length} messages after escalation:`,
          e
        );
      }
    }

    managed.session = session;
    managed.config = cfg;
    managed.inFlight = false;
    managed.state = 'idle';
    managed.activeAbortController = null;
    managed.lastProgressAt = 0;
    managed.lastActivity = Date.now();
  }

  client.on(Events.ClientReady, async () => {
    console.error(`[bot:discord] Connected as ${client.user?.tag ?? 'unknown'}`);
    console.error(`[bot:discord] Allowed users: [${[...allowedUsers].join(', ')}]`);
    console.error(`[bot:discord] Default dir: ${defaultDir}`);
    console.error(`[bot:discord] Approval: ${approvalMode}`);
    console.error(
      `[bot:discord] Watchdog: timeout=${watchdogMs}ms compactions=${maxWatchdogCompacts} grace=${watchdogIdleGraceTimeouts}`
    );
    if (allowGuilds) {
      console.error(`[bot:discord] Guild mode enabled${guildId ? ` (guild ${guildId})` : ''}`);
    }
    // Log multi-agent config
    const agents = botConfig.agents;
    if (agents && Object.keys(agents).length > 0) {
      const agentIds = Object.keys(agents);
      console.error(
        `[bot:discord] Multi-agent mode: ${agentIds.length} agents configured [${agentIds.join(', ')}]`
      );
      const routing = botConfig.routing;
      if (routing?.default) {
        console.error(`[bot:discord] Default agent: ${routing.default}`);
      }
    }

    // Register slash commands
    try {
      const commands = [
        new SlashCommandBuilder().setName('help').setDescription('Show available commands'),
        new SlashCommandBuilder().setName('version').setDescription('Show version'),
        new SlashCommandBuilder().setName('new').setDescription('Start a new session'),
        new SlashCommandBuilder().setName('status').setDescription('Show session statistics'),
        new SlashCommandBuilder()
          .setName('watchdog')
          .setDescription('Show watchdog settings/status'),
        new SlashCommandBuilder().setName('agent').setDescription('Show current agent info'),
        new SlashCommandBuilder().setName('agents').setDescription('List all configured agents'),
        new SlashCommandBuilder().setName('cancel').setDescription('Cancel the current operation'),
        new SlashCommandBuilder().setName('reset').setDescription('Reset the session'),
        new SlashCommandBuilder()
          .setName('escalate')
          .setDescription('Escalate to a larger model')
          .addStringOption((option) =>
            option.setName('model').setDescription('Model name or "next"').setRequired(false)
          ),
        new SlashCommandBuilder().setName('deescalate').setDescription('Return to base model'),
        new SlashCommandBuilder().setName('restart_bot').setDescription('Restart the bot service'),
      ].map((cmd) => cmd.toJSON());

      const rest = new REST({ version: '10' }).setToken(token);

      // Register globally (takes up to 1 hour to propagate) or per-guild (instant)
      if (guildId) {
        await rest.put(Routes.applicationGuildCommands(client.user!.id, guildId), {
          body: commands,
        });
        console.error(
          `[bot:discord] Registered ${commands.length} slash commands for guild ${guildId}`
        );
      } else {
        await rest.put(Routes.applicationCommands(client.user!.id), { body: commands });
        console.error(`[bot:discord] Registered ${commands.length} global slash commands`);
      }
    } catch (e: any) {
      console.error(`[bot:discord] Failed to register slash commands: ${e?.message ?? e}`);
    }
  });

  // Handle slash command interactions
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!allowedUsers.has(interaction.user.id)) {
      await interaction.reply({
        content: '⚠️ You are not authorized to use this bot.',
        ephemeral: true,
      });
      return;
    }

    const cmd = interaction.commandName;
    // Create a fake message object with enough properties to work with existing handlers
    const fakeMsg = {
      author: interaction.user,
      channel: interaction.channel,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      content: `/${cmd}`,
      reply: async (content: string) => {
        if (interaction.replied || interaction.deferred) {
          return await interaction.followUp(content);
        }
        return await interaction.reply(content);
      },
    } as unknown as Message;

    // Defer reply for commands that might take a while
    if (cmd === 'status' || cmd === 'watchdog' || cmd === 'agent' || cmd === 'agents') {
      await interaction.deferReply();
    }

    // Resolve agent for this interaction
    const { agentId, persona } = resolveAgentForMessage(
      fakeMsg,
      botConfig.agents,
      botConfig.routing
    );
    const key = sessionKeyForMessage(fakeMsg, allowGuilds, agentId);

    switch (cmd) {
      case 'help': {
        const lines = [
          '**IdleHands Commands**',
          '',
          '/help — This message',
          '/version — Show version',
          '/new — Start fresh session',
          '/status — Session stats',
          '/watchdog — Show watchdog settings/status',
          '/agent — Show current agent',
          '/agents — List all configured agents',
          '/cancel — Abort running task',
          '/reset — Full session reset',
          '/restart_bot — Restart the bot service',
        ];
        await interaction.reply(lines.join('\n'));
        break;
      }
      case 'version': {
        const lines = [
          `**IdleHands** v${PKG_VERSION}`,
          '',
          `**Model:** \`${config.model || 'auto'}\``,
          `**Endpoint:** \`${config.endpoint || '?'}\``,
        ];
        await interaction.reply(lines.join('\n'));
        break;
      }
      case 'new': {
        destroySession(key);
        const agentName = persona?.display_name || agentId;
        const agentMsg = persona ? ` (agent: ${agentName})` : '';
        await interaction.reply(`✨ New session started${agentMsg}. Send a message to begin.`);
        break;
      }
      case 'status': {
        const managed = sessions.get(key);
        if (!managed) {
          await interaction.editReply('No active session.');
        } else {
          const lines = [
            `**Session:** ${managed.key}`,
            `**Agent:** ${managed.agentPersona?.display_name || managed.agentId}`,
            `**Model:** ${managed.config.model ?? 'default'}`,
            `**State:** ${managed.state}`,
            `**Turns:** ${managed.session.messages.length}`,
          ];
          await interaction.editReply(lines.join('\n'));
        }
        break;
      }
      case 'watchdog': {
        const managed = sessions.get(key);
        await interaction.editReply(watchdogStatusText(managed));
        break;
      }
      case 'agent': {
        const agentName = persona?.display_name || agentId;
        if (persona) {
          const lines = [
            `**Current Agent:** ${agentName}`,
            persona.model ? `**Model:** ${persona.model}` : null,
            persona.system_prompt
              ? `**System Prompt:** ${persona.system_prompt.slice(0, 100)}...`
              : null,
          ].filter(Boolean);
          await interaction.editReply(lines.join('\n'));
        } else {
          await interaction.editReply(`**Current Agent:** Default (no persona configured)`);
        }
        break;
      }
      case 'agents': {
        const agentsConfig = botConfig.agents;
        if (!agentsConfig || Object.keys(agentsConfig).length === 0) {
          await interaction.editReply('No agents configured.');
        } else {
          const lines = ['**Configured Agents:**', ''];
          for (const [id, agent] of Object.entries(agentsConfig)) {
            const name = agent.display_name || id;
            const model = agent.model ? ` (${agent.model})` : '';
            lines.push(`• **${name}**${model}`);
          }
          await interaction.editReply(lines.join('\n'));
        }
        break;
      }
      case 'cancel': {
        const managed = sessions.get(key);
        if (!managed) {
          await interaction.reply('No active session.');
        } else {
          const res = cancelActive(managed);
          await interaction.reply(res.message);
        }
        break;
      }
      case 'reset': {
        destroySession(key);
        await interaction.reply('🔄 Session reset.');
        break;
      }
      case 'escalate': {
        const managed = sessions.get(key);
        const escalation = persona?.escalation;
        if (!escalation || !escalation.models?.length) {
          await interaction.reply('❌ No escalation models configured for this agent.');
          break;
        }

        const arg = interaction.options.getString('model');

        // No arg: show available models and current state
        if (!arg) {
          const currentModel = managed?.config.model || config.model || 'default';
          const lines = [
            `**Current model:** \`${currentModel}\``,
            `**Escalation models:** ${escalation.models.map((m) => `\`${m}\``).join(', ')}`,
            '',
            'Usage: `/escalate model:<name>` or `/escalate model:next`',
          ];
          if (managed?.pendingEscalation) {
            lines.push('', `⚡ **Pending escalation:** \`${managed.pendingEscalation}\``);
          }
          await interaction.reply(lines.join('\n'));
          break;
        }

        if (!managed) {
          await interaction.reply('No active session. Send a message first.');
          break;
        }

        // Handle 'next' - escalate to next model in chain
        let targetModel: string;
        if (arg.toLowerCase() === 'next') {
          const nextIndex = Math.min(managed.currentModelIndex, escalation.models.length - 1);
          targetModel = escalation.models[nextIndex];
        } else {
          // Specific model requested
          if (!escalation.models.includes(arg)) {
            await interaction.reply(
              `❌ Model \`${arg}\` not in escalation chain. Available: ${escalation.models.map((m) => `\`${m}\``).join(', ')}`
            );
            break;
          }
          targetModel = arg;
        }

        managed.pendingEscalation = targetModel;
        await interaction.reply(
          `⚡ Next message will use \`${targetModel}\`. Send your request now.`
        );
        break;
      }
      case 'deescalate': {
        const managed = sessions.get(key);
        if (!managed) {
          await interaction.reply('No active session.');
          break;
        }
        if (managed.currentModelIndex === 0 && !managed.pendingEscalation) {
          await interaction.reply('Already using base model.');
          break;
        }

        const baseModel = persona?.model || config.model || 'default';
        managed.pendingEscalation = null;
        managed.currentModelIndex = 0;

        // Recreate session with base model
        const cfg: IdlehandsConfig = {
          ...managed.config,
          model: baseModel,
        };
        await recreateSession(managed, cfg);
        await interaction.reply(`✅ Returned to base model: \`${baseModel}\``);
        break;
      }
      case 'restart_bot': {
        const { spawn } = await import('node:child_process');
        await interaction.reply('🔄 Restarting idlehands-bot service...');
        spawn('systemctl', ['--user', 'restart', 'idlehands-bot'], {
          detached: true,
          stdio: 'ignore',
        }).unref();
        break;
      }
    }
  });

  // Handle button interactions (model selection, etc.)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (!allowedUsers.has(interaction.user.id)) {
      await interaction.reply({ content: '⚠️ Not authorized.', ephemeral: true });
      return;
    }

    const customId = interaction.customId;
    if (!customId.startsWith('model_switch:')) return;

    const modelId = customId.slice('model_switch:'.length);
    await interaction.deferUpdate();

    try {
      const { plan } = await import('../runtime/planner.js');
      const { execute, loadActiveRuntime } = await import('../runtime/executor.js');
      const { loadRuntimes } = await import('../runtime/store.js');

      const rtConfig = await loadRuntimes();
      const active = await loadActiveRuntime();
      const result = plan({ modelId, mode: 'live' }, rtConfig, active);

      if (!result.ok) {
        await interaction.editReply({ content: `❌ Plan failed: ${result.reason}`, components: [] });
        return;
      }

      if (result.reuse) {
        await interaction.editReply({ content: `✅ Already using \`${result.model.display_name}\``, components: [] });
        return;
      }

      const execResult = await execute(result, {
        onStep: async (step, status) => {
          if (status === 'done') {
            await interaction.editReply({ content: `⏳ ${step.description}... ✓`, components: [] }).catch(() => {});
          }
        },
        confirm: async (prompt) => {
          await interaction.followUp(`⚠️ ${prompt}\nAuto-approving for bot context.`);
          return true;
        },
      });

      if (execResult.ok) {
        await interaction.editReply({ content: `✅ Switched to \`${result.model.display_name}\``, components: [] });
      } else {
        await interaction.editReply({ content: `❌ Switch failed: ${execResult.error || 'unknown error'}`, components: [] });
      }
    } catch (e: any) {
      await interaction.editReply({ content: `❌ Switch failed: ${e?.message ?? String(e)}`, components: [] });
    }
  });

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    if (!allowedUsers.has(msg.author.id)) return;

    if (!allowGuilds && msg.guildId) return;
    if (allowGuilds && guildId && msg.guildId && msg.guildId !== guildId) return;

    let content = msg.content?.trim();
    if (!content) return;

    // Check if this channel requires @mention to respond
    const requireMentionChannels = botConfig.routing?.require_mention_channels ?? [];
    if (requireMentionChannels.includes(msg.channelId)) {
      const botMention = client.user ? `<@${client.user.id}>` : null;
      const botMentionNick = client.user ? `<@!${client.user.id}>` : null;
      const isMentioned =
        botMention &&
        (content.includes(botMention) || (botMentionNick && content.includes(botMentionNick)));
      if (!isMentioned) return; // Silently ignore messages without mention

      // Strip the bot mention from content so the agent sees clean text
      if (botMention)
        content = content.replace(new RegExp(`<@!?${client.user!.id}>`, 'g'), '').trim();
      if (!content) return; // Nothing left after stripping mention
    }

    // Resolve agent for this message to get the correct session key
    const { agentId, persona } = resolveAgentForMessage(msg, botConfig.agents, botConfig.routing);
    const key = sessionKeyForMessage(msg, allowGuilds, agentId);

    if (content === '/new') {
      destroySession(key);
      const agentName = persona?.display_name || agentId;
      const agentMsg = persona ? ` (agent: ${agentName})` : '';
      await sendUserVisible(
        msg,
        `✨ New session started${agentMsg}. Send a message to begin.`
      ).catch(() => { });
      return;
    }

    const managed = await getOrCreate(msg);
    if (!managed) {
      await sendUserVisible(msg, '⚠️ Too many active sessions. Please retry later.').catch(
        () => { }
      );
      return;
    }

    if (content === '/cancel') {
      const res = cancelActive(managed);
      await sendUserVisible(msg, res.message).catch(() => { });
      return;
    }

    if (content === '/start') {
      const agentLine = managed.agentPersona
        ? `Agent: **${managed.agentPersona.display_name || managed.agentId}**`
        : null;
      const lines = [
        '🔧 Idle Hands — Local-first coding agent',
        '',
        ...(agentLine ? [agentLine] : []),
        `Model: \`${managed.session.model}\``,
        `Endpoint: \`${managed.config.endpoint || '?'}\``,
        `Default dir: \`${managed.config.dir || defaultDir}\``,
        '',
        'Send me a coding task, or use /help for commands.',
      ];
      await sendUserVisible(msg, lines.join('\n')).catch(() => { });
      return;
    }

    if (content === '/help') {
      const lines = [
        'Commands:',
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
      await sendUserVisible(msg, lines.join('\n')).catch(() => { });
      return;
    }

    if (content === '/model') {
      await sendUserVisible(
        msg,
        `Model: \`${managed.session.model}\`\nHarness: \`${managed.session.harness}\``
      ).catch(() => { });
      return;
    }

    if (content === '/version') {
      await sendUserVisible(msg, `Idle Hands v${PKG_VERSION}`).catch(() => { });
      return;
    }

    if (content === '/compact') {
      managed.session.reset();
      await sendUserVisible(msg, '🗜 Session context compacted (reset to system prompt).').catch(
        () => { }
      );
      return;
    }

    if (content === '/dir' || content.startsWith('/dir ')) {
      const arg = content.slice('/dir'.length).trim();
      if (!arg) {
        const lines = [
          `Working directory: \`${managed.config.dir || defaultDir}\``,
          `Directory pinned: ${managed.dirPinned ? 'yes' : 'no'}`,
        ];
        if (!managed.dirPinned && managed.repoCandidates.length > 1) {
          lines.push('Action required: run `/dir <repo-root>` before file edits.');
          lines.push(
            `Detected repos: ${managed.repoCandidates
              .slice(0, 5)
              .map((p) => `\`${p}\``)
              .join(', ')}`
          );
        }
        await sendUserVisible(msg, lines.join('\n')).catch(() => { });
        return;
      }

      const resolvedDir = path.resolve(expandHome(arg));
      if (!isPathAllowed(resolvedDir, managed.allowedDirs)) {
        await sendUserVisible(
          msg,
          `❌ Directory not allowed. Allowed roots: ${managed.allowedDirs.map((d) => `\`${d}\``).join(', ')}`
        ).catch(() => { });
        return;
      }

      const repoCandidates = await detectRepoCandidates(resolvedDir, managed.allowedDirs).catch(
        () => managed.repoCandidates
      );
      const cfg: IdlehandsConfig = {
        ...managed.config,
        dir: resolvedDir,
        allowed_write_roots: managed.allowedDirs,
        dir_pinned: true,
        repo_candidates: repoCandidates,
      };
      await recreateSession(managed, cfg);
      managed.dirPinned = true;
      managed.repoCandidates = repoCandidates;
      await sendUserVisible(msg, `✅ Working directory pinned to \`${resolvedDir}\``).catch(
        () => { }
      );
      return;
    }

    if (content === '/approval' || content.startsWith('/approval ')) {
      const arg = content.slice('/approval'.length).trim().toLowerCase();
      const modes = ['plan', 'default', 'auto-edit', 'yolo'] as const;
      if (!arg) {
        await sendUserVisible(
          msg,
          `Approval mode: \`${managed.config.approval_mode || approvalMode}\`\nOptions: ${modes.join(', ')}`
        ).catch(() => { });
        return;
      }
      if (!modes.includes(arg as any)) {
        await sendUserVisible(msg, `Invalid mode. Options: ${modes.join(', ')}`).catch(() => { });
        return;
      }
      managed.config.approval_mode = arg as any;
      managed.config.no_confirm = arg === 'yolo';
      await sendUserVisible(msg, `✅ Approval mode set to \`${arg}\``).catch(() => { });
      return;
    }

    if (content === '/mode' || content.startsWith('/mode ')) {
      const arg = content.slice('/mode'.length).trim().toLowerCase();
      if (!arg) {
        await sendUserVisible(msg, `Mode: \`${managed.config.mode || 'code'}\``).catch(() => { });
        return;
      }
      if (arg !== 'code' && arg !== 'sys') {
        await sendUserVisible(msg, 'Invalid mode. Options: code, sys').catch(() => { });
        return;
      }
      managed.config.mode = arg as any;
      if (arg === 'sys' && managed.config.approval_mode === 'auto-edit') {
        managed.config.approval_mode = 'default';
      }
      await sendUserVisible(msg, `✅ Mode set to \`${arg}\``).catch(() => { });
      return;
    }

    if (content === '/subagents' || content.startsWith('/subagents ')) {
      const arg = content.slice('/subagents'.length).trim().toLowerCase();
      const current = managed.config.sub_agents?.enabled !== false;
      if (!arg) {
        await sendUserVisible(
          msg,
          `Sub-agents: \`${current ? 'on' : 'off'}\`\nUsage: /subagents on | off`
        ).catch(() => { });
        return;
      }
      if (arg !== 'on' && arg !== 'off') {
        await sendUserVisible(msg, 'Invalid value. Usage: /subagents on | off').catch(() => { });
        return;
      }
      const enabled = arg === 'on';
      managed.config.sub_agents = { ...(managed.config.sub_agents ?? {}), enabled };
      await sendUserVisible(
        msg,
        `✅ Sub-agents \`${enabled ? 'on' : 'off'}\`${!enabled ? ' — spawn_task disabled for this session' : ''}`
      ).catch(() => { });
      return;
    }

    if (content === '/changes') {
      const replay = managed.session.replay;
      if (!replay) {
        await sendUserVisible(msg, 'Replay is disabled. No change tracking available.').catch(
          () => { }
        );
        return;
      }
      try {
        const checkpoints = await replay.list(50);
        if (!checkpoints.length) {
          await sendUserVisible(msg, 'No file changes this session.').catch(() => { });
          return;
        }
        const byFile = new Map<string, number>();
        for (const cp of checkpoints) byFile.set(cp.filePath, (byFile.get(cp.filePath) ?? 0) + 1);
        const lines = [`Session changes (${byFile.size} files):`];
        for (const [fp, count] of byFile)
          lines.push(`✎ \`${fp}\` (${count} edit${count > 1 ? 's' : ''})`);
        await sendUserVisible(msg, lines.join('\n')).catch(() => { });
      } catch (e: any) {
        await sendUserVisible(msg, `Error listing changes: ${e?.message ?? String(e)}`).catch(
          () => { }
        );
      }
      return;
    }

    if (content === '/undo') {
      const lastPath = managed.session.lastEditedPath;
      if (!lastPath) {
        await sendUserVisible(msg, 'No recent edits to undo.').catch(() => { });
        return;
      }
      try {
        const { undo_path } = await import('../tools.js');
        const result = await undo_path(
          { cwd: managed.config.dir || defaultDir, noConfirm: true, dryRun: false } as any,
          { path: lastPath }
        );
        await sendUserVisible(msg, `✅ ${result}`).catch(() => { });
      } catch (e: any) {
        await sendUserVisible(msg, `❌ Undo failed: ${e?.message ?? String(e)}`).catch(() => { });
      }
      return;
    }

    if (content === '/vault' || content.startsWith('/vault ')) {
      const query = content.slice('/vault'.length).trim();
      if (!query) {
        await sendUserVisible(msg, 'Usage: /vault <search query>').catch(() => { });
        return;
      }
      const vault = managed.session.vault;
      if (!vault) {
        await sendUserVisible(msg, 'Vault is disabled.').catch(() => { });
        return;
      }
      try {
        const results = await vault.search(query, 5);
        if (!results.length) {
          await sendUserVisible(msg, `No vault results for "${query}"`).catch(() => { });
          return;
        }
        const lines = [`Vault results for "${query}":`];
        for (const r of results) {
          const title = r.kind === 'note' ? `note:${r.key}` : `tool:${r.tool || r.key || '?'}`;
          const body = (r.value ?? r.snippet ?? r.content ?? '').replace(/\s+/g, ' ').slice(0, 120);
          lines.push(`• ${title}: ${body}`);
        }
        await sendUserVisible(msg, lines.join('\n')).catch(() => { });
      } catch (e: any) {
        await sendUserVisible(msg, `Error searching vault: ${e?.message ?? String(e)}`).catch(
          () => { }
        );
      }
      return;
    }

    if (content === '/status') {
      const used = managed.session.currentContextTokens;
      const pct =
        managed.session.contextWindow > 0
          ? Math.min(100, (used / managed.session.contextWindow) * 100).toFixed(1)
          : '?';
      const agentLine = managed.agentPersona
        ? `Agent: ${managed.agentPersona.display_name || managed.agentId}`
        : null;
      await sendUserVisible(
        msg,
        [
          ...(agentLine ? [agentLine] : []),
          `Mode: ${managed.config.mode ?? 'code'}`,
          `Approval: ${managed.config.approval_mode}`,
          `Model: ${managed.session.model}`,
          `Harness: ${managed.session.harness}`,
          `Dir: ${managed.config.dir ?? defaultDir}`,
          `Dir pinned: ${managed.dirPinned ? 'yes' : 'no'}`,
          `Context: ~${used}/${managed.session.contextWindow} (${pct}%)`,
          `State: ${managed.state}`,
          `Queue: ${managed.pendingQueue.length}/${maxQueue}`,
        ].join('\n')
      ).catch(() => { });
      return;
    }

    if (content === '/watchdog' || content === '/watchdog status') {
      await sendUserVisible(msg, watchdogStatusText(managed)).catch(() => { });
      return;
    }

    if (content.startsWith('/watchdog ')) {
      await sendUserVisible(msg, 'Usage: /watchdog or /watchdog status').catch(() => { });
      return;
    }

    // /agent - show current agent info
    if (content === '/agent') {
      if (!managed.agentPersona) {
        await sendUserVisible(msg, 'No agent configured. Using global config.').catch(() => { });
        return;
      }
      const p = managed.agentPersona;
      const lines = [
        `**Agent: ${p.display_name || managed.agentId}** (\`${managed.agentId}\`)`,
        ...(p.model ? [`Model: \`${p.model}\``] : []),
        ...(p.endpoint ? [`Endpoint: \`${p.endpoint}\``] : []),
        ...(p.approval_mode ? [`Approval: \`${p.approval_mode}\``] : []),
        ...(p.default_dir ? [`Default dir: \`${p.default_dir}\``] : []),
        ...(p.allowed_dirs?.length
          ? [`Allowed dirs: ${p.allowed_dirs.map((d) => `\`${d}\``).join(', ')}`]
          : []),
      ];
      await sendUserVisible(msg, lines.join('\n')).catch(() => { });
      return;
    }

    // /agents - list all configured agents
    if (content === '/agents') {
      const agents = botConfig.agents;
      if (!agents || Object.keys(agents).length === 0) {
        await sendUserVisible(msg, 'No agents configured. Using global config.').catch(() => { });
        return;
      }
      const lines = ['**Configured Agents:**'];
      for (const [id, p] of Object.entries(agents)) {
        const current = id === managed.agentId ? ' ← current' : '';
        const model = p.model ? ` (${p.model})` : '';
        lines.push(`• **${p.display_name || id}** (\`${id}\`)${model}${current}`);
      }

      // Show routing rules
      const routing = botConfig.routing;
      if (routing) {
        lines.push('', '**Routing:**');
        if (routing.default) lines.push(`Default: \`${routing.default}\``);
        if (routing.users && Object.keys(routing.users).length > 0) {
          lines.push(
            `Users: ${Object.entries(routing.users)
              .map(([u, a]) => `${u}→${a}`)
              .join(', ')}`
          );
        }
        if (routing.channels && Object.keys(routing.channels).length > 0) {
          lines.push(
            `Channels: ${Object.entries(routing.channels)
              .map(([c, a]) => `${c}→${a}`)
              .join(', ')}`
          );
        }
        if (routing.guilds && Object.keys(routing.guilds).length > 0) {
          lines.push(
            `Guilds: ${Object.entries(routing.guilds)
              .map(([g, a]) => `${g}→${a}`)
              .join(', ')}`
          );
        }
      }

      await sendUserVisible(msg, lines.join('\n')).catch(() => { });
      return;
    }

    // /escalate - explicitly escalate to a larger model for next message
    if (content === '/escalate' || content.startsWith('/escalate ')) {
      const escalation = managed.agentPersona?.escalation;
      if (!escalation || !escalation.models?.length) {
        await sendUserVisible(msg, '❌ No escalation models configured for this agent.').catch(
          () => { }
        );
        return;
      }

      const arg = content.slice('/escalate'.length).trim();

      // No arg: show available models and current state
      if (!arg) {
        const currentModel = managed.config.model || config.model || 'default';
        const lines = [
          `**Current model:** \`${currentModel}\``,
          `**Escalation models:** ${escalation.models.map((m) => `\`${m}\``).join(', ')}`,
          '',
          'Usage: `/escalate <model>` or `/escalate next`',
          'Then send your message - it will use the escalated model.',
        ];
        if (managed.pendingEscalation) {
          lines.push(
            '',
            `⚡ **Pending escalation:** \`${managed.pendingEscalation}\` (next message will use this)`
          );
        }
        await sendUserVisible(msg, lines.join('\n')).catch(() => { });
        return;
      }

      // Handle 'next' - escalate to next model in chain
      let targetModel: string;
      if (arg.toLowerCase() === 'next') {
        const nextIndex = Math.min(managed.currentModelIndex, escalation.models.length - 1);
        targetModel = escalation.models[nextIndex];
      } else {
        // Specific model requested
        if (!escalation.models.includes(arg)) {
          await sendUserVisible(
            msg,
            `❌ Model \`${arg}\` not in escalation chain. Available: ${escalation.models.map((m) => `\`${m}\``).join(', ')}`
          ).catch(() => { });
          return;
        }
        targetModel = arg;
      }

      managed.pendingEscalation = targetModel;
      await sendUserVisible(
        msg,
        `⚡ Next message will use \`${targetModel}\`. Send your request now.`
      ).catch(() => { });
      return;
    }

    // /deescalate - return to base model
    if (content === '/deescalate') {
      if (managed.currentModelIndex === 0 && !managed.pendingEscalation) {
        await sendUserVisible(msg, 'Already using base model.').catch(() => { });
        return;
      }

      const baseModel = managed.agentPersona?.model || config.model || 'default';
      managed.pendingEscalation = null;
      managed.currentModelIndex = 0;

      // Recreate session with base model
      const cfg: IdlehandsConfig = {
        ...managed.config,
        model: baseModel,
      };
      await recreateSession(managed, cfg);
      await sendUserVisible(msg, `✅ Returned to base model: \`${baseModel}\``).catch(() => { });
      return;
    }

    // /git_status - show git status for working directory
    if (content === '/git_status') {
      const cwd = managed.config.dir || defaultDir;
      if (!cwd) {
        await sendUserVisible(msg, 'No working directory set. Use `/dir` to set one.').catch(() => { });
        return;
      }

      try {
        const { spawnSync } = await import('node:child_process');

        // Run git status -s
        const statusResult = spawnSync('git', ['status', '-s'], {
          cwd,
          encoding: 'utf8',
          timeout: 5000,
        });

        if (statusResult.status !== 0) {
          const err = String(statusResult.stderr || statusResult.error || 'Unknown error');
          if (err.includes('not a git repository') || err.includes('not in a git')) {
            await sendUserVisible(msg, '❌ Not a git repository.').catch(() => { });
          } else {
            await sendUserVisible(msg, `❌ git status failed: ${err.slice(0, 200)}`).catch(() => { });
          }
          return;
        }

        const statusOut = String(statusResult.stdout || '').trim();

        // Get branch info
        const branchResult = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd,
          encoding: 'utf8',
          timeout: 2000,
        });
        const branch = branchResult.status === 0 ? String(branchResult.stdout || '').trim() : 'unknown';

        if (!statusOut) {
          await sendUserVisible(
            msg,
            `📁 \`${cwd}\`\n🌿 Branch: \`${branch}\`\n\n✅ Working tree clean`
          ).catch(() => { });
          return;
        }

        const lines = statusOut.split('\n').slice(0, 30);
        const truncated = statusOut.split('\n').length > 30;

        const formatted = lines
          .map((line) => `\`${line.slice(0, 2)}\` ${line.slice(3)}`)
          .join('\n');

        await sendUserVisible(
          msg,
          `📁 \`${cwd}\`\n🌿 Branch: \`${branch}\`\n\n\`\`\`\n${formatted}${truncated ? '\n...' : ''}\`\`\``
        ).catch(() => { });
      } catch (e: any) {
        await sendUserVisible(msg, `❌ git status failed: ${e?.message ?? String(e)}`).catch(() => { });
      }
      return;
    }

    if (content === '/hosts') {
      try {
        const { loadRuntimes, redactConfig } = await import('../runtime/store.js');
        const config = await loadRuntimes();
        const redacted = redactConfig(config);
        if (!redacted.hosts.length) {
          await sendUserVisible(
            msg,
            'No hosts configured. Use `idlehands hosts add` in CLI.'
          ).catch(() => { });
          return;
        }

        const lines = redacted.hosts.map(
          (h) =>
            `${h.enabled ? '🟢' : '🔴'} ${h.display_name} (\`${h.id}\`)\n  Transport: ${h.transport}`
        );

        const chunks = splitDiscord(lines.join('\n\n'));
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await sendUserVisible(msg, chunk).catch(() => { });
          else await (msg.channel as any).send(chunk).catch(() => { });
        }
      } catch (e: any) {
        await sendUserVisible(msg, `❌ Failed to load hosts: ${e?.message ?? String(e)}`).catch(
          () => { }
        );
      }
      return;
    }

    if (content === '/backends') {
      try {
        const { loadRuntimes, redactConfig } = await import('../runtime/store.js');
        const config = await loadRuntimes();
        const redacted = redactConfig(config);
        if (!redacted.backends.length) {
          await sendUserVisible(
            msg,
            'No backends configured. Use `idlehands backends add` in CLI.'
          ).catch(() => { });
          return;
        }

        const lines = redacted.backends.map(
          (b) => `${b.enabled ? '🟢' : '🔴'} ${b.display_name} (\`${b.id}\`)\n  Type: ${b.type}`
        );

        const chunks = splitDiscord(lines.join('\n\n'));
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await sendUserVisible(msg, chunk).catch(() => { });
          else await (msg.channel as any).send(chunk).catch(() => { });
        }
      } catch (e: any) {
        await sendUserVisible(msg, `❌ Failed to load backends: ${e?.message ?? String(e)}`).catch(
          () => { }
        );
      }
      return;
    }

    if (content === '/models' || content === '/rtmodels') {
      try {
        const { loadRuntimes } = await import('../runtime/store.js');
        const config = await loadRuntimes();
        if (!config.models.length) {
          await sendUserVisible(msg, 'No runtime models configured.').catch(() => { });
          return;
        }

        const enabledModels = config.models.filter((m) => m.enabled);
        if (!enabledModels.length) {
          await sendUserVisible(msg, 'No enabled runtime models. Use `idlehands models enable <id>` in CLI.').catch(() => { });
          return;
        }

        // Create buttons for model selection (Discord max 5 buttons per row, 5 rows)
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
        const rows: any[] = [];
        let currentRow = new ActionRowBuilder<any>();

        for (const m of enabledModels) {
          const btn = new ButtonBuilder()
            .setCustomId(`model_switch:${m.id}`)
            .setLabel(m.display_name.slice(0, 80))
            .setStyle(ButtonStyle.Primary);

          currentRow.addComponents(btn);

          if (currentRow.components.length >= 5) {
            rows.push(currentRow);
            currentRow = new ActionRowBuilder<any>();
          }
        }
        if (currentRow.components.length > 0) {
          rows.push(currentRow);
        }

        await (msg.channel as any).send({
          content: '📋 **Select a model to switch to:**',
          components: rows.slice(0, 5), // Discord max 5 rows
        }).catch(() => { });
      } catch (e: any) {
        await sendUserVisible(
          msg,
          `❌ Failed to load runtime models: ${e?.message ?? String(e)}`
        ).catch(() => { });
      }
      return;
    }

    if (content === '/rtstatus') {
      try {
        const { loadActiveRuntime } = await import('../runtime/executor.js');
        const active = await loadActiveRuntime();
        if (!active) {
          await sendUserVisible(msg, 'No active runtime.').catch(() => { });
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
          if (i === 0) await sendUserVisible(msg, chunk).catch(() => { });
          else await (msg.channel as any).send(chunk).catch(() => { });
        }
      } catch (e: any) {
        await sendUserVisible(
          msg,
          `❌ Failed to read runtime status: ${e?.message ?? String(e)}`
        ).catch(() => { });
      }
      return;
    }

    if (content === '/switch' || content.startsWith('/switch ')) {
      try {
        const modelId = content.slice('/switch'.length).trim();
        if (!modelId) {
          await sendUserVisible(msg, 'Usage: /switch <model-id>').catch(() => { });
          return;
        }

        const { plan } = await import('../runtime/planner.js');
        const { execute, loadActiveRuntime } = await import('../runtime/executor.js');
        const { loadRuntimes } = await import('../runtime/store.js');

        const rtConfig = await loadRuntimes();
        const active = await loadActiveRuntime();
        const result = plan({ modelId, mode: 'live' }, rtConfig, active);

        if (!result.ok) {
          await sendUserVisible(msg, `❌ Plan failed: ${result.reason}`).catch(() => { });
          return;
        }

        if (result.reuse) {
          await sendUserVisible(msg, '✅ Runtime already active and healthy.').catch(() => { });
          return;
        }

        const statusMsg = await sendUserVisible(
          msg,
          `⏳ Switching to \`${result.model.display_name}\`...`
        ).catch(() => null);

        const execResult = await execute(result, {
          onStep: async (step, status) => {
            if (status === 'done' && statusMsg) {
              await statusMsg.edit(`⏳ ${step.description}... ✓`).catch(() => { });
            }
          },
          confirm: async (prompt) => {
            await sendUserVisible(msg, `⚠️ ${prompt}\nAuto-approving for bot context.`).catch(
              () => { }
            );
            return true;
          },
        });

        if (execResult.ok) {
          if (statusMsg) {
            await statusMsg.edit(`✅ Switched to \`${result.model.display_name}\``).catch(() => { });
          } else {
            await sendUserVisible(msg, `✅ Switched to \`${result.model.display_name}\``).catch(
              () => { }
            );
          }
        } else {
          const err = `❌ Switch failed: ${execResult.error || 'unknown error'}`;
          if (statusMsg) {
            await statusMsg.edit(err).catch(() => { });
          } else {
            await sendUserVisible(msg, err).catch(() => { });
          }
        }
      } catch (e: any) {
        await sendUserVisible(msg, `❌ Switch failed: ${e?.message ?? String(e)}`).catch(() => { });
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
        await sendUserVisible(
          msg,
          `⏳ Queue full (${managed.pendingQueue.length}/${maxQueue}). Use /cancel.`
        ).catch(() => { });
        return;
      }
      managed.pendingQueue.push(msg);
      await sendUserVisible(msg, `⏳ Queued (#${managed.pendingQueue.length}).`).catch(() => { });
      return;
    }

    console.error(
      `[bot:discord] ${msg.author.id}: ${content.slice(0, 50)}${content.length > 50 ? '…' : ''}`
    );

    // Do not await long-running turns here.
    // Keeping the message handler non-blocking ensures control commands like /cancel
    // are handled immediately while a generation is in flight.
    void processMessage(managed, msg).catch(async (e: any) => {
      const errMsg = e?.message ?? String(e);
      console.error(`[bot:discord] processMessage failed for ${msg.author.id}: ${errMsg}`);
      await sendUserVisible(
        msg,
        `⚠️ Bot error: ${errMsg.length > 300 ? errMsg.slice(0, 297) + '...' : errMsg}`
      ).catch(() => { });
    });
  });

  const DISCORD_RATE_LIMIT_MS = 15_000;

  async function handleDiscordAnton(
    managed: ManagedSession,
    msg: Message,
    content: string
  ): Promise<void> {
    const args = content.replace(/^\/anton\s*/, '').trim();
    const sub = firstToken(args);

    if (!sub || sub === 'status') {
      if (!managed.antonActive) {
        await sendUserVisible(msg, 'No Anton run in progress.').catch(() => { });
      } else if (managed.antonAbortSignal?.aborted) {
        await sendUserVisible(
          msg,
          '🛑 Anton is stopping. Please wait for the current attempt to unwind.'
        ).catch(() => { });
      } else if (managed.antonProgress) {
        const line1 = formatProgressBar(managed.antonProgress);
        if (managed.antonProgress.currentTask) {
          await sendUserVisible(
            msg,
            `${line1}\n\n**Working on:** *${managed.antonProgress.currentTask}* (Attempt ${managed.antonProgress.currentAttempt})`
          ).catch(() => { });
        } else {
          await sendUserVisible(msg, line1).catch(() => { });
        }
      } else {
        await sendUserVisible(msg, '🤖 Anton is running (no progress data yet).').catch(() => { });
      }
      return;
    }

    if (sub === 'stop') {
      if (!managed.antonActive || !managed.antonAbortSignal) {
        await sendUserVisible(msg, 'No Anton run in progress.').catch(() => { });
        return;
      }
      managed.lastActivity = Date.now();
      managed.antonAbortSignal.aborted = true;
      await sendUserVisible(msg, '🛑 Anton stop requested.').catch(() => { });
      return;
    }

    if (sub === 'last') {
      if (!managed.antonLastResult) {
        await sendUserVisible(msg, 'No previous Anton run.').catch(() => { });
        return;
      }
      await sendUserVisible(msg, formatRunSummary(managed.antonLastResult)).catch(() => { });
      return;
    }

    const filePart = sub === 'run' ? args.replace(/^\S+\s*/, '').trim() : args;
    if (!filePart) {
      await sendUserVisible(
        msg,
        '/anton <file> — start | /anton status | /anton stop | /anton last'
      ).catch(() => { });
      return;
    }

    if (managed.antonActive) {
      const staleMs = Date.now() - managed.lastActivity;
      if (staleMs > 120_000) {
        managed.antonActive = false;
        managed.antonAbortSignal = null;
        managed.antonProgress = null;
        await sendUserVisible(
          msg,
          '♻️ Recovered stale Anton run state. Starting a fresh run...'
        ).catch(() => { });
      } else {
        const runningMsg = managed.antonAbortSignal?.aborted
          ? '🛑 Anton is still stopping. Please wait a moment, then try again.'
          : '⚠️ Anton is already running. Use /anton stop first.';
        await sendUserVisible(msg, runningMsg).catch(() => { });
        return;
      }
    }

    const cwd = managed.config.dir || process.cwd();
    const filePath = path.resolve(cwd, filePart);

    try {
      await fs.stat(filePath);
    } catch {
      await sendUserVisible(msg, `File not found: ${filePath}`).catch(() => { });
      return;
    }

    const defaults = (managed.config as any).anton || {};
    const runConfig: AntonRunConfig = {
      taskFile: filePath,
      projectDir: defaults.project_dir || cwd,
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
      buildCommand: defaults.build_command ?? undefined,
      testCommand: defaults.test_command ?? undefined,
      lintCommand: defaults.lint_command ?? undefined,
      skipOnFail: defaults.skip_on_fail ?? false,
      skipOnBlocked: defaults.skip_on_blocked ?? true,
      rollbackOnFail: defaults.rollback_on_fail ?? false,
      maxIdenticalFailures: defaults.max_identical_failures ?? 5,
      approvalMode: (defaults.approval_mode ?? 'yolo') as AntonRunConfig['approvalMode'],
      verbose: false,
      dryRun: false,
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
        managed.lastActivity = Date.now();
        const now = Date.now();
        if (now - lastProgressAt >= DISCORD_RATE_LIMIT_MS) {
          lastProgressAt = now;
          channel.send(formatTaskStart(task, attempt, prog)).catch(() => { });
        }
      },
      onTaskEnd(task, result, prog) {
        managed.antonProgress = prog;
        managed.lastActivity = Date.now();
        const now = Date.now();
        if (now - lastProgressAt >= DISCORD_RATE_LIMIT_MS) {
          lastProgressAt = now;
          channel.send(formatTaskEnd(task, result, prog)).catch(() => { });
        }
      },
      onTaskSkip(task, reason) {
        managed.lastActivity = Date.now();
        channel.send(formatTaskSkip(task, reason)).catch(() => { });
      },
      onRunComplete(result) {
        managed.lastActivity = Date.now();
        managed.antonLastResult = result;
        managed.antonActive = false;
        managed.antonAbortSignal = null;
        managed.antonProgress = null;
        channel.send(formatRunSummary(result)).catch(() => { });
      },
      onHeartbeat() {
        managed.lastActivity = Date.now();
      },
      onToolLoop(taskText, event) {
        managed.lastActivity = Date.now();
        if (defaults.progress_events !== false) {
          channel.send(formatToolLoopEvent(taskText, event)).catch(() => { });
        }
      },
      onCompaction(taskText, event) {
        managed.lastActivity = Date.now();
        // Only send for significant compactions to avoid noise
        if (defaults.progress_events !== false && event.droppedMessages >= 5) {
          channel.send(formatCompactionEvent(taskText, event)).catch(() => { });
        }
      },
      onVerification(taskText, verification) {
        managed.lastActivity = Date.now();
        // Only send for failures — successes are already reported in onTaskEnd
        if (defaults.progress_events !== false && !verification.passed) {
          channel.send(formatVerificationDetail(taskText, verification)).catch(() => { });
        }
      },
    };

    let pendingCount = 0;
    try {
      const tf = await parseTaskFile(filePath);
      pendingCount = tf.pending.length;
    } catch { }

    await sendUserVisible(
      msg,
      `🤖 Anton started on ${filePart} (${pendingCount} tasks pending)`
    ).catch(() => { });

    runAnton({
      config: runConfig,
      idlehandsConfig: managed.config,
      progress,
      abortSignal,
      vault: managed.session.vault,
      lens: managed.session.lens,
    }).catch((err: Error) => {
      managed.lastActivity = Date.now();
      managed.antonActive = false;
      managed.antonAbortSignal = null;
      managed.antonProgress = null;
      channel.send(`Anton error: ${err.message}`).catch(() => { });
    });
  }

  const shutdown = async () => {
    clearInterval(cleanupTimer);
    for (const key of sessions.keys()) destroySession(key);
    await client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  await client.login(token);
}
