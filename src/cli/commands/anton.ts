/**
 * /anton command — wire Anton task runner into the REPL.
 *
 * Subcommands:
 *   /anton <file> [flags]   — start a run
 *   /anton run <file> [flags] — same as above
 *   /anton status            — show progress
 *   /anton stop              — abort the running run
 *   /anton last              — show last run summary
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { runAnton } from '../../anton/controller.js';
import { parseTaskFile } from '../../anton/parser.js';
import {
  formatRunSummary,
  formatProgressBar,
  formatTaskStart,
  formatTaskEnd,
  formatTaskSkip,
  formatTaskHeartbeat,
  formatToolLoopEvent,
  formatCompactionEvent,
  formatVerificationDetail,
} from '../../anton/reporter.js';
import type { AntonRunConfig, AntonProgressCallback } from '../../anton/types.js';
import { projectDir } from '../../utils.js';
import type { SlashCommand } from '../command-registry.js';
import { firstToken, restTokens } from '../command-utils.js';
import type { ReplContext } from '../repl-context.js';

// ── Flag parsing ────────────────────────────────────────────────

interface ParsedAntonFlags {
  file: string;
  maxRetries?: number;
  maxIterations?: number;
  taskTimeout?: number;
  totalTimeout?: number;
  maxTokens?: number;
  autoCommit?: boolean;
  branch?: boolean;
  allowDirty?: boolean;
  aggressiveClean?: boolean;
  verifyAi?: boolean;
  verifyModel?: string;
  decompose?: boolean;
  maxDecomposeDepth?: number;
  maxTotalTasks?: number;
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  skipOnFail?: boolean;
  skipOnBlocked?: boolean;
  rollbackOnFail?: boolean;
  scopeGuard?: 'off' | 'lax' | 'strict';
  approval?: string;
  verbose?: boolean;
  dryRun?: boolean;
}

function parseAntonArgs(args: string): ParsedAntonFlags | null {
  const tokens = restTokens(args);
  if (tokens.length === 0) return null;

  // First positional arg that doesn't start with -- is the file
  let file = '';
  const flags: Record<string, string> = {};

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const eqIdx = t.indexOf('=');
      if (eqIdx > 0) {
        flags[t.slice(2, eqIdx)] = t.slice(eqIdx + 1);
      } else {
        // Next token is the value, unless it starts with -- or is last
        const next = tokens[i + 1];
        if (next && !next.startsWith('--')) {
          flags[t.slice(2)] = next;
          i++;
        } else {
          flags[t.slice(2)] = 'true';
        }
      }
    } else if (!file) {
      file = t;
    }
  }

  if (!file) return null;

  const num = (k: string) => (flags[k] !== undefined ? Number(flags[k]) : undefined);
  const bool = (k: string) => {
    if (flags[k] === undefined) return undefined;
    return flags[k] !== 'false' && flags[k] !== '0';
  };

  return {
    file,
    maxRetries: num('max-retries'),
    maxIterations: num('max-iterations'),
    taskTimeout: num('task-timeout'),
    totalTimeout: num('total-timeout'),
    maxTokens: num('max-tokens'),
    autoCommit: bool('auto-commit'),
    branch: bool('branch'),
    allowDirty: bool('allow-dirty'),
    aggressiveClean: bool('aggressive-clean'),
    verifyAi: bool('verify-ai'),
    verifyModel: flags['verify-model'],
    decompose: bool('decompose'),
    maxDecomposeDepth: num('max-decompose-depth'),
    maxTotalTasks: num('max-total-tasks'),
    buildCommand: flags['build-command'],
    testCommand: flags['test-command'],
    lintCommand: flags['lint-command'],
    skipOnFail: bool('skip-on-fail'),
    skipOnBlocked: bool('skip-on-blocked'),
    rollbackOnFail: bool('rollback-on-fail'),
    scopeGuard: flags['scope-guard'] as 'off' | 'lax' | 'strict' | undefined,
    approval: flags['approval'],
    verbose: bool('verbose'),
    dryRun: bool('dry-run'),
  };
}

// ── Subcommand handlers ─────────────────────────────────────────

function emitAntonUpdate(ctx: ReplContext, text: string): void {
  if (!text.trim()) return;
  if (ctx.emitRuntimeUpdate) {
    ctx.emitRuntimeUpdate(text);
    return;
  }
  console.error(text);
}

function formatAgeShort(msAgo: number): string {
  if (msAgo < 60_000) return `${Math.max(1, Math.round(msAgo / 1000))}s ago`;
  if (msAgo < 3_600_000) return `${Math.round(msAgo / 60_000)}m ago`;
  return `${Math.round(msAgo / 3_600_000)}h ago`;
}

function summarizeLoopEvent(ev: NonNullable<ReplContext['antonLastLoopEvent']>): string {
  const emoji = ev.kind === 'final-failure' ? '🔴' : ev.kind === 'auto-recovered' ? '🟠' : '🟡';
  const kind =
    ev.kind === 'final-failure'
      ? 'final failure'
      : ev.kind === 'auto-recovered'
        ? 'auto-recovered'
        : 'loop event';
  const msg = ev.message.length > 120 ? ev.message.slice(0, 117) + '...' : ev.message;
  return `${emoji} Last loop: ${kind} (${formatAgeShort(Date.now() - ev.at)})\n${msg}`;
}

function showStatus(ctx: ReplContext): void {
  if (!ctx.antonActive) {
    console.log('No Anton run in progress.');
    return;
  }
  if (ctx.antonProgress) {
    const line1 = formatProgressBar(ctx.antonProgress);
    const lines = [line1];

    if (ctx.antonProgress.currentTask) {
      lines.push(
        '',
        `Working on: ${ctx.antonProgress.currentTask} (Attempt ${ctx.antonProgress.currentAttempt})`
      );
    }

    if (ctx.antonLastLoopEvent) {
      lines.push('', summarizeLoopEvent(ctx.antonLastLoopEvent));
    }

    console.log(lines.join('\n'));
    return;
  }

  if (ctx.antonLastLoopEvent) {
    console.log(
      `🤖 Anton is running (no progress data yet).\n\n${summarizeLoopEvent(ctx.antonLastLoopEvent)}`
    );
    return;
  }

  console.log('🤖 Anton is running (no progress data yet).');
}

function showLast(ctx: ReplContext): void {
  if (!ctx.antonLastResult) {
    console.log('No previous Anton run.');
    return;
  }
  console.log(formatRunSummary(ctx.antonLastResult));
}

function stopRun(ctx: ReplContext): void {
  if (!ctx.antonActive || !ctx.antonAbortSignal) {
    console.log('No Anton run in progress.');
    return;
  }
  ctx.antonAbortSignal.aborted = true;
  console.log('🛑 Anton stop requested. Run will halt after the current task.');
}

async function startRun(ctx: ReplContext, args: string): Promise<void> {
  if (ctx.antonActive) {
    console.log('⚠️  Anton is already running. Use /anton stop first.');
    return;
  }

  const parsed = parseAntonArgs(args);
  if (!parsed) {
    showUsage();
    return;
  }

  // Resolve file path
  const cwd = projectDir(ctx.config);
  const filePath = path.resolve(cwd, parsed.file);

  // Validate file exists
  try {
    await fs.stat(filePath);
  } catch {
    console.log(`File not found: ${filePath}`);
    return;
  }

  // Build AntonRunConfig from parsed flags + config defaults
  const defaults = ctx.config.anton || {};
  const config: AntonRunConfig = {
    taskFile: filePath,
    preflightEnabled: defaults.preflight?.enabled ?? false,
    preflightRequirementsReview: defaults.preflight?.requirements_review ?? true,
    preflightDiscoveryTimeoutSec:
      defaults.preflight?.discovery_timeout_sec ?? defaults.task_timeout_sec ?? 600,
    preflightReviewTimeoutSec:
      defaults.preflight?.review_timeout_sec ?? defaults.task_timeout_sec ?? 600,
    preflightMaxRetries: defaults.preflight?.max_retries ?? 2,
    preflightSessionMaxIterations: defaults.preflight?.session_max_iterations ?? 500,
    preflightSessionTimeoutSec:
      defaults.preflight?.session_timeout_sec ?? defaults.task_timeout_sec ?? 600,
    projectDir: cwd,
    maxRetriesPerTask: parsed.maxRetries ?? defaults.max_retries ?? 3,
    maxIterations: parsed.maxIterations ?? defaults.max_iterations ?? 200,
    taskMaxIterations: defaults.task_max_iterations ?? 50,
    taskTimeoutSec: parsed.taskTimeout ?? defaults.task_timeout_sec ?? 600,
    totalTimeoutSec: parsed.totalTimeout ?? defaults.total_timeout_sec ?? 7200,
    maxTotalTokens: parsed.maxTokens ?? defaults.max_total_tokens ?? Infinity,
    maxPromptTokensPerAttempt: defaults.max_prompt_tokens_per_attempt ?? 999_999_999,
    autoCommit: parsed.autoCommit ?? defaults.auto_commit ?? true,
    branch: parsed.branch ?? false,
    allowDirty: parsed.allowDirty ?? false,
    aggressiveCleanOnFail: parsed.aggressiveClean ?? false,
    verifyAi: parsed.verifyAi ?? defaults.verify_ai ?? true,
    verifyModel: parsed.verifyModel ?? undefined,
    decompose: parsed.decompose ?? defaults.decompose ?? true,
    maxDecomposeDepth: parsed.maxDecomposeDepth ?? defaults.max_decompose_depth ?? 2,
    maxTotalTasks: parsed.maxTotalTasks ?? defaults.max_total_tasks ?? 500,
    buildCommand: parsed.buildCommand ?? undefined,
    testCommand: parsed.testCommand ?? undefined,
    lintCommand: parsed.lintCommand ?? undefined,
    skipOnFail: parsed.skipOnFail ?? defaults.skip_on_fail ?? false,
    skipOnBlocked: parsed.skipOnBlocked ?? defaults.skip_on_blocked ?? true,
    rollbackOnFail: parsed.rollbackOnFail ?? defaults.rollback_on_fail ?? false,
    scopeGuard: parsed.scopeGuard ?? defaults.scope_guard ?? 'lax',
    maxIdenticalFailures: defaults.max_identical_failures ?? 3,
    approvalMode: (parsed.approval ??
      defaults.approval_mode ??
      'yolo') as AntonRunConfig['approvalMode'],
    verbose: parsed.verbose ?? defaults.verbose ?? false,
    dryRun: parsed.dryRun ?? false,
  };

  // Set up REPL state
  const abortSignal = { aborted: false };
  ctx.antonActive = true;
  ctx.antonAbortSignal = abortSignal;
  ctx.antonProgress = null;
  ctx.antonLastLoopEvent = null;

  // Build progress callback
  const heartbeatSecRaw = Number(defaults.progress_heartbeat_sec ?? 30);
  const heartbeatIntervalMs = Number.isFinite(heartbeatSecRaw)
    ? Math.max(5000, Math.floor(heartbeatSecRaw * 1000))
    : 30_000;

  let lastProgressAt = 0;
  let lastHeartbeatNoticeAt = 0;
  let runStartMs = 0;
  let lastHeartbeatText = '';

  const progress: AntonProgressCallback = {
    onTaskStart(task, attempt, prog) {
      const now = Date.now();
      if (!runStartMs) runStartMs = now;
      lastProgressAt = now;
      ctx.antonProgress = prog;
      emitAntonUpdate(ctx, formatTaskStart(task, attempt, prog));
    },
    onTaskEnd(task, result, prog) {
      const now = Date.now();
      lastProgressAt = now;
      ctx.antonProgress = prog;
      emitAntonUpdate(ctx, formatTaskEnd(task, result, prog));
    },
    onTaskSkip(task, reason, _prog) {
      emitAntonUpdate(ctx, formatTaskSkip(task, reason));
    },
    onRunComplete(result) {
      ctx.antonLastResult = result;
      ctx.antonActive = false;
      ctx.antonAbortSignal = null;
      ctx.antonProgress = null;
      runStartMs = 0;
      lastHeartbeatText = '';
      emitAntonUpdate(ctx, formatRunSummary(result));
    },
    onHeartbeat() {
      const now = Date.now();
      if (defaults.progress_events === false) return;
      if (!ctx.antonProgress?.currentTask) return;
      if (now - lastProgressAt < 3000) return;
      if (now - lastHeartbeatNoticeAt < heartbeatIntervalMs) return;

      if (!runStartMs) runStartMs = now;
      ctx.antonProgress = {
        ...ctx.antonProgress,
        elapsedMs: now - runStartMs,
      };

      const hb = formatTaskHeartbeat(ctx.antonProgress);
      if (hb === lastHeartbeatText) return;

      lastHeartbeatNoticeAt = now;
      lastHeartbeatText = hb;
      emitAntonUpdate(ctx, hb);
    },
    onToolLoop(taskText, event) {
      const detail = String(event.message ?? '');
      const kind = /final loop failure|retries exhausted/i.test(detail)
        ? 'final-failure'
        : /auto-?recover|auto-?continu/i.test(detail)
          ? 'auto-recovered'
          : 'other';
      ctx.antonLastLoopEvent = {
        kind,
        taskText,
        message: detail,
        at: Date.now(),
      };

      emitAntonUpdate(ctx, formatToolLoopEvent(taskText, event));
    },
    onCompaction(taskText, event) {
      emitAntonUpdate(ctx, formatCompactionEvent(taskText, event));
    },
    onVerification(taskText, verification) {
      emitAntonUpdate(ctx, formatVerificationDetail(taskText, verification));
    },
    onStage(message) {
      if (defaults.progress_events !== false) {
        emitAntonUpdate(ctx, message);
      }
    },
  };

  // Parse initial task count for display
  let pendingCount = 0;
  try {
    const taskFile = await parseTaskFile(filePath);
    pendingCount = taskFile.pending.length;
  } catch {
    // Non-fatal, just won't show count
  }

  console.log(`🤖 Anton started on ${parsed.file} (${pendingCount} tasks pending)`);

  // Fire-and-forget — REPL stays responsive
  runAnton({
    config,
    idlehandsConfig: ctx.config,
    progress,
    abortSignal,
    apiKey: undefined,
    vault: ctx.session.vault,
    lens: ctx.session.lens,
  }).catch((err: Error) => {
    emitAntonUpdate(ctx, `Anton error: ${err.message}`);
    ctx.antonActive = false;
    ctx.antonAbortSignal = null;
    ctx.antonProgress = null;
  });
}

function showUsage(): void {
  console.log(
    [
      'Usage: /anton <file> [flags]',
      '',
      'Subcommands:',
      '  /anton <file> [flags]   Start autonomous task runner',
      '  /anton run <file>       Same as above',
      '  /anton status           Show current progress',
      '  /anton stop             Stop the running task runner',
      '  /anton last             Show last run results',
      '',
      'Flags:',
      '  --max-retries <n>       Max retries per task (default: 3)',
      '  --max-iterations <n>    Max total iterations (default: 200)',
      '  --task-timeout <sec>    Per-task timeout (default: 600)',
      '  --total-timeout <sec>   Total budget (default: 7200)',
      '  --max-tokens <n>        Token budget (default: unlimited)',
      '  --auto-commit           Git commit each success (default: true)',
      '  --allow-dirty           Allow dirty working tree',
      '  --verify-ai             Enable L2 AI verification (default: true)',
      '  --decompose             Enable task decomposition (default: true)',
      '  --skip-on-fail          Skip failed tasks (default: false)',
      '  --skip-on-blocked       Skip tasks that return blocked (default: true)',
      '  --rollback-on-fail      Revert task on failure (default: false)',
      '  --scope-guard MODE      Scope guard: off|lax|strict (default: lax)',
      '  --dry-run               Show plan without executing',
      '  --verbose               Stream agent tokens',
    ].join('\n')
  );
}

// ── Exported command ────────────────────────────────────────────

export const antonCommands: SlashCommand[] = [
  {
    name: '/anton',
    description: 'Autonomous task runner',
    async execute(ctx, args, _line) {
      const sub = firstToken(args);

      if (!sub) {
        showStatus(ctx);
        return true;
      }

      switch (sub) {
        case 'status':
          showStatus(ctx);
          return true;
        case 'stop':
          stopRun(ctx);
          return true;
        case 'last':
          showLast(ctx);
          return true;
        case 'help':
          showUsage();
          return true;
        case 'run': {
          const runArgs = args.replace(/^\S+\s*/, '').trim();
          await startRun(ctx, runArgs);
          return true;
        }
        default:
          // First arg is the file path
          await startRun(ctx, args);
          return true;
      }
    },
  },
];
