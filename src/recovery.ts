/**
 * Mid-session crash recovery (§6e)
 *
 * - Autosave: periodically writes session state (messages, turn count, metadata)
 *   to ~/.local/state/idlehands/autosave.json every N turns or M seconds.
 * - Lockfile: written on session start, removed on clean exit.
 *   If lockfile exists at startup → previous session crashed → offer recovery.
 * - Restore: loads the autosave and resumes from last checkpoint.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage } from './types.js';
import { stateDir } from './utils.js';

const STATE_DIR = stateDir();
const AUTOSAVE_PATH = path.join(STATE_DIR, 'autosave.json');
const LOCKFILE_PATH = path.join(STATE_DIR, 'session.lock');

export type AutosaveData = {
  messages: ChatMessage[];
  model: string;
  harness: string;
  cwd: string;
  turns: number;
  toolCalls: number;
  savedAt: string;       // ISO timestamp
  pid: number;
};

/** Ensure state directory exists */
async function ensureStateDir(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

// ─── Lockfile ──────────────────────────────────────────────

/**
 * Write a lockfile with the current PID.
 * Returns true if created, false if one already existed (dirty shutdown detected).
 */
export async function acquireLock(): Promise<{ acquired: boolean; stalePid?: number }> {
  await ensureStateDir();
  try {
    // O_EXCL: fail if file exists
    const fd = await fs.open(LOCKFILE_PATH, 'wx');
    await fd.write(`${process.pid}\n`);
    await fd.close();
    return { acquired: true };
  } catch (e: any) {
    if (e?.code === 'EEXIST') {
      // Lockfile already exists — dirty shutdown
      let stalePid: number | undefined;
      try {
        const raw = await fs.readFile(LOCKFILE_PATH, 'utf8');
        stalePid = parseInt(raw.trim(), 10) || undefined;
      } catch {
        // ignore
      }
      return { acquired: false, stalePid };
    }
    throw e;
  }
}

/** Release the lockfile. Best-effort — never throws. */
export async function releaseLock(): Promise<void> {
  try {
    await fs.rm(LOCKFILE_PATH, { force: true });
  } catch {
    // ignore
  }
}

/**
 * Force-acquire the lock (after user confirms recovery or dismisses).
 * Overwrites the stale lockfile with current PID.
 */
export async function forceAcquireLock(): Promise<void> {
  await ensureStateDir();
  await fs.writeFile(LOCKFILE_PATH, `${process.pid}\n`, 'utf8');
}

/** Check whether the PID in the lockfile is still running */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

// ─── Autosave ──────────────────────────────────────────────

/** Save session state to autosave.json (atomic write) */
export async function writeAutosave(data: AutosaveData): Promise<void> {
  await ensureStateDir();
  const tmp = AUTOSAVE_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, AUTOSAVE_PATH);
}

/** Read the autosave if it exists. Returns null if missing/corrupt. */
export async function readAutosave(): Promise<AutosaveData | null> {
  try {
    const raw = await fs.readFile(AUTOSAVE_PATH, 'utf8');
    const data = JSON.parse(raw) as AutosaveData;
    // Basic validation
    if (!data.messages || !Array.isArray(data.messages) || data.messages.length < 2) return null;
    if (data.messages[0].role !== 'system') return null;
    return data;
  } catch {
    return null;
  }
}

/** Remove the autosave file (on clean session end). */
export async function clearAutosave(): Promise<void> {
  try {
    await fs.rm(AUTOSAVE_PATH, { force: true });
  } catch {
    // ignore
  }
}

/**
 * Format a human-readable recovery prompt.
 */
export function formatRecoveryPrompt(data: AutosaveData): string {
  const savedAt = new Date(data.savedAt);
  const agoMs = Date.now() - savedAt.getTime();
  const agoMin = Math.floor(agoMs / 60_000);
  const agoStr = agoMin < 1 ? 'just now' : agoMin === 1 ? '1 min ago' : `${agoMin} min ago`;

  return `Recovered session from crash (${data.turns} turns, ${data.toolCalls} tool calls, ${agoStr}). Resume? [Y/n]`;
}

// ─── Autosave Timer ────────────────────────────────────────

export type AutosaveController = {
  /** Call after each turn to check if we should autosave */
  tick: (messages: ChatMessage[], meta: { model: string; harness: string; cwd: string; turns: number; toolCalls: number }) => void;
  /** Force an immediate save */
  flush: (messages: ChatMessage[], meta: { model: string; harness: string; cwd: string; turns: number; toolCalls: number }) => Promise<void>;
  /** Stop the timer */
  stop: () => void;
};

/**
 * Create an autosave controller that saves every `turnInterval` turns
 * or every `intervalMs` milliseconds, whichever comes first.
 */
export function createAutosaveController(opts?: {
  turnInterval?: number;   // default 5
  intervalMs?: number;      // default 60_000
}): AutosaveController {
  const turnInterval = opts?.turnInterval ?? 5;
  const intervalMs = opts?.intervalMs ?? 60_000;

  let lastSaveTurn = 0;
  let pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let latestState: { messages: ChatMessage[]; meta: { model: string; harness: string; cwd: string; turns: number; toolCalls: number } } | null = null;

  const doSave = async (messages: ChatMessage[], meta: { model: string; harness: string; cwd: string; turns: number; toolCalls: number }) => {
    const data: AutosaveData = {
      messages,
      model: meta.model,
      harness: meta.harness,
      cwd: meta.cwd,
      turns: meta.turns,
      toolCalls: meta.toolCalls,
      savedAt: new Date().toISOString(),
      pid: process.pid
    };
    await writeAutosave(data);
    lastSaveTurn = meta.turns;
  };

  // Periodic timer: save latest state every intervalMs
  timer = setInterval(() => {
    if (!latestState) return;
    const { messages, meta } = latestState;
    if (pending) return; // already saving
    pending = doSave(messages, meta).catch(() => {}).finally(() => { pending = null; });
  }, intervalMs);

  // Don't keep the process alive just for autosave
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }

  const tick = (messages: ChatMessage[], meta: { model: string; harness: string; cwd: string; turns: number; toolCalls: number }) => {
    latestState = { messages: [...messages], meta };

    // Save every N turns
    if (meta.turns - lastSaveTurn >= turnInterval) {
      if (!pending) {
        pending = doSave([...messages], meta).catch(() => {}).finally(() => { pending = null; });
      }
    }
  };

  const flush = async (messages: ChatMessage[], meta: { model: string; harness: string; cwd: string; turns: number; toolCalls: number }) => {
    await doSave([...messages], meta);
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { tick, flush, stop };
}
