/**
 * Tests for Anton verifier functionality.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe } from 'node:test';

// Import from dist (compiled JS)
import type { DetectedCommands, AntonAgentResult, AntonRunConfig } from '../dist/anton/types.js';
import { detectVerificationCommands, runVerification } from '../dist/anton/verifier.js';

describe('Anton Verifier', () => {
  describe('runVerification', () => {
    test('L0 pass (status=done)', async () => {
      const opts = {
        agentResult: { status: 'done' as const, reason: undefined, subtasks: [] },
        task: { text: 'test task' },
        projectDir: '/tmp',
        commands: { build: undefined, test: undefined, lint: undefined },
        config: { verifyAi: false } as AntonRunConfig,
        diff: '',
      };

      const result = await runVerification(opts);

      assert.strictEqual(result.l0_agentDone, true);
      assert.strictEqual(result.l1_build, undefined);
      assert.strictEqual(result.l1_test, undefined);
      assert.strictEqual(result.l1_lint, undefined);
      assert.strictEqual(result.l2_ai, undefined);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.summary, 'All checks passed');
    });

    test('L0 fail (status=blocked) → L1/L2 not run', async () => {
      const opts = {
        agentResult: { status: 'blocked' as const, reason: 'cannot proceed', subtasks: [] },
        task: { text: 'test task' },
        projectDir: '/tmp',
        commands: { build: 'true', test: 'true', lint: 'true' },
        config: { verifyAi: true } as AntonRunConfig,
        diff: 'some diff',
        createVerifySession: async () => ({
          ask: async () => '{"pass": true, "reason": "ok"}',
          close: async () => {},
        }),
      };

      const result = await runVerification(opts);

      assert.strictEqual(result.l0_agentDone, false);
      assert.strictEqual(result.l1_build, undefined);
      assert.strictEqual(result.l1_test, undefined);
      assert.strictEqual(result.l1_lint, undefined);
      assert.strictEqual(result.l2_ai, undefined);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.summary, 'Agent reported status: blocked');
    });

    test('L1 all pass', async () => {
      const opts = {
        agentResult: { status: 'done' as const, reason: undefined, subtasks: [] },
        task: { text: 'test task' },
        projectDir: '/tmp',
        commands: { build: 'true', test: 'true', lint: 'true' },
        config: { verifyAi: false } as AntonRunConfig,
        diff: '',
      };

      const result = await runVerification(opts);

      assert.strictEqual(result.l0_agentDone, true);
      assert.strictEqual(result.l1_build, true);
      assert.strictEqual(result.l1_test, true);
      assert.strictEqual(result.l1_lint, true);
      assert.strictEqual(result.l2_ai, undefined);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.summary, 'All checks passed');
    });

    test('L1 partial fail (build ok, test fail) → L2 not run', async () => {
      const opts = {
        agentResult: { status: 'done' as const, reason: undefined, subtasks: [] },
        task: { text: 'test task' },
        projectDir: '/tmp',
        commands: { build: 'true', test: 'false', lint: 'true' },
        config: { verifyAi: true } as AntonRunConfig,
        diff: 'some diff',
        createVerifySession: async () => ({
          ask: async () => '{"pass": true, "reason": "ok"}',
          close: async () => {},
        }),
      };

      const result = await runVerification(opts);

      assert.strictEqual(result.l0_agentDone, true);
      assert.strictEqual(result.l1_build, true);
      assert.strictEqual(result.l1_test, false);
      assert.strictEqual(result.l1_lint, true);
      assert.strictEqual(result.l2_ai, undefined);
      assert.strictEqual(result.passed, false);
      assert.ok(result.summary.includes('Command failures'));
      assert.ok(result.summary.includes('test:'));
    });

    test("L1 no commands defined → doesn't block", async () => {
      const opts = {
        agentResult: { status: 'done' as const, reason: undefined, subtasks: [] },
        task: { text: 'test task' },
        projectDir: '/tmp',
        commands: { build: undefined, test: undefined, lint: undefined },
        config: { verifyAi: false } as AntonRunConfig,
        diff: '',
      };

      const result = await runVerification(opts);

      assert.strictEqual(result.l0_agentDone, true);
      assert.strictEqual(result.l1_build, undefined);
      assert.strictEqual(result.l1_test, undefined);
      assert.strictEqual(result.l1_lint, undefined);
      assert.strictEqual(result.l2_ai, undefined);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.summary, 'All checks passed');
    });

    test('L2 valid JSON pass', async () => {
      const opts = {
        agentResult: { status: 'done' as const, reason: undefined, subtasks: [] },
        task: { text: 'test task' },
        projectDir: '/tmp',
        commands: { build: undefined, test: undefined, lint: undefined },
        config: { verifyAi: true } as AntonRunConfig,
        diff: 'some diff content',
        createVerifySession: async () => ({
          ask: async () => '{"pass": true, "reason": "Code looks good"}',
          close: async () => {},
        }),
      };

      const result = await runVerification(opts);

      assert.strictEqual(result.l0_agentDone, true);
      assert.strictEqual(result.l2_ai, true);
      assert.strictEqual(result.l2_reason, 'Code looks good');
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.summary, 'All checks passed');
    });

    test('L2 valid JSON fail with reason', async () => {
      const opts = {
        agentResult: { status: 'done' as const, reason: undefined, subtasks: [] },
        task: { text: 'test task' },
        projectDir: '/tmp',
        commands: { build: undefined, test: undefined, lint: undefined },
        config: { verifyAi: true } as AntonRunConfig,
        diff: 'some diff content',
        createVerifySession: async () => ({
          ask: async () => '{"pass": false, "reason": "Code has issues"}',
          close: async () => {},
        }),
      };

      const result = await runVerification(opts);

      assert.strictEqual(result.l0_agentDone, true);
      assert.strictEqual(result.l2_ai, false);
      assert.strictEqual(result.l2_reason, 'Code has issues');
      assert.strictEqual(result.passed, false);
      assert.ok(result.summary.includes('L2: Code has issues'));
    });

    test('L2 non-JSON response → fails safe', async () => {
      const opts = {
        agentResult: { status: 'done' as const, reason: undefined, subtasks: [] },
        task: { text: 'test task' },
        projectDir: '/tmp',
        commands: { build: undefined, test: undefined, lint: undefined },
        config: { verifyAi: true } as AntonRunConfig,
        diff: 'some diff content',
        createVerifySession: async () => ({
          ask: async () => 'This is not JSON',
          close: async () => {},
        }),
      };

      const result = await runVerification(opts);

      assert.strictEqual(result.l0_agentDone, true);
      assert.strictEqual(result.l2_ai, false);
      assert.strictEqual(result.l2_reason, 'Invalid verifier response: not valid JSON');
      assert.strictEqual(result.passed, false);
    });

    test('L2 JSON missing `pass` field → fails safe', async () => {
      const opts = {
        agentResult: { status: 'done' as const, reason: undefined, subtasks: [] },
        task: { text: 'test task' },
        projectDir: '/tmp',
        commands: { build: undefined, test: undefined, lint: undefined },
        config: { verifyAi: true } as AntonRunConfig,
        diff: 'some diff content',
        createVerifySession: async () => ({
          ask: async () => '{"reason": "Missing pass field"}',
          close: async () => {},
        }),
      };

      const result = await runVerification(opts);

      assert.strictEqual(result.l0_agentDone, true);
      assert.strictEqual(result.l2_ai, false);
      assert.strictEqual(result.l2_reason, 'Invalid verifier response: missing pass field');
      assert.strictEqual(result.passed, false);
    });

    test('L2 disabled (verifyAi=false) → skipped', async () => {
      const opts = {
        agentResult: { status: 'done' as const, reason: undefined, subtasks: [] },
        task: { text: 'test task' },
        projectDir: '/tmp',
        commands: { build: undefined, test: undefined, lint: undefined },
        config: { verifyAi: false } as AntonRunConfig,
        diff: 'some diff content',
        createVerifySession: async () => ({
          ask: async () => '{"pass": true, "reason": "Should not be called"}',
          close: async () => {},
        }),
      };

      const result = await runVerification(opts);

      assert.strictEqual(result.l0_agentDone, true);
      assert.strictEqual(result.l2_ai, undefined);
      assert.strictEqual(result.l2_reason, undefined);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.summary, 'All checks passed');
    });

    test('L2 skipped when L1 fails', async () => {
      const opts = {
        agentResult: { status: 'done' as const, reason: undefined, subtasks: [] },
        task: { text: 'test task' },
        projectDir: '/tmp',
        commands: { build: 'false', test: undefined, lint: undefined },
        config: { verifyAi: true } as AntonRunConfig,
        diff: 'some diff content',
        createVerifySession: async () => ({
          ask: async () => '{"pass": true, "reason": "Should not be called"}',
          close: async () => {},
        }),
      };

      const result = await runVerification(opts);

      assert.strictEqual(result.l0_agentDone, true);
      assert.strictEqual(result.l1_build, false);
      assert.strictEqual(result.l2_ai, undefined);
      assert.strictEqual(result.l2_reason, undefined);
      assert.strictEqual(result.passed, false);
      assert.ok(result.summary.includes('Command failures'));
    });

    test('Overall pass: all levels', async () => {
      const opts = {
        agentResult: { status: 'done' as const, reason: undefined, subtasks: [] },
        task: { text: 'test task' },
        projectDir: '/tmp',
        commands: { build: 'true', test: 'true', lint: 'true' },
        config: { verifyAi: true } as AntonRunConfig,
        diff: 'some diff content',
        createVerifySession: async () => ({
          ask: async () => '{"pass": true, "reason": "Everything looks good"}',
          close: async () => {},
        }),
      };

      const result = await runVerification(opts);

      assert.strictEqual(result.l0_agentDone, true);
      assert.strictEqual(result.l1_build, true);
      assert.strictEqual(result.l1_test, true);
      assert.strictEqual(result.l1_lint, true);
      assert.strictEqual(result.l2_ai, true);
      assert.strictEqual(result.l2_reason, 'Everything looks good');
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.summary, 'All checks passed');
    });
  });

  describe('detectVerificationCommands', () => {
    test('Detection: package.json with scripts', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'verifier-test-'));

      try {
        const packageJson = {
          name: 'test-package',
          scripts: {
            build: 'tsc',
            test: 'jest',
            lint: 'eslint .',
          },
        };

        await writeFile(join(tmpDir, 'package.json'), JSON.stringify(packageJson, null, 2));

        const commands = await detectVerificationCommands(tmpDir, {});

        assert.strictEqual(commands.build, 'npm run build');
        assert.strictEqual(commands.test, 'npm test');
        assert.strictEqual(commands.lint, 'npm run lint');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    test('Detection: overrides take precedence', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'verifier-test-'));

      try {
        const packageJson = {
          name: 'test-package',
          scripts: {
            build: 'tsc',
            test: 'jest',
            lint: 'eslint .',
          },
        };

        await writeFile(join(tmpDir, 'package.json'), JSON.stringify(packageJson, null, 2));

        const commands = await detectVerificationCommands(tmpDir, {
          build: 'custom-build',
          test: 'custom-test',
          lint: 'custom-lint',
        });

        assert.strictEqual(commands.build, 'custom-build');
        assert.strictEqual(commands.test, 'custom-test');
        assert.strictEqual(commands.lint, 'custom-lint');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
