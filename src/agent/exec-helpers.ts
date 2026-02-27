const CACHED_EXEC_OBSERVATION_HINT =
  '[idlehands hint] Reused cached output for repeated read-only exec call (unchanged observation).';

const REPLAYED_EXEC_HINT =
  '[idlehands hint] You already ran this exact command. This is the replayed result from your previous execution. Do NOT re-run it — use the output below to continue your task.';

/** Heuristic: classify shell command as read-only for cache replay safety. */
export function looksLikeReadOnlyExecCommand(command: string): boolean {
  let cmd = String(command || '')
    .trim()
    .toLowerCase();
  if (!cmd) return false;
  cmd = cmd.replace(/^(\s*cd\s+[^;&|]+\s*(?:&&|;)\s*)+/i, '').trim();
  if (!cmd) return false;

  if (/(^|\s)(?:>>?|<<?)\s*/.test(cmd)) return false;
  if (/\b(?:rm|mv|cp|touch|mkdir|rmdir|chmod|chown|truncate|dd)\b/.test(cmd)) return false;
  if (/\b(?:sed|perl)\b[^\n]*\s-i\b/.test(cmd)) return false;
  if (/\btee\b/.test(cmd)) return false;

  if (/\bgit\b/.test(cmd)) {
    if (
      /\bgit\b[^\n|;&]*\b(?:add|am|apply|bisect|checkout|switch|clean|clone|commit|fetch|merge|pull|push|rebase|reset|revert|stash)\b/.test(
        cmd
      )
    ) {
      return false;
    }
    if (
      /\bgit\b[^\n|;&]*\b(?:log|show|status|diff|rev-parse|branch(?:\s+--list)?|tag(?:\s+--list)?|ls-files|grep)\b/.test(
        cmd
      )
    ) {
      return true;
    }
  }

  if (/^\s*(?:grep|rg|ag|ack|find|ls|cat|head|tail|wc|stat)\b/.test(cmd)) return true;
  if (/\|\s*(?:grep|rg|ag|ack)\b/.test(cmd)) return true;
  if (/^\s*(?:file|which|type|uname|env|printenv|id|whoami|pwd)\b/.test(cmd)) return true;
  if (/\bgit\b[^\n|;&]*\b(?:blame|remote|config\s+--(?:get|list|global|local|system))\b/.test(cmd))
    return true;

  return false;
}

/** Heuristic: command where non-zero rc should be interpreted as failure signal. */
export function execRcShouldSignalFailure(command: string): boolean {
  const cmd = String(command || '').toLowerCase();
  if (!cmd) return false;

  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)\b/.test(cmd))
    return true;
  if (/\bnode\s+--test\b/.test(cmd)) return true;
  if (/\b(?:pytest|go\s+test|cargo\s+test|ctest|mvn\s+test|gradle\s+test)\b/.test(cmd)) return true;
  if (/\b(?:cargo\s+build|go\s+build|tsc\b)\b/.test(cmd)) return true;
  if (/^\s*(?:rg|grep|ag|ack)\b/.test(cmd)) return false;

  return false;
}

/** Annotate exec output payload/content with cached observation hint. */
export function withCachedExecObservationHint(content: string): string {
  if (!content) return content;

  try {
    const parsed = JSON.parse(content);
    const out = typeof parsed?.out === 'string' ? parsed.out : '';
    if (out.includes(CACHED_EXEC_OBSERVATION_HINT)) return content;
    parsed.out = out ? `${out}\n${CACHED_EXEC_OBSERVATION_HINT}` : CACHED_EXEC_OBSERVATION_HINT;
    parsed.cached_observation = true;
    return JSON.stringify(parsed);
  } catch {
    if (content.includes(CACHED_EXEC_OBSERVATION_HINT)) return content;
    return `${content}\n${CACHED_EXEC_OBSERVATION_HINT}`;
  }
}

