/**
 * Session state persistence: paths, save/load, REPL history, prompt templates.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stateDir, configDir } from '../utils.js';

const HISTORY_MAX_LINES = 10_000;

// ── Session paths ────────────────────────────────────────────────────

function sessionStateDir(): string {
  return stateDir();
}

export function lastSessionPath(): string {
  return path.join(sessionStateDir(), 'last-session.json');
}

export function namedSessionPath(name: string): string {
  return path.join(sessionStateDir(), 'sessions', `${name}.json`);
}

export function projectSessionPath(cwd: string): string {
  const key = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(sessionStateDir(), 'projects', `${key}.json`);
}

function conversationBranchesDir(): string {
  return path.join(sessionStateDir(), 'conversation-branches');
}

export function conversationBranchPath(name: string): string {
  return path.join(conversationBranchesDir(), `${name}.json`);
}

export function isSafeBranchName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

// ── Save/load ────────────────────────────────────────────────────────

export async function saveSessionFile(filePath: string, payload: any): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

export async function listSavedSessions(): Promise<Array<{ name: string; path: string; ts: number }>> {
  const dir = path.join(sessionStateDir(), 'sessions');
  const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as any[]);
  const out: Array<{ name: string; path: string; ts: number }> = [];
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const p = path.join(dir, e.name);
    const st = await fs.stat(p).catch(() => null as any);
    if (!st) continue;
    out.push({ name: e.name.replace(/\.json$/, ''), path: p, ts: st.mtimeMs });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export async function listConversationBranches(): Promise<Array<{ name: string; path: string; ts: number }>> {
  const dir = conversationBranchesDir();
  const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as any[]);
  const out: Array<{ name: string; path: string; ts: number }> = [];
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const p = path.join(dir, e.name);
    const st = await fs.stat(p).catch(() => null as any);
    if (!st) continue;
    out.push({ name: e.name.replace(/\.json$/, ''), path: p, ts: st.mtimeMs });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

// ── Prompt templates ─────────────────────────────────────────────────

export async function loadPromptTemplates(): Promise<Record<string, string>> {
  const builtins: Record<string, string> = {
    '/fix': 'Find and fix bugs in the code I\'m about to describe:',
    '/review': 'Review the following code for issues, style, and correctness:',
    '/test': 'Write tests for:',
    '/explain': 'Explain this code in detail:',
    '/refactor': 'Refactor this code to improve readability and maintainability:',
  };

  const userPath = path.join(configDir(), 'templates.json');
  try {
    const raw = await fs.readFile(userPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (!k.startsWith('/')) continue;
        if (typeof v !== 'string' || !v.trim()) continue;
        builtins[k] = v;
      }
    }
  } catch {
    // ignore missing/invalid custom template file
  }

  return builtins;
}

// ── REPL history ─────────────────────────────────────────────────────

function historyFilePath(): string {
  return path.join(stateDir(), 'history');
}

export async function loadHistory(): Promise<string[]> {
  const p = historyFilePath();
  const raw = await fs.readFile(p, 'utf8').catch(() => '');
  if (!raw) return [];
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(-HISTORY_MAX_LINES);
}

export async function rotateHistoryIfNeeded(): Promise<void> {
  const p = historyFilePath();
  const raw = await fs.readFile(p, 'utf8').catch(() => '');
  if (!raw) return;
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length <= HISTORY_MAX_LINES) return;
  const kept = lines.slice(-HISTORY_MAX_LINES);
  await fs.writeFile(p, kept.join('\n') + '\n', 'utf8');
}

export async function appendHistoryLine(line: string): Promise<void> {
  const value = line.trim();
  if (!value) return;
  const p = historyFilePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, value + '\n', 'utf8');
  // Rotate occasionally (append-only until trim threshold reached).
  const st = await fs.stat(p).catch(() => null as any);
  if (st && st.size > 1024 * 1024) {
    await rotateHistoryIfNeeded();
  }
}
