/**
 * Anton integration tests — end-to-end scenarios with temp git repos.
 *
 * Each test creates a real git repo, a real task file, and uses mock agent
 * sessions to simulate the full Anton loop.
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe, beforeEach, afterEach } from 'node:test';

import type { AgentSession, AgentResult } from '../dist/agent.js';
import { runAnton } from '../dist/anton/controller.js';
import { releaseAntonLock } from '../dist/anton/lock.js';
import { parseTaskFile } from '../dist/anton/parser.js';
import type { AntonRunConfig, AntonProgressCallback } from '../dist/anton/types.js';
import type { IdlehandsConfig } from '../dist/types.js';

// ── Helpers ─────────────────────────────────────────────────────

/** Create a temp git repo with initial commit + package.json + test.js */
async function createFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'anton-integ-'));

  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: dir, stdio: 'pipe' });

  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'test-project',
        version: '1.0.0',
        scripts: { test: 'node test.js', build: 'echo build ok' },
      },
      null,
      2
    )
  );

  await writeFile(join(dir, 'test.js'), 'process.exit(0);\n');

  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

/** Create a task file and commit it */
async function writeTaskFile(dir: string, content: string): Promise<string> {
  const p = join(dir, 'TASKS.md');
  await writeFile(p, content);
  execSync('git add TASKS.md && git commit -m "tasks"', { cwd: dir, stdio: 'pipe' });
  return p;
}

/** Build a mock session where ask() returns a canned response */
function mockSession(responses: string[]): AgentSession {
  let idx = 0;
  return {
    model: 'mock',
    harness: 'mock',
    endpoint: 'mock',
    contextWindow: 8192,
    supportsVision: false,
    messages: [],
    usage: { prompt: 100, completion: 50 },
    async ask(): Promise<AgentResult> {
      const text = responses[idx] || '<anton-result>status: done</anton-result>';
      idx++;
      return { text, turns: 1, toolCalls: 0 };
    },
    cancel() {},
    async close() {},
    setModel() {},
    async setEndpoint() {},
    async listModels() {
      return [];
    },
    async refreshServerHealth() {
      return null;
    },
    getPerfSummary() {
      return { requests: 1, avgLatency: 100, totalTokens: 150 };
    },
    async captureOn() {
      return '';
    },
    captureOff() {},
    async captureLast() {
      return '';
    },
    getSystemPrompt() {
      return '';
    },
    setSystemPrompt() {},
    resetSystemPrompt() {},
    listMcpServers() {
      return [];
    },
    listMcpTools() {
      return [];
    },
    async restartMcpServer() {
      return { ok: true, message: '' };
    },
    enableMcpTool() {
      return true;
    },
    disableMcpTool() {
      return true;
    },
    mcpWarnings() {
      return [];
    },
    listLspServers() {
      return [];
    },
    setVerbose() {},
    reset() {},
    restore() {},
    planSteps: [],
    async executePlanStep() {
      return [];
    },
    clearPlan() {},
    async compactHistory() {
      return {
        beforeMessages: 0,
        afterMessages: 0,
        freedTokens: 0,
        archivedToolMessages: 0,
        droppedMessages: 0,
        dryRun: false,
      };
    },
  };
}