/** Annotate exec output payload/content with replay hint. */
export function withReplayedExecHint(content: string): string {
  if (!content) return content;
  try {
    const parsed = JSON.parse(content);
    const out = typeof parsed?.out === 'string' ? parsed.out : '';
    if (out.includes(REPLAYED_EXEC_HINT)) return content;
    parsed.out = out ? `${REPLAYED_EXEC_HINT}\n${out}` : REPLAYED_EXEC_HINT;
    parsed.replayed = true;
    return JSON.stringify(parsed);
  } catch {
    if (content.includes(REPLAYED_EXEC_HINT)) return content;
    return `${REPLAYED_EXEC_HINT}\n${content}`;
  }
}

/** Whether an exec result payload is cacheable (rc===0 JSON payload). */
export function readOnlyExecCacheable(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    const rc = Number(parsed?.rc ?? NaN);
    return Number.isFinite(rc) && rc === 0;
  } catch {
    return false;
  }
}

/**
 * Normalize an exec command for signature comparison by stripping trailing
 * output-filter pipes (| tail, | head, | grep, | sed, | awk, | cut, | sort, | uniq).
 * This ensures commands like:
 *   `php artisan test --filter=X 2>&1 | tail -15`
 *   `php artisan test --filter=X 2>&1 | tail -50`
 * produce the same normalized form for loop detection.
 */
