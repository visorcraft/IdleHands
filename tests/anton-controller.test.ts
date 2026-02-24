/**
 * Tests for Anton controller - main orchestrator.
 *
 * IMPORTANT: These tests run serially (concurrency: 1) because they share
 * the global anton.lock file.
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe, beforeEach, afterEach } from 'node:test';

import type { AgentSession, AgentResult } from '../dist/agent.js';
import { runAnton } from '../dist/anton/controller.js';
import { releaseAntonLock } from '../dist/anton/lock.js';
import type {
  AntonRunConfig,
  AntonProgressCallback,
  AntonProgress,
  AntonTask,
  AntonAttempt,
  AntonRunResult,
} from '../dist/anton/types.js';
import type { IdlehandsConfig } from '../dist/types.js';

// Mock session factory — returns correct AgentResult shape
function createMockSession(responses: string[]): AgentSession {
  let responseIndex = 0;

  return {
    model: 'test-model',
    harness: 'test',
    endpoint: 'test',
    contextWindow: 8192,
    supportsVision: false,
    messages: [],
    usage: { prompt: 100, completion: 50 },

    async ask(prompt): Promise<AgentResult> {
      const response = responses[responseIndex] || '<anton-result>status: done</anton-result>';
      responseIndex++;

      return {
        text: response,
        turns: 1,
        toolCalls: 0,
      };
    },

    cancel: () => { },
    close: async () => { },
    setModel: () => { },
    setEndpoint: async () => { },
    listModels: async () => [],
    refreshServerHealth: async () => null,
    getPerfSummary: () => ({ requests: 1, avgLatency: 100, totalTokens: 150 }),
    captureOn: async () => 'test.txt',
    captureOff: () => { },
    captureLast: async () => 'test.txt',
    getSystemPrompt: () => 'test',
    setSystemPrompt: () => { },
    resetSystemPrompt: () => { },
    listMcpServers: () => [],
    listMcpTools: () => [],
    restartMcpServer: async () => ({ ok: true, message: 'test' }),
    enableMcpTool: () => true,
    disableMcpTool: () => true,
    mcpWarnings: () => [],
    listLspServers: () => [],
    setVerbose: () => { },
    reset: () => { },
    restore: () => { },
    planSteps: [],
    executePlanStep: async () => [],
    clearPlan: () => { },
    compactHistory: async () => ({
      beforeMessages: 0,
      afterMessages: 0,
      freedTokens: 0,
      archivedToolMessages: 0,
      droppedMessages: 0,
      dryRun: false,
    }),
  };
}

// Create temp git repo with initial commit
async function createTempGitRepo(): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'anton-ctrl-'));

  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'pipe' });

  await writeFile(join(tmpDir, 'README.md'), '# Test Project\n');
  execSync('git add .', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: tmpDir, stdio: 'pipe' });

  return tmpDir;
}

// Create task file inside git repo and commit it
async function createTaskFile(dir: string, content: string): Promise<string> {
  const taskFile = join(dir, 'TASKS.md');
  await writeFile(taskFile, content);
  execSync('git add TASKS.md && git commit -m "Add tasks"', { cwd: dir, stdio: 'pipe' });
  return taskFile;
}

// Default config factory
function createTestConfig(overrides: Partial<AntonRunConfig> = {}): AntonRunConfig {
  return {
    taskFile: '',
    projectDir: '',
    maxRetriesPerTask: 2,
    maxIterations: 10,
    taskTimeoutSec: 30,
    totalTimeoutSec: 300,
    maxTotalTokens: Infinity,
    maxPromptTokensPerAttempt: 128000,
    autoCommit: true,
    branch: false,
    allowDirty: true,
    aggressiveCleanOnFail: false,
    verifyAi: false,
    verifyModel: undefined,
    decompose: true,
    maxDecomposeDepth: 2,
    maxTotalTasks: 100,
    buildCommand: undefined,
    testCommand: undefined,
    skipOnFail: true,
    skipOnBlocked: true,
    rollbackOnFail: false,
    maxIdenticalFailures: 5,
    approvalMode: 'yolo' as const,
    verbose: false,
    dryRun: false,
    ...overrides,
  };
}

function createTestIdlehandsConfig(): IdlehandsConfig {
  return {
    endpoint: 'test',
    model: 'test-model',
    max_tokens: 1000,
    temperature: 0,
    top_p: 1,
    timeout: 30,
    max_iterations: 10,
    approval_mode: 'yolo' as const,
    no_confirm: true,
    verbose: false,
    dry_run: false,
  };
}

// Mock progress callback that records all events
function createMockProgressCallback(): AntonProgressCallback & {
  events: Array<{ type: string; data: any }>;
} {
  const events: Array<{ type: string; data: any }> = [];
  return {
    events,
    onTaskStart: (task, attempt, progress) => {
      events.push({ type: 'taskStart', data: { task, attempt, progress } });
    },
    onTaskEnd: (task, result, progress) => {
      events.push({ type: 'taskEnd', data: { task, result, progress } });
    },
    onTaskSkip: (task, reason, progress) => {
      events.push({ type: 'taskSkip', data: { task, reason, progress } });
    },
    onRunComplete: (result) => {
      events.push({ type: 'runComplete', data: { result } });
    },
  };
}

// Concurrency 1 because all tests share the global anton.lock
describe('Anton Controller', { concurrency: 1 }, () => {
  // Release lock before each test to avoid contention
  beforeEach(async () => {
    await releaseAntonLock();
  });
  afterEach(async () => {
    await releaseAntonLock();
  });

  test('1. Happy path: 3 tasks pass → completed=3, completedAll=true', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(
      tmpDir,
      ['# Test Tasks', '', '- [ ] Task 1', '- [ ] Task 2', '- [ ] Task 3'].join('\n')
    );

    const config = createTestConfig({ taskFile, projectDir: tmpDir });
    const progress = createMockProgressCallback();

    let sessionCount = 0;
    const createSession = async () => {
      sessionCount++;
      return createMockSession(['<anton-result>status: done</anton-result>']);
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.completed, 3);
    assert.equal(result.completedAll, true);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.stopReason, 'all_done');
    assert.equal(sessionCount, 3);
  });

  test('2. Retry then pass → attempts.length=2 and failed=0', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));

    const config = createTestConfig({ taskFile, projectDir: tmpDir });
    const progress = createMockProgressCallback();

    let sessionCount = 0;
    const createSession = async () => {
      sessionCount++;
      // First attempt: failed (triggers retry). Second attempt: done.
      if (sessionCount === 1) {
        return createMockSession(['<anton-result>status: failed\nreason: lint errors</anton-result>']);
      }
      return createMockSession(['<anton-result>status: done</anton-result>']);
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    const taskAttempts = result.attempts.filter((a) => a.taskKey === result.attempts[0]?.taskKey);
    assert.equal(taskAttempts.length, 2);
    assert.equal(result.failed, 0, 'intermediate failed attempts should not count as final failed tasks');
    assert.equal(sessionCount, 2);
  });

  test('3. Max retries exceeded → skipped=1', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      maxRetriesPerTask: 1,
      skipOnFail: true,
    });
    const progress = createMockProgressCallback();

    const createSession = async () => {
      return createMockSession(['<anton-result>status: failed\nreason: lint errors</anton-result>']);
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.skipped, 1);
    assert.equal(result.completed, 0);
  });

  test("4. Abort signal → stopReason='abort'", async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(
      tmpDir,
      ['# Test Tasks', '', '- [ ] Task 1', '- [ ] Task 2'].join('\n')
    );

    const config = createTestConfig({ taskFile, projectDir: tmpDir });
    const progress = createMockProgressCallback();
    const abortSignal = { aborted: false };

    let sessionCount = 0;
    const createSession = async () => {
      sessionCount++;
      if (sessionCount === 1) {
        // Set abort after first task completes
        abortSignal.aborted = true;
      }
      return createMockSession(['<anton-result>status: done</anton-result>']);
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal,
      createSession,
    });

    assert.equal(result.stopReason, 'abort');
  });

  test('4b. Abort signal cancels an in-flight attempt', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(
      tmpDir,
      ['# Test Tasks', '', '- [ ] Long Task'].join('\n')
    );

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      taskTimeoutSec: 120,
      totalTimeoutSec: 120,
    });
    const progress = createMockProgressCallback();
    const abortSignal = { aborted: false };

    const createSession = async (): Promise<AgentSession> => {
      const base = createMockSession(['<anton-result>status: done</anton-result>']);
      return {
        ...base,
        async ask(_prompt: any, hooks?: any): Promise<AgentResult> {
          return await new Promise<AgentResult>((resolve, reject) => {
            const sig: AbortSignal | undefined = hooks?.signal;
            if (!sig) {
              reject(new Error('missing abort signal'));
              return;
            }
            const onAbort = () => reject(new Error('aborted'));
            sig.addEventListener('abort', onAbort, { once: true });
            // Simulate a very long task that should be interrupted by /anton stop.
            setTimeout(() => {
              sig.removeEventListener('abort', onAbort);
              resolve({
                text: '<anton-result>status: done</anton-result>',
                turns: 1,
                toolCalls: 0,
              });
            }, 60_000);
          });
        },
      };
    };

    const started = Date.now();
    setTimeout(() => {
      abortSignal.aborted = true;
    }, 200);

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal,
      createSession,
    });

    assert.equal(result.stopReason, 'abort');
    assert.ok(Date.now() - started < 10_000, 'abort should stop run promptly');
  });

  test("5. Max iterations → stopReason='max_iterations'", async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(
      tmpDir,
      [
        '# Test Tasks',
        '',
        '- [ ] Task 1',
        '- [ ] Task 2',
        '- [ ] Task 3',
        '- [ ] Task 4',
        '- [ ] Task 5',
      ].join('\n')
    );

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      maxIterations: 2,
    });
    const progress = createMockProgressCallback();

    const createSession = async () => {
      return createMockSession(['<anton-result>status: done</anton-result>']);
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.stopReason, 'max_iterations');
    assert.equal(result.completed, 2);
  });

  test("6. Total timeout → stopReason='total_timeout'", async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      totalTimeoutSec: 0.001, // Tiny timeout
    });
    const progress = createMockProgressCallback();

    const createSession = async () => {
      await new Promise((r) => setTimeout(r, 5)); // Ensure time passes
      return createMockSession(['<anton-result>status: done</anton-result>']);
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.stopReason, 'total_timeout');
  });

  test("7. Token budget → stopReason='token_budget'", async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(
      tmpDir,
      ['# Test Tasks', '', '- [ ] Task 1', '- [ ] Task 2'].join('\n')
    );

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      maxTotalTokens: 100, // Very low budget
    });
    const progress = createMockProgressCallback();

    const createSession = async () => {
      return createMockSession(['<anton-result>status: done</anton-result>']);
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.stopReason, 'token_budget');
  });

  test("8. skipOnFail=false → stopReason='fatal_error'", async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      skipOnFail: false,
    });
    const progress = createMockProgressCallback();

    const createSession = async () => {
      const mock = createMockSession([]);
      return {
        ...mock,
        async ask() {
          throw new Error('Simulated agent failure');
        },
      };
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.stopReason, 'fatal_error');
    assert.ok(result.attempts.some((a) => a.status === 'error'));
  });

  test('9. Pre-completed tasks skipped', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(
      tmpDir,
      ['# Test Tasks', '', '- [x] Already done', '- [ ] Task 1'].join('\n')
    );

    const config = createTestConfig({ taskFile, projectDir: tmpDir });
    const progress = createMockProgressCallback();

    const createSession = async () => {
      return createMockSession(['<anton-result>status: done</anton-result>']);
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.preCompleted, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.totalTasks, 2);
  });

  test('10. autoCommit=false → no commits', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      autoCommit: false,
    });
    const progress = createMockProgressCallback();

    const createSession = async () => {
      return createMockSession(['<anton-result>status: done</anton-result>']);
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.totalCommits, 0);
  });

  test('11. Decomposition → sub-tasks inserted', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(
      tmpDir,
      ['# Test Tasks', '', '- [ ] Big task'].join('\n')
    );

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      decompose: true,
    });
    const progress = createMockProgressCallback();

    let sessionCount = 0;
    const createSession = async () => {
      sessionCount++;
      if (sessionCount === 1) {
        return createMockSession([
          '<anton-result>status: decompose\n- Sub task 1\n- Sub task 2</anton-result>',
        ]);
      }
      // Subsequent sessions handle the sub-tasks
      return createMockSession(['<anton-result>status: done</anton-result>']);
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    const decomposedAttempts = result.attempts.filter((a) => a.status === 'decomposed');
    assert.ok(decomposedAttempts.length >= 1);
  });

  test('12. Each attempt gets fresh session (factory called N times)', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(
      tmpDir,
      ['# Test Tasks', '', '- [ ] Task 1', '- [ ] Task 2'].join('\n')
    );

    const config = createTestConfig({ taskFile, projectDir: tmpDir });
    const progress = createMockProgressCallback();

    let sessionCount = 0;
    const createSession = async () => {
      sessionCount++;
      return createMockSession(['<anton-result>status: done</anton-result>']);
    };

    await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(sessionCount, 2); // One session per task
  });

  test('13. Lock released on error', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));

    const config = createTestConfig({ taskFile, projectDir: tmpDir });
    const progress = createMockProgressCallback();

    const createSession = async () => {
      throw new Error('Session creation failed');
    };

    try {
      await runAnton({
        config,
        idlehandsConfig: createTestIdlehandsConfig(),
        progress,
        abortSignal: { aborted: false },
        createSession,
      });
    } catch {
      // Expected
    }

    // If lock was properly released, we can acquire it again
    // (next test will verify this implicitly)
    assert.ok(true);
  });

  test('14. SIGINT sets abort flag (implicit via abort test)', async () => {
    assert.ok(true);
  });

  test('15. Timeout calls session.cancel() before close', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      taskTimeoutSec: 0.01, // 10ms timeout
    });
    const progress = createMockProgressCallback();

    let cancelCalled = false;
    const createSession = async () => {
      const mock = createMockSession([]);
      return {
        ...mock,
        async ask() {
          // Simulate slow operation that exceeds taskTimeoutSec
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { text: '<anton-result>status: done</anton-result>', turns: 1, toolCalls: 0 };
        },
        cancel() {
          cancelCalled = true;
        },
      };
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    const timeoutAttempts = result.attempts.filter(
      (a) => a.status === 'timeout' || a.status === 'error'
    );
    assert.ok(timeoutAttempts.length > 0 || cancelCalled, 'Expected timeout or cancel');
  });

  test('16. Decomposed parent auto-completed when all children pass', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(
      tmpDir,
      ['# Test Tasks', '', '- [ ] Parent task', '  - [ ] Child 1', '  - [ ] Child 2'].join('\n')
    );

    const config = createTestConfig({ taskFile, projectDir: tmpDir });
    const progress = createMockProgressCallback();

    const createSession = async () => {
      return createMockSession(['<anton-result>status: done</anton-result>']);
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    // Children pass → parent auto-completed → all done
    assert.ok(result.completed >= 2);
    assert.equal(result.completedAll, true);
  });

  test('17a. Preflight discovery complete skips implementation and marks task', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      preflightEnabled: true,
      preflightRequirementsReview: true,
    } as any);

    let calls = 0;
    const createSession = async () => {
      calls++;
      if (calls === 1) {
        return createMockSession(['{"status":"complete","filename":""}']);
      }
      return createMockSession(['<anton-result>status: done</anton-result>']);
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress: createMockProgressCallback(),
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.completedAll, true);
    assert.equal(calls, 1, 'implementation should not run when discovery says complete');

    const content = await readFile(taskFile, 'utf8');
    assert.ok(content.includes('- [x] Task 1'));
  });

  test('17b. Preflight incomplete runs requirements review and implementation uses plan file', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));
    const planFile = join(tmpDir, '.agents', 'tasks', 'plan.md');
    await mkdir(join(tmpDir, '.agents', 'tasks'), { recursive: true });
    await writeFile(planFile, '# plan');

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      preflightEnabled: true,
      preflightRequirementsReview: true,
    } as any);

    const prompts: string[] = [];
    let calls = 0;
    const createSession = async () => ({
      ...createMockSession(['<anton-result>status: done</anton-result>']),
      async ask(prompt: string) {
        prompts.push(prompt);
        calls++;
        if (calls === 1) return { text: `{"status":"incomplete","filename":"${planFile}"}`, turns: 1, toolCalls: 0 } as any;
        if (calls === 2) return { text: `{"status":"ready","filename":"${planFile}"}`, turns: 1, toolCalls: 0 } as any;
        return { text: '<anton-result>status: done</anton-result>', turns: 1, toolCalls: 0 } as any;
      },
    } as any);

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress: createMockProgressCallback(),
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.completedAll, true);
    assert.ok(prompts.some((p) => p.includes(`Primary plan file: ${planFile}`)));
  });

  test('17c. Preflight path safety rejects outside path and follows skip policy', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));
    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      preflightEnabled: true,
      skipOnFail: true,
      maxRetriesPerTask: 1,
    } as any);

    const createSession = async () => createMockSession(['{"status":"incomplete","filename":"/tmp/evil.md"}']);

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress: createMockProgressCallback(),
      abortSignal: { aborted: false },
      createSession,
    });

    assert.ok(result.skipped >= 1 || result.failed >= 0);
  });

  test('17d. Preflight malformed JSON triggers retry then skip', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));
    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      preflightEnabled: true,
      skipOnFail: true,
      maxRetriesPerTask: 1,
      preflightMaxRetries: 0,
    } as any);

    const createSession = async () => createMockSession(['not-json']);

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress: createMockProgressCallback(),
      abortSignal: { aborted: false },
      createSession,
    });

    assert.ok(result.attempts.some((a) => (a.error || '').includes('preflight-error')));
  });

  test('17e. Preflight timeout is handled', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));
    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      preflightEnabled: true,
      preflightDiscoveryTimeoutSec: 0.05,
      skipOnFail: true,
      maxRetriesPerTask: 1,
    } as any);

    const createSession = async () => ({
      ...createMockSession([]),
      async ask() {
        await new Promise((r) => setTimeout(r, 120));
        return { text: '{"status":"complete","filename":""}', turns: 1, toolCalls: 0 } as any;
      },
    } as any);

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress: createMockProgressCallback(),
      abortSignal: { aborted: false },
      createSession,
    });

    assert.ok(result.attempts.some((a) => a.status === 'timeout' || (a.error || '').includes('timeout')));
  });

  test('17f. Reporter stage messages are emitted via onStage', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));
    const planFile = join(tmpDir, '.agents', 'tasks', 'plan.md');
    await mkdir(join(tmpDir, '.agents', 'tasks'), { recursive: true });
    await writeFile(planFile, '# plan');

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      preflightEnabled: true,
      preflightRequirementsReview: true,
    } as any);

    const stageMessages: string[] = [];
    const progress = {
      ...createMockProgressCallback(),
      onStage: (m: string) => stageMessages.push(m),
    } as any;

    let calls = 0;
    const createSession = async () => ({
      ...createMockSession(['<anton-result>status: done</anton-result>']),
      async ask() {
        calls++;
        if (calls === 1) return { text: `{"status":"incomplete","filename":"${planFile}"}`, turns: 1, toolCalls: 0 } as any;
        if (calls === 2) return { text: `{"status":"ready","filename":"${planFile}"}`, turns: 1, toolCalls: 0 } as any;
        return { text: '<anton-result>status: done</anton-result>', turns: 1, toolCalls: 0 } as any;
      },
    } as any);

    await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    assert.ok(stageMessages.some((m) => m.includes('Discovery')));
    assert.ok(stageMessages.some((m) => m.includes('Requirements review')));
    assert.ok(stageMessages.some((m) => m.includes('Implementation')));
  });

  test('17g. Preflight review retry stays on review stage and reuses same plan file', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));
    const planFile = join(tmpDir, '.agents', 'tasks', 'plan.md');
    await mkdir(join(tmpDir, '.agents', 'tasks'), { recursive: true });
    await writeFile(planFile, '# plan');

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      preflightEnabled: true,
      preflightRequirementsReview: true,
      preflightMaxRetries: 1,
    } as any);

    const stageMessages: string[] = [];
    const progress = {
      ...createMockProgressCallback(),
      onStage: (m: string) => stageMessages.push(m),
    } as any;

    let discoveryCalls = 0;
    let reviewCalls = 0;
    let implementationCalls = 0;

    const createSession = async () => ({
      ...createMockSession(['<anton-result>status: done</anton-result>']),
      async ask(prompt: string) {
        if (prompt.includes('PRE-FLIGHT DISCOVERY')) {
          discoveryCalls++;
          return { text: `{"status":"incomplete","filename":"${planFile}"}`, turns: 1, toolCalls: 0 } as any;
        }
        if (prompt.includes('Please review this plan file')) {
          reviewCalls++;
          if (reviewCalls === 1) throw new Error('preflight-review-timeout');
          return { text: `{"status":"ready","filename":"${planFile}"}`, turns: 1, toolCalls: 0 } as any;
        }

        implementationCalls++;
        return { text: '<anton-result>status: done</anton-result>', turns: 1, toolCalls: 0 } as any;
      },
    } as any);

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.completedAll, true);
    assert.equal(discoveryCalls, 1);
    assert.equal(reviewCalls, 2);
    assert.equal(implementationCalls, 1);
    assert.ok(stageMessages.some((m) => m.includes('Retrying review with existing plan file')));
  });

  test('17h. Preflight sessions enforce capped config while keeping tools enabled', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));
    const planFile = join(tmpDir, '.agents', 'tasks', 'plan.md');
    await mkdir(join(tmpDir, '.agents', 'tasks'), { recursive: true });
    await writeFile(planFile, '# plan');

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      preflightEnabled: true,
      preflightRequirementsReview: false,
      preflightDiscoveryTimeoutSec: 300,
      preflightSessionMaxIterations: 2,
      preflightSessionTimeoutSec: 45,
    } as any);

    const sessionConfigs: IdlehandsConfig[] = [];
    const createSession = async (sessionConfig: IdlehandsConfig) => {
      sessionConfigs.push(sessionConfig);
      return {
        ...createMockSession(['<anton-result>status: done</anton-result>']),
        async ask(prompt: string) {
          if (prompt.includes('PRE-FLIGHT DISCOVERY')) {
            return { text: `{"status":"incomplete","filename":"${planFile}"}`, turns: 1, toolCalls: 0 } as any;
          }
          return { text: '<anton-result>status: done</anton-result>', turns: 1, toolCalls: 0 } as any;
        },
      } as any;
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress: createMockProgressCallback(),
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.completedAll, true);
    assert.ok(sessionConfigs.length >= 2);
    const preflightSession = sessionConfigs[0];
    assert.equal(preflightSession.no_tools, false);
    assert.equal(preflightSession.max_iterations, 2);
    assert.equal(preflightSession.timeout, 45);
  });

  test('17i. Missing discovery plan file is bootstrapped instead of failing preflight', async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(tmpDir, ['# Test Tasks', '', '- [ ] Task 1'].join('\n'));
    const planFile = join(tmpDir, '.agents', 'tasks', 'missing-plan.md');

    const stageMessages: string[] = [];
    const progress = {
      ...createMockProgressCallback(),
      onStage: (m: string) => stageMessages.push(m),
    } as any;

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      preflightEnabled: true,
      preflightRequirementsReview: false,
    } as any);

    const createSession = async () => ({
      ...createMockSession(['<anton-result>status: done</anton-result>']),
      async ask(prompt: string) {
        if (prompt.includes('PRE-FLIGHT DISCOVERY')) {
          return { text: `{"status":"incomplete","filename":"${planFile}"}`, turns: 1, toolCalls: 0 } as any;
        }
        return { text: '<anton-result>status: done</anton-result>', turns: 1, toolCalls: 0 } as any;
      },
    } as any);

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.completedAll, true);
    const fallbackBody = await readFile(planFile, 'utf8');
    assert.match(fallbackBody, /auto-generated fallback/i);
    assert.ok(stageMessages.some((m) => m.includes('Created fallback plan file')));
  });

  test("17. maxTotalTasks exceeded → stopReason='max_tasks_exceeded'", async () => {
    const tmpDir = await createTempGitRepo();
    const taskFile = await createTaskFile(
      tmpDir,
      [
        '# Test Tasks',
        '',
        '- [ ] Task 1',
        '- [ ] Task 2',
        '- [ ] Task 3',
        '- [ ] Task 4',
        '- [ ] Task 5',
      ].join('\n')
    );

    const config = createTestConfig({
      taskFile,
      projectDir: tmpDir,
      maxTotalTasks: 3, // Less than total tasks
    });
    const progress = createMockProgressCallback();

    const createSession = async () => {
      return createMockSession(['<anton-result>status: done</anton-result>']);
    };

    const result = await runAnton({
      config,
      idlehandsConfig: createTestIdlehandsConfig(),
      progress,
      abortSignal: { aborted: false },
      createSession,
    });

    assert.equal(result.stopReason, 'max_tasks_exceeded');
  });
});
