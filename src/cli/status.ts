/**
 * Server health queries, perf metrics, cost estimation, status bar,
 * and startup banner rendering.
 */

import { estimateTokensFromMessages } from '../history.js';
import type { makeStyler } from '../term.js';
import { fetchWithTimeout } from '../utils.js';

// ── Server health ────────────────────────────────────────────────────

export type ServerHealthSnapshot = {
  ok: boolean;
  sourceUrl?: string;
  statusCode?: number;
  statusText?: string;
  model?: string;
  contextSize?: number;
  slotCount?: number;
  pendingRequests?: number;
  kvUsed?: number;
  kvTotal?: number;
  ppTps?: number;
  tgTps?: number;
  unsupported?: boolean;
  error?: string;
};

export type PerfTurnSample = {
  ts: number;
  turn: number;
  ttftMs?: number;
  ttcMs?: number;
  promptTokens: number;
  completionTokens: number;
  ppTps?: number;
  tgTps?: number;
};

export function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function pickNumberDeep(input: unknown, keys: string[], depth = 2): number | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const n = asNumber(obj[key]);
      if (n !== undefined) return n;
    }
  }

  if (depth <= 0) return undefined;

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = pickNumberDeep(value, keys, depth - 1);
      if (nested !== undefined) return nested;
    }
  }

  return undefined;
}

function pickStringDeep(input: unknown, keys: string[], depth = 2): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }

  if (depth <= 0) return undefined;

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = pickStringDeep(value, keys, depth - 1);
      if (nested) return nested;
    }
  }

  return undefined;
}

function healthCandidateUrls(endpoint: string): string[] {
  const clean = endpoint.replace(/\/+$/, '');
  const out = new Set<string>();
  out.add(`${clean}/health`);
  if (/\/v1$/i.test(clean)) {
    out.add(`${clean.replace(/\/v1$/i, '')}/health`);
  }
  return [...out].filter(Boolean);
}

/* shared fetchWithTimeout in utils */
export async function queryServerHealth(
  endpoint: string,
  timeoutMs = 2000
): Promise<ServerHealthSnapshot> {
  const candidates = healthCandidateUrls(endpoint);
  let saw404 = false;
  let lastError = '';

  for (const url of candidates) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs);
    } catch (e: any) {
      lastError = String(e?.message ?? e);
      continue;
    }

    if (res.status === 404) {
      saw404 = true;
      continue;
    }

    let payload: unknown = null;
    let statusText = '';
    const ct = (res.headers.get('content-type') || '').toLowerCase();

    try {
      if (ct.includes('application/json')) {
        payload = await res.json();
      } else {
        statusText = (await res.text()).trim();
        if (statusText.startsWith('{') || statusText.startsWith('[')) {
          payload = JSON.parse(statusText);
        }
      }
    } catch {
      // leave payload empty
    }

    if (!res.ok) {
      return {
        ok: false,
        sourceUrl: url,
        statusCode: res.status,
        statusText: statusText || res.statusText,
        error: `GET /health failed: HTTP ${res.status} ${res.statusText}`,
      };
    }

    const model = pickStringDeep(payload, ['model', 'model_name', 'loaded_model', 'current_model']);
    const contextSize = pickNumberDeep(payload, [
      'context_size',
      'context_window',
      'n_ctx',
      'ctx_size',
    ]);
    const slotCount = pickNumberDeep(payload, ['slots_total', 'slot_count', 'slots', 'n_slots']);
    const pendingRequests = pickNumberDeep(payload, [
      'pending_requests',
      'queue',
      'queued_requests',
      'requests_pending',
    ]);
    const kvUsed = pickNumberDeep(payload, [
      'kv_used',
      'kv_cache_used',
      'kv_tokens',
      'cache_tokens',
    ]);
    const kvTotal = pickNumberDeep(payload, [
      'kv_total',
      'kv_cache_total',
      'context_size',
      'context_window',
      'n_ctx',
    ]);
    const ppTps = pickNumberDeep(payload, [
      'pp_tps',
      'prompt_tps',
      'prompt_tokens_per_second',
      'pp_tokens_per_second',
    ]);
    const tgTps = pickNumberDeep(payload, [
      'tg_tps',
      'generation_tps',
      'tokens_per_second',
      'gen_tps',
    ]);

    const statusFromPayload = pickStringDeep(payload, ['status', 'state']) || statusText || 'ok';

    return {
      ok: true,
      sourceUrl: url,
      statusCode: res.status,
      statusText: statusFromPayload,
      model,
      contextSize,
      slotCount,
      pendingRequests,
      kvUsed,
      kvTotal,
      ppTps,
      tgTps,
    };
  }

  if (saw404) {
    return {
      ok: false,
      unsupported: true,
      error: '/health endpoint unavailable on this server',
    };
  }

  return {
    ok: false,
    error: lastError || 'health check failed',
  };
}

