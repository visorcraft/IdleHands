/**
 * Per-chat session lifecycle for the Telegram bot.
 * Manages creation, destruction, timeout, limits, queueing, and turn-level cancellation safety.
 */

import path from 'node:path';

import { createSession, type AgentSession } from '../agent.js';
import type { AntonRunResult, AntonProgress } from '../anton/types.js';
import type {
  IdlehandsConfig,
  BotTelegramConfig,
  ConfirmationProvider,
  AgentPersona,
} from '../types.js';

import {
  detectRepoCandidates,
  expandHome,
  isPathAllowed,
  normalizeAllowedDirs,
} from './dir-guard.js';

function pathResolveHome(input: string): string {
  return path.resolve(expandHome(input));
}

export type SessionState = 'idle' | 'running' | 'canceling' | 'resetting';

export type ManagedSession = {
  session: AgentSession;
  config: IdlehandsConfig;
  confirmProvider?: ConfirmationProvider;
  chatId: number;
  userId: number;
  createdAt: number;
  lastActivity: number;
  workingDir: string;
  allowedDirs: string[];
  dirPinned: boolean;
  repoCandidates: string[];
  approvalMode: string;
  inFlight: boolean;
  pendingQueue: string[];
  state: SessionState;
  activeTurnId: number;
  activeAbortController: AbortController | null;
  lastProgressAt: number;
  antonActive: boolean;
  antonAbortSignal: { aborted: boolean } | null;
  antonLastResult: AntonRunResult | null;
  antonProgress: AntonProgress | null;
  // Multi-agent routing
  agentId: string;
  agentPersona: AgentPersona | null;
  // Escalation tracking
  currentModelIndex: number; // 0 = base model, 1+ = escalated
  escalationCount: number; // how many times escalated this turn
  pendingEscalation: string | null; // model to escalate to on next message
  pendingEscalationEndpoint: string | null; // endpoint override for pending escalation
  // Watchdog compaction recovery
  watchdogCompactAttempts: number; // how many times watchdog has compacted this turn
};

