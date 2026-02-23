/**
 * Anton verification engine — Phase E implementation.
 *
 * Implements the three-level verification cascade:
 * - L0: Agent completion status
 * - L1: Build/test/lint commands
 * - L2: AI code review (optional)
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { runCommand } from '../runtime/executor.js';

import type {
  DetectedCommands,
  AntonVerificationResult,
  AntonAgentResult,
  AntonRunConfig,
} from './types.js';

export interface VerifyOpts {
  agentResult: AntonAgentResult;
  task: { text: string };
  projectDir: string;
  commands: DetectedCommands;
  config: AntonRunConfig;
  diff: string;
  createVerifySession?: () => Promise<{
    ask: (prompt: string) => Promise<string>;
    close: () => Promise<void>;
  }>;
}

/**
 * Detect verification commands based on project files and overrides.
 * Priority: overrides → package.json → Cargo.toml → Makefile → Python configs
 */
export async function detectVerificationCommands(
  cwd: string,
  overrides: Partial<DetectedCommands>
): Promise<DetectedCommands> {
  const result: DetectedCommands = {
    build: overrides.build,
    test: overrides.test,
    lint: overrides.lint,
  };

  // L1: Overrides take absolute precedence
  if (result.build !== undefined && result.test !== undefined && result.lint !== undefined) {
    return result;
  }

  // L2: Check package.json for npm scripts
  try {
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const scripts = pkg.scripts || {};

      if (result.build === undefined && scripts.build) {
        result.build = 'npm run build';
      }
      if (result.test === undefined && scripts.test) {
        // Skip if it's just the default npm error stub
        const testScript = scripts.test.trim();
        if (testScript !== 'echo "Error: no test specified" && exit 1') {
          result.test = 'npm test';
        }
      }
      if (result.lint === undefined && scripts.lint) {
        result.lint = 'npm run lint';
      }
    }
  } catch {
    // Ignore JSON parse errors
  }

  // L3: Check Cargo.toml for Rust projects
  if (existsSync(join(cwd, 'Cargo.toml'))) {
    if (result.build === undefined) {
      result.build = 'cargo build';
    }
    if (result.test === undefined) {
      result.test = 'cargo test';
    }
    if (result.lint === undefined && isCommandAvailable('cargo', 'clippy')) {
      result.lint = 'cargo clippy';
    }
  }

  // L4: Check Makefile
  if (existsSync(join(cwd, 'Makefile'))) {
    if (result.build === undefined) {
      result.build = 'make';
    }
    if (result.test === undefined && makeTargetExists(cwd, 'test')) {
      result.test = 'make test';
    }
  }

  // L5: Check Python configs
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'setup.py'))) {
    if (result.test === undefined && isCommandAvailable('pytest')) {
      result.test = 'pytest';
    }
    if (result.lint === undefined && isCommandAvailable('ruff')) {
      result.lint = 'ruff check .';
    }
  }

  return result;
}

/**
 * Run the full verification cascade (L0 → L1 → L2).
 */
