import { spawnSync } from 'node:child_process';

import { getChangedFiles } from '../git.js';

export type ScopeGuardMode = 'off' | 'lax' | 'strict';

export type ScopeGuardResult = { ok: true } | { ok: false; reason: string; details: string };

/**
 * Check if a changed file is related to an expected file.
 * Used in 'lax' mode to allow test files, same-directory files, etc.
 */
function isRelatedFile(changedFile: string, expectedFile: string): boolean {
  const changedBase = changedFile.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  const expectedBase = expectedFile.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  const changedDir = changedFile.includes('/') ? changedFile.replace(/\/[^/]+$/, '') : '';
  const expectedDir = expectedFile.includes('/') ? expectedFile.replace(/\/[^/]+$/, '') : '';

  // Same base name (e.g., AdminAction.php and AdminActionTest.php)
  if (changedBase === expectedBase || changedBase.startsWith(expectedBase) || expectedBase.startsWith(changedBase)) {
    return true;
  }

  // Test file patterns: FooTest, Foo.test, Foo.spec, test_Foo, foo_test
  const testPatterns = [
    new RegExp(`^${expectedBase}[._-]?[Tt]est`, 'i'),
    new RegExp(`^${expectedBase}[._-]?[Ss]pec`, 'i'),
    new RegExp(`^[Tt]est[._-]?${expectedBase}`, 'i'),
    new RegExp(`${expectedBase}[._-]test$`, 'i'),
    new RegExp(`${expectedBase}[._-]spec$`, 'i'),
  ];
  if (testPatterns.some(p => p.test(changedBase))) {
    return true;
  }

  // Changed file is in a test directory and references the expected file's base name
  const testDirs = ['tests', 'test', '__tests__', 'spec', 'specs', 'unit', 'integration', 'feature'];
  const changedDirParts = changedDir.toLowerCase().split('/');
  if (testDirs.some(d => changedDirParts.includes(d)) && changedBase.toLowerCase().includes(expectedBase.toLowerCase())) {
    return true;
  }

  // Same directory
  if (changedDir && expectedDir && changedDir === expectedDir) {
    return true;
  }

  // Factory, fixture, mock, stub files related to the expected file
  const relatedPatterns = [
    new RegExp(`${expectedBase}[._-]?[Ff]actory`, 'i'),
    new RegExp(`${expectedBase}[._-]?[Ff]ixture`, 'i'),
    new RegExp(`${expectedBase}[._-]?[Mm]ock`, 'i'),
    new RegExp(`${expectedBase}[._-]?[Ss]tub`, 'i'),
    new RegExp(`[Mm]ock[._-]?${expectedBase}`, 'i'),
  ];
  if (relatedPatterns.some(p => p.test(changedBase))) {
    return true;
  }

  return false;
}

/**
 * If task text explicitly names files, enforce working tree changes stay in scope.
 * 
 * @param mode - 'off' (disabled), 'lax' (allow related files), 'strict' (exact match only)
 */
