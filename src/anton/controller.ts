/**
 * Anton autonomous task runner — main orchestrator.
 *
 * Coordinates all components: parser, prompt, verifier, lock, git, session.
 * Reads like a recipe following the TASKS.md Phase F pseudocode exactly.
 */

import type { 
  AntonRunConfig, 
  AntonRunResult, 
  AntonProgressCallback, 
  AntonProgress, 
  AntonAttempt, 
  AntonStopReason,
  AntonTask,
  AntonTaskFile,
  AntonAttemptStatus
} from './types.js';
import type { IdlehandsConfig } from '../types.js';
import type { AgentSession } from '../agent.js';
import type { VaultStore } from '../vault.js';
import type { LensStore } from '../lens.js';
import { 
  parseTaskFile, 
  findRunnablePendingTasks, 
  markTaskChecked, 
  appendTaskNote, 
  insertSubTasks, 
  autoCompleteAncestors 
} from './parser.js';
import { buildAntonPrompt, parseAntonResult } from './prompt.js';
import { detectVerificationCommands, runVerification } from './verifier.js';
import { acquireAntonLock, releaseAntonLock } from './lock.js';
import { buildSessionConfig, buildVerifyConfig, defaultCreateSession } from './session.js';
import { formatDryRunPlan } from './reporter.js';
import { 
  ensureCleanWorkingTree, 
  getWorkingDiff, 
  commitAll, 
  commitAmend, 
  restoreTrackedChanges, 
  cleanUntracked, 
  createBranch, 
  isGitDirty 
} from '../git.js';

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

/**
 * Main Anton orchestrator. Follows Phase F pseudocode exactly.
 */
export async function runAnton(opts: RunAntonOpts): Promise<AntonRunResult> {
  const { config, idlehandsConfig, progress, abortSignal, apiKey, vault, lens } = opts;
  const createSessionFn = opts.createSession || defaultCreateSession;
  
  const startTimeMs = Date.now();
  let lockAcquired = false;
  let totalTokens = 0;
  let totalCommits = 0;
  let iterationsUsed = 0;
  const attempts: AntonAttempt[] = [];
  let taskRetryCount: Map<string, number> = new Map();
  
  // SIGINT handler
  const handleAbort = () => {
    abortSignal.aborted = true;
  };
  process.on('SIGINT', handleAbort);
  
  try {
    // 1. Acquire Anton lock
    await acquireAntonLock(config.taskFile, config.projectDir);
    lockAcquired = true;
    
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
        skipped: 0,
        failed: 0,
        remaining: taskFile.pending.length,
        attempts: [],
        totalDurationMs: Date.now() - startTimeMs,
        totalTokens: 0,
        totalCommits: 0,
        completedAll: false,
        stopReason: 'all_done',
      };
    }
    
    // 7. Main loop
    mainLoop: while (true) {
      // Re-parse task file each iteration
      taskFile = await parseTaskFile(config.taskFile);
      
      // Find runnable pending tasks
      const skippedKeys = new Set(attempts.filter(a => a.status === 'skipped').map(a => a.taskKey));
      const runnableTasks = findRunnablePendingTasks(taskFile, skippedKeys);
      if (runnableTasks.length === 0) break; // No more work
      
      const currentTask = runnableTasks[0];
      
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
        skippedSoFar: attempts.filter(a => a.status === 'skipped').length,
        iterationsUsed,
        elapsedMs: Date.now() - startTimeMs,
        estimatedRemainingMs: undefined,
      };

      // Handle max retries
      const retries = taskRetryCount.get(currentTask.key) || 0;
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
      progress.onTaskStart(currentTask, attemptNumber, currentProgress);
      
      let session: AgentSession | undefined;
      let attempt: AntonAttempt;
      
      try {
        // Spawn fresh session per attempt
        const sessionConfig = buildSessionConfig(idlehandsConfig, config);
        session = await createSessionFn(sessionConfig, apiKey);
        
        // Set up timeout
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => {
          controller.abort();
          session?.cancel();
        }, config.taskTimeoutSec * 1000);
        
        try {
          const taskStartMs = Date.now();
          
          // Build prompt and ask session
          const prompt = await buildAntonPrompt({
            task: currentTask,
            taskFile,
            taskFilePath: config.taskFile,
            projectDir: config.projectDir,
            config,
            retryContext: undefined,
            vault,
            lens,
            maxContextTokens: idlehandsConfig.context_max_tokens || 8000,
          });
          const result = await session.ask(prompt);
          
          clearTimeout(timeoutHandle);
          
          const taskEndMs = Date.now();
          const durationMs = taskEndMs - taskStartMs;
          const tokensUsed = session.usage.prompt + session.usage.completion;
          
          // Parse structured result
          const agentResult = parseAntonResult(result.text);
          
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
          } else if (agentResult.status === 'blocked') {
            status = 'blocked';
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
              createVerifySession: config.verifyAi ? async () => {
                const verifyConfig = buildVerifyConfig(idlehandsConfig, config);
                const session = await createSessionFn(verifyConfig, apiKey);
                return {
                  ask: async (prompt: string) => {
                    const result = await session.ask(prompt);
                    return result.text;
                  },
                  close: () => session.close(),
                };
              } : undefined,
            });
            
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
              
              // Restore tracked changes
              await restoreTrackedChanges(config.projectDir);
              
              if (config.aggressiveCleanOnFail) {
                await cleanUntracked(config.projectDir);
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
          clearTimeout(timeoutHandle);
          
          const isTimeout = controller.signal.aborted;
          attempt = {
            taskKey: currentTask.key,
            taskText: currentTask.text,
            attempt: attemptNumber,
            durationMs: Date.now() - startTimeMs,
            tokensUsed: session.usage.prompt + session.usage.completion,
            status: isTimeout ? 'timeout' : 'error',
            verification: undefined,
            error: error instanceof Error ? error.message : String(error),
            commitHash: undefined,
          };
          
          totalTokens += attempt.tokensUsed;
        }
        
      } finally {
        if (session) {
          await session.close();
        }
      }
      
      attempts.push(attempt);
      
      // Update retry count
      if (attempt.status !== 'passed') {
        taskRetryCount.set(currentTask.key, attemptNumber);
      }
      
      // Report task end
      progress.onTaskEnd(currentTask, attempt, currentProgress);
      
      // Break on fatal error if not skipping
      if ((attempt.status === 'failed' || attempt.status === 'error') && !config.skipOnFail) {
        break mainLoop;
      }
    }
    
    // Final task file parse to get current state
    const finalTaskFile = await parseTaskFile(config.taskFile);
    const finalCompleted = finalTaskFile.completed.length - initialCompleted;
    const skipped = attempts.filter(a => a.status === 'skipped').length;
    const failed = attempts.filter(a => ['failed', 'error'].includes(a.status)).length;
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
      skipped,
      failed,
      remaining,
      attempts,
      totalDurationMs: Date.now() - startTimeMs,
      totalTokens,
      totalCommits,
      completedAll: remaining === 0,
      stopReason,
    };
    
    progress.onRunComplete(result);
    return result;
    
  } finally {
    // 8. Lock release in finally
    if (lockAcquired) {
      await releaseAntonLock();
    }
    
    process.off('SIGINT', handleAbort);
  }
}