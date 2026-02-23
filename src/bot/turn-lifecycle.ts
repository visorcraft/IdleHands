/**
 * Shared turn lifecycle primitives for Discord and Telegram bot surfaces.
 *
 * Both surfaces manage per-session turn state identically; the only difference
 * is how they look up the managed object (Discord by key, Telegram by chatId).
 * These pure functions operate directly on a managed state object that both
 * surfaces' ManagedSession types satisfy.
 */

export interface ManagedTurnState {
  inFlight: boolean;
  state: string; // 'idle' | 'running' | 'canceling' | 'resetting'
  activeTurnId: number;
  activeAbortController: AbortController | null;
  lastProgressAt: number;
  lastActivity: number;
  watchdogCompactAttempts: number;
  pendingQueue: any[];
  session: { cancel(): void };
}

export function beginTurn(
  managed: ManagedTurnState
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

export function isTurnActive(managed: ManagedTurnState, turnId: number): boolean {
  return managed.inFlight && managed.activeTurnId === turnId && managed.state !== 'resetting';
}

export function markProgress(managed: ManagedTurnState, turnId: number): void {
  if (managed.activeTurnId !== turnId) return;
  managed.lastProgressAt = Date.now();
  managed.lastActivity = Date.now();
}

export function finishTurn(managed: ManagedTurnState, turnId: number): void {
  if (managed.activeTurnId !== turnId) return;
  managed.inFlight = false;
  managed.state = 'idle';
  managed.activeAbortController = null;
  managed.lastActivity = Date.now();
}

export function cancelActive(managed: ManagedTurnState): { ok: boolean; message: string } {
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
