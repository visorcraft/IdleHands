/**
 * CLI argument parsing, boolean/numeric coercions, and help text.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { McpServerConfig } from '../types.js';

/** Convert raw errors into user-friendly messages (no stack traces). */
export function friendlyError(e: any): string {
  const msg = e?.message ?? String(e);
  if (msg.includes('max iterations exceeded')) {
    return `Stopped: ${msg}. The task needed more steps than allowed. Try --max-iterations <N> to increase the limit.`;
  }
  if (msg.includes('Connection timeout') || msg.includes('ECONNREFUSED')) {
    return `Connection failed: ${msg}. Is your LLM server running?`;
  }
  if (msg.includes('model loading') || msg.includes('503')) {
    return `Model is loading — try again in a few seconds. (${msg})`;
  }
  if (msg.includes('AbortError') || msg.includes('aborted')) {
    return 'Aborted.';
  }
  return msg;
}

// Flags that are always boolean (never consume the next positional arg as their value)
const BOOLEAN_FLAGS = new Set([
  'help',
  'h',
  'verbose',
  'quiet',
  'dry-run',
  'dry_run',
  'no-confirm',
  'no_confirm',
  'yolo',
  'non-interactive',
  'non_interactive',
  'one-shot',
  'one_shot',
  'all',
  'no-context',
  'no_context',
  'no-trifecta',
  'no-vault',
  'no-lens',
  'no-replay',
  'no-sub-agents',
  'i-know-what-im-doing',
  'i_know_what_im_doing',
  'version',
  'v',
  'upgrade',
  'rollback',
  'lockdown',
  'sys',
  'offline',
  'no-update-check',
  'init',
  'plan',
  'step',
  'continue',
  'fresh',
  'fail-on-error',
  'diff-only',
  'vim',
  'show-server-metrics',
  'no-server-metrics',
  'auto-detect-model-change',
  'tui',
  'no-tui',
]);

const OPTIONAL_VALUE_FLAGS = new Set(['resume']);

const SHORT_ALIASES: Record<string, string> = {
  h: 'help',
  v: 'version',
  p: 'prompt',
};

export function parseArgs(argv: string[]) {
  const out: any = { _: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) {
      out._.push(a);
      continue;
    }
    // Handle single-dash short flags like -v, -h, -p
    if (a.length === 2 && a.startsWith('-')) {
      const short = a.slice(1);
      const mapped = SHORT_ALIASES[short] ?? short;

      if (BOOLEAN_FLAGS.has(mapped) || BOOLEAN_FLAGS.has(short)) {
        out[mapped] = true;
        continue;
      }

      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        out[mapped] = next;
        i++;
      } else {
        out[mapped] = true;
      }
      continue;
    }
    const [k, v] = a.includes('=') ? a.split('=', 2) : [a, undefined];
    const key = k.replace(/^--/, '');
    if (v !== undefined) {
      out[key] = v;
    } else if (BOOLEAN_FLAGS.has(key)) {
      out[key] = true;
    } else if (OPTIONAL_VALUE_FLAGS.has(key)) {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

export function asNum(v: any): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function asBool(v: any): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === true) return true;
  if (v === false) return false;
  if (typeof v === 'string') {
    if (['1', 'true', 'yes', 'on'].includes(v.toLowerCase())) return true;
    if (['0', 'false', 'no', 'off'].includes(v.toLowerCase())) return false;
  }
  return undefined;
}

export async function loadMcpServerConfigFile(configPath: string): Promise<McpServerConfig[]> {
  const abs = path.resolve(configPath);
  const raw = await fs.readFile(abs, 'utf8');
  const parsed = JSON.parse(raw);

  const asServers = (): any[] => {
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.servers)) return parsed.servers;
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
  };

  const out: McpServerConfig[] = [];
  for (const item of asServers()) {
    if (!item || typeof item !== 'object') continue;
    const name = String((item as any).name ?? '').trim();
    const transport = String((item as any).transport ?? '').trim();
    if (!name || (transport !== 'stdio' && transport !== 'http')) continue;

    out.push({
      name,
      transport: transport as 'stdio' | 'http',
      command: (item as any).command == null ? undefined : String((item as any).command),
      args: Array.isArray((item as any).args)
        ? (item as any).args.map((a: any) => String(a))
        : undefined,
      env:
        (item as any).env && typeof (item as any).env === 'object'
          ? ((item as any).env as Record<string, string>)
          : undefined,
      url: (item as any).url == null ? undefined : String((item as any).url),
      enabled: typeof (item as any).enabled === 'boolean' ? (item as any).enabled : undefined,
      enabled_tools: Array.isArray((item as any).enabled_tools)
        ? (item as any).enabled_tools.map((v: any) => String(v))
        : undefined,
    });
  }

  if (!out.length) {
    throw new Error(`No valid MCP servers found in ${abs}`);
  }

  return out;
}