export function normalizeExecCommandForSig(command: string): string {
  let cmd = String(command || '').trim();
  if (!cmd) return cmd;

  // Strip trailing stderr redirects before pipe analysis
  // e.g. "command 2>&1 | tail -5" → normalize the pipe part
  // We want to keep 2>&1 that precede pipes but strip the output-filter pipes themselves.

  // Iteratively strip trailing output-filter pipes.
  // Match: | (tail|head|grep|sed|awk|cut|sort|uniq|wc|tr) [args...]
  // But only when they appear at the end of the command (i.e., the last pipe segment).
  const FILTER_PIPE_RE =
    /\s*\|\s*(?:tail|head|grep|egrep|fgrep|sed|awk|cut|sort|uniq|wc|tr)\b[^|]*$/i;

  let prev = cmd;
  for (let i = 0; i < 5; i++) {
    const stripped = cmd.replace(FILTER_PIPE_RE, '').trim();
    if (stripped === cmd || !stripped) break;
    cmd = stripped;
    if (cmd === prev) break;
    prev = cmd;
  }

  // Normalize awk/sed range-read commands to collapse different line ranges
  // targeting the same file into one signature. This prevents the model from
  // defeating loop detection by tweaking NR ranges on the same file.
  {
    // Strip leading cd && chains for analysis
    const stripped = cmd.replace(/^(\s*cd\s+[^;&|]+\s*(?:&&|;)\s*)+/i, '').trim();

    // awk 'NR>=M && NR<=N' FILE  or  awk 'NR>=M' FILE
    const awkMatch = stripped.match(
      /^\s*awk\s+['"]NR\s*>=\s*\d+(?:\s*&&\s*NR\s*<=\s*\d+)?['"]\s+(.+)$/i
    );
    if (awkMatch) {
      const file = awkMatch[1].trim().replace(/['"]$/g, '');
      // Preserve the cd prefix but normalize the awk range
      const cdPrefix = cmd.slice(0, cmd.length - stripped.length);
      cmd = cdPrefix + 'awk <range> ' + file;
      return cmd;
    }

    // sed -n 'M,Np' FILE
    const sedMatch = stripped.match(
      /^\s*sed\s+-n\s+['"]?\d+,\d+p['"]?\s+(.+)$/i
    );
    if (sedMatch) {
      const file = sedMatch[1].trim().replace(/['"]$/g, '');
      const cdPrefix = cmd.slice(0, cmd.length - stripped.length);
      cmd = cdPrefix + 'sed -n <range> ' + file;
      return cmd;
    }
  }

  return cmd;
}

/**
 * Detect `sed -n 'N,Mp' file` patterns used as a substitute for read_file.
 * Returns a redirect message if detected, or null if not a sed-as-read pattern.
 */
export function detectSedAsRead(command: string): string | null {
  let cmd = String(command || '').trim();
  if (!cmd) return null;

  // Strip leading cd && chains
  cmd = cmd.replace(/^(\s*cd\s+[^;&|]+\s*(?:&&|;)\s*)+/i, '').trim();
  if (!cmd) return null;

  // Match: sed -n 'START,ENDp' FILE  (with optional quotes around the range)
  const match = cmd.match(
    /^\s*sed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+(.+)$/i
  );
  if (!match) return null;

  const startLine = parseInt(match[1], 10);
  const endLine = parseInt(match[2], 10);
  const filePath = match[3].trim().replace(/['"]$/g, '');
  const limit = endLine - startLine + 1;

  return (
    `STOP: Do not use sed to read file sections. Use read_file instead:\n` +
    `  read_file({ path: "${filePath}", offset: ${startLine}, limit: ${limit} })\n` +
    `This is faster, tracked by the read budget, and avoids unnecessary exec calls.`
  );
}

/**
 * Detect `awk 'NR>=M && NR<=N' file` patterns used as a substitute for read_file.
 * Returns a redirect message if detected, or null if not an awk-as-read pattern.
 */
export function detectAwkAsRead(command: string): string | null {
  let cmd = String(command || '').trim();
  if (!cmd) return null;

  // Strip leading cd && chains
  cmd = cmd.replace(/^(\s*cd\s+[^;&|]+\s*(?:&&|;)\s*)+/i, '').trim();
  if (!cmd) return null;

  // Match: awk 'NR>=START && NR<=END' FILE
  const matchRange = cmd.match(
    /^\s*awk\s+['"]NR\s*>=\s*(\d+)\s*&&\s*NR\s*<=\s*(\d+)['"]\s+(.+?)(?:\s*\|.*)?$/i
  );
  if (matchRange) {
    const startLine = parseInt(matchRange[1], 10);
    const endLine = parseInt(matchRange[2], 10);
    const filePath = matchRange[3].trim().replace(/['"]$/g, '');
    const limit = endLine - startLine + 1;
    return (
      `STOP: Do not use awk to read file sections. Use read_file instead:\n` +
      `  read_file({ path: "${filePath}", offset: ${startLine}, limit: ${limit} })\n` +
      `This is faster, tracked by the read budget, and avoids unnecessary exec calls.`
    );
  }

  // Match: awk 'NR>=START' FILE (no upper bound)
  const matchFrom = cmd.match(
    /^\s*awk\s+['"]NR\s*>=\s*(\d+)['"]\s+(.+?)(?:\s*\|.*)?$/i
  );
  if (matchFrom) {
    const startLine = parseInt(matchFrom[1], 10);
    const filePath = matchFrom[2].trim().replace(/['"]$/g, '');
    return (
      `STOP: Do not use awk to read file sections. Use read_file instead:\n` +
      `  read_file({ path: "${filePath}", offset: ${startLine}, limit: 100 })\n` +
      `This is faster, tracked by the read budget, and avoids unnecessary exec calls.`
    );
  }

  // Match: awk 'NR==LINE' FILE (single line)
  const matchSingle = cmd.match(
    /^\s*awk\s+['"]NR\s*==\s*(\d+)['"]\s+(.+?)(?:\s*\|.*)?$/i
  );
  if (matchSingle) {
    const line = parseInt(matchSingle[1], 10);
    const filePath = matchSingle[2].trim().replace(/['"]$/g, '');
    return (
      `STOP: Do not use awk to read single lines. Use read_file instead:\n` +
      `  read_file({ path: "${filePath}", offset: ${line}, limit: 1 })\n` +
      `This is faster, tracked by the read budget, and avoids unnecessary exec calls.`
    );
  }

  return null;
}

/**
 * Extract the grep/search pattern from an exec grep command.
 * Returns { pattern, paths } or null if not a grep command.
 */
export function extractGrepPattern(command: string): { pattern: string; paths: string[] } | null {
  let cmd = String(command || '').trim();
  if (!cmd) return null;

  // Strip leading cd && chains
  cmd = cmd.replace(/^(\s*cd\s+[^;&|]+\s*(?:&&|;)\s*)+/i, '').trim();

  // Match: grep [flags] "pattern" path(s)
  // Common forms:
  //   grep -rn "pattern" path/
  //   grep -n "pattern" file
  //   grep -A5 "pattern" file
  const grepMatch = cmd.match(
    /^\s*(?:grep|egrep|fgrep|rg)\s+(?:[-]\w+\s+)*(?:["']([^"']+)["']|(\S+))\s+(.+?)(?:\s*\|.*)?$/i
  );
  if (!grepMatch) return null;

  const pattern = grepMatch[1] || grepMatch[2];
  if (!pattern) return null;

  const pathStr = grepMatch[3].trim();
  // Split paths on whitespace (simplified — doesn't handle quoted paths with spaces)
  const paths = pathStr.split(/\s+/).filter((p) => !p.startsWith('-'));

  return { pattern, paths };
}

/**
 * Detect `cat file`, `head -N file`, `tail -N file` patterns used as
 * substitutes for read_file. Returns a redirect message or null.
 * Does NOT match `tail file | grep` (log tailing) — only pure file reads.
 */
export function detectCatHeadTailAsRead(command: string): string | null {
  let cmd = String(command || '').trim();
  if (!cmd) return null;

  // Strip leading cd && chains
  cmd = cmd.replace(/^(\s*cd\s+[^;&|]+\s*(?:&&|;)\s*)+/i, '').trim();
  if (!cmd) return null;

  // Detect cat FILE | head -N | tail -M (manual file pagination)
  const catPipeMatch = cmd.match(
    /^\s*cat\s+(\S+)\s*\|\s*head\s+(?:-n?\s*)?(\d+)\s*(?:\|\s*tail\s+(?:-n?\s*)?(\d+))?\s*$/i
  );
  if (catPipeMatch) {
    const filePath = catPipeMatch[1].replace(/['"]$/g, '').replace(/^['"]/, '');
    const headN = parseInt(catPipeMatch[2], 10);
    const tailN = catPipeMatch[3] ? parseInt(catPipeMatch[3], 10) : 0;
    if (tailN > 0) {
      const offset = headN - tailN + 1;
      return (
        `STOP: Do not use cat|head|tail to paginate files. Use read_file instead:\n` +
        `  read_file({ path: "${filePath}", offset: ${offset}, limit: ${tailN} })\n` +
        `This is faster, tracked by the read budget, and avoids unnecessary exec calls.`
      );
    }
    return (
      `STOP: Do not use cat|head to read files. Use read_file instead:\n` +
      `  read_file({ path: "${filePath}", limit: ${headN} })\n` +
      `This is faster, tracked by the read budget, and avoids unnecessary exec calls.`
    );
  }

  // Skip other commands with pipes (grep/filter chains, not simple reads)
  if (/\|/.test(cmd)) return null;

  // cat FILE (possibly with | head at the end, but we already excluded pipes)
  const catMatch = cmd.match(/^\s*cat\s+(\S+)\s*$/i);
  if (catMatch) {
    const filePath = catMatch[1].replace(/['"]$/g, '').replace(/^['"]/, '');
    return (
      `STOP: Do not use cat to read files. Use read_file instead:\n` +
      `  read_file({ path: "${filePath}" })\n` +
      `This is faster, tracked by the read budget, and avoids unnecessary exec calls.`
    );
  }

  // head -N FILE or head -n N FILE
  const headMatch = cmd.match(/^\s*head\s+(?:-n?\s*)?(\d+)\s+(\S+)\s*$/i);
  if (headMatch) {
    const limit = parseInt(headMatch[1], 10);
    const filePath = headMatch[2].replace(/['"]$/g, '').replace(/^['"]/, '');
    return (
      `STOP: Do not use head to read files. Use read_file instead:\n` +
      `  read_file({ path: "${filePath}", limit: ${limit} })\n` +
      `This is faster, tracked by the read budget, and avoids unnecessary exec calls.`
    );
  }

  // tail -N FILE (without pipes — pure tail reads)
  const tailMatch = cmd.match(/^\s*tail\s+(?:-n?\s*)?(\d+)\s+(\S+)\s*$/i);
  if (tailMatch) {
    const filePath = tailMatch[2].replace(/['"]$/g, '').replace(/^['"]/, '');
    return (
      `STOP: Do not use tail to read files. Use read_file instead:\n` +
      `  read_file({ path: "${filePath}" }) with search to find the section you need.\n` +
      `This is faster, tracked by the read budget, and avoids unnecessary exec calls.`
    );
  }

  return null;
}

/**
 * Extract the test filter name from an exec command containing a test runner.
 * Returns the filter string or null.
 */
export function extractTestFilter(command: string): string | null {
  let cmd = String(command || '').trim();
  if (!cmd) return null;

  // Strip leading cd && chains
  cmd = cmd.replace(/^(\s*cd\s+[^;&|]+\s*(?:&&|;)\s*)+/i, '').trim();
  if (!cmd) return null;

  // php artisan test --filter=NAME or --filter NAME
  const artisanMatch = cmd.match(/--filter[= ](\S+)/i);
  if (artisanMatch) return artisanMatch[1];

  // pytest -k "expression"
  const pytestMatch = cmd.match(/pytest\s.*-k\s+["']?([^"'\s]+)/i);
  if (pytestMatch) return pytestMatch[1];

  // jest/vitest --testNamePattern or -t
  const jestMatch = cmd.match(/(?:--testNamePattern|--testPathPattern|-t)\s+["']?([^"'\s]+)/i);
  if (jestMatch) return jestMatch[1];

  return null;
}


/**
 * Extract the target file path from an exec grep command that targets a single file.
 * Returns the file path or null if the grep doesn't target a specific file.
 * Used to detect same-file grep thrashing (many different patterns on the same file).
 */
export function extractGrepTargetFile(command: string): string | null {
  let cmd = String(command || '').trim();
  if (!cmd) return null;

  // Strip leading cd && chains
  cmd = cmd.replace(/^(\s*cd\s+[^;&|]+\s*(?:&&|;)\s*)+/i, '').trim();

  // Match: grep [flags] "pattern" SINGLE_FILE (no wildcards, no directory recursion)
  const grepMatch = cmd.match(
    /^\s*(?:grep|egrep|fgrep)\s+(?:-\w+\s+)*(?:["'][^"']+["']|\S+)\s+(\S+?)\s*$/i
  );
  if (!grepMatch) return null;

  const filePath = grepMatch[1].replace(/['"]$/g, '').replace(/^['"]/, '');
  // Skip wildcards, directories (ending in /), and flags
  if (filePath.startsWith('-') || filePath.includes('*') || filePath.endsWith('/')) return null;
  // Must look like a file (has an extension or path separator)
  if (!filePath.includes('.') && !filePath.includes('/')) return null;

  return filePath;
}
/**
 * Extract the target file path from a tail/grep log-reading command.
 * Returns the log file path or null if not a log-reading command.
 */
export function extractLogFilePath(command: string): string | null {
  let cmd = String(command || '').trim();
  if (!cmd) return null;

  // Strip leading cd && chains
  cmd = cmd.replace(/^(\s*cd\s+[^;&|]+\s*(?:&&|;)\s*)+/i, '').trim();
  if (!cmd) return null;

  // Match tail -N FILE, grep PATTERN FILE where FILE looks like a log
  const logPatterns = [
    /\btail\s+(?:-[nf]?\s*)?(?:\d+\s+)?(\S*\.log\S*)/i,
    /\bgrep\b[^|]*?(\S*\.log\S*)/i,
    /\bcat\s+(\S*\.log\S*)/i,
  ];

  for (const re of logPatterns) {
    const match = cmd.match(re);
    if (match) {
      const path = match[1].replace(/['"]$/g, '').replace(/^['"]/, '');
      // Only match actual log files, not things like "grep log" matching the word
      if (path.includes('.log')) return path;
    }
  }

  return null;
}

/**
 * Extract the target file path from a cat/head/tail command.
 * Used to look up cached content when the model falls back to shell
 * commands after read_file is poisoned (deadlock prevention).
 * Returns the file path or null if not a simple file read command.
 */
export function extractFilePathFromReadCommand(command: string): string | null {
  let cmd = String(command || '').trim();
  if (!cmd) return null;

  // Strip leading cd && chains
  cmd = cmd.replace(/^(\s*cd\s+[^;&|]+\s*(?:&&|;)\s*)+/i, '').trim();
  if (!cmd) return null;

  // cat FILE (no pipes)
  const catMatch = cmd.match(/^\s*cat\s+(\S+)\s*$/i);
  if (catMatch) {
    return catMatch[1].replace(/['"]/g, '');
  }

  // head -N FILE or head -n N FILE
  const headMatch = cmd.match(/^\s*head\s+(?:-n?\s*)?\d+\s+(\S+)\s*$/i);
  if (headMatch) {
    return headMatch[1].replace(/['"]/g, '');
  }

  // tail -N FILE (no pipes)
  const tailMatch = cmd.match(/^\s*tail\s+(?:-n?\s*)?\d+\s+(\S+)\s*$/i);
  if (tailMatch) {
    return tailMatch[1].replace(/['"]/g, '');
  }

  // cat FILE | head -N (pagination pattern)
  const catPipeMatch = cmd.match(/^\s*cat\s+(\S+)\s*\|\s*head/i);
  if (catPipeMatch) {
    return catPipeMatch[1].replace(/['"]/g, '');
  }

  return null;
}

/**
 * Normalize test commands for loop detection.
 * Extracts the test framework and filter/target so that running the same test
 * repeatedly with different output options is detected as a loop.
 * 
 * Examples:
 *   "php artisan test --filter=FooTest 2>&1 | tail -20" → "php artisan test --filter=FooTest"
 *   "npm test -- --grep=\"bar\"" → "npm test --grep=\"bar\""
 *   "pytest tests/test_foo.py -v" → "pytest tests/test_foo.py"
 *   "go test ./... -run TestBar" → "go test -run TestBar"
 * 
 * Returns the normalized command or the original if not a recognized test command.
 */
export function normalizeTestCommandForSig(command: string): string | null {
  let cmd = String(command || "").trim();
  if (!cmd) return null;

  // Strip leading cd && chains
  cmd = cmd.replace(/^(\s*cd\s+[^;&|]+\s*(?:&&|;)\s*)+/i, "").trim();
  if (!cmd) return null;

  // First apply the general exec normalization (strips tail/head/grep pipes)
  cmd = normalizeExecCommandForSig(cmd);

  // PHP/Laravel: php artisan test --filter=X
  const phpMatch = cmd.match(
    /^\s*(php\s+artisan\s+test)\s+(--filter[=\s]+\S+)/i
  );
  if (phpMatch) {
    return `${phpMatch[1]} ${phpMatch[2]}`.trim();
  }

  // PHPUnit: phpunit --filter X or vendor/bin/phpunit --filter X
  const phpunitMatch = cmd.match(
    /^\s*((?:vendor\/bin\/)?phpunit)\s+.*?(--filter[=\s]+\S+)/i
  );
  if (phpunitMatch) {
    return `${phpunitMatch[1]} ${phpunitMatch[2]}`.trim();
  }

  // Jest/npm test: npm test -- --grep="X" or npx jest --testNamePattern=X
  const npmTestMatch = cmd.match(
    /^\s*(npm\s+test|npx\s+jest)\s+.*?(--(?:grep|testNamePattern|testPathPattern)[=\s]+\S+)/i
  );
  if (npmTestMatch) {
    return `${npmTestMatch[1]} ${npmTestMatch[2]}`.trim();
  }

  // Pytest: pytest path/test.py or pytest -k "pattern"
  const pytestMatch = cmd.match(
    /^\s*(pytest)\s+(?:.*?(-k\s+\S+)|(\S+\.py\b))/i
  );
  if (pytestMatch) {
    const target = pytestMatch[2] || pytestMatch[3];
    return `pytest ${target}`.trim();
  }

  // Go test: go test ./... -run TestX
  const goTestMatch = cmd.match(
    /^\s*(go\s+test)\s+.*?(-run\s+\S+)/i
  );
  if (goTestMatch) {
    return `${goTestMatch[1]} ${goTestMatch[2]}`.trim();
  }

  // Cargo test: cargo test test_name
  const cargoMatch = cmd.match(
    /^\s*(cargo\s+test)\s+(\S+)/i
  );
  if (cargoMatch && !cargoMatch[2].startsWith("-")) {
    return `${cargoMatch[1]} ${cargoMatch[2]}`.trim();
  }

  // Not a recognized test command
  return null;
}
