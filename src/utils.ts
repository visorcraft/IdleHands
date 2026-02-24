/**
 * Shared utility functions.
 *
 * Avoids duplicate implementations scattered across modules.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Package version read once at startup. Falls back to '0.0.0'. */
export const PKG_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

/** Resolved absolute path to bash — avoids ENOENT under restricted environments. */
export const BASH_PATH: string = (() => {
  const isWin = os.platform() === 'win32';
  try {
    const selector = isWin ? 'where' : 'which';
    const r = spawnSync(selector, ['bash'], { encoding: 'utf8', timeout: 1000 });
    const p = r.stdout?.split(/\r?\n/)[0]?.trim();
    if (p && (isWin || p.startsWith('/'))) return p;

    if (isWin) {
      // Common Git Bash locations if not in PATH
      const common = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        path.join(os.homedir(), 'AppData\\Local\\Programs\\Git\\bin\\bash.exe'),
      ];
      for (const c of common) {
        if (existsSync(c)) return c;
      }
    }
  } catch {
    /* fallback */
  }
  return isWin ? 'bash' : '/usr/bin/bash';
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
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, 'idlehands');
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'idlehands');
}

/**
 * XDG-compatible config directory.
 * `~/.config/idlehands`
 * Can be overridden with IDLEHANDS_CONFIG_DIR environment variable.
 */
export function configDir(): string {
  if (process.env.IDLEHANDS_CONFIG_DIR) return process.env.IDLEHANDS_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'idlehands');
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : path.join(os.homedir(), '.config');
  return path.join(base, 'idlehands');
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
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 3000
): Promise<Response> {
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
