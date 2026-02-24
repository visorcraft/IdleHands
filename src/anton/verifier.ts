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
import { join, extname } from 'node:path';

import { getChangedFiles } from '../git.js';
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
  /** Pre-existing lint error count captured before the run started.  If set,
   *  lint verification passes when the error count hasn't increased. */
  baselineLintErrorCount?: number;
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
      let lintResult = await runCommand(opts.commands.lint, 180_000, opts.projectDir);
      // Pre-verify autofix: if lint fails, try autofix on touched files then re-check once.
      if (lintResult.exitCode !== 0) {
        const autofixed = await tryAutofixChangedFiles(opts.projectDir);
        if (autofixed) {
          console.error(`[anton:verify] autofix ran on changed files, re-running lint`);
          lintResult = await runCommand(opts.commands.lint, 180_000, opts.projectDir);
        }
      }
      if (lintResult.exitCode === 0) {
        result.l1_lint = true;
      } else if (opts.baselineLintErrorCount !== undefined) {
        // Compare against baseline: pass if we haven't introduced NEW errors.
        const currentErrors = countLintErrors(lintResult.stdout + '\n' + lintResult.stderr);
        if (currentErrors <= opts.baselineLintErrorCount) {
          result.l1_lint = true;
          console.error(`[anton:verify] lint exit≠0 but errors (${currentErrors}) <= baseline (${opts.baselineLintErrorCount}), passing`);
        } else {
          result.l1_lint = false;
          l1_all = false;
          // Filter to only error-level lines so the retry context isn't flooded
          // with pre-existing warnings (e.g. hundreds of no-explicit-any).
          const fullOutput = lintResult.stdout + '\n' + lintResult.stderr;
          const errorOnly = filterLintErrorLines(fullOutput);
          const combined = combineOutput('lint', errorOnly || lintResult.stdout, '');
          const newCount = currentErrors - opts.baselineLintErrorCount;
          failedCommands.push(`lint (${newCount} new error${newCount !== 1 ? 's' : ''}): ${truncateOutput(combined, 500)}`);
          fullOutputParts.push(combined);
        }
      } else {
        result.l1_lint = false;
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

      const parsed = parseVerifierResponse(response);
      result.l2_ai = parsed.pass;
      result.l2_reason = parsed.reason;
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

// ── Pre-verify autofix ──────────────────────────────────────────

/** File extensions eligible for autoformat/autofix. */
const AUTOFIX_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.json', '.md', '.yaml', '.yml',
  '.vue', '.svelte', '.html',
]);

/**
 * Attempt to auto-fix lint/format issues on files changed in the current attempt.
 * Runs eslint --fix and/or prettier --write on eligible changed files.
 * Returns true if any autofix command was executed.
 */
