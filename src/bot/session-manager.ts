/**
 * Per-chat session lifecycle for the Telegram bot.
 * Manages creation, destruction, timeout, limits, queueing, and turn-level cancellation safety.
 */

import { createSession, type AgentSession } from '../agent.js';
import type { IdlehandsConfig, BotTelegramConfig, ConfirmationProvider } from '../types.js';
import type { AntonRunResult, AntonProgress } from '../anton/types.js';

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
};

export class SessionManager {
  private sessions = new Map<number, ManagedSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private baseConfig: IdlehandsConfig,
    private botConfig: BotTelegramConfig,
    private makeConfirmProvider?: (chatId: number, userId: number) => ConfirmationProvider | undefined,
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

    const workingDir = this.botConfig.default_dir || this.baseConfig.dir || process.cwd();
    const approvalMode = (this.botConfig.approval_mode as any) || this.baseConfig.approval_mode || 'auto-edit';
    const config: IdlehandsConfig = {
      ...this.baseConfig,
      dir: workingDir,
      approval_mode: approvalMode,
      no_confirm: approvalMode === 'yolo',
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
    };

    this.sessions.set(chatId, managed);
    return managed;
  }

  beginTurn(chatId: number): { managed: ManagedSession; turnId: number; controller: AbortController } | null {
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
    if (!managed.inFlight) return { ok: false, message: 'Nothing running right now.' };

    managed.state = 'canceling';
    managed.pendingQueue = [];
    try { managed.activeAbortController?.abort(); } catch {}
    try { managed.session.cancel(); } catch {}
    managed.lastActivity = Date.now();

    return { ok: true, message: '⏹ Cancel requested. Stopping current turn...' };
  }

  resetSession(chatId: number): { ok: boolean; message: string } {
    const managed = this.sessions.get(chatId);
    if (!managed) return { ok: false, message: 'No active session.' };

    managed.state = 'resetting';
    managed.pendingQueue = [];
    try { managed.activeAbortController?.abort(); } catch {}
    try { managed.session.cancel(); } catch {}

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
    try { managed.activeAbortController?.abort(); } catch {}
    try { managed.session.cancel(); } catch {}
    this.sessions.delete(chatId);
    return true;
  }

  /** Change the working directory for a session. */
  async setDir(chatId: number, dir: string): Promise<boolean> {
    const managed = this.sessions.get(chatId);
    if (!managed) return false;

    // Validate against allowed_dirs
    const allowedDirs = this.botConfig.allowed_dirs ?? ['~'];
    const homeDir = process.env.HOME || '/home';
    const resolvedDir = dir.replace(/^~/, homeDir);
    const allowed = allowedDirs.some((d) => {
      const resolved = d.replace(/^~/, homeDir);
      return resolvedDir.startsWith(resolved);
    });
    if (!allowed) return false;

    // Destroy and recreate with new dir
    this.destroy(chatId);
    const config: IdlehandsConfig = {
      ...managed.config,
      dir: resolvedDir,
      no_confirm: managed.approvalMode === 'yolo',
      approval_mode: managed.approvalMode as any,
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
    });
    return true;
  }

  /** Clean up sessions that have exceeded the inactivity timeout. Returns chat IDs of expired sessions. */
  cleanupExpired(): number[] {
    const now = Date.now();
    const expired: number[] = [];
    for (const [chatId, managed] of this.sessions) {
      if (now - managed.lastActivity > this.sessionTimeoutMs && !managed.inFlight) {
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
  list(): Array<{ chatId: number; inFlight: boolean; workingDir: string; age: number; state: SessionState }> {
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
