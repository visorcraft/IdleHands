/**
 * Anton autonomous task runner — main orchestrator.
 *
 * Coordinates all components: parser, prompt, verifier, lock, git, session.
 * Structured as a deterministic orchestration flow for autonomous task execution.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentSession } from '../agent.js';
import { isToolLoopBreak, AUTO_CONTINUE_PROMPT } from '../bot/auto-continue.js';
import {
  ensureCleanWorkingTree,
  getWorkingDiff,
  commitAll,
  restoreTrackedChanges,
  cleanUntracked,
  createBranch,
  getUntrackedFiles,
  removeUntrackedFiles,
} from '../git.js';
import type { LensStore } from '../lens.js';
import type { IdlehandsConfig } from '../types.js';
import { estimateTokens } from '../utils.js';
import type { VaultStore } from '../vault.js';

import { acquireAntonLock, releaseAntonLock, touchAntonLock } from './lock.js';
import {
  parseTaskFile,
  findRunnablePendingTasks,
  markTaskChecked,
  insertSubTasks,
  autoCompleteAncestors,
} from './parser.js';
import {
  ensureAgentsTasksDir,
  makeUniqueTaskPlanFilename,
  buildDiscoveryPrompt,
  parseDiscoveryResult,
  buildRequirementsReviewPrompt,
  parseRequirementsReviewResult,
  ensurePlanFileExistsOrBootstrap,
  assertPlanFileExistsAndNonEmpty,
  buildDiscoveryRewritePrompt,
  buildReviewRewritePrompt,
  FORCE_DISCOVERY_DECISION_PROMPT,
  FORCE_REVIEW_DECISION_PROMPT,
} from './preflight.js';
import { buildAntonPrompt, parseAntonResult, classifyTaskComplexity } from './prompt.js';
import { formatDryRunPlan } from './reporter.js';
import { classifyInfraError, ensureAntonRuntimeReady } from './runtime-ready.js';
import {
  buildSessionConfig,
  buildPreflightConfig,
  buildDecomposeConfig,
  buildVerifyConfig,
  defaultCreateSession,
} from './session.js';
import type {
  AntonRunConfig,
  AntonRunResult,
  AntonProgressCallback,
  AntonProgress,
  AntonAttempt,
  AntonStopReason,
  AntonAttemptStatus,
  AntonPreflightRecord,
} from './types.js';
import { captureLintBaseline, detectVerificationCommands, runVerification } from './verifier.js';

// ─────────────────────────────────────────────────────────────────────────────
// L2 Retry Enhancement Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract file paths mentioned in an L2 failure reason.
 * Looks for patterns like: app/Models/Channel.php, src/foo/bar.ts, etc.
 */
function extractFilePathsFromL2Reason(reason: string): string[] {
  const patterns = [
    // PHP/Laravel style: app/Models/Channel.php, app/Http/Controllers/Foo.php
    /\b(app\/[\w\/]+\.php)\b/gi,
    // General file paths with extensions
    /\b((?:src|lib|tests?)\/[\w\/.-]+\.\w+)\b/gi,
    // Model names that can be mapped to files: "Channel model" -> app/Models/Channel.php
    /\b(\w+)\s+model\b/gi,
  ];

  const found = new Set<string>();
  for (const pattern of patterns) {
    const matches = reason.matchAll(pattern);
    for (const match of matches) {
      const p = match[1];
      // If it's a model name reference like "Channel model", convert to path
      if (/model$/i.test(match[0]) && !/\.php$/i.test(p)) {
        found.add(`app/Models/${p}.php`);
      } else {
        found.add(p);
      }
    }
  }
  return [...found];
}

/**
 * Detect if L2 reason indicates a "missing implementation" pattern.
 * Returns true if the model wrote tests but forgot the actual implementation.
 */
function isL2MissingImplementation(reason: string): boolean {
  const missingPatterns = [
    /missing\s+(?:from|in)\s+/i,
    /no\s+(?:corresponding|evidence|actual)/i,
    /relationship\s+(?:method\s+)?is\s+missing/i,
    /but\s+(?:the|there['']?s?\s+no)/i,
    /tests?\s+(?:expect|added|written).*but/i,
    /should\s+be\s+(?:hasMany|hasOne|belongsTo|morphMany)/i,
  ];
  return missingPatterns.some((p) => p.test(reason));
}

function isRecoverablePreflightDiscoveryError(errMsg: string): boolean {
  return (
    /preflight-json-missing-object|preflight-discovery-invalid-status|preflight-discovery-invalid-filename|preflight-discovery-filename|preflight-plan-empty|preflight-plan-not-a-file/i.test(
      errMsg
    ) || /identical call repeated|breaking loop|tool\s+edit_range/i.test(errMsg)
  );
}

function isRecoverablePreflightReviewError(errMsg: string): boolean {
  return /preflight-json-missing-object|preflight-review-invalid-status|preflight-review-invalid-filename|preflight-review-filename|preflight-plan-empty|preflight-plan-not-a-file/i.test(
    errMsg
  );
}

/**
 * Try to read a file's contents for injection into retry context.
 * Returns null if file doesn't exist or is too large.
 */
