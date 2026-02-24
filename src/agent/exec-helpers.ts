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
