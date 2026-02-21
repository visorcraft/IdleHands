/**
 * Shared utility functions.
 *
 * Avoids duplicate implementations scattered across modules.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

/** Package version read once at startup. Falls back to '0.0.0'. */
export const PKG_VERSION: string = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { return '0.0.0'; }
})();

/** Resolved absolute path to bash — avoids ENOENT under restricted environments. */
export const BASH_PATH: string = (() => {
  try {
    const r = spawnSync('which', ['bash'], { encoding: 'utf8', timeout: 1000 });
    const p = r.stdout?.trim();
    if (p && p.startsWith('/')) return p;
  } catch { /* fallback */ }
  return '/usr/bin/bash';
})();

/**
 * Escape special regex metacharacters in a string so it can be used as a
 * literal match inside a `new RegExp(...)` expression.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rough token estimate: ceil(charCount / 4).
 * Good enough for budget math — not a real tokenizer.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * XDG-compatible state directory for persistent app data.
 * `~/.local/state/idlehands`
 */
export function stateDir(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'idlehands');
}

/**
 * XDG-compatible config directory.
 * `~/.config/idlehands`
 */
export function configDir(): string {
  return path.join(os.homedir(), '.config', 'idlehands');
}

/**
 * Resolve the project working directory.
 * Uses `config.dir` when explicitly set, otherwise `process.cwd()`.
 */
export function projectDir(config: { dir?: string }): string {
  return config.dir || process.cwd();
}

/**
 * Escape a string for safe single-quoted shell passthrough.
 * Wraps in single quotes, handles embedded single quotes.
 */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Fetch with timeout using AbortController.
 * Throws on network errors/timeouts (caller decides fallback behavior).
 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 3000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate a short random hex ID.
 * @param bytes - Number of random bytes (default 6 = 12 hex chars)
 */
export function randomId(bytes = 6): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Generate a timestamped random ID: `<ts>_<random>`
 * Useful for session IDs, request IDs, etc.
 */
export function timestampedId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString('hex');
  return `${ts}-${rand}`;
}