function readFileForL2Injection(projectDir: string, filePath: string): string | null {
  const MAX_FILE_SIZE = 15000; // ~15KB, reasonable for injection
  try {
    const fullPath = path.resolve(projectDir, filePath);
    if (!fs.existsSync(fullPath)) return null;
    const stat = fs.statSync(fullPath);
    if (stat.size > MAX_FILE_SIZE) return null;
    return fs.readFileSync(fullPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Build enhanced retry context when L2 fails due to missing implementation.
 * - On first L2 failure: Add strong guidance about which files to modify
 * - On 2+ L2 failures: Inject the actual file contents so model can see what's missing
 */
function buildL2EnhancedRetryContext(
  l2Reason: string,
  l2FailCount: number,
  projectDir: string,
  taskText: string
): string {
  const parts: string[] = [];
  const filePaths = extractFilePathsFromL2Reason(l2Reason);
  const isMissingImpl = isL2MissingImplementation(l2Reason);

  if (!isMissingImpl || filePaths.length === 0) {
    // Not a "missing implementation" pattern, no enhancement needed
    return '';
  }

  parts.push('');
  parts.push('═══════════════════════════════════════════════════════════════════════');
  parts.push('⚠️  CRITICAL: AI REVIEW FAILED — MISSING IMPLEMENTATION DETECTED');
  parts.push('═══════════════════════════════════════════════════════════════════════');
  parts.push('');
  parts.push(`The AI review found that you wrote tests but FORGOT THE ACTUAL IMPLEMENTATION.`);
  parts.push(`Task: "${taskText}"`);
  parts.push('');
  parts.push('YOU MUST MODIFY THESE FILES:');
  for (const fp of filePaths) {
    parts.push(`  → ${fp}`);
  }
  parts.push('');

  // After 2+ identical L2 failures, inject file contents
  if (l2FailCount >= 2) {
    parts.push('Since you have failed this verification multiple times, here are the current');
    parts.push('contents of the files you need to modify:');
    parts.push('');

    for (const fp of filePaths) {
      const contents = readFileForL2Injection(projectDir, fp);
      if (contents !== null) {
        parts.push(`┌─── ${fp} ───`);
        parts.push(contents);
        parts.push(`└─── end of ${fp} ───`);
        parts.push('');
      } else {
        parts.push(`[Could not read ${fp} — file may not exist or is too large]`);
        parts.push('');
      }
    }
  }

  parts.push('INSTRUCTIONS:');
  parts.push('1. READ the files listed above (they are your existing code)');
  parts.push('2. ADD the missing method/relationship to the model file');
  parts.push('3. Do NOT just modify tests — the MODEL/SOURCE file must change');
  parts.push('4. The L2 review expects to see your implementation in the diff');
  parts.push('');

  return parts.join('\n');
}

export interface RunAntonOpts {
  config: AntonRunConfig;
  idlehandsConfig: IdlehandsConfig;
  progress: AntonProgressCallback;
  abortSignal: { aborted: boolean };
  apiKey?: string;
  vault?: VaultStore;
  lens?: LensStore;
  createSession?: (config: IdlehandsConfig, apiKey?: string) => Promise<AgentSession>;
}

const ANTON_RESULT_SYSTEM_CONTRACT = `[Anton output contract]
Every final implementation/decompose answer MUST contain exactly one structured block:
<anton-result>
status: done|failed|blocked|decompose
reason: <optional>
subtasks:
- <only when status=decompose>
</anton-result>
Do not omit this block.`;

const STRUCTURED_RESULT_RECOVERY_PROMPT = `Your previous reply did not include a valid <anton-result> block.
Do NOT call tools.
Return ONLY this block shape and nothing else:
<anton-result>
status: done|failed|blocked|decompose
reason: <optional>
subtasks:
- <only when status=decompose>
</anton-result>`;

function isStructuredResultParseFailure(reason?: string): boolean {
  if (!reason) return false;
  return (
    reason === 'Agent did not emit structured result' ||
    reason === 'No status line found in result block' ||
    reason.startsWith('Unknown status:')
  );
}

function injectAntonResultContract(session: AgentSession): void {
  try {
    const current = String(session.getSystemPrompt?.() ?? '').trim();
    if (!current) return;
    if (current.includes('<anton-result>') || current.includes('[Anton output contract]')) return;
    session.setSystemPrompt(`${current}\n\n${ANTON_RESULT_SYSTEM_CONTRACT}`);
  } catch {
    // best effort
  }
}

export async function runAnton(opts: RunAntonOpts): Promise<AntonRunResult> {
  const { config, idlehandsConfig, progress, abortSignal, apiKey, vault, lens } = opts;
  const createSessionFn = opts.createSession || defaultCreateSession;
  const runtimeResilienceEnabled = !opts.createSession; // unit tests inject mock sessions; skip runtime orchestration there.

  const startTimeMs = Date.now();
  let lockAcquired = false;
  let totalTokens = 0;
  let totalCommits = 0;
  let iterationsUsed = 0;
  let autoCompleted = 0;
  const attempts: AntonAttempt[] = [];
  const preflightRecords: AntonPreflightRecord[] = [];
  const taskPlanByTaskKey = new Map<string, string>();
  const taskRetryCount: Map<string, number> = new Map();
  const lastFailureReason: Map<string, string> = new Map();
  const consecutiveIdenticalCount: Map<string, number> = new Map();
  const l2FailCount: Map<string, number> = new Map(); // Track consecutive L2 failures per task
  let lockHeartbeatTimer: NodeJS.Timeout | null = null;

  // SIGINT handler
  const handleAbort = () => {
    abortSignal.aborted = true;
  };
  process.on('SIGINT', handleAbort);

  try {
    // 1. Acquire Anton lock
    await acquireAntonLock(config.taskFile, config.projectDir);
    lockAcquired = true;

    // Keep Anton lock fresh + emit heartbeat while run is active.
    lockHeartbeatTimer = setInterval(() => {
      void touchAntonLock();
      try {
        progress.onHeartbeat?.();
      } catch {}
    }, 5000);

    // 2. Parse task file
    let taskFile = await parseTaskFile(config.taskFile);
    const initialPending = taskFile.pending.length;
    const initialCompleted = taskFile.completed.length;

    // 3. Detect verification commands
    const commands = await detectVerificationCommands(config.projectDir, {
      build: config.buildCommand,
      test: config.testCommand,
      lint: config.lintCommand,
    });

    // 3b. Capture baseline lint error count so we only fail on NEW errors
    const baselineLintErrorCount = await captureLintBaseline(commands.lint, config.projectDir);

    // 4. Clean-tree check (unless allowDirty)
    if (!config.allowDirty) {
      const diff = await getWorkingDiff(config.projectDir);
      if (diff.trim()) {
        await ensureCleanWorkingTree(config.projectDir);
      }
    }

    // 5. Branch creation (if --branch)
    if (config.branch) {
      const branchName = `anton-${Date.now()}`;
      await createBranch(config.projectDir, branchName);
    }

    // 6. Dry-run early return
    if (config.dryRun) {
      const summary = formatDryRunPlan(taskFile, commands);
      console.log(summary);

      return {
        totalTasks: taskFile.totalCount,
        preCompleted: initialCompleted,
        completed: 0,
        autoCompleted: 0,
        skipped: 0,
        failed: 0,
        remaining: taskFile.pending.length,
        attempts: [],
        preflightRecords: [],
        totalDurationMs: Date.now() - startTimeMs,
        totalTokens: 0,
        totalCommits: 0,
        completedAll: false,
        stopReason: 'all_done',
      };
    }

    // Runtime preflight (infra guardrail): ensure endpoint/model is actually ready
    // before spending tokens on task attempts.
    if (runtimeResilienceEnabled) {
      const preflight = await ensureAntonRuntimeReady(idlehandsConfig, {
        forceRestart: false,
        timeoutMs: 120_000,
      });
      if (!preflight.ok) {
        throw new Error(`Anton preflight failed: ${preflight.detail}`);
      }
    }

    // 7. Main loop
    mainLoop: while (true) {
      // Re-parse task file each iteration
      taskFile = await parseTaskFile(config.taskFile);

      // Find runnable pending tasks
      const skippedKeys = new Set(
        attempts.filter((a) => a.status === 'skipped').map((a) => a.taskKey)
      );
      const runnableTasks = findRunnablePendingTasks(taskFile, skippedKeys);
      if (runnableTasks.length === 0) break; // No more work

      const currentTask = runnableTasks[0];

      // Build retry context from previous failed attempts on this task
      const prevAttempts = attempts.filter((a) => a.taskKey === currentTask.key);
      let retryContext: string | undefined;
      if (prevAttempts.length > 0) {
        const lastAttempt = prevAttempts[prevAttempts.length - 1];
        const parts: string[] = [];
        parts.push(`Previous attempt #${lastAttempt.attempt} result: ${lastAttempt.status}`);
        if (lastAttempt.verification) {
          const v = lastAttempt.verification;
          parts.push(`Verification: ${v.summary}`);
          if (v.l1_build === false) parts.push('- Build command failed');
          if (v.l1_test === false) parts.push('- Test command failed');
          if (v.l1_lint === false) parts.push('- Lint command failed');
          if (v.l2_ai === false && v.l2_reason) {
            parts.push(`- AI review: ${v.l2_reason}`);

            // Enhanced L2 retry context: stronger guidance + file injection on repeated failures
            const currentL2Count = l2FailCount.get(currentTask.key) || 0;
            const l2Enhancement = buildL2EnhancedRetryContext(
              v.l2_reason,
              currentL2Count,
              config.projectDir,
              currentTask.text
            );
            if (l2Enhancement) {
              parts.push(l2Enhancement);
            }
          }

          // Include error output (filtered to errors only, no warnings) so the
          // agent can see and fix the exact issues.
          if (v.commandOutput) {
            parts.push('');
            parts.push('=== Error output (errors only, warnings excluded) ===');
            parts.push(v.commandOutput);
            parts.push('=== End of error output ===');
            parts.push('');
            parts.push(
              'IMPORTANT: Your previous code changes are STILL IN PLACE — do NOT rewrite from scratch.'
            );
            parts.push('1. Read the specific files listed in the errors above.');
            parts.push('2. Fix ONLY the reported errors (e.g. import ordering, missing types).');
            parts.push('3. Run the lint/build/test command yourself to verify before completing.');
            parts.push('Do NOT touch files that are not mentioned in the errors.');
          }
        }
        if (lastAttempt.error) {
          parts.push(`Error: ${lastAttempt.error}`);
        }
        retryContext = parts.join('\n');
      }

      // Check stop conditions
      if (abortSignal.aborted) {
        break mainLoop;
      }

      if (iterationsUsed >= config.maxIterations) {
        break mainLoop;
      }

      const elapsedMs = Date.now() - startTimeMs;
      if (elapsedMs >= config.totalTimeoutSec * 1000) {
        break mainLoop;
      }

      if (totalTokens >= config.maxTotalTokens) {
        break mainLoop;
      }

      if (taskFile.totalCount > config.maxTotalTasks) {
        break mainLoop;
      }

      // Progress tracking
      const currentProgress: AntonProgress = {
        currentIndex: 0,
        totalPending: initialPending,
        completedSoFar: taskFile.completed.length - initialCompleted,
        skippedSoFar: attempts.filter((a) => a.status === 'skipped').length,
        iterationsUsed,
        elapsedMs: Date.now() - startTimeMs,
        estimatedRemainingMs: undefined,
        currentTask: currentTask.text,
        currentAttempt: (taskRetryCount.get(currentTask.key) || 0) + 1,
      };

      // Handle max retries
      const retries = taskRetryCount.get(currentTask.key) || 0;

      // Check for consecutive identical failures (dedup guard)
      const maxIdentical = config.maxIdenticalFailures ?? 3;
      const identicalCount = consecutiveIdenticalCount.get(currentTask.key) || 0;
      if (identicalCount >= maxIdentical) {
        if (!config.skipOnFail) {
          break mainLoop;
        }

        progress.onTaskSkip(
          currentTask,
          `${maxIdentical} consecutive identical failures`,
          currentProgress
        );

        const skipAttempt: AntonAttempt = {
          taskKey: currentTask.key,
          taskText: currentTask.text,
          attempt: retries + 1,
          durationMs: 0,
          tokensUsed: 0,
          status: 'skipped',
          verification: undefined,
          error: `${maxIdentical} consecutive identical failures`,
          commitHash: undefined,
        };
        attempts.push(skipAttempt);
        taskRetryCount.set(currentTask.key, retries + 1);
        continue;
      }

      if (retries >= config.maxRetriesPerTask) {
        if (!config.skipOnFail) {
          break mainLoop;
        }

        progress.onTaskSkip(currentTask, 'max retries exceeded', currentProgress);

        // Mark as skipped and continue
        const skipAttempt: AntonAttempt = {
          taskKey: currentTask.key,
          taskText: currentTask.text,
          attempt: retries + 1,
          durationMs: 0,
          tokensUsed: 0,
          status: 'skipped',
          verification: undefined,
          error: 'max retries exceeded',
          commitHash: undefined,
        };
        attempts.push(skipAttempt);
        taskRetryCount.set(currentTask.key, retries + 1);
        continue;
      }

      const attemptNumber = retries + 1;

      // Publish active task context early so /anton status + heartbeat keep working
      // during preflight stages (discovery/review), not only implementation.
      progress.onTaskStart(currentTask, attemptNumber, currentProgress);

      // Optional preflight pipeline: discovery -> requirements review.
      // Runs on first attempt for each task. Retries are stage-local to avoid churn.
      if (config.preflightEnabled && retries === 0) {
        const preflightMaxRetries = Math.max(0, config.preflightMaxRetries ?? 2);
        const preflightTotalTries = preflightMaxRetries + 1;
        let preflightMarkedComplete = false;
        let discoveryOk = false;
        let discoveryUsedFallbackPlan = false;

        await ensureAgentsTasksDir(config.projectDir);
        const plannedFilePath =
          taskPlanByTaskKey.get(currentTask.key) ?? makeUniqueTaskPlanFilename(config.projectDir);
        // Default to 50 iterations for discovery (was 500 - way too high for a simple JSON check)
        let discoveryIterationCap = Math.max(
          1,
          Math.floor(config.preflightSessionMaxIterations ?? 50)
        );
        let discoveryRetryHint: string | undefined;

        // Shared preflight session - reused between discovery and review stages to avoid
        // session creation overhead. Created lazily, closed on error (for fresh retry state)
        // or at end of preflight block.
        let preflightSession: AgentSession | undefined;
        const closePreflightSession = async () => {
          if (preflightSession) {
            try {
              await preflightSession.close();
            } catch {
              // best effort
            }
            preflightSession = undefined;
          }
        };

        try {
        // Stage 1: discovery (retry discovery only).
        for (let discoveryTry = 0; discoveryTry <= preflightMaxRetries; discoveryTry++) {
          const stageStart = Date.now();
          const discoveryTimeoutSec = config.preflightDiscoveryTimeoutSec ?? config.taskTimeoutSec;
          const discoveryTimeoutMs = discoveryTimeoutSec * 1000;

          try {
            progress.onStage?.('🔎 Discovery: checking if already done...');
            // Create session if not already open (first try or after error closed it)
            if (!preflightSession) {
              preflightSession = await createSessionFn(
                buildPreflightConfig(
                  idlehandsConfig,
                  config,
                  discoveryTimeoutSec,
                  discoveryIterationCap
                ),
                apiKey
              );
            }

            const discoveryPrompt = buildDiscoveryPrompt({
              task: currentTask,
              taskFilePath: config.taskFile,
              projectDir: config.projectDir,
              planFilePath: plannedFilePath,
              retryHint: discoveryRetryHint,
            });

            let discoveryTimeoutHandle: NodeJS.Timeout;
            const discoveryRes = await Promise.race([
              preflightSession.ask(discoveryPrompt).finally(() => clearTimeout(discoveryTimeoutHandle)),
              new Promise<never>((_, reject) => {
                discoveryTimeoutHandle = setTimeout(() => {
                  try {
                    preflightSession?.cancel();
                  } catch {
                    // best effort
                  }
                  reject(new Error('preflight-discovery-timeout'));
                }, discoveryTimeoutMs);
              }),
            ]);

            let discoveryTokens =
              preflightSession.usage.prompt + preflightSession.usage.completion;
            totalTokens += discoveryTokens;

            // Try to parse discovery result; if invalid JSON, attempt force-decision prompt
            let discovery;
            try {
              discovery = parseDiscoveryResult(discoveryRes.text, config.projectDir);
            } catch (parseError) {
              const parseErrMsg = parseError instanceof Error ? parseError.message : String(parseError);
              // Only try force-decision for JSON/format errors, not file path errors
              if (/preflight-json-missing-object|preflight-discovery-invalid/i.test(parseErrMsg)) {
                progress.onStage?.('⚠️ Discovery output invalid, requesting forced decision...');
                try {
                  const forceRes = await preflightSession.ask(FORCE_DISCOVERY_DECISION_PROMPT);
                  const forceTokens = preflightSession.usage.prompt + preflightSession.usage.completion - discoveryTokens;
                  discoveryTokens += forceTokens;
                  totalTokens += forceTokens;
                  discovery = parseDiscoveryResult(forceRes.text, config.projectDir);
                  progress.onStage?.('✅ Forced decision succeeded');
                } catch {
                  // Force-decision also failed, throw original error
                  throw parseError;
                }
              } else {
                throw parseError;
              }
            }

            if (discovery.status === 'complete') {
              preflightRecords.push({
                taskKey: currentTask.key,
                stage: 'discovery',
                durationMs: Date.now() - stageStart,
                tokensUsed: discoveryTokens,
                status: discovery.status,
                filename: discovery.filename || undefined,
              });
              await markTaskChecked(config.taskFile, currentTask.key);
              await autoCompleteAncestors(config.taskFile, currentTask.key);
              autoCompleted += 1;
              progress.onStage?.(`✅ Discovery confirmed already complete: ${currentTask.text}`);
              preflightMarkedComplete = true;
              discoveryOk = true;
              // No review needed - close session now
              await closePreflightSession();
              break;
            }

            // If the model returned incomplete+filename without making any tool calls,
            // it almost certainly hallucinated the file write. Immediately ask it to
            // actually write the file before we even check the filesystem.
            if (discoveryRes.toolCalls === 0) {
              progress.onStage?.('⚠️ Discovery returned filename but made no tool calls — forcing write...');
              const writeRes = await preflightSession.ask(
                buildDiscoveryRewritePrompt(discovery.filename, 'file was never written (no tool calls)')
              );
              const writeTokens =
                preflightSession.usage.prompt + preflightSession.usage.completion - discoveryTokens;
              discoveryTokens += writeTokens;
              totalTokens += writeTokens;
              try {
                const rewritten = parseDiscoveryResult(writeRes.text, config.projectDir);
                if (rewritten.status === 'incomplete' && rewritten.filename) {
                  discovery = rewritten;
                }
              } catch {
                // keep original discovery.filename; validation below will handle it
              }
            }

            // Discovery claims a plan filename; verify it truly exists and has content.
            // If missing/empty, explicitly ask model to retry writing before accepting success.
            let planPath = discovery.filename;
            for (let writeFixTry = 0; writeFixTry < 2; writeFixTry++) {
              try {
                await assertPlanFileExistsAndNonEmpty(planPath);
                break;
              } catch (planErr) {
                const planMsg = planErr instanceof Error ? planErr.message : String(planErr);
                const reason = /preflight-plan-empty/i.test(planMsg)
                  ? 'empty file'
                  : /preflight-plan-not-a-file/i.test(planMsg)
                    ? 'not a regular file'
                    : /ENOENT/i.test(planMsg)
                      ? 'missing file'
                      : planMsg;

                if (writeFixTry === 0) {
                  progress.onStage?.(
                    `⚠️ Discovery returned filename but file is invalid (${reason}). Asking model to rewrite plan file...`
                  );
                  const rewriteRes = await preflightSession.ask(
                    buildDiscoveryRewritePrompt(planPath, reason)
                  );
                  const rewriteTokens =
                    preflightSession.usage.prompt + preflightSession.usage.completion - discoveryTokens;
                  discoveryTokens += rewriteTokens;
                  totalTokens += rewriteTokens;

                  try {
                    const rewritten = parseDiscoveryResult(rewriteRes.text, config.projectDir);
                    if (rewritten.status === 'incomplete') {
                      planPath = rewritten.filename;
                    }
                  } catch {
                    // Keep original planPath; second validation pass will fail and route to fallback.
                  }
                  continue;
                }

                const discoveryPlanState = await ensurePlanFileExistsOrBootstrap({
                  absPath: planPath,
                  task: currentTask,
                  source: 'discovery',
                });
                if (discoveryPlanState === 'bootstrapped') {
                  discoveryUsedFallbackPlan = true;
                  progress.onStage?.(
                    `⚠️ Discovery returned a filename but did not write valid contents. Created fallback plan file: ${planPath}`
                  );
                }
              }
            }

            preflightRecords.push({
              taskKey: currentTask.key,
              stage: 'discovery',
              durationMs: Date.now() - stageStart,
              tokensUsed: discoveryTokens,
              status: discovery.status,
              filename: planPath || undefined,
            });

            taskPlanByTaskKey.set(currentTask.key, planPath);
            progress.onStage?.(`📝 Discovery plan file: ${planPath}`);
            discoveryOk = true;
            break;
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            const timeout = /timeout/i.test(errMsg);

            preflightRecords.push({
              taskKey: currentTask.key,
              stage: 'discovery',
              durationMs: Date.now() - stageStart,
              tokensUsed: 0,
              status: timeout ? 'timeout' : 'error',
              error: errMsg,
            });

            const short = errMsg.length > 180 ? `${errMsg.slice(0, 177)}...` : errMsg;
            discoveryRetryHint = `Previous discovery attempt failed: ${short}. Do not edit source files. Only update ${plannedFilePath} and return strict JSON.`;

            // If discovery returns malformed/non-JSON output (or loops on source edits),
            // degrade immediately to fallback plan instead of burning retries.
            if (isRecoverablePreflightDiscoveryError(errMsg)) {
              discoveryUsedFallbackPlan = true;
              const fallbackState = await ensurePlanFileExistsOrBootstrap({
                absPath: plannedFilePath,
                task: currentTask,
                source: 'discovery',
              });
              if (fallbackState === 'bootstrapped') {
                progress.onStage?.(
                  `⚠️ Discovery returned invalid output (${short}). Bootstrapped fallback plan and continuing: ${plannedFilePath}`
                );
              } else {
                progress.onStage?.(
                  `⚠️ Discovery returned invalid output (${short}). Reusing existing plan and continuing: ${plannedFilePath}`
                );
              }
              taskPlanByTaskKey.set(currentTask.key, plannedFilePath);
              discoveryOk = true;
              break;
            }

            if (discoveryTry < preflightMaxRetries) {
              // Close session on error so retry gets fresh state
              await closePreflightSession();

              if (/max iterations exceeded/i.test(errMsg)) {
                const nextCap = Math.min(
                  Math.max(discoveryIterationCap * 2, discoveryIterationCap + 2),
                  1000
                );
                if (nextCap > discoveryIterationCap) {
                  progress.onStage?.(
                    `⚠️ Discovery hit max iterations (${discoveryIterationCap}). Increasing preflight cap to ${nextCap} and retrying...`
                  );
                  discoveryIterationCap = nextCap;
                  continue;
                }
              }

              progress.onStage?.(
                `⚠️ Discovery failed (${discoveryTry + 1}/${preflightTotalTries}): ${short}. Retrying discovery...`
              );
              continue;
            }

            // Final discovery failure: degrade gracefully by bootstrapping a fallback plan file
            // so Anton can still proceed to implementation/review instead of hard-failing task 1.
            discoveryUsedFallbackPlan = true;
            const fallbackState = await ensurePlanFileExistsOrBootstrap({
              absPath: plannedFilePath,
              task: currentTask,
              source: 'discovery',
            });
            if (fallbackState === 'bootstrapped') {
              progress.onStage?.(
                `⚠️ Discovery failed after ${preflightTotalTries} tries (${short}). Bootstrapped fallback plan and continuing: ${plannedFilePath}`
              );
            } else {
              progress.onStage?.(
                `⚠️ Discovery failed after ${preflightTotalTries} tries (${short}). Reusing existing plan and continuing: ${plannedFilePath}`
              );
            }
            taskPlanByTaskKey.set(currentTask.key, plannedFilePath);
            discoveryOk = true;
            break;
          }
          // Note: session stays open for reuse in review stage (closed at end of preflight block)
        }

        // Discovery already marked complete -> next task.
        if (preflightMarkedComplete) {
          continue;
        }

        if (!discoveryOk) {
          continue;
        }

        // Stage 2: requirements review (retry review only; keep same plan file).
        // NOTE: Discovery prompt now includes review instructions, producing a "reviewed" plan.
        // Separate review stage is skipped by default to save an LLM round-trip.
        // Set preflightRequirementsReview=true AND preflightSeparateReview=true to force separate review.
        const skipSeparateReview = !config.preflightSeparateReview;
        const forceSeparateReview = config.preflightRequirementsReview && discoveryUsedFallbackPlan;
        if (forceSeparateReview && skipSeparateReview) {
          progress.onStage?.(
            '⚠️ Discovery used a fallback plan; forcing separate requirements review before implementation...'
          );
        }

        if (config.preflightRequirementsReview && (!skipSeparateReview || forceSeparateReview)) {
          const reviewPlanFile = taskPlanByTaskKey.get(currentTask.key) ?? plannedFilePath;
          let reviewOk = false;
          // Default to 30 iterations for review (simpler than discovery, just refining existing plan)
          let reviewIterationCap = Math.max(
            1,
            Math.floor(config.preflightSessionMaxIterations ?? 30)
          );

          for (let reviewTry = 0; reviewTry <= preflightMaxRetries; reviewTry++) {
            const stageStart = Date.now();
            const reviewTimeoutSec = config.preflightReviewTimeoutSec ?? config.taskTimeoutSec;
            const reviewTimeoutMs = reviewTimeoutSec * 1000;

            try {
              progress.onStage?.('🧪 Requirements review: refining plan...');
              // Reuse preflight session from discovery, or create new one if needed (e.g., after error)
              if (!preflightSession) {
                preflightSession = await createSessionFn(
                  buildPreflightConfig(idlehandsConfig, config, reviewTimeoutSec, reviewIterationCap),
                  apiKey
                );
              }

              const reviewPrompt = buildRequirementsReviewPrompt(reviewPlanFile);
              let reviewTimeoutHandle: NodeJS.Timeout;
              const reviewRes = await Promise.race([
                preflightSession.ask(reviewPrompt).finally(() => clearTimeout(reviewTimeoutHandle)),
                new Promise<never>((_, reject) => {
                  reviewTimeoutHandle = setTimeout(() => {
                    try {
                      preflightSession?.cancel();
                    } catch {
                      // best effort
                    }
                    reject(new Error('preflight-review-timeout'));
                  }, reviewTimeoutMs);
                }),
              ]);

              let reviewTokens = preflightSession.usage.prompt + preflightSession.usage.completion;
              totalTokens += reviewTokens;

              // Try to parse review result; if invalid JSON, attempt force-decision prompt
              let review;
              try {
                review = parseRequirementsReviewResult(reviewRes.text, config.projectDir);
              } catch (parseError) {
                const parseErrMsg = parseError instanceof Error ? parseError.message : String(parseError);
                // Only try force-decision for JSON/format errors
                if (/preflight-json-missing-object|preflight-review-invalid/i.test(parseErrMsg)) {
                  progress.onStage?.('⚠️ Review output invalid, requesting forced decision...');
                  try {
                    const forceRes = await preflightSession.ask(FORCE_REVIEW_DECISION_PROMPT);
                    const forceTokens = preflightSession.usage.prompt + preflightSession.usage.completion - reviewTokens;
                    reviewTokens += forceTokens;
                    totalTokens += forceTokens;
                    review = parseRequirementsReviewResult(forceRes.text, config.projectDir);
                    progress.onStage?.('✅ Forced decision succeeded');
                  } catch (forceError) {
                    // Force-decision also failed, throw original error
                    throw parseError;
                  }
                } else {
                  throw parseError;
                }
              }

              let reviewedPlanPath = review.filename;
              for (let writeFixTry = 0; writeFixTry < 2; writeFixTry++) {
                try {
                  await assertPlanFileExistsAndNonEmpty(reviewedPlanPath);
                  break;
                } catch (planErr) {
                  const planMsg = planErr instanceof Error ? planErr.message : String(planErr);
                  const reason = /preflight-plan-empty/i.test(planMsg)
                    ? 'empty file'
                    : /preflight-plan-not-a-file/i.test(planMsg)
                      ? 'not a regular file'
                      : /ENOENT/i.test(planMsg)
                        ? 'missing file'
                        : planMsg;

                  if (writeFixTry === 0) {
                    progress.onStage?.(
                      `⚠️ Requirements review returned filename but file is invalid (${reason}). Asking model to rewrite plan file...`
                    );
                    const rewriteRes = await preflightSession.ask(
                      buildReviewRewritePrompt(reviewedPlanPath, reason)
                    );
                    const rewriteTokens =
                      preflightSession.usage.prompt + preflightSession.usage.completion - reviewTokens;
                    reviewTokens += rewriteTokens;
                    totalTokens += rewriteTokens;

                    try {
                      const rewritten = parseRequirementsReviewResult(rewriteRes.text, config.projectDir);
                      if (rewritten.status === 'ready') {
                        reviewedPlanPath = rewritten.filename;
                      }
                    } catch {
                      // Keep existing path; second validation pass decides fallback.
                    }
                    continue;
                  }

                  const reviewPlanState = await ensurePlanFileExistsOrBootstrap({
                    absPath: reviewedPlanPath,
                    task: currentTask,
                    source: 'requirements-review',
                  });
                  if (reviewPlanState === 'bootstrapped') {
                    progress.onStage?.(
                      `⚠️ Requirements review returned a filename but did not write valid contents. Created fallback plan file: ${reviewedPlanPath}`
                    );
                  }
                }
              }

              preflightRecords.push({
                taskKey: currentTask.key,
                stage: 'requirements-review',
                durationMs: Date.now() - stageStart,
                tokensUsed: reviewTokens,
                status: 'ready',
                filename: reviewedPlanPath,
              });

              taskPlanByTaskKey.set(currentTask.key, reviewedPlanPath);
              progress.onStage?.(`✅ Requirements review ready: ${reviewedPlanPath}`);
              reviewOk = true;
              break;
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : String(error);
              const timeout = /timeout/i.test(errMsg);

              preflightRecords.push({
                taskKey: currentTask.key,
                stage: 'requirements-review',
                durationMs: Date.now() - stageStart,
                tokensUsed: 0,
                status: timeout ? 'timeout' : 'error',
                error: errMsg,
              });

              const short = errMsg.length > 180 ? `${errMsg.slice(0, 177)}...` : errMsg;

              // If review returns malformed/non-JSON output, keep moving with existing plan
              // only when discovery already produced a real plan. If discovery used fallback,
              // require a valid review result before proceeding to implementation.
              if (isRecoverablePreflightReviewError(errMsg)) {
                if (!forceSeparateReview) {
                  const fallbackState = await ensurePlanFileExistsOrBootstrap({
                    absPath: reviewPlanFile,
                    task: currentTask,
                    source: 'requirements-review',
                  });
                  if (fallbackState === 'bootstrapped') {
                    progress.onStage?.(
                      `⚠️ Requirements review returned invalid output (${short}). Bootstrapped fallback plan and continuing: ${reviewPlanFile}`
                    );
                  } else {
                    progress.onStage?.(
                      `⚠️ Requirements review returned invalid output (${short}). Reusing existing plan and continuing: ${reviewPlanFile}`
                    );
                  }
                  taskPlanByTaskKey.set(currentTask.key, reviewPlanFile);
                  reviewOk = true;
                  break;
                }

                progress.onStage?.(
                  `⚠️ Requirements review returned invalid output (${short}). Discovery fallback plan requires a valid review, retrying...`
                );
              }

              if (reviewTry < preflightMaxRetries) {
                // Close session on error so retry gets fresh state
                await closePreflightSession();

                if (/max iterations exceeded/i.test(errMsg)) {
                  const nextCap = Math.min(
                    Math.max(reviewIterationCap * 2, reviewIterationCap + 2),
                    1000
                  );
                  if (nextCap > reviewIterationCap) {
                    progress.onStage?.(
                      `⚠️ Requirements review hit max iterations (${reviewIterationCap}). Increasing preflight cap to ${nextCap} and retrying...`
                    );
                    reviewIterationCap = nextCap;
                    continue;
                  }
                }

                progress.onStage?.(
                  `⚠️ Requirements review failed (${reviewTry + 1}/${preflightTotalTries}): ${short}. Retrying review with existing plan file...`
                );
                continue;
              }

              const preflightAttempt: AntonAttempt = {
                taskKey: currentTask.key,
                taskText: currentTask.text,
                attempt: attemptNumber,
                durationMs: Date.now() - stageStart,
                tokensUsed: 0,
                status: timeout ? 'timeout' : 'error',
                verification: undefined,
                error: `preflight-error(requirements-review): ${errMsg}`,
                commitHash: undefined,
              };
              attempts.push(preflightAttempt);
              taskRetryCount.set(currentTask.key, retries + 1);
              if (!config.skipOnFail) break mainLoop;
            }
            // Note: session stays open, will be closed at end of preflight block
          }

          if (!reviewOk) {
            continue;
          }
        }
        } finally {
          // Always close preflight session at end of preflight block
          await closePreflightSession();
        }
      }

      progress.onStage?.('🛠️ Implementation: executing vetted plan...');

      let session: AgentSession | undefined;
      let attempt: AntonAttempt;
      const taskComplexity = classifyTaskComplexity(currentTask.text);
      const isComplexDecompose =
        config.decompose &&
        currentTask.depth < config.maxDecomposeDepth &&
        taskComplexity === 'complex';

      try {
        // Spawn fresh session per attempt
        const sessionConfig = isComplexDecompose
          ? buildDecomposeConfig(idlehandsConfig, config)
          : buildSessionConfig(idlehandsConfig, config);
        console.error(
          `[anton:debug] task="${currentTask.text}" depth=${currentTask.depth} complexity=${taskComplexity} isComplexDecompose=${isComplexDecompose} no_tools=${!!sessionConfig.no_tools} max_iterations=${sessionConfig.max_iterations}`
        );
        session = await createSessionFn(sessionConfig, apiKey);
        injectAntonResultContract(session);

        // Set up timeout + stop propagation for the currently running attempt.
        // /anton stop flips abortSignal.aborted; we poll that and cancel session.ask immediately
        // instead of waiting for the task attempt to naturally finish.
        const controller = new AbortController();
        const cancelCurrentAttempt = () => {
          if (controller.signal.aborted) return;
          controller.abort();
          try {
            session?.cancel();
          } catch {}
        };

        const timeoutHandle = setTimeout(() => {
          cancelCurrentAttempt();
        }, config.taskTimeoutSec * 1000);

        const abortPoll = setInterval(() => {
          if (abortSignal.aborted) {
            cancelCurrentAttempt();
          }
        }, 250);

        const initialUntrackedFiles = new Set(getUntrackedFiles(config.projectDir));
        const taskStartMs = Date.now();

        try {
          // Build prompt and ask session.
          // If the prompt exceeds budget and we have retryContext, progressively
          // trim the retry context (which includes full command output) until it
          // fits.  This avoids aborting retries just because the error output is
          // too large to include verbatim.
          let effectiveRetryContext = retryContext;
          let prompt = '';
          let estimatedPromptTokens = 0;

          for (let trimPass = 0; trimPass < 3; trimPass++) {
            prompt = await buildAntonPrompt({
              task: currentTask,
              taskFile,
              taskFilePath: config.taskFile,
              projectDir: config.projectDir,
              config,
              retryContext: effectiveRetryContext,
              taskPlanFile: taskPlanByTaskKey.get(currentTask.key),
              vault,
              lens,
              maxContextTokens: idlehandsConfig.context_max_tokens || 8000,
              currentTurn: 1,
              maxIterations: config.taskMaxIterations,
            });

            const promptText = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
            estimatedPromptTokens = estimateTokens(promptText);

            if (estimatedPromptTokens <= config.maxPromptTokensPerAttempt) {
              break; // fits within budget
            }

            // Over budget — try trimming retry context
            if (effectiveRetryContext) {
              if (trimPass === 0) {
                // First trim: cut command output to 1000 chars
                effectiveRetryContext = effectiveRetryContext.replace(
                  /=== Full error output from failed commands ===[\s\S]*?=== End of error output ===/,
                  (m) => {
                    const inner = m.slice(m.indexOf('===\n') + 4, m.lastIndexOf('\n==='));
                    return `=== Error output (trimmed) ===\n${inner.slice(0, 1000)}\n...(truncated)\n=== End of error output ===`;
                  }
                );
                console.error(
                  `[anton:budget] trimPass=1: trimmed retry command output to 1000 chars`
                );
              } else if (trimPass === 1) {
                // Second trim: drop command output entirely, keep just summary
                effectiveRetryContext = effectiveRetryContext.replace(
                  /\n*=== (Full e|E)rror output[\s\S]*?=== End of error output ===\n*/,
                  '\n(Full error output omitted due to prompt budget — run the lint/test command to see errors)\n'
                );
                console.error(`[anton:budget] trimPass=2: dropped retry command output entirely`);
              } else {
                // Third trim: drop retry context entirely
                effectiveRetryContext = undefined;
                console.error(`[anton:budget] trimPass=3: dropped retry context entirely`);
              }
            } else {
              // No retry context to trim — genuinely over budget
              break;
            }
          }

          if (estimatedPromptTokens > config.maxPromptTokensPerAttempt) {
            throw new Error(
              `prompt-budget-exceeded: estimated=${estimatedPromptTokens} max=${config.maxPromptTokensPerAttempt}`
            );
          }

          let result: Awaited<ReturnType<AgentSession['ask']>>;
          let recoveredInfra = false;
          const askHooks = {
            signal: controller.signal,
            onToolLoop: (event: {
              level: string;
              toolName: string;
              count: number;
              message: string;
            }) => {
              try {
                progress.onToolLoop?.(currentTask.text, event);
              } catch {
                /* best effort */
              }
            },
            onCompaction: (event: {
              droppedMessages: number;
              freedTokens: number;
              summaryUsed: boolean;
            }) => {
              try {
                progress.onCompaction?.(currentTask.text, event);
              } catch {
                /* best effort */
              }
            },
            onTurnEnd: (stats: { turn: number; toolCalls: number }) => {
              const tokens = session ? session.usage.prompt + session.usage.completion : 0;
              console.error(
                `[anton:turn] task="${currentTask.text.slice(0, 40)}" turn=${stats.turn} toolCalls=${stats.toolCalls} tokens=${tokens}`
              );
            },
          };
          let toolLoopRetries = 0;
          const toolLoopMaxRetries =
            idlehandsConfig.tool_loop_auto_continue?.enabled !== false
              ? (idlehandsConfig.tool_loop_auto_continue?.max_retries ?? 3)
              : 0;
          while (true) {
            try {
              result = await session.ask(prompt, askHooks as any);
              break;
            } catch (e) {
              // Auto-recover and explicitly report tool-loop outcomes.
              if (isToolLoopBreak(e)) {
                const loopMessage = e instanceof Error ? e.message : String(e);

                if (
                  toolLoopRetries < toolLoopMaxRetries &&
                  !abortSignal.aborted &&
                  !controller.signal.aborted
                ) {
                  toolLoopRetries++;
                  console.error(
                    `[anton] tool-loop auto-continue (retry ${toolLoopRetries}/${toolLoopMaxRetries}) task="${currentTask.text.slice(0, 40)}"`
                  );
                  try {
                    progress.onToolLoop?.(currentTask.text, {
                      level: 'critical',
                      toolName: 'unknown',
                      count: toolLoopRetries,
                      message: `Auto-recovered by continuing (retry ${toolLoopRetries}/${toolLoopMaxRetries})`,
                    });
                  } catch {
                    // best effort
                  }
                  prompt = AUTO_CONTINUE_PROMPT;
                  continue;
                }

                if (!abortSignal.aborted && !controller.signal.aborted) {
                  const finalLoopFailure = `Final loop failure after ${toolLoopRetries}/${toolLoopMaxRetries} auto-retries: ${loopMessage}`;
                  console.error(
                    `[anton] ${finalLoopFailure} task="${currentTask.text.slice(0, 40)}"`
                  );
                  try {
                    progress.onToolLoop?.(currentTask.text, {
                      level: 'critical',
                      toolName: 'unknown',
                      count: Math.max(toolLoopRetries, 1),
                      message: finalLoopFailure,
                    });
                  } catch {
                    // best effort
                  }
                  throw new Error(finalLoopFailure);
                }
              }

              const infraKind = classifyInfraError(e);
              if (
                !runtimeResilienceEnabled ||
                abortSignal.aborted ||
                controller.signal.aborted ||
                recoveredInfra ||
                infraKind === 'other'
              ) {
                throw e;
              }

              const recovery = await ensureAntonRuntimeReady(idlehandsConfig, {
                forceRestart: infraKind === 'infra_down',
                timeoutMs: 180_000,
              });

              if (!recovery.ok) {
                throw new Error(`infra-recovery-failed: ${recovery.detail}`);
              }

              recoveredInfra = true;
              // Retry the same attempt once after infra recovery without incrementing retry counters.
            }
          }

          const taskEndMs = Date.now();
          const durationMs = taskEndMs - taskStartMs;
          let tokensUsed = session.usage.prompt + session.usage.completion;

          // Parse structured result (with one-shot recovery for format-only failures).
          let agentResult = parseAntonResult(result.text);

          if (
            agentResult.status === 'blocked' &&
            isStructuredResultParseFailure(agentResult.reason) &&
            !abortSignal.aborted &&
            !controller.signal.aborted
          ) {
            try {
              progress.onStage?.(
                '⚠️ Agent omitted structured result. Requesting format-only recovery...'
              );
              const repaired = await session.ask(STRUCTURED_RESULT_RECOVERY_PROMPT);
              iterationsUsed += repaired.turns;
              agentResult = parseAntonResult(repaired.text);
              tokensUsed = session.usage.prompt + session.usage.completion;
            } catch (repairErr) {
              console.error(`[anton:result-recovery] failed: ${repairErr}`);
            }
          }

          // If result is still parse-broken, treat as failed (retriable) instead of blocked (terminal).
          if (agentResult.status === 'blocked' && isStructuredResultParseFailure(agentResult.reason)) {
            agentResult = {
              status: 'failed',
              reason: `structured-result-parse-failure: ${agentResult.reason}`,
              subtasks: [],
            };
          }

          // Per-attempt token cost guardrail (not just prompt size).
          if (tokensUsed > config.maxPromptTokensPerAttempt) {
            throw new Error(
              `attempt-token-budget-exceeded: used=${tokensUsed} max=${config.maxPromptTokensPerAttempt}`
            );
          }

          console.error(
            `[anton:result] task="${currentTask.text.slice(0, 50)}" status=${agentResult.status} reason=${agentResult.reason ?? 'none'} subtasks=${agentResult.subtasks.length} tokens=${tokensUsed} duration=${Math.round(durationMs / 1000)}s`
          );
          if (isComplexDecompose) {
            console.error(
              `[anton:debug] decompose result: status=${agentResult.status} subtasks=${agentResult.subtasks.length} reason=${agentResult.reason ?? 'none'}`
            );
            if (
              agentResult.status === 'failed' &&
              (agentResult.reason ?? '').startsWith('structured-result-parse-failure')
            ) {
              console.error(
                `[anton:debug] decompose raw output (first 500 chars): ${(result.text ?? '').slice(0, 500)}`
              );
            }
          }

          let status: AntonAttemptStatus;
          let commitHash: string | undefined;
          let verification;

          if (agentResult.status === 'decompose') {
            // Handle decomposition
            if (config.decompose && currentTask.depth < config.maxDecomposeDepth) {
              await insertSubTasks(config.taskFile, currentTask.key, agentResult.subtasks);
              status = 'decomposed';

              // Check if total tasks exceeded after decomposition
              const updatedTaskFile = await parseTaskFile(config.taskFile);
              if (updatedTaskFile.totalCount > config.maxTotalTasks) {
                status = 'blocked';
              }
            } else {
              status = 'blocked';
            }
          } else if (agentResult.status === 'blocked' || agentResult.status === 'failed') {
            status = agentResult.status;

            if (status === 'blocked') {
              console.error(
                `[anton] Task "${currentTask.text.slice(0, 50)}" agent reported blocked: ${agentResult.reason || 'No reason given'}`
              );
            }
            if (status === 'failed') {
              console.error(
                `[anton] Task "${currentTask.text.slice(0, 50)}" agent reported failure: ${agentResult.reason || 'No reason given'}`
              );

              if (config.rollbackOnFail) {
                console.error(`[anton] Rolling back tracked changes...`);
                await restoreTrackedChanges(config.projectDir);

                if (config.aggressiveCleanOnFail) {
                  console.error(
                    `[anton] Removing all untracked files (aggressiveCleanOnFail=true)...`
                  );
                  await cleanUntracked(config.projectDir);
                } else {
                  const currentUntracked = getUntrackedFiles(config.projectDir);
                  const newlyCreated = currentUntracked.filter(
                    (f) => !initialUntrackedFiles.has(f)
                  );
                  if (newlyCreated.length > 0) {
                    console.error(
                      `[anton] Removing ${newlyCreated.length} newly created files: ${newlyCreated.slice(0, 5).join(', ')}${newlyCreated.length > 5 ? '...' : ''}`
                    );
                    removeUntrackedFiles(config.projectDir, newlyCreated);
                  }
                }
              }
            }
          } else {
            // Run verification
            const diff = await getWorkingDiff(config.projectDir);
            verification = await runVerification({
              agentResult,
              task: currentTask,
              projectDir: config.projectDir,
              commands,
              config,
              diff,
              baselineLintErrorCount,
              createVerifySession: config.verifyAi
                ? async () => {
                    const verifyConfig = buildVerifyConfig(idlehandsConfig, config);
                    const session = await createSessionFn(verifyConfig, apiKey);
                    return {
                      ask: async (prompt: string) => {
                        const result = await session.ask(prompt);
                        return result.text;
                      },
                      close: () => session.close(),
                    };
                  }
                : undefined,
            });

            // Log verification details
            console.error(
              `[anton:verify] task="${currentTask.text.slice(0, 50)}" passed=${verification.passed} l1_build=${verification.l1_build ?? 'n/a'} l1_test=${verification.l1_test ?? 'n/a'} l1_lint=${verification.l1_lint ?? 'n/a'} l2_ai=${verification.l2_ai ?? 'n/a'}`
            );
            if (verification.l2_reason) {
              console.error(`[anton:verify] L2 reason: ${verification.l2_reason.slice(0, 200)}`);
            }
            try {
              progress.onVerification?.(currentTask.text, verification);
            } catch {
              /* best effort */
            }

            if (verification.passed) {
              status = 'passed';

              if (config.autoCommit) {
                // Mark task as checked and auto-complete ancestors first
                await markTaskChecked(config.taskFile, currentTask.key);
                await autoCompleteAncestors(config.taskFile, currentTask.key);

                commitHash = commitAll(config.projectDir, `Anton: ${currentTask.text}`);
                if (commitHash) totalCommits++;
              } else {
                await markTaskChecked(config.taskFile, currentTask.key);
                await autoCompleteAncestors(config.taskFile, currentTask.key);
              }
            } else {
              status = 'failed';

              // Log verification failure details
              console.error(
                `[anton] Task "${currentTask.text.slice(0, 50)}" verification failed: ${verification.summary}`
              );

              if (config.rollbackOnFail) {
                // Restore tracked changes
                console.error(`[anton] Rolling back tracked changes...`);
                await restoreTrackedChanges(config.projectDir);

                if (config.aggressiveCleanOnFail) {
                  console.error(
                    `[anton] Removing all untracked files (aggressiveCleanOnFail=true)...`
                  );
                  await cleanUntracked(config.projectDir);
                } else {
                  const currentUntracked = getUntrackedFiles(config.projectDir);
                  const newlyCreated = currentUntracked.filter(
                    (f) => !initialUntrackedFiles.has(f)
                  );
                  if (newlyCreated.length > 0) {
                    console.error(
                      `[anton] Removing ${newlyCreated.length} newly created files: ${newlyCreated.slice(0, 5).join(', ')}${newlyCreated.length > 5 ? '...' : ''}`
                    );
                    removeUntrackedFiles(config.projectDir, newlyCreated);
                  }
                }
              }
            }
          }

          attempt = {
            taskKey: currentTask.key,
            taskText: currentTask.text,
            attempt: attemptNumber,
            durationMs,
            tokensUsed,
            status,
            verification,
            error: undefined,
            commitHash,
          };

          totalTokens += tokensUsed;
          iterationsUsed++;
        } catch (error) {
          const isTimeout = controller.signal.aborted;
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(
            `[anton:debug] task="${currentTask.key}" error: ${errMsg} (timeout=${isTimeout}, tokens=${session.usage.prompt + session.usage.completion})`
          );
          attempt = {
            taskKey: currentTask.key,
            taskText: currentTask.text,
            attempt: attemptNumber,
            durationMs: Date.now() - taskStartMs,
            tokensUsed: session.usage.prompt + session.usage.completion,
            status: isTimeout ? 'timeout' : 'error',
            verification: undefined,
            error: errMsg,
            commitHash: undefined,
          };

          totalTokens += attempt.tokensUsed;
          // Log error and rollback
          console.error(`[anton] Task "${currentTask.text.slice(0, 50)}" error: ${attempt.error}`);

          if (config.rollbackOnFail) {
            try {
              console.error(`[anton] Rolling back tracked changes...`);
              await restoreTrackedChanges(config.projectDir);

              if (config.aggressiveCleanOnFail) {
                console.error(
                  `[anton] Removing all untracked files (aggressiveCleanOnFail=true)...`
                );
                await cleanUntracked(config.projectDir);
              } else {
                const currentUntracked = getUntrackedFiles(config.projectDir);
                const newlyCreated = currentUntracked.filter((f) => !initialUntrackedFiles.has(f));
                if (newlyCreated.length > 0) {
                  console.error(
                    `[anton] Removing ${newlyCreated.length} newly created files: ${newlyCreated.slice(0, 5).join(', ')}${newlyCreated.length > 5 ? '...' : ''}`
                  );
                  removeUntrackedFiles(config.projectDir, newlyCreated);
                }
              }
            } catch (rollbackErr) {
              console.error(`[anton] Rollback error: ${rollbackErr}`);
            }
          }
        } finally {
          clearTimeout(timeoutHandle);
          clearInterval(abortPoll);
        }
      } finally {
        if (session) {
          await session.close();
        }
      }

      attempts.push(attempt);

      // Update retry count and record failure reason for next attempt
      if (attempt.status !== 'passed' && attempt.status !== ('decomposed' as any)) {
        // Blocked tasks should NOT be retried — a blocked status means the agent
        // cannot complete the task regardless of how many retries we give it.
        if (attempt.status === 'blocked') {
          // Immediately exhaust retries so the task is skipped on next loop iteration
          taskRetryCount.set(currentTask.key, config.maxRetriesPerTask);
        } else if (
          (attempt.error ?? '').startsWith('prompt-budget-exceeded') ||
          (attempt.error ?? '').startsWith('attempt-token-budget-exceeded')
        ) {
          // Don't burn retries/tokens on oversized prompts/attempts.
          taskRetryCount.set(currentTask.key, config.maxRetriesPerTask);
        } else {
          taskRetryCount.set(currentTask.key, attemptNumber);
        }

        // Track consecutive identical failures for dedup guard
        const currentReason = attempt.verification?.summary ?? attempt.error ?? 'unknown';
        const prevReason = lastFailureReason.get(currentTask.key);
        if (prevReason && prevReason === currentReason) {
          consecutiveIdenticalCount.set(
            currentTask.key,
            (consecutiveIdenticalCount.get(currentTask.key) || 0) + 1
          );
        } else {
          // Different failure — reset the consecutive counter
          consecutiveIdenticalCount.set(currentTask.key, 1);
        }

        lastFailureReason.set(currentTask.key, currentReason);

        // Track L2-specific failures for enhanced retry context
        if (attempt.verification?.l2_ai === false) {
          l2FailCount.set(currentTask.key, (l2FailCount.get(currentTask.key) || 0) + 1);
          console.error(
            `[anton:l2-fail] task="${currentTask.text.slice(0, 40)}" l2_fail_count=${l2FailCount.get(currentTask.key)}`
          );
        }
      } else {
        // Task passed — reset L2 fail count
        l2FailCount.delete(currentTask.key);
      }

      // Report task end
      progress.onTaskEnd(currentTask, attempt, currentProgress);

      const isUnskippableBlock = attempt.status === 'blocked' && !config.skipOnBlocked;

      // Blocked tasks break immediately — they can't be fixed by retrying.
      if (isUnskippableBlock) {
        break mainLoop;
      }

      // For failed/error tasks: only break if retries are exhausted.
      // The retry loop at the top of mainLoop handles re-attempts and will
      // break when maxRetriesPerTask is reached (if skipOnFail is false).
      // Previously this broke immediately on the first failure, preventing
      // the AI from fixing verification errors (e.g. lint) on retry.
      const isFail = attempt.status === 'failed' || attempt.status === 'error';
      if (isFail && !config.skipOnFail) {
        const retries = taskRetryCount.get(currentTask.key) || 0;
        if (retries >= config.maxRetriesPerTask) {
          break mainLoop;
        }
        // Otherwise, let the loop continue — the top-of-loop retry check
        // will pick this task up again with retryContext containing the
        // verification failure details so the AI can fix the issue.
      }
    }

    // Final task file parse to get current state
    const finalTaskFile = await parseTaskFile(config.taskFile);
    const finalCompleted = finalTaskFile.completed.length - initialCompleted;
    const skipped = attempts.filter((a) => a.status === 'skipped').length;

    // Count failures by FINAL per-task outcome, not per-attempt outcome.
    // A task that fails on attempt #1 and passes on retry should not contribute
    // to failed summary counts.
    const lastAttemptByTask = new Map<string, AntonAttempt>();
    for (const attempt of attempts) {
      lastAttemptByTask.set(attempt.taskKey, attempt);
    }
    const failed = Array.from(lastAttemptByTask.values()).filter((a) =>
      ['failed', 'error', 'timeout', 'blocked'].includes(a.status)
    ).length;

    const remaining = finalTaskFile.pending.length;

    // Determine stop reason
    let stopReason: AntonStopReason;
    if (abortSignal.aborted) {
      stopReason = 'abort';
    } else if (iterationsUsed >= config.maxIterations) {
      stopReason = 'max_iterations';
    } else if (Date.now() - startTimeMs >= config.totalTimeoutSec * 1000) {
      stopReason = 'total_timeout';
    } else if (totalTokens >= config.maxTotalTokens) {
      stopReason = 'token_budget';
    } else if (finalTaskFile.totalCount > config.maxTotalTasks) {
      stopReason = 'max_tasks_exceeded';
    } else if (failed > 0 && !config.skipOnFail) {
      stopReason = 'fatal_error';
    } else {
      stopReason = 'all_done';
    }

    const result: AntonRunResult = {
      totalTasks: taskFile.totalCount,
      preCompleted: initialCompleted,
      completed: finalCompleted,
      autoCompleted,
      skipped,
      failed,
      remaining,
      attempts,
      preflightRecords,
      totalDurationMs: Date.now() - startTimeMs,
      totalTokens,
      totalCommits,
      completedAll: remaining === 0,
      stopReason,
    };

    progress.onRunComplete(result);
    return result;
  } finally {
    if (lockHeartbeatTimer) {
      clearInterval(lockHeartbeatTimer);
      lockHeartbeatTimer = null;
    }

    // 8. Lock release in finally
    if (lockAcquired) {
      await releaseAntonLock();
    }

    process.off('SIGINT', handleAbort);
  }
}