// ── Formatting helpers ───────────────────────────────────────────────

export function formatCount(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '?';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

export function formatTps(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '-';
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} t/s`;
}

export function formatKv(used?: number, total?: number): string | undefined {
  if (used === undefined || total === undefined || total <= 0) return undefined;
  const pct = ((used / total) * 100).toFixed(1);
  return `${formatCount(used)}/${formatCount(total)} (${pct}%)`;
}

export function mean(nums: number[]): number | undefined {
  if (!nums.length) return undefined;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function percentile(nums: number[], p: number): number | undefined {
  if (!nums.length) return undefined;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// ── Status line / cost ───────────────────────────────────────────────

export function formatStatusLine(session: any, cfg: any, S: ReturnType<typeof makeStyler>): string {
  const usedReported = (session?.usage?.prompt ?? 0) + (session?.usage?.completion ?? 0);
  const used =
    usedReported > 0 ? usedReported : estimateTokensFromMessages(session?.messages ?? []);
  const ctx = session?.contextWindow ?? 0;
  const pct = ctx > 0 ? ((used / ctx) * 100).toFixed(1) : '?';

  const mode = cfg?.mode ?? 'code';
  const dir = String(cfg?.dir ?? '').trim();
  const model = String(session?.model ?? '').trim();

  const usedK = used >= 1000 ? `${(used / 1000).toFixed(1)}k` : String(used);
  const ctxK = ctx >= 1000 ? `${Math.round(ctx / 1000)}k` : String(ctx);

  return (
    `Model: ${S.cyan(model || 'unknown')}` +
    ` | Ctx: ~${usedK}/${ctxK} (${pct}%)` +
    ` | Mode: ${S.bold(mode)}` +
    (dir ? ` | Dir: ${S.dim(dir)}` : '')
  );
}

type ModelCostProfile = {
  pattern: RegExp;
  promptPerMillionUsd: number;
  completionPerMillionUsd: number;
};

const MODEL_COST_PROFILES: ModelCostProfile[] = [
  { pattern: /gpt-4\.1\b/i, promptPerMillionUsd: 2.0, completionPerMillionUsd: 8.0 },
  { pattern: /gpt-4o\b/i, promptPerMillionUsd: 5.0, completionPerMillionUsd: 15.0 },
  { pattern: /gpt-4o-mini\b/i, promptPerMillionUsd: 0.15, completionPerMillionUsd: 0.6 },
  { pattern: /gpt-4\.1-mini\b/i, promptPerMillionUsd: 0.4, completionPerMillionUsd: 1.6 },
  {
    pattern: /claude-3-5-sonnet|claude-3\.5-sonnet/i,
    promptPerMillionUsd: 3.0,
    completionPerMillionUsd: 15.0,
  },
  {
    pattern: /claude-opus|claude-3-opus/i,
    promptPerMillionUsd: 15.0,
    completionPerMillionUsd: 75.0,
  },
];

function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '::1') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;

  const m = h.match(/^172\.(\d+)\./);
  if (m) {
    const octet = Number(m[1]);
    if (Number.isFinite(octet) && octet >= 16 && octet <= 31) return true;
  }

  return false;
}

export function endpointLooksLocal(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return isPrivateHost(u.hostname);
  } catch {
    return false;
  }
}

export function estimateCostLine(opts: {
  model: string;
  endpoint: string;
  promptTokens: number;
  completionTokens: number;
}): string {
  if (endpointLooksLocal(opts.endpoint)) {
    return 'Cost estimate: $0.0000 (local endpoint)';
  }

  const profile = MODEL_COST_PROFILES.find((p) => p.pattern.test(opts.model));
  if (!profile) {
    return 'Cost estimate: unknown (no pricing profile for this model)';
  }

  const promptCost = (opts.promptTokens / 1_000_000) * profile.promptPerMillionUsd;
  const completionCost = (opts.completionTokens / 1_000_000) * profile.completionPerMillionUsd;
  const total = promptCost + completionCost;

  return `Cost estimate: ~$${total.toFixed(4)} (prompt $${promptCost.toFixed(4)} + completion $${completionCost.toFixed(4)})`;
}

// ── Replay capture ───────────────────────────────────────────────────

export async function replayCaptureFile(filePath: string, cfg: any): Promise<void> {
  const { default: fs } = await import('node:fs/promises');
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error('Capture file is empty.');

  const entries = lines.map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSONL at line ${idx + 1}`);
    }
  });

  const { OpenAIClient } = await import('../client.js');
  const { unifiedDiffFromBuffers } = await import('../replay_cli.js');
  const client = new OpenAIClient(cfg.endpoint, undefined, !!cfg.verbose);

  console.log(
    `Replaying ${entries.length} capture entr${entries.length === 1 ? 'y' : 'ies'} against ${cfg.endpoint}`
  );

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? {};
    const request = entry.request && typeof entry.request === 'object' ? entry.request : {};
    const response = entry.response && typeof entry.response === 'object' ? entry.response : {};

    const model = String(cfg.model || request.model || '').trim();
    if (!model) {
      console.log(`\n#${i + 1}: skipped (no model in capture and no --model override)`);
      continue;
    }

    const rawMessages = Array.isArray(request.messages) ? request.messages : [];
    const messages = rawMessages.filter((m: any) => m?.role !== 'tool');

    const replayed = await client.chat({
      model,
      messages: messages as any,
      tools: Array.isArray(request.tools) ? request.tools : undefined,
      tool_choice: request.tool_choice,
      temperature: typeof request.temperature === 'number' ? request.temperature : undefined,
      top_p: typeof request.top_p === 'number' ? request.top_p : undefined,
      max_tokens: typeof request.max_tokens === 'number' ? request.max_tokens : undefined,
      extra:
        request.cache_prompt !== undefined ? { cache_prompt: request.cache_prompt } : undefined,
    });

    const oldText = String((response as any)?.choices?.[0]?.message?.content ?? '');
    const newText = String((replayed as any)?.choices?.[0]?.message?.content ?? '');

    const oldTools = JSON.stringify((response as any)?.choices?.[0]?.message?.tool_calls ?? []);
    const newTools = JSON.stringify((replayed as any)?.choices?.[0]?.message?.tool_calls ?? []);

    console.log(`\n#${i + 1} model=${model}`);

    if (oldText === newText) {
      console.log('  Text: unchanged');
    } else {
      console.log('  Text: changed');
      const diff = await unifiedDiffFromBuffers(Buffer.from(oldText), Buffer.from(newText));
      const clipped = diff.split(/\r?\n/).slice(0, 80).join('\n');
      console.log(clipped || '[no text diff available]');
      if (diff.split(/\r?\n/).length > 80) console.log('[diff truncated]');
    }

    if (oldTools === newTools) {
      console.log('  Tool calls: unchanged');
    } else {
      console.log('  Tool calls: changed');
      console.log(`  Original: ${oldTools}`);
      console.log(`  Replayed: ${newTools}`);
    }
  }
}