function defaultConfig(overrides: Partial<AntonRunConfig> = {}): AntonRunConfig {
  return {
    taskFile: '',
    projectDir: '',
    maxRetriesPerTask: 2,
    maxIterations: 20,
    taskTimeoutSec: 30,
    totalTimeoutSec: 120,
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
    lintCommand: undefined,
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

function baseIdlehandsConfig(): IdlehandsConfig {
  return {
    endpoint: 'mock',
    model: 'mock',
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

function silentProgress(): AntonProgressCallback {
  return {
    onTaskStart() {},
    onTaskEnd() {},
    onTaskSkip() {},
    onRunComplete() {},
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('Anton Integration', { concurrency: 1 }, () => {
  beforeEach(async () => {
    await releaseAntonLock();
  });
  afterEach(async () => {
    await releaseAntonLock();
  });

  test.skip('J3. 3 tasks all pass → all checked, completedAll=true (covered by anton-controller)', async () => {
    const dir = await createFixtureRepo();
    const taskFile = await writeTaskFile(
      dir,
      ['# Tasks', '- [ ] Task A', '- [ ] Task B', '- [ ] Task C'].join('\n')
    );

    const result = await runAnton({
      config: defaultConfig({ taskFile, projectDir: dir }),
      idlehandsConfig: baseIdlehandsConfig(),
      progress: silentProgress(),
      abortSignal: { aborted: false },
      createSession: async () => mockSession(['<anton-result>status: done</anton-result>']),
    });

    assert.equal(result.completed, 3);
    assert.equal(result.completedAll, true);
    assert.equal(result.stopReason, 'all_done');

    // Verify task file has all items checked
    const parsed = await parseTaskFile(taskFile);
    assert.equal(parsed.pending.length, 0);
    assert.equal(parsed.completed.length, 3);
  });

  test.skip('J4. Resume — manually check task 1, run Anton, only 2 attempted (covered by anton-controller)', async () => {
    const dir = await createFixtureRepo();
    const taskFile = await writeTaskFile(
      dir,
      ['# Tasks', '- [x] Already done', '- [ ] Task B', '- [ ] Task C'].join('\n')
    );

    let sessionCount = 0;
    const result = await runAnton({
      config: defaultConfig({ taskFile, projectDir: dir }),
      idlehandsConfig: baseIdlehandsConfig(),
      progress: silentProgress(),
      abortSignal: { aborted: false },
      createSession: async () => {
        sessionCount++;
        return mockSession(['<anton-result>status: done</anton-result>']);
      },
    });

    assert.equal(result.preCompleted, 1);
    assert.equal(result.completed, 2);
    assert.equal(sessionCount, 2); // Only 2 sessions created
    assert.equal(result.completedAll, true);
  });

  test.skip('J5. Failure + retry — mock fails first attempt, passes second (covered by anton-controller)', async () => {
    const dir = await createFixtureRepo();
    const taskFile = await writeTaskFile(dir, ['# Tasks', '- [ ] Tricky task'].join('\n'));

    let sessionCount = 0;
    const result = await runAnton({
      config: defaultConfig({ taskFile, projectDir: dir }),
      idlehandsConfig: baseIdlehandsConfig(),
      progress: silentProgress(),
      abortSignal: { aborted: false },
      createSession: async () => {
        sessionCount++;
        if (sessionCount === 1) {
          // Use 'failed' instead of 'blocked' — blocked now exhausts retries immediately
          return mockSession(['<anton-result>status: failed</anton-result>']);
        }
        return mockSession(['<anton-result>status: done</anton-result>']);
      },
    });

    assert.equal(sessionCount, 2);
    assert.equal(result.completed, 1);
    assert.equal(result.completedAll, true);
  });

  test.skip('J6. Decomposition — mock emits decompose, sub-tasks appear (covered by anton-controller)', async () => {
    const dir = await createFixtureRepo();
    const taskFile = await writeTaskFile(dir, ['# Tasks', '- [ ] Big task'].join('\n'));

    let sessionCount = 0;
    const result = await runAnton({
      config: defaultConfig({ taskFile, projectDir: dir, decompose: true }),
      idlehandsConfig: baseIdlehandsConfig(),
      progress: silentProgress(),
      abortSignal: { aborted: false },
      createSession: async () => {
        sessionCount++;
        if (sessionCount === 1) {
          // First call: decompose
          return mockSession(['<anton-result>status: decompose\n- Sub A\n- Sub B</anton-result>']);
        }
        // Subsequent calls: complete the sub-tasks
        return mockSession(['<anton-result>status: done</anton-result>']);
      },
    });

    const decomposed = result.attempts.filter((a) => a.status === 'decomposed');
    assert.ok(decomposed.length >= 1, 'Expected at least one decomposed attempt');

    // Sub-tasks should have been completed
    const passed = result.attempts.filter((a) => a.status === 'passed');
    assert.ok(passed.length >= 2, 'Expected sub-tasks to pass');
  });

  test('J7. Dirty tree — fails preflight without --allow-dirty', async () => {
    const dir = await createFixtureRepo();
    const taskFile = await writeTaskFile(dir, ['# Tasks', '- [ ] Task 1'].join('\n'));

    // Make the tree dirty
    await writeFile(join(dir, 'dirty.txt'), 'uncommitted');

    try {
      await runAnton({
        config: defaultConfig({ taskFile, projectDir: dir, allowDirty: false }),
        idlehandsConfig: baseIdlehandsConfig(),
        progress: silentProgress(),
        abortSignal: { aborted: false },
        createSession: async () => mockSession([]),
      });
      assert.fail('Expected dirty tree error');
    } catch (err: any) {
      assert.ok(
        err.message.includes('dirty') ||
          err.message.includes('clean') ||
          err.message.includes('uncommitted'),
        `Expected dirty tree error, got: ${err.message}`
      );
    }
  });

  test('J8. Malformed AI output → recovered via format-only followup', async () => {
    const dir = await createFixtureRepo();
    const taskFile = await writeTaskFile(dir, ['# Tasks', '- [ ] Task 1'].join('\n'));

    const result = await runAnton({
      config: defaultConfig({
        taskFile,
        projectDir: dir,
        skipOnFail: true,
        maxRetriesPerTask: 1,
      }),
      idlehandsConfig: baseIdlehandsConfig(),
      progress: silentProgress(),
      abortSignal: { aborted: false },
      createSession: async () =>
        mockSession([
          // First response malformed (no <anton-result>).
          'I completed the task successfully!',
          // Recovery prompt response provides valid structured result.
          '<anton-result>\nstatus: done\n</anton-result>',
        ]),
    });

    assert.equal(result.completed, 1, 'Malformed output should be repairable');
    assert.equal(result.failed, 0);
    assert.equal(result.stopReason, 'all_done');
  });

  test.skip('J9. Build + test pass (redundant with global CI build/test)', async () => {
    // This test just validates the project itself builds and tests pass
    const buildResult = execSync('npm run build 2>&1', {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.ok(!buildResult.includes('error TS'), 'Build should have no TS errors');
  });

  test('J10. Dry run shows plan without executing', async () => {
    const dir = await createFixtureRepo();
    const taskFile = await writeTaskFile(
      dir,
      ['# Tasks', '- [ ] Task 1', '- [ ] Task 2'].join('\n')
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.join(' '));

    try {
      const result = await runAnton({
        config: defaultConfig({ taskFile, projectDir: dir, dryRun: true }),
        idlehandsConfig: baseIdlehandsConfig(),
        progress: silentProgress(),
        abortSignal: { aborted: false },
        createSession: async () => {
          throw new Error('Should not create session in dry run');
        },
      });

      assert.equal(result.completed, 0);
      assert.ok(logs.some((l) => l.includes('Dry Run') || l.includes('pending')));
    } finally {
      console.log = origLog;
    }
  });
});
