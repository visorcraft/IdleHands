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
    approval: flags['approval'],
    verbose: bool('verbose'),
    dryRun: bool('dry-run'),
  };
}

// ── Subcommand handlers ─────────────────────────────────────────

function showStatus(ctx: ReplContext): void {
  if (!ctx.antonActive) {
    console.log('No Anton run in progress.');
    return;
  }
  if (ctx.antonProgress) {
    const line1 = formatProgressBar(ctx.antonProgress);
    if (ctx.antonProgress.currentTask) {
      console.log(`${line1}\n\nWorking on: ${ctx.antonProgress.currentTask} (Attempt ${ctx.antonProgress.currentAttempt})`);
    } else {
      console.log(line1);
    }
  } else {
    console.log('🤖 Anton is running (no progress data yet).');
  }
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
    projectDir: cwd,
    maxRetriesPerTask: parsed.maxRetries ?? defaults.max_retries ?? 3,
    maxIterations: parsed.maxIterations ?? defaults.max_iterations ?? 200,
    taskTimeoutSec: parsed.taskTimeout ?? defaults.task_timeout_sec ?? 600,
    totalTimeoutSec: parsed.totalTimeout ?? defaults.total_timeout_sec ?? 7200,
    maxTotalTokens: parsed.maxTokens ?? defaults.max_total_tokens ?? Infinity,
    maxPromptTokensPerAttempt: defaults.max_prompt_tokens_per_attempt ?? 128_000,
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

  // Build progress callback
  const progress: AntonProgressCallback = {
    onTaskStart(task, attempt, prog) {
      ctx.antonProgress = prog;
      console.error(formatTaskStart(task, attempt, prog));
    },
    onTaskEnd(task, result, prog) {
      ctx.antonProgress = prog;
      console.error(formatTaskEnd(task, result, prog));
    },
    onTaskSkip(task, reason, _prog) {
      console.error(formatTaskSkip(task, reason));
    },
    onRunComplete(result) {
      ctx.antonLastResult = result;
      ctx.antonActive = false;
      ctx.antonAbortSignal = null;
      ctx.antonProgress = null;
      console.error(formatRunSummary(result));
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
    console.error(`Anton error: ${err.message}`);
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