// ── Status bar ───────────────────────────────────────────────────────

export class StatusBar {
  private enabled = false;
  private lastRendered = '';

  constructor(_S?: ReturnType<typeof makeStyler>) {}

  canUse(): boolean {
    return (
      !!process.stdout.isTTY &&
      typeof (process.stdout as any).rows === 'number' &&
      (process.stdout as any).rows >= 10
    );
  }

  setEnabled(on: boolean): void {
    this.enabled = on && this.canUse();
    if (!this.enabled) this.clear();
  }

  clear(): void {
    if (!this.canUse()) return;
    const rows = (process.stdout as any).rows as number;
    process.stdout.write(`\x1b[s\x1b[${rows};1H\x1b[2K\x1b[u`);
    this.lastRendered = '';
  }

  render(text: string): void {
    if (!this.enabled) return;
    if (!this.canUse()) return;
    const rows = (process.stdout as any).rows as number;
    const cols = (process.stdout as any).columns as number | undefined;
    const t = cols && cols > 10 ? truncateToColumns(text, cols) : text;
    if (t === this.lastRendered) return;
    this.lastRendered = t;
    process.stdout.write(`\x1b[s\x1b[${rows};1H\x1b[2K${t}\x1b[u`);
  }
}

function truncateToColumns(s: string, cols: number): string {
  if (s.length <= cols) return s;
  return s.slice(0, Math.max(0, cols - 1)) + '…';
}