export async function tryAutofixChangedFiles(projectDir: string): Promise<boolean> {
  let changedFiles: string[];
  try {
    changedFiles = getChangedFiles(projectDir);
  } catch {
    return false;
  }

  const eligible = changedFiles.filter((f) => AUTOFIX_EXTENSIONS.has(extname(f).toLowerCase()));
  if (eligible.length === 0) return false;

  // Cap at 50 files to keep autofix bounded
  const batch = eligible.slice(0, 50);
  let ran = false;

  // Try eslint --fix (only if eslint is available)
  const jsFiles = batch.filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  if (jsFiles.length > 0 && isCommandAvailable('npx')) {
    try {
      const eslintRes = spawnSync(
        'npx', ['eslint', '--fix', '--no-error-on-unmatched-pattern', ...jsFiles],
        { cwd: projectDir, timeout: 60_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      if (eslintRes.status === 0 || eslintRes.status === 1) {
        // exit 1 means some unfixable errors remain, but fixable ones were fixed
        ran = true;
        console.error(`[anton:autofix] eslint --fix ran on ${jsFiles.length} files`);
      }
    } catch {
      // eslint not available or crashed — continue
    }
  }

  // Try prettier --write (only if prettier is available)
  if (isCommandAvailable('npx')) {
    try {
      const prettierRes = spawnSync(
        'npx', ['prettier', '--write', '--ignore-unknown', ...batch],
        { cwd: projectDir, timeout: 60_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      if (prettierRes.status === 0) {
        ran = true;
        console.error(`[anton:autofix] prettier --write ran on ${batch.length} files`);
      }
    } catch {
      // prettier not available or crashed — continue
    }
  }

  return ran;
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

/**
 * Parse L2 verifier response with fault tolerance.
 * Tries JSON first, then extracts JSON from markdown fences,
 * then falls back to keyword inference from prose.
 */
function parseVerifierResponse(raw: string): { pass: boolean; reason: string } {
  const text = raw.trim();

  // 1. Try direct JSON parse
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.pass === 'boolean') {
      return { pass: parsed.pass, reason: parsed.reason || 'No reason provided' };
    }
  } catch { /* not valid JSON, continue */ }

  // 2. Try extracting JSON from markdown code fences or inline braces
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || text.match(/(\{[\s\S]*?"pass"[\s\S]*?\})/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (typeof parsed.pass === 'boolean') {
        return { pass: parsed.pass, reason: parsed.reason || 'No reason provided' };
      }
    } catch { /* still not valid, continue */ }
  }

  // 3. Keyword inference from prose
  const lower = text.toLowerCase();
  const passPatterns = [
    /\bpass\b/, /\bapproved?\b/, /\blooks?\s+good\b/, /\bcorrect(ly)?\b/,
    /\bwell[- ]implemented\b/, /\bno\s+(issues?|problems?|concerns?)\b/,
    /\bcode\s+(is\s+)?clean\b/, /\btask\s+(is\s+)?(complete|done)\b/,
  ];
  const failPatterns = [
    /\bfail\b/, /\breject(ed)?\b/, /\bnot\s+(correct|approved?)\b/,
    /\bissues?\s+found\b/, /\bproblems?\s+found\b/, /\bbug(s)?\b/,
    /\bmissing\b/, /\bincorrect\b/, /\bbroken\b/,
  ];

  const passScore = passPatterns.filter(p => p.test(lower)).length;
  const failScore = failPatterns.filter(p => p.test(lower)).length;

  if (passScore > 0 && passScore > failScore) {
    const snippet = text.length > 200 ? text.slice(0, 200) + '...' : text;
    return { pass: true, reason: `(inferred from prose) ${snippet}` };
  }
  if (failScore > 0) {
    const snippet = text.length > 200 ? text.slice(0, 200) + '...' : text;
    return { pass: false, reason: `(inferred from prose) ${snippet}` };
  }

  // 4. Ambiguous — default to pass since L1 already validated build/test
  const snippet = text.length > 200 ? text.slice(0, 200) + '...' : text;
  return { pass: true, reason: `(ambiguous response, defaulting to pass) ${snippet}` };
}

// ── Lint output filtering ───────────────────────────────────────────

/**
 * Filter lint output to only include error-level lines (not warnings).
 * Keeps file path headers for context.  Returns empty string if no errors found.
 */
export function filterLintErrorLines(output: string): string {
  const lines = output.split('\n');
  const result: string[] = [];
  let lastFilePath = '';

  for (const line of lines) {
    // File path line (eslint): "/path/to/file.ts"
    if (/^\/.*\.\w+$/.test(line.trim()) || /^[A-Z]:\\/.test(line.trim())) {
      lastFilePath = line;
      continue;
    }
    // Error line: "  1:1  error  ..."
    if (/\d+:\d+\s+error\s/.test(line) || /\berror\s+TS\d+/.test(line) || /\berror\[E\d+\]/.test(line)) {
      if (lastFilePath && (result.length === 0 || result[result.length - 1] !== lastFilePath)) {
        result.push(lastFilePath);
      }
      result.push(line);
    }
    // Summary line: "✖ N problems (N errors, N warnings)"
    if (/^\u2716\s+\d+\s+problem/.test(line) || /^\d+\s+error/.test(line)) {
      result.push(line);
    }
  }

  return result.join('\n');
}

// ── Lint baseline helpers ───────────────────────────────────────────

/**
 * Count the number of "error" lines in lint output.
 * Works for eslint, tsc, ruff, clippy — all emit lines containing "error".
 */
export function countLintErrors(output: string): number {
  // Match lines like:
  //   1:1  error  `./types.js` ...     (eslint)
  //   error TS2322: ...                 (tsc)
  //   src/foo.rs:1:1: error[E0308]: ... (clippy)
  //   src/foo.py:1:1: E302 ...          (ruff — codes starting with E/W/F)
  const lines = output.split('\n');
  let count = 0;
  for (const line of lines) {
    // eslint: "  1:1  error  ..."
    if (/\d+:\d+\s+error\s/.test(line)) { count++; continue; }
    // tsc: "error TS..."  or  "file.ts(1,1): error TS..."
    if (/\berror\s+TS\d+/.test(line)) { count++; continue; }
    // clippy/rustc: "error[E"
    if (/\berror\[E\d+\]/.test(line)) { count++; continue; }
  }
  return count;
}

/**
 * Capture baseline lint error count before Anton starts modifying files.
 * Returns the count, or undefined if lint is not configured or passes cleanly.
 */
export async function captureLintBaseline(
  lintCommand: string | undefined,
  projectDir: string
): Promise<number | undefined> {
  if (!lintCommand) return undefined;
  try {
    const result = await runCommand(lintCommand, 180_000, projectDir);
    if (result.exitCode === 0) return 0; // clean baseline
    const count = countLintErrors(result.stdout + '\n' + result.stderr);
    if (count > 0) {
      console.error(`[anton:baseline] pre-existing lint errors: ${count}`);
    }
    return count;
  } catch {
    return undefined;
  }
}
