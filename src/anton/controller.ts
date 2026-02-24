/**
 * Anton autonomous task runner — main orchestrator.
 *
 * Coordinates all components: parser, prompt, verifier, lock, git, session.
 * Structured as a deterministic orchestration flow for autonomous task execution.
 */

import type { AgentSession } from '../agent.js';
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
import { execute, loadActiveRuntime, runOnHost } from '../runtime/executor.js';
import { waitForModelsReady } from '../runtime/health.js';
import { plan } from '../runtime/planner.js';
import { loadRuntimes } from '../runtime/store.js';
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
import { buildAntonPrompt, parseAntonResult, classifyTaskComplexity } from './prompt.js';
import {
  ensureAgentsTasksDir,
  makeUniqueTaskPlanFilename,
  buildDiscoveryPrompt,
  parseDiscoveryResult,
  buildRequirementsReviewPrompt,
  parseRequirementsReviewResult,
  ensurePlanFileExistsOrBootstrap,
} from './preflight.js';
import { formatDryRunPlan } from './reporter.js';
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
import { isToolLoopBreak, AUTO_CONTINUE_PROMPT } from '../bot/auto-continue.js';

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

function endpointBase(endpoint?: string): string | null {
  if (!endpoint) return null;
  const e = endpoint.trim().replace(/\/+$/, '');
  if (!e) return null;
  return e.endsWith('/v1') ? e : `${e}/v1`;
}

async function probeEndpointReady(endpoint?: string): Promise<{ ok: boolean; reason: string }> {
  const base = endpointBase(endpoint);
  if (!base) return { ok: false, reason: 'endpoint-not-configured' };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(`${base}/models`, { signal: ctrl.signal as any });
    if (res.status === 503) return { ok: false, reason: 'loading-http-503' };
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    return { ok: true, reason: 'ok' };
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    if (msg.includes('aborted')) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: msg.slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}

function classifyInfraError(err: unknown): 'infra_down' | 'loading' | 'other' {
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
  if (!msg) return 'other';
  if (msg.includes('aborted') || msg.includes('cancel')) return 'other';

  if (msg.includes('503') || msg.includes('model is loading') || msg.includes('loading')) {
    return 'loading';
  }

  const infraPatterns = [
    'econnrefused',
    'could not connect',
    'connection refused',
    'enotfound',
    'fetch failed',
    'connect timeout',
    'socket hang up',
    'no models found',
    'endpoint',
  ];

  if (infraPatterns.some((p) => msg.includes(p))) {
    return 'infra_down';
  }

  return 'other';
}

async function ensureAntonRuntimeReady(
  idlehandsConfig: IdlehandsConfig,
  opts: { forceRestart: boolean; timeoutMs?: number }
): Promise<{ ok: boolean; detail: string }> {
  const endpointProbe = await probeEndpointReady(idlehandsConfig.endpoint);
  if (endpointProbe.ok) return { ok: true, detail: 'endpoint-ready' };

  // Try runtime orchestration recovery when endpoint probe fails.
  let rtConfig;
  try {
    rtConfig = await loadRuntimes();
  } catch {
    return {
      ok: false,
      detail: `endpoint-not-ready (${endpointProbe.reason}); runtimes-unavailable`,
    };
  }

  const active = await loadActiveRuntime();
  let targetModelId: string | undefined;

  if (active?.modelId && rtConfig.models.some((m) => m.id === active.modelId && m.enabled)) {
    targetModelId = active.modelId;
  } else if (
    typeof idlehandsConfig.model === 'string' &&
    rtConfig.models.some((m) => m.id === idlehandsConfig.model && m.enabled)
  ) {
    targetModelId = idlehandsConfig.model;
  }

  if (!targetModelId) {
    return {
      ok: false,
      detail: `endpoint-not-ready (${endpointProbe.reason}); no-runtime-model-mapping`,
    };
  }

  const planOut = plan(
    { modelId: targetModelId, mode: 'live', forceRestart: opts.forceRestart },
    rtConfig,
    active
  );
  if (!planOut.ok) {
    return { ok: false, detail: `runtime-plan-failed ${planOut.code}: ${planOut.reason}` };
  }

  const execRes = await execute(planOut, {
    force: true,
    confirm: async () => true,
  });

  if (!execRes.ok) {
    return { ok: false, detail: `runtime-exec-failed: ${execRes.error ?? 'unknown'}` };
  }

  const timeoutMs = Math.max(
    10_000,
    opts.timeoutMs ?? (planOut.model.launch.probe_timeout_sec ?? 600) * 1000
  );
  for (const resolvedHost of planOut.hosts) {
    const hostCfg = rtConfig.hosts.find((h) => h.id === resolvedHost.id);
    if (!hostCfg) continue;
    const ready = await waitForModelsReady(
      runOnHost as any,
      hostCfg,
      planOut.model.runtime_defaults?.port ?? 8080,
      {
        timeoutMs,
        intervalMs: planOut.model.launch.probe_interval_ms ?? 2000,
      }
    );
    if (!ready.ok) {
      return {
        ok: false,
        detail: `wait-ready failed on ${resolvedHost.id}: ${ready.reason ?? 'timeout'}`,
      };
    }
  }

  return { ok: true, detail: 'runtime-ready' };
}