export type OneShotOutputEvent =
  | { type: 'system'; model: string; harness: string; context_window: number }
  | { type: 'assistant_delta'; content: string }
  | { type: 'assistant'; content: string; thinking?: string }
  | {
      type: 'tool_call';
      name: string;
      args: Record<string, unknown>;
      result?: string;
      success?: boolean;
      summary?: string;
    }
  | { type: 'diff'; content: string }
  | {
      type: 'result';
      ok: boolean;
      turns?: number;
      tool_calls?: number;
      duration_ms: number;
      error?: string;
      partial?: boolean;
    };

export function normalizeOutputFormat(value: unknown): 'text' | 'json' | 'stream-json' {
  const v = String(value ?? 'text').toLowerCase();
  if (v === 'json' || v === 'stream-json' || v === 'text') return v;
  return 'text';
}

export function printHelp(): void {
  console.log(`Usage: idlehands [options] [instruction]
       idlehands <command>

Commands:
  setup                      Interactive first-run configuration wizard
  bot <telegram|discord>     Start a chat bot frontend
  hosts|backends|models      Runtime orchestration management
  select --model <id>        Switch active runtime model (use --restart --wait-ready)
  health                     Probe configured + discovered runtime servers
  init                       Generate .idlehands.md from current project
  upgrade                    Self-update from GitHub or npm
  rollback                   Restore previous version from backup
  service [action]           Manage bot background service (status|start|stop|restart|logs|install|uninstall)

Options:
  --run-as USER         Run as a different Linux user (re-execs via sudo)
  --endpoint URL
  --model NAME
  --dir PATH
  --max-tokens N
  --context-window N         (context window; default from model config or 131072)
  --i-know-what-im-doing     (allow large context window without warning)
  --temperature F
  --top-p F
  --timeout N
  --response-timeout N       (seconds to wait for model responses; default 600)
  --connection-timeout N     (seconds to wait for initial HTTP connection/headers; default follows response-timeout)
  --initial-connection-check [true|false]  (run fast probe before first ask; default true)
  --initial-connection-timeout N           (seconds for first probe timeout; default 10)
  --max-iterations N
  --sys                      (start in sys mode)
  --sys-eager                (inject system snapshot into first message)
  --no-confirm               (alias: --yolo)
  --non-interactive          (reject unconfirmed operations instead of prompting)
  --plan                     (start in plan approval mode)
  --step                     (confirm each tool call step-by-step)
  --lockdown                 (promote all cautious commands to forbidden — max safety)
  --harness ID               (override harness selection)
  --context-file PATH        (inject file contents into initial session context)
  --no-context               (skip project context file loading)
  --context-max-tokens N     (max tokens for injected context, default 8192)
  --compact-at F             (auto-compact threshold, 0.5-0.95, default 0.8)
  --fresh                    (skip session resume and start clean)
  --session NAME             (save/load named session state)
  --prompt, -p TEXT          (one-shot prompt text; aliases positional instruction)
  --output-format text|json|stream-json  (default: text)
  --fail-on-error            (exit non-zero when task fails; default true)
  --diff-only                (emit unified git diff and restore clean tree; requires clean repo)
  --one-shot                 (single instruction then exit, same as passing instruction as args)
  --replay PATH              (replay a capture JSONL file against the current endpoint)
  --continue                 (resume last session for current directory)
  --resume [NAME]            (auto-resume previous session; optional named session)
  --no-trifecta             (disable replay/vault/lens subsystems)
  --no-replay               (disable replay checkpoints)
  --no-vault                (disable vault subsystem)
  --no-lens                 (disable lens subsystem)
  --no-sub-agents           (disable spawn_task; single-agent execution only)
  --vault-mode active|passive|off  (vault behavior when enabled)
  --theme NAME               (color theme: default, dark, light, minimal, hacker)
  --vim                      (start with vi-mode editing)
  --no-tui                   (force classic CLI instead of fullscreen TUI)
  --color auto|always|never
  --restart                (for /select: force restart instead of reuse)
  --wait-ready             (for /select: wait until /v1/models is ready)
  --wait-timeout N         (seconds for --wait-ready)
  --scan-ports RANGE       (for health: discovery range, e.g. 8080-8100)
  --json                   (machine-readable output for select/health/status)
  --dry-run
  --quiet
  --verbose
  --config PATH              (default: ~/.config/idlehands/config.json)
  --offline                  (skip network-dependent checks like auto-update)
  --no-update-check          (disable startup update checks)
  --show-server-metrics      (print per-turn server/perf metrics)
  --no-server-metrics        (disable per-turn server/perf metrics)
  --slow-tg-tps-threshold N  (warn if generation speed drops below N t/s; default 10)
  --auto-detect-model-change (poll /v1/models every 30s and auto-switch harness on change)
  --mcp PATH                 (append ad-hoc MCP server config file for this session)
  --mcp-tool-budget N        (max MCP tool schema token budget; default 1000)
  --mcp-call-timeout-sec N   (timeout per MCP tool call; default 30)
  --help, -h
  --version, -v
`);
}