function trifectaSummary(cfg: any): string {
  const t = cfg?.trifecta ?? {};
  const enabled = t.enabled !== false;
  if (!enabled) return 'off';
  const replay = t.replay?.enabled !== false ? 'on' : 'off';
  const lens = t.lens?.enabled !== false ? 'on' : 'off';
  const vault = t.vault?.enabled !== false ? (t.vault?.mode ?? 'active') : 'off';
  return `on (replay:${replay} lens:${lens} vault:${vault})`;
}

// ── Startup banner ───────────────────────────────────────────────────

export function renderStartupBanner(
  session: any,
  cfg: any,
  S: ReturnType<typeof makeStyler>,
  opts?: { firstRun?: boolean; lockdown?: boolean; gitSummary?: string }
): void {
  const approvalLabel = opts?.lockdown
    ? `${cfg.approval_mode} [LOCKDOWN]`
    : String(cfg?.approval_mode ?? 'auto-edit');

  const lines = [
    `${S.bold('Idle Hands')}`,
    `Model: ${S.cyan(String(session.model ?? ''))}`,
    `Endpoint: ${String(cfg.endpoint ?? '')}`,
    `Harness: ${S.magenta(String(session.harness ?? ''))}`,
    `Context window: ${String(session.contextWindow ?? '')}`,
    `Dir: ${String(cfg.dir ?? '')}`,
    `Mode: ${String(cfg.mode ?? 'code')} | Approval: ${approvalLabel}`,
    `Trifecta: ${trifectaSummary(cfg)}`,
    ...(opts?.gitSummary ? [`Git: ${opts.gitSummary}`] : []),
  ];

  const visible = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const width = Math.max(...visible.map((l) => l.length));
  const top = `┌${'─'.repeat(width + 2)}┐`;
  const bottom = `└${'─'.repeat(width + 2)}┘`;
  console.log(top);
  for (let i = 0; i < lines.length; i++) {
    const pad = ' '.repeat(Math.max(0, width - visible[i].length));
    console.log(`│ ${lines[i]}${pad} │`);
  }
  console.log(bottom);
  if (opts?.firstRun) {
    console.log(S.dim('First run? Type a coding task, or /help for commands.'));
  }
}