/**
 * Main Anton orchestrator.
 */
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
      } catch { }
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
          if (v.l2_ai === false && v.l2_reason) parts.push(`- AI review: ${v.l2_reason}`);

          // Include error output (filtered to errors only, no warnings) so the
          // agent can see and fix the exact issues.
          if (v.commandOutput) {
            parts.push('');
            parts.push('=== Error output (errors only, warnings excluded) ===');
            parts.push(v.commandOutput);
            parts.push('=== End of error output ===');
            parts.push('');
            parts.push('IMPORTANT: Your previous code changes are STILL IN PLACE — do NOT rewrite from scratch.');
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

        progress.onTaskSkip(currentTask, `${maxIdentical} consecutive identical failures`, currentProgress);

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

      // Optional preflight pipeline: discovery -> requirements review.
      // Runs on first attempt for each task. Retries are stage-local to avoid churn.
      if (config.preflightEnabled && retries === 0) {
        const preflightMaxRetries = Math.max(0, config.preflightMaxRetries ?? 2);
        const preflightTotalTries = preflightMaxRetries + 1;
        let preflightMarkedComplete = false;
        let discoveryOk = false;

        await ensureAgentsTasksDir(config.projectDir);
        const plannedFilePath =
          taskPlanByTaskKey.get(currentTask.key) ?? makeUniqueTaskPlanFilename(config.projectDir);
        let discoveryIterationCap = Math.max(
          1,
          Math.floor(config.preflightSessionMaxIterations ?? 500)
        );

        // Stage 1: discovery (retry discovery only).
        for (let discoveryTry = 0; discoveryTry <= preflightMaxRetries; discoveryTry++) {
          const stageStart = Date.now();
          const discoveryTimeoutSec = config.preflightDiscoveryTimeoutSec ?? config.taskTimeoutSec;
          const discoveryTimeoutMs = discoveryTimeoutSec * 1000;
          let discoverySession: AgentSession | undefined;

          try {
            progress.onStage?.('🔎 Discovery: checking if already done...');
            discoverySession = await createSessionFn(
              buildPreflightConfig(
                idlehandsConfig,
                config,
                discoveryTimeoutSec,
                discoveryIterationCap
              ),
              apiKey
            );

            const discoveryPrompt = buildDiscoveryPrompt({
              task: currentTask,
              taskFilePath: config.taskFile,
              projectDir: config.projectDir,
              planFilePath: plannedFilePath,
            });

            const discoveryRes = await Promise.race([
              discoverySession.ask(discoveryPrompt),
              new Promise<never>((_, reject) =>
                setTimeout(() => {
                  try {
                    discoverySession?.cancel();
                  } catch {
                    // best effort
                  }
                  reject(new Error('preflight-discovery-timeout'));
                }, discoveryTimeoutMs)
              ),
            ]);

            const discoveryTokens = discoverySession.usage.prompt + discoverySession.usage.completion;
            totalTokens += discoveryTokens;
            const discovery = parseDiscoveryResult(discoveryRes.text, config.projectDir);

            preflightRecords.push({
              taskKey: currentTask.key,
              stage: 'discovery',
              durationMs: Date.now() - stageStart,
              tokensUsed: discoveryTokens,
              status: discovery.status,
              filename: discovery.filename || undefined,
            });

            if (discovery.status === 'complete') {
              await markTaskChecked(config.taskFile, currentTask.key);
              await autoCompleteAncestors(config.taskFile, currentTask.key);
              autoCompleted += 1;
              progress.onStage?.(`✅ Discovery confirmed already complete: ${currentTask.text}`);
              preflightMarkedComplete = true;
              discoveryOk = true;
              break;
            }

            const discoveryPlanState = await ensurePlanFileExistsOrBootstrap({
              absPath: discovery.filename,
              task: currentTask,
              source: 'discovery',
            });
            if (discoveryPlanState === 'bootstrapped') {
              progress.onStage?.(
                `⚠️ Discovery returned a filename but did not write it. Created fallback plan file: ${discovery.filename}`
              );
            }

            taskPlanByTaskKey.set(currentTask.key, discovery.filename);
            progress.onStage?.(`📝 Discovery plan file: ${discovery.filename}`);
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

            if (discoveryTry < preflightMaxRetries) {
              const short = errMsg.length > 180 ? `${errMsg.slice(0, 177)}...` : errMsg;

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

            const preflightAttempt: AntonAttempt = {
              taskKey: currentTask.key,
              taskText: currentTask.text,
              attempt: attemptNumber,
              durationMs: Date.now() - stageStart,
              tokensUsed: 0,
              status: timeout ? 'timeout' : 'error',
              verification: undefined,
              error: `preflight-error(discovery): ${errMsg}`,
              commitHash: undefined,
            };
            attempts.push(preflightAttempt);
            taskRetryCount.set(currentTask.key, retries + 1);
            if (!config.skipOnFail) break mainLoop;
          } finally {
            try {
              await discoverySession?.close();
            } catch {
              // best effort
            }
          }
        }

        // Discovery already marked complete -> next task.
        if (preflightMarkedComplete) {
          continue;
        }

        if (!discoveryOk) {
          continue;
        }

        // Stage 2: requirements review (retry review only; keep same plan file).
        if (config.preflightRequirementsReview) {
          const reviewPlanFile = taskPlanByTaskKey.get(currentTask.key) ?? plannedFilePath;
          let reviewOk = false;
          let reviewIterationCap = Math.max(
            1,
            Math.floor(config.preflightSessionMaxIterations ?? 500)
          );

          for (let reviewTry = 0; reviewTry <= preflightMaxRetries; reviewTry++) {
            const stageStart = Date.now();
            const reviewTimeoutSec = config.preflightReviewTimeoutSec ?? config.taskTimeoutSec;
            const reviewTimeoutMs = reviewTimeoutSec * 1000;
            let reviewSession: AgentSession | undefined;

            try {
              progress.onStage?.('🧪 Requirements review: refining plan...');
              reviewSession = await createSessionFn(
                buildPreflightConfig(idlehandsConfig, config, reviewTimeoutSec, reviewIterationCap),
                apiKey
              );

              const reviewPrompt = buildRequirementsReviewPrompt(reviewPlanFile);
              const reviewRes = await Promise.race([
                reviewSession.ask(reviewPrompt),
                new Promise<never>((_, reject) =>
                  setTimeout(() => {
                    try {
                      reviewSession?.cancel();
                    } catch {
                      // best effort
                    }
                    reject(new Error('preflight-review-timeout'));
                  }, reviewTimeoutMs)
                ),
              ]);

              const reviewTokens = reviewSession.usage.prompt + reviewSession.usage.completion;
              totalTokens += reviewTokens;
              const review = parseRequirementsReviewResult(reviewRes.text, config.projectDir);

              const reviewPlanState = await ensurePlanFileExistsOrBootstrap({
                absPath: review.filename,
                task: currentTask,
                source: 'requirements-review',
              });
              if (reviewPlanState === 'bootstrapped') {
                progress.onStage?.(
                  `⚠️ Requirements review returned a filename but did not write it. Created fallback plan file: ${review.filename}`
                );
              }

              preflightRecords.push({
                taskKey: currentTask.key,
                stage: 'requirements-review',
                durationMs: Date.now() - stageStart,
                tokensUsed: reviewTokens,
                status: 'ready',
                filename: review.filename,
              });

              taskPlanByTaskKey.set(currentTask.key, review.filename);
              progress.onStage?.(`✅ Requirements review ready: ${review.filename}`);
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

              if (reviewTry < preflightMaxRetries) {
                const short = errMsg.length > 180 ? `${errMsg.slice(0, 177)}...` : errMsg;

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
            } finally {
              try {
                await reviewSession?.close();
              } catch {
                // best effort
              }
            }
          }

          if (!reviewOk) {
            continue;
          }
        }
      }

      progress.onStage?.('🛠️ Implementation: executing vetted plan...');
      progress.onTaskStart(currentTask, attemptNumber, currentProgress);

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
        console.error(`[anton:debug] task="${currentTask.text}" depth=${currentTask.depth} complexity=${taskComplexity} isComplexDecompose=${isComplexDecompose} no_tools=${!!sessionConfig.no_tools} max_iterations=${sessionConfig.max_iterations}`);
        session = await createSessionFn(sessionConfig, apiKey);

        // Set up timeout + stop propagation for the currently running attempt.
        // /anton stop flips abortSignal.aborted; we poll that and cancel session.ask immediately
        // instead of waiting for the task attempt to naturally finish.
        const controller = new AbortController();
        const cancelCurrentAttempt = () => {
          if (controller.signal.aborted) return;
          controller.abort();
          try {
            session?.cancel();
          } catch { }
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
                effectiveRetryContext = effectiveRetryContext
                  .replace(
                    /=== Full error output from failed commands ===[\s\S]*?=== End of error output ===/,
                    (m) => {
                      const inner = m.slice(m.indexOf('===\n') + 4, m.lastIndexOf('\n==='));
                      return `=== Error output (trimmed) ===\n${inner.slice(0, 1000)}\n...(truncated)\n=== End of error output ===`;
                    }
                  );
                console.error(`[anton:budget] trimPass=1: trimmed retry command output to 1000 chars`);
              } else if (trimPass === 1) {
                // Second trim: drop command output entirely, keep just summary
                effectiveRetryContext = effectiveRetryContext
                  .replace(
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
            onToolLoop: (event: { level: string; toolName: string; count: number; message: string }) => {
              try { progress.onToolLoop?.(currentTask.text, event); } catch { /* best effort */ }
            },
            onCompaction: (event: { droppedMessages: number; freedTokens: number; summaryUsed: boolean }) => {
              try { progress.onCompaction?.(currentTask.text, event); } catch { /* best effort */ }
            },
            onTurnEnd: (stats: { turn: number; toolCalls: number }) => {
              const tokens = session ? (session.usage.prompt + session.usage.completion) : 0;
              console.error(`[anton:turn] task="${currentTask.text.slice(0, 40)}" turn=${stats.turn} toolCalls=${stats.toolCalls} tokens=${tokens}`);
            },
          };
          let toolLoopRetries = 0;
          const toolLoopMaxRetries = idlehandsConfig.tool_loop_auto_continue?.enabled !== false
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
          const tokensUsed = session.usage.prompt + session.usage.completion;

          // Per-attempt token cost guardrail (not just prompt size).
          if (tokensUsed > config.maxPromptTokensPerAttempt) {
            throw new Error(
              `attempt-token-budget-exceeded: used=${tokensUsed} max=${config.maxPromptTokensPerAttempt}`
            );
          }

          // Parse structured result
          const agentResult = parseAntonResult(result.text);
          console.error(`[anton:result] task="${currentTask.text.slice(0, 50)}" status=${agentResult.status} reason=${agentResult.reason ?? 'none'} subtasks=${agentResult.subtasks.length} tokens=${tokensUsed} duration=${Math.round(durationMs / 1000)}s`);
          if (isComplexDecompose) {
            console.error(`[anton:debug] decompose result: status=${agentResult.status} subtasks=${agentResult.subtasks.length} reason=${agentResult.reason ?? 'none'}`);
            if (agentResult.status === 'blocked' && agentResult.reason === 'Agent did not emit structured result') {
              console.error(`[anton:debug] decompose raw output (first 500 chars): ${(result.text ?? '').slice(0, 500)}`);
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
                  console.error(`[anton] Removing all untracked files (aggressiveCleanOnFail=true)...`);
                  await cleanUntracked(config.projectDir);
                } else {
                  const currentUntracked = getUntrackedFiles(config.projectDir);
                  const newlyCreated = currentUntracked.filter((f) => !initialUntrackedFiles.has(f));
                  if (newlyCreated.length > 0) {
                    console.error(`[anton] Removing ${newlyCreated.length} newly created files: ${newlyCreated.slice(0, 5).join(', ')}${newlyCreated.length > 5 ? '...' : ''}`);
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
            console.error(`[anton:verify] task="${currentTask.text.slice(0, 50)}" passed=${verification.passed} l1_build=${verification.l1_build ?? 'n/a'} l1_test=${verification.l1_test ?? 'n/a'} l1_lint=${verification.l1_lint ?? 'n/a'} l2_ai=${verification.l2_ai ?? 'n/a'}`);
            if (verification.l2_reason) {
              console.error(`[anton:verify] L2 reason: ${verification.l2_reason.slice(0, 200)}`);
            }
            try { progress.onVerification?.(currentTask.text, verification); } catch { /* best effort */ }

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
                  console.error(`[anton] Removing all untracked files (aggressiveCleanOnFail=true)...`);
                  await cleanUntracked(config.projectDir);
                } else {
                  const currentUntracked = getUntrackedFiles(config.projectDir);
                  const newlyCreated = currentUntracked.filter((f) => !initialUntrackedFiles.has(f));
                  if (newlyCreated.length > 0) {
                    console.error(`[anton] Removing ${newlyCreated.length} newly created files: ${newlyCreated.slice(0, 5).join(', ')}${newlyCreated.length > 5 ? '...' : ''}`);
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
          console.error(`[anton:debug] task="${currentTask.key}" error: ${errMsg} (timeout=${isTimeout}, tokens=${session.usage.prompt + session.usage.completion})`);
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
          console.error(
            `[anton] Task "${currentTask.text.slice(0, 50)}" error: ${attempt.error}`
          );

          if (config.rollbackOnFail) {
            try {
              console.error(`[anton] Rolling back tracked changes...`);
              await restoreTrackedChanges(config.projectDir);

              if (config.aggressiveCleanOnFail) {
                console.error(`[anton] Removing all untracked files (aggressiveCleanOnFail=true)...`);
                await cleanUntracked(config.projectDir);
              } else {
                const currentUntracked = getUntrackedFiles(config.projectDir);
                const newlyCreated = currentUntracked.filter((f) => !initialUntrackedFiles.has(f));
                if (newlyCreated.length > 0) {
                  console.error(`[anton] Removing ${newlyCreated.length} newly created files: ${newlyCreated.slice(0, 5).join(', ')}${newlyCreated.length > 5 ? '...' : ''}`);
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
      const isFail = (attempt.status === 'failed' || attempt.status === 'error');
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