export class SessionManager {
  private sessions = new Map<number, ManagedSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private baseConfig: IdlehandsConfig,
    private botConfig: BotTelegramConfig,
    private makeConfirmProvider?: (
      chatId: number,
      userId: number
    ) => ConfirmationProvider | undefined
  ) {}

  get maxSessions(): number {
    return this.botConfig.max_sessions ?? 5;
  }

  get maxQueue(): number {
    return this.botConfig.max_queue ?? 3;
  }

  get sessionTimeoutMs(): number {
    return (this.botConfig.session_timeout_min ?? 30) * 60_000;
  }

  /** Start the cleanup loop. */
  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
  }

  /** Stop the cleanup loop and destroy all sessions. */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [chatId] of this.sessions) {
      this.destroy(chatId);
    }
  }

  /** Get an existing session for a chat. */
  get(chatId: number): ManagedSession | undefined {
    return this.sessions.get(chatId);
  }

  /** Check if a session exists for a chat. */
  has(chatId: number): boolean {
    return this.sessions.has(chatId);
  }

  /**
   * Resolve which agent persona should handle a message.
   * Priority: user > chat > default > first agent > null
   */
  resolveAgent(chatId: number, userId: number): { agentId: string; persona: AgentPersona | null } {
    const agents = this.botConfig.agents;
    const routing = this.botConfig.routing;
    const agentMap = agents ?? {};
    const agentIds = Object.keys(agentMap);

    // No agents configured — return null persona (use global config)
    if (agentIds.length === 0) {
      return { agentId: '_default', persona: null };
    }

    const route = routing ?? {};
    let resolvedId: string | undefined;

    // Priority 1: User-specific routing
    if (route.users && route.users[String(userId)]) {
      resolvedId = route.users[String(userId)];
    }
    // Priority 2: Chat-specific routing
    else if (route.chats && route.chats[String(chatId)]) {
      resolvedId = route.chats[String(chatId)];
    }
    // Priority 3: Default agent
    else if (route.default) {
      resolvedId = route.default;
    }
    // Priority 4: First defined agent
    else {
      resolvedId = agentIds[0];
    }

    // Validate the resolved agent exists
    const persona = agentMap[resolvedId];
    if (!persona) {
      // Fallback to first agent if routing points to non-existent agent
      const fallbackId = agentIds[0];
      return { agentId: fallbackId, persona: agentMap[fallbackId] ?? null };
    }

    return { agentId: resolvedId, persona };
  }

  /** Get or create a session for a chat. Returns null if at max capacity. */
  async getOrCreate(chatId: number, userId: number): Promise<ManagedSession | null> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      existing.lastActivity = Date.now();
      return existing;
    }

    if (this.sessions.size >= this.maxSessions) {
      return null;
    }

    // Resolve which agent should handle this chat
    const { agentId, persona } = this.resolveAgent(chatId, userId);

    const rawAllowedDirs = persona?.allowed_dirs ?? this.botConfig.allowed_dirs;
    const allowedDirs = normalizeAllowedDirs(rawAllowedDirs);
    const workingDir = pathResolveHome(
      persona?.default_dir ||
        persona?.allowed_dirs?.[0] ||
        this.botConfig.default_dir ||
        this.baseConfig.dir ||
        process.cwd()
    );
    const approvalMode =
      persona?.approval_mode ||
      (this.botConfig.approval_mode as any) ||
      this.baseConfig.approval_mode ||
      'auto-edit';

    const repoCandidates = await detectRepoCandidates(workingDir, allowedDirs).catch(
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

    const config: IdlehandsConfig = {
      ...this.baseConfig,
      dir: workingDir,
      approval_mode: approvalMode,
      no_confirm: approvalMode === 'yolo',
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

    const confirmProvider = this.makeConfirmProvider?.(chatId, userId);
    const session = await createSession({ config, confirmProvider });

    const managed: ManagedSession = {
      session,
      config,
      confirmProvider,
      chatId,
      userId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      workingDir,
      allowedDirs,
      dirPinned,
      repoCandidates,
      approvalMode: config.approval_mode ?? 'auto-edit',
      inFlight: false,
      pendingQueue: [],
      state: 'idle',
      activeTurnId: 0,
      activeAbortController: null,
      lastProgressAt: 0,
      antonActive: false,
      antonAbortSignal: null,
      antonLastResult: null,
      antonProgress: null,
      agentId,
      agentPersona: persona,
      currentModelIndex: 0,
      escalationCount: 0,
      pendingEscalation: null,
      pendingEscalationEndpoint: null,
      watchdogCompactAttempts: 0,
    };

    this.sessions.set(chatId, managed);

    // Log agent assignment for debugging
    if (persona) {
      console.error(
        `[bot:telegram] ${userId} → agent:${agentId} (${persona.display_name || agentId})`
      );
    }

    return managed;
  }

  beginTurn(
    chatId: number
  ): { managed: ManagedSession; turnId: number; controller: AbortController } | null {
    const managed = this.sessions.get(chatId);
    if (!managed) return null;
    if (managed.inFlight || managed.state === 'resetting') return null;

    const controller = new AbortController();
    managed.inFlight = true;
    managed.state = 'running';
    managed.activeTurnId += 1;
    managed.activeAbortController = controller;
    managed.lastProgressAt = Date.now();
    managed.lastActivity = Date.now();
    managed.watchdogCompactAttempts = 0;

    return { managed, turnId: managed.activeTurnId, controller };
  }

  isTurnActive(chatId: number, turnId: number): boolean {
    const managed = this.sessions.get(chatId);
    if (!managed) return false;
    return managed.inFlight && managed.activeTurnId === turnId && managed.state !== 'resetting';
  }

  markProgress(chatId: number, turnId: number): void {
    const managed = this.sessions.get(chatId);
    if (!managed) return;
    if (managed.activeTurnId !== turnId) return;
    managed.lastProgressAt = Date.now();
    managed.lastActivity = Date.now();
  }

  finishTurn(chatId: number, turnId: number): ManagedSession | undefined {
    const managed = this.sessions.get(chatId);
    if (!managed) return undefined;
    if (managed.activeTurnId !== turnId) return managed;

    managed.inFlight = false;
    managed.state = 'idle';
    managed.activeAbortController = null;
    managed.lastActivity = Date.now();
    return managed;
  }

  cancelActive(chatId: number): { ok: boolean; message: string } {
    const managed = this.sessions.get(chatId);
    if (!managed) return { ok: false, message: 'No active session.' };

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
      } catch {}
      try {
        managed.session.cancel();
      } catch {}
    }

    managed.lastActivity = Date.now();

    const parts: string[] = [];
    if (wasRunning) parts.push('stopping current task');
    if (queueSize > 0) parts.push(`cleared ${queueSize} queued task${queueSize > 1 ? 's' : ''}`);

    return { ok: true, message: `⏹ Cancelled: ${parts.join(', ')}.` };
  }

  resetSession(chatId: number): { ok: boolean; message: string } {
    const managed = this.sessions.get(chatId);
    if (!managed) return { ok: false, message: 'No active session.' };

    managed.state = 'resetting';
    managed.pendingQueue = [];
    if (managed.antonAbortSignal) managed.antonAbortSignal.aborted = true;
    managed.antonActive = false;
    managed.antonAbortSignal = null;
    managed.antonProgress = null;
    try {
      managed.activeAbortController?.abort();
    } catch {}
    try {
      managed.session.cancel();
    } catch {}

    this.destroy(chatId);
    return { ok: true, message: '🔄 Session reset. Send a new message to start fresh.' };
  }

  dequeueNext(chatId: number): string | undefined {
    const managed = this.sessions.get(chatId);
    if (!managed) return undefined;
    return managed.pendingQueue.shift();
  }

  /** Destroy a session for a chat. */
  destroy(chatId: number): boolean {
    const managed = this.sessions.get(chatId);
    if (!managed) return false;
    managed.state = 'resetting';
    managed.pendingQueue = [];
    if (managed.antonAbortSignal) managed.antonAbortSignal.aborted = true;
    managed.antonActive = false;
    managed.antonAbortSignal = null;
    managed.antonProgress = null;
    try {
      managed.activeAbortController?.abort();
    } catch {}
    try {
      managed.session.cancel();
    } catch {}
    this.sessions.delete(chatId);
    return true;
  }

  /** Recreate a session with new config (used for escalation). */
  async recreateSession(chatId: number, newConfig: Partial<IdlehandsConfig>): Promise<boolean> {
    const managed = this.sessions.get(chatId);
    if (!managed) return false;

    managed.state = 'resetting';
    managed.pendingQueue = [];
    try {
      managed.activeAbortController?.abort();
    } catch {}

    // Preserve conversation history before destroying the old session
    const oldMessages = managed.session.messages.slice();

    try {
      managed.session.cancel();
    } catch {}

    const config: IdlehandsConfig = {
      ...managed.config,
      ...newConfig,
    };

    const confirmProvider = this.makeConfirmProvider?.(chatId, managed.userId);
    const session = await createSession({ config, confirmProvider });

    // Restore conversation history to the new session
    if (oldMessages.length > 0) {
      try {
        session.restore(oldMessages);
      } catch (e) {
        console.error(
          `[session-manager] Failed to restore ${oldMessages.length} messages after escalation:`,
          e
        );
      }
    }

    managed.session = session;
    managed.config = config;
    managed.confirmProvider = confirmProvider;
    managed.inFlight = false;
    managed.state = 'idle';
    managed.activeAbortController = null;
    managed.lastProgressAt = 0;
    managed.lastActivity = Date.now();

    return true;
  }

  /** Change the working directory for a session. */
  async setDir(chatId: number, dir: string): Promise<boolean> {
    const managed = this.sessions.get(chatId);
    if (!managed) return false;

    const allowedDirs = managed.allowedDirs.length
      ? managed.allowedDirs
      : normalizeAllowedDirs(this.botConfig.allowed_dirs);
    const resolvedDir = pathResolveHome(dir);
    if (!isPathAllowed(resolvedDir, allowedDirs)) return false;

    // User explicitly pinned directory via /dir.
    const repoCandidates = await detectRepoCandidates(resolvedDir, allowedDirs).catch(
      () => managed.repoCandidates
    );

    // Destroy and recreate with new dir
    this.destroy(chatId);
    const config: IdlehandsConfig = {
      ...managed.config,
      dir: resolvedDir,
      no_confirm: managed.approvalMode === 'yolo',
      approval_mode: managed.approvalMode as any,
      allowed_write_roots: allowedDirs,
      require_dir_pin_for_mutations: managed.config.require_dir_pin_for_mutations ?? false,
      dir_pinned: true,
      repo_candidates: repoCandidates,
    };
    const confirmProvider = this.makeConfirmProvider?.(chatId, managed.userId);
    const session = await createSession({ config, confirmProvider });

    this.sessions.set(chatId, {
      session,
      config,
      confirmProvider,
      chatId,
      userId: managed.userId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      workingDir: resolvedDir,
      allowedDirs,
      dirPinned: true,
      repoCandidates,
      approvalMode: managed.approvalMode,
      inFlight: false,
      pendingQueue: [],
      state: 'idle',
      activeTurnId: 0,
      activeAbortController: null,
      lastProgressAt: 0,
      antonActive: false,
      antonAbortSignal: null,
      antonLastResult: null,
      antonProgress: null,
      agentPersona: managed.agentPersona,
      currentModelIndex: managed.currentModelIndex,
      escalationCount: managed.escalationCount,
      pendingEscalation: managed.pendingEscalation,
      pendingEscalationEndpoint: managed.pendingEscalationEndpoint,
      watchdogCompactAttempts: 0,
    });
    return true;
  }

  /** Unpin the current directory for a session. */
  async unpin(chatId: number): Promise<boolean> {
    const managed = this.sessions.get(chatId);
    if (!managed) return false;
    // Re-create session with dir_pinned: false and cleared dir
    this.destroy(chatId);
    const config: IdlehandsConfig = {
      ...managed.config,
      dir: undefined,
      no_confirm: managed.approvalMode === 'yolo',
      approval_mode: managed.approvalMode as any,
      allowed_write_roots: managed.allowedDirs,
      require_dir_pin_for_mutations: managed.config.require_dir_pin_for_mutations ?? false,
      dir_pinned: false,
      repo_candidates: managed.repoCandidates,
    };
    const confirmProvider = this.makeConfirmProvider?.(chatId, managed.userId);
    const session = await createSession({ config, confirmProvider });

    this.sessions.set(chatId, {
      session,
      config,
      confirmProvider,
      chatId,
      userId: managed.userId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      workingDir: managed.workingDir,
      allowedDirs: managed.allowedDirs,
      dirPinned: false,
      repoCandidates: managed.repoCandidates,
      approvalMode: managed.approvalMode,
      inFlight: false,
      pendingQueue: [],
      state: 'idle',
      activeTurnId: 0,
      activeAbortController: null,
      lastProgressAt: 0,
      antonActive: false,
      antonAbortSignal: null,
      antonLastResult: null,
      antonProgress: null,
      // Preserve multi-agent state
      agentId: managed.agentId,
      agentPersona: managed.agentPersona,
      currentModelIndex: managed.currentModelIndex,
      escalationCount: managed.escalationCount,
      pendingEscalation: managed.pendingEscalation,
      pendingEscalationEndpoint: managed.pendingEscalationEndpoint,
      watchdogCompactAttempts: 0,
    });
    return true;
  }

  /** Clean up sessions that have exceeded the inactivity timeout. Returns chat IDs of expired sessions. */
  cleanupExpired(): number[] {
    const now = Date.now();
    const expired: number[] = [];
    for (const [chatId, managed] of this.sessions) {
      if (
        now - managed.lastActivity > this.sessionTimeoutMs &&
        !managed.inFlight &&
        !managed.antonActive
      ) {
        this.destroy(chatId);
        expired.push(chatId);
      }
    }
    return expired;
  }

  /** Get session count. */
  get size(): number {
    return this.sessions.size;
  }

  /** List all active sessions (for debugging). */
  list(): Array<{
    chatId: number;
    inFlight: boolean;
    workingDir: string;
    age: number;
    state: SessionState;
  }> {
    const now = Date.now();
    return [...this.sessions.values()].map((m) => ({
      chatId: m.chatId,
      inFlight: m.inFlight,
      workingDir: m.workingDir,
      age: now - m.createdAt,
      state: m.state,
    }));
  }
}