export async function runVerification(opts: VerifyOpts): Promise<AntonVerificationResult> {
  const result: AntonVerificationResult = {
    l0_agentDone: false,
    l1_build: undefined,
    l1_test: undefined,
    l1_lint: undefined,
    l2_ai: undefined,
    l2_reason: undefined,
    passed: false,
    summary: '',
    commandOutput: undefined,
  };

  // L0: Check agent completion status
  result.l0_agentDone = opts.agentResult.status === 'done';
  if (!result.l0_agentDone) {
    result.passed = false;
    result.summary = `Agent reported status: ${opts.agentResult.status}`;
    return result;
  }

  // L1: Run build/test/lint commands
  let l1_all = true;
  const failedCommands: string[] = [];
  const fullOutputParts: string[] = [];

  if (opts.commands.build !== undefined) {
    try {
      const buildResult = await runCommand(opts.commands.build, 180_000, opts.projectDir);
      result.l1_build = buildResult.exitCode === 0;
      if (!result.l1_build) {
        l1_all = false;
        const combined = combineOutput('build', buildResult.stdout, buildResult.stderr);
        failedCommands.push(`build: ${truncateOutput(combined, 500)}`);
        fullOutputParts.push(combined);
      }
    } catch (err) {
      result.l1_build = false;
      l1_all = false;
      failedCommands.push(`build: ${String(err)}`);
      fullOutputParts.push(`build error: ${String(err)}`);
    }
  }

  if (opts.commands.test !== undefined) {
    try {
      const testResult = await runCommand(opts.commands.test, 180_000, opts.projectDir);
      result.l1_test = testResult.exitCode === 0;
      if (!result.l1_test) {
        l1_all = false;
        const combined = combineOutput('test', testResult.stdout, testResult.stderr);
        failedCommands.push(`test: ${truncateOutput(combined, 500)}`);
        fullOutputParts.push(combined);
      }
    } catch (err) {
      result.l1_test = false;
      l1_all = false;
      failedCommands.push(`test: ${String(err)}`);
      fullOutputParts.push(`test error: ${String(err)}`);
    }
  }

  if (opts.commands.lint !== undefined) {
    try {
      const lintResult = await runCommand(opts.commands.lint, 180_000, opts.projectDir);
      result.l1_lint = lintResult.exitCode === 0;
      if (!result.l1_lint) {
        l1_all = false;
        const combined = combineOutput('lint', lintResult.stdout, lintResult.stderr);
        failedCommands.push(`lint: ${truncateOutput(combined, 500)}`);
        fullOutputParts.push(combined);
      }
    } catch (err) {
      result.l1_lint = false;
      l1_all = false;
      failedCommands.push(`lint: ${String(err)}`);
      fullOutputParts.push(`lint error: ${String(err)}`);
    }
  }

  // If L1 failed, skip L2
  if (!l1_all) {
    result.passed = false;
    result.summary = `Command failures: ${failedCommands.join('; ')}`;
    result.commandOutput = truncateOutput(fullOutputParts.join('\n\n'), 4000);
    return result;
  }

  // L2: AI verification (only if enabled and conditions met)
  if (opts.config.verifyAi && opts.diff.trim() && opts.createVerifySession) {
    let session: { ask: (prompt: string) => Promise<string>; close: () => Promise<void> } | null =
      null;
    try {
      session = await opts.createVerifySession();
      const prompt = `You are a code review verifier. Task: "${opts.task.text}"

Diff:
\`\`\`diff
${opts.diff}
\`\`\`

Reply with exactly one JSON object:
{"pass": true, "reason": "..."}
or
{"pass": false, "reason": "..."}`;

      const response = await session.ask(prompt);

      try {
        const parsed = JSON.parse(response.trim());
        if (typeof parsed.pass === 'boolean') {
          result.l2_ai = parsed.pass;
          result.l2_reason = parsed.reason || 'No reason provided';
        } else {
          result.l2_ai = false;
          result.l2_reason = 'Invalid verifier response: missing pass field';
        }
      } catch {
        result.l2_ai = false;
        result.l2_reason = 'Invalid verifier response: not valid JSON';
      }
    } catch (err) {
      result.l2_ai = false;
      result.l2_reason = `Verifier session error: ${String(err)}`;
    } finally {
      if (session) {
        try {
          await session.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  // Overall result
  const l2_pass = result.l2_ai ?? true; // undefined means skipped, treat as pass
  result.passed = result.l0_agentDone && l1_all && l2_pass;

  if (result.passed) {
    result.summary = 'All checks passed';
  } else {
    const failures = [];
    if (!result.l0_agentDone) failures.push('L0: agent not done');
    if (!l1_all) failures.push(`L1: ${failedCommands.join(', ')}`);
    if (result.l2_ai === false) failures.push(`L2: ${result.l2_reason}`);
    result.summary = failures.join('; ');
  }

  return result;
}

// Helper functions

function isCommandAvailable(...cmd: string[]): boolean {
  const command = cmd.length === 1 ? cmd[0] : cmd.join(' ');
  const result = spawnSync('which', [cmd[0]], {
    timeout: 5000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0) return false;

  // For compound commands like 'cargo clippy', test the full command
  if (cmd.length > 1) {
    const testResult = spawnSync('bash', ['-c', `${command} --help >/dev/null 2>&1`], {
      timeout: 5000,
    });
    return testResult.status === 0;
  }

  return true;
}

function makeTargetExists(cwd: string, target: string): boolean {
  try {
    const result = spawnSync('make', ['-n', target], {
      cwd,
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    // make -n returns 0 if target exists and is valid
    return result.status === 0;
  } catch {
    return false;
  }
}

function truncateOutput(text: string, maxLen: number = 2000): string {
  const cleaned = text.trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}...` : cleaned;
}

/** Combine stdout and stderr into a single labeled output block. */
function combineOutput(label: string, stdout: string, stderr: string): string {
  const parts: string[] = [`=== ${label} ===`];
  const out = stdout.trim();
  const err = stderr.trim();
  if (out) parts.push(`stdout:\n${out}`);
  if (err) parts.push(`stderr:\n${err}`);
  if (!out && !err) parts.push('(no output)');
  return parts.join('\n');
}