export function checkTaskScopeGuard(
  taskText: string,
  projectDir: string,
  mode: ScopeGuardMode = 'strict'
): ScopeGuardResult {
  // Mode: off - no scope checking
  if (mode === 'off') {
    return { ok: true };
  }

  const expected = extractExplicitTaskFiles(taskText);
  if (expected.length === 0) return { ok: true };

  const changed = getChangedFiles(projectDir)
    .map((p) => p.replace(/^\.\//, ''))
    .filter(Boolean);

  if (changed.length === 0) return { ok: true };

  const expectedSet = new Set(expected);
  
  let outOfScope: string[];
  
  if (mode === 'strict') {
    // Strict: only exact matches allowed
    outOfScope = changed.filter((f) => !expectedSet.has(f));
  } else {
    // Lax: allow related files (tests, same directory, etc.)
    outOfScope = changed.filter((changedFile) => {
      // Check exact match first
      if (expectedSet.has(changedFile)) return false;
      
      // Check if related to any expected file
      for (const expectedFile of expected) {
        if (isRelatedFile(changedFile, expectedFile)) {
          return false; // Not out of scope - it's related
        }
      }
      
      return true; // Out of scope
    });
  }

  if (outOfScope.length === 0) return { ok: true };

  return {
    ok: false,
    reason: `Scope guard failed: task explicitly targets ${expected.join(', ')} but modified out-of-scope files`,
    details: `Expected: ${expected.join(', ')}\nChanged: ${changed.join(', ')}\nOut-of-scope: ${outOfScope.join(', ')}\nMode: ${mode}`,
  };
}

export function extractExplicitTaskFiles(taskText: string): string[] {
  const text = String(taskText || '');
  const files = new Set<string>();

  const pathRegex = /\b([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]{1,8})\b/g;
  for (const m of text.matchAll(pathRegex)) {
    files.add(m[1].replace(/^\.\//, ''));
  }

  const bareRegex = /\b([A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8})\b/g;
  for (const m of text.matchAll(bareRegex)) {
    const file = m[1];
    if (!file.includes('/')) files.add(file);
  }

  return [...files];
}

export function isCommandAvailable(...cmd: string[]): boolean {
  const command = cmd.length === 1 ? cmd[0] : cmd.join(' ');
  const result = spawnSync('which', [cmd[0]], {
    timeout: 5000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0) return false;

  if (cmd.length > 1) {
    const testResult = spawnSync('bash', ['-c', `${command} --help >/dev/null 2>&1`], {
      timeout: 5000,
    });
    return testResult.status === 0;
  }

  return true;
}

export function makeTargetExists(cwd: string, target: string): boolean {
  try {
    const result = spawnSync('make', ['-n', target], {
      cwd,
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function truncateOutput(text: string, maxLen: number = 2000): string {
  const cleaned = text.trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}...` : cleaned;
}

export function combineOutput(label: string, stdout: string, stderr: string): string {
  const parts: string[] = [`=== ${label} ===`];
  const out = stdout.trim();
  const err = stderr.trim();
  if (out) parts.push(`stdout:\n${out}`);
  if (err) parts.push(`stderr:\n${err}`);
  if (!out && !err) parts.push('(no output)');
  return parts.join('\n');
}

export function parseVerifierResponse(raw: string): { pass: boolean; reason: string } {
  const text = raw.trim();

  // 1. Try direct JSON parse
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.pass === 'boolean') {
      return { pass: parsed.pass, reason: parsed.reason || 'No reason provided' };
    }
  } catch {
    /* not valid JSON, continue */
  }

  // 2. Try extracting JSON from markdown code fences or inline braces
  const jsonMatch =
    text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || text.match(/(\{[\s\S]*?"pass"[\s\S]*?\})/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (typeof parsed.pass === 'boolean') {
        return { pass: parsed.pass, reason: parsed.reason || 'No reason provided' };
      }
    } catch {
      /* still not valid, continue */
    }
  }

  // 3. Keyword inference from prose
  const lower = text.toLowerCase();
  const passPatterns = [
    /\bpass\b/,
    /\bapproved?\b/,
    /\blooks?\s+good\b/,
    /\bcorrect(ly)?\b/,
    /\bwell[- ]implemented\b/,
    /\bno\s+(issues?|problems?|concerns?)\b/,
    /\bcode\s+(is\s+)?clean\b/,
    /\btask\s+(is\s+)?(complete|done)\b/,
  ];
  const failPatterns = [
    /\bfail\b/,
    /\breject(ed)?\b/,
    /\bnot\s+(correct|approved?)\b/,
    /\bissues?\s+found\b/,
    /\bproblems?\s+found\b/,
    /\bbug(s)?\b/,
    /\bmissing\b/,
    /\bincorrect\b/,
    /\bbroken\b/,
  ];

  const passScore = passPatterns.filter((p) => p.test(lower)).length;
  const failScore = failPatterns.filter((p) => p.test(lower)).length;

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
