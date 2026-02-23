import path from 'node:path';

/** Maximum chars for tool result digest stored in live messages. */
const MAX_DIGEST_CHARS = 4000;

/**
 * Generate a token-efficient digest for a tool result.
 * This is stored in live messages[] instead of full output to reduce prompt size.
 * Full output should be archived to vault keyed by tool_call_id for retrieval.
 */
function digestFailureContent(content: string, callIdHint?: string): string {
  const lines = String(content ?? '').split('\n');
  const head = lines.slice(0, 20);
  const tail = lines.length > 40 ? lines.slice(-20) : lines.slice(20);
  const middleOmitted = Math.max(0, lines.length - (head.length + tail.length));

  const out: string[] = [];
  out.push(...head);
  if (middleOmitted > 0) out.push(`... (${middleOmitted} lines omitted)`);
  if (tail.length) out.push(...tail);
  if (callIdHint) out.push(`[full failure output archived in vault: call_id=${callIdHint}]`);

  const joined = out.join('\n');
  return joined.length > MAX_DIGEST_CHARS
    ? joined.slice(0, MAX_DIGEST_CHARS) + '\n# [failure digest truncated]'
    : joined;
}

export function digestToolResult(
  name: string,
  args: Record<string, unknown>,
  content: string,
  success: boolean
): string {
  if (!success) {
    const callIdHint =
      typeof (args as any)?._tool_call_id === 'string'
        ? String((args as any)._tool_call_id)
        : undefined;
    return digestFailureContent(content, callIdHint);
  }

  if (content.length <= MAX_DIGEST_CHARS) {
    return content;
  }

  // Tool-specific digest strategies
  switch (name) {
    case 'read_file':
    case 'read_files': {
      const lines = content.split('\n');
      const lineCount = lines.length;
      const trailer = lines.length > 20 ? `\n# ... (${lineCount - 20} more lines)` : '';
      return lines.slice(0, 20).join('\n') + trailer;
    }
    case 'exec': {
      try {
        const parsed = JSON.parse(content);
        const rc = parsed.rc ?? '?';
        const outLines = String(parsed.out || '').split('\n');
        const errLines = String(parsed.err || '')
          .split('\n')
          .filter(Boolean);
        const outPreview = outLines.slice(-15).join('\n');
        const errPreview = errLines.slice(0, 5).join('\n');
        const truncated =
          outLines.length > 15 ? `\n# ... (${outLines.length - 15} more lines)` : '';
        const errSection = errPreview ? `\n[stderr]\n${errPreview}` : '';
        return (
          JSON.stringify({
            rc,
            out: outPreview + truncated,
            ...(errPreview && { err: errPreview }),
          }) + errSection
        );
      } catch {
        return (
          content.slice(0, MAX_DIGEST_CHARS) +
          (content.length > MAX_DIGEST_CHARS ? '\n# [truncated]' : '')
        );
      }
    }
    case 'search_files': {
      const lines = content.split('\n');
      const count = lines.filter((l) => l.includes(':') && !l.startsWith('[')).length;
      const top = lines.slice(0, 15).join('\n');
      const marker = lines.find((l) => l.includes('[truncated,') && l.includes('chars total'));
      const truncated =
        lines.length > 15
          ? `\n# ... (${lines.length - 15} more matches, ${count} total)`
          : marker
            ? `\n${marker}`
            : '';
      return top + truncated;
    }
    case 'list_dir': {
      const lines = content.split('\n');
      const count = lines.filter((l) => l.includes('\t') && !l.startsWith('[')).length;
      const top = lines.slice(0, 20).join('\n');
      const marker = lines.find((l) => l.includes('[truncated,') && l.includes('chars total'));
      const truncated =
        lines.length > 20
          ? `\n# ... (${lines.length - 20} more entries, ${count} total)${marker ? `\n${marker}` : ''}`
          : marker
            ? `\n${marker}`
            : '';
      return top + truncated;
    }
    case 'spawn_task': {
      // Keep the final status line and last 20 lines of output
      const lines = content.split('\n');
      const statusLine = lines.find((l) => l.includes('status=')) || '';
      const tail = lines.slice(-20).join('\n');
      const header = statusLine ? `${statusLine}\n` : '';
      const truncated =
        lines.length > 20 ? `# ... (${lines.length - 20} earlier lines omitted)\n` : '';
      return header + truncated + tail;
    }
    default:
      // Generic truncation for unknown tools
      if (content.length > MAX_DIGEST_CHARS) {
        return content.slice(0, MAX_DIGEST_CHARS) + '\n# [truncated]';
      }
      return content;
  }
}

/** Generate a minimal unified diff for Phase 7 rich display (max 20 lines, truncated). */
export function generateMinimalDiff(before: string, after: string, filePath: string): string {
  const bLines = before.split('\n');
  const aLines = after.split('\n');
  const out: string[] = [];
  out.push(`--- a/${filePath}`);
  out.push(`+++ b/${filePath}`);

  // Simple line-by-line diff (find changed region)
  let diffStart = 0;
  while (
    diffStart < bLines.length &&
    diffStart < aLines.length &&
    bLines[diffStart] === aLines[diffStart]
  )
    diffStart++;
  let bEnd = bLines.length - 1;
  let aEnd = aLines.length - 1;
  while (bEnd > diffStart && aEnd > diffStart && bLines[bEnd] === aLines[aEnd]) {
    bEnd--;
    aEnd--;
  }

  const contextBefore = Math.max(0, diffStart - 2);
  const contextAfter = Math.min(
    Math.max(bLines.length, aLines.length) - 1,
    Math.max(bEnd, aEnd) + 2
  );
  const bEndContext = Math.min(bLines.length - 1, contextAfter);
  const aEndContext = Math.min(aLines.length - 1, contextAfter);

  out.push(
    `@@ -${contextBefore + 1},${bEndContext - contextBefore + 1} +${contextBefore + 1},${aEndContext - contextBefore + 1} @@`
  );

  let lineCount = 0;
  const MAX_LINES = 20;

  // Context before change
  for (let i = contextBefore; i < diffStart && lineCount < MAX_LINES; i++) {
    out.push(` ${bLines[i]}`);
    lineCount++;
  }
  // Removed lines
  for (let i = diffStart; i <= bEnd && i < bLines.length && lineCount < MAX_LINES; i++) {
    out.push(`-${bLines[i]}`);
    lineCount++;
  }
  // Added lines
  for (let i = diffStart; i <= aEnd && i < aLines.length && lineCount < MAX_LINES; i++) {
    out.push(`+${aLines[i]}`);
    lineCount++;
  }
  // Context after change
  const afterStart = Math.max(bEnd, aEnd) + 1;
  for (
    let i = afterStart;
    i <= contextAfter && i < Math.max(bLines.length, aLines.length) && lineCount < MAX_LINES;
    i++
  ) {
    const line = i < aLines.length ? aLines[i] : (bLines[i] ?? '');
    out.push(` ${line}`);
    lineCount++;
  }

  const totalChanges = bEnd - diffStart + 1 + (aEnd - diffStart + 1);
  if (lineCount >= MAX_LINES && totalChanges > MAX_LINES) {
    out.push(`[+${totalChanges - MAX_LINES} more lines]`);
  }

  return out.join('\n');
}

/** Generate a one-line summary of a tool result for hooks/display. */
export function toolResultSummary(
  name: string,
  args: Record<string, unknown>,
  content: string,
  success: boolean
): string {
  if (!success) return content.slice(0, 120);
  switch (name) {
    case 'read_file':
    case 'read_files': {
      const lines = content.split('\n').length;
      return `${lines} lines read`;
    }
    case 'write_file':
      return `wrote ${(args.path as string) || 'file'}`;
    case 'apply_patch': {
      const n = Array.isArray(args.files) ? args.files.length : '?';
      return content.startsWith('ERROR') ? content.slice(0, 120) : `applied patch to ${n} file(s)`;
    }
    case 'edit_range': {
      const p = String(args.path ?? '?');
      return content.startsWith('ERROR') ? content.slice(0, 120) : `edited range in ${p}`;
    }
    case 'edit_file':
      return content.startsWith('ERROR') ? content.slice(0, 120) : `applied edit`;
    case 'insert_file':
      return `inserted at line ${args.line ?? '?'}`;
    case 'exec': {
      try {
        const r = JSON.parse(content);
        const lines = (r.out || '').split('\n').filter(Boolean).length;
        return `rc=${r.rc}, ${lines} lines`;
      } catch {
        return content.slice(0, 80);
      }
    }
    case 'list_dir': {
      const entries = content.split('\n').filter(Boolean).length;
      return `${entries} entries`;
    }
    case 'search_files': {
      const matches = (content.match(/^\d+:/gm) || []).length;
      return `${matches} matches`;
    }
    case 'spawn_task': {
      const line = content.split(/\r?\n/).find((l) => l.includes('status='));
      return line ? line.trim() : 'sub-agent task finished';
    }
    case 'vault_search':
      return `vault results`;
    default:
      return content.slice(0, 80);
  }
}

export function execCommandFromSig(sig: string): string {
  if (!sig.startsWith('exec:')) return '';
  const raw = sig.slice('exec:'.length);
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.command === 'string' ? parsed.command : '';
  } catch {
    return '';
  }
}

export { formatDurationMs } from '../shared/format.js';

export function looksLikePlanningNarration(text: string, finishReason?: string): boolean {
  const s = String(text ?? '')
    .trim()
    .toLowerCase();
  if (!s) return false;

  // Incomplete streamed answer: likely still needs another turn.
  if (finishReason === 'length') return true;

  // Strong completion cues: treat as final answer.
  if (/(^|\n)\s*(done|completed|finished|final answer|summary:)\b/.test(s)) return false;

  // Typical "thinking out loud"/plan chatter that should continue with tools.
  if (/\b(let me|i(?:'|’)ll|i will|i'm going to|i am going to|next i(?:'|’)ll|first i(?:'|’)ll|i need to|i should|checking|reviewing|exploring|starting by)\b/.test(
    s
  )) {
    return true;
  }

  // Handle entire response wrapped in a single markdown block
  let contentToInspect = s;
  if (contentToInspect.startsWith('```') && contentToInspect.endsWith('```')) {
    const codeLines = contentToInspect.split('\n');
    if (codeLines.length >= 3) {
      contentToInspect = codeLines.slice(1, -1).join('\n').trim();
    }
  }

  // Hallucinated naked shell commands (common when models forget the exec tool envelope).
  // E.g. "grep -rn foo" or "npm install" on a single line with no context.
  const lines = contentToInspect.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length > 0 && lines.length <= 5) {
    const firstLine = lines[0].trim();
    const firstWord = firstLine.split(/\s+/)[0];
    const nakedCommands = new Set([
      'grep', 'ls', 'cat', 'npm', 'yarn', 'pnpm', 'git', 'node', 'python',
      'cargo', 'go', 'find', 'awk', 'sed', 'rg', 'cd', 'mkdir', 'touch',
      'rm', 'mv', 'cp', 'curl', 'wget', 'docker', 'pytest', 'tsc', 'npx'
    ]);
    if (nakedCommands.has(firstWord)) {
      // If it has flags or paths, treat as a broken tool call
      if (
        firstLine.includes(' -') ||
        firstLine.includes(' --') ||
        firstLine.includes('/') ||
        firstLine.includes('./') ||
        firstLine === firstWord
      ) {
        return true;
      }
    }

    // Also catch bare hallucinated file paths
    if (firstLine.startsWith('/') || firstLine.startsWith('./') || firstLine.startsWith('src/')) {
      return true;
    }
  }

  return false;
}

export function approxTokenCharCap(maxTokens: number): number {
  const safe = Math.max(64, Math.floor(maxTokens));
  return safe * 4;
}

export function capTextByApproxTokens(
  text: string,
  maxTokens: number
): { text: string; truncated: boolean } {
  const raw = String(text ?? '');
  const maxChars = approxTokenCharCap(maxTokens);
  if (raw.length <= maxChars) return { text: raw, truncated: false };
  const clipped = raw.slice(0, maxChars);
  return {
    text: `${clipped}\n\n[sub-agent] result truncated to ~${maxTokens} tokens (${raw.length} chars original)`,
    truncated: true,
  };
}

export function isLikelyBinaryBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 512);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Strip absolute paths from a message to prevent cross-project leaks in vault.
 * Paths within cwd are replaced with relative equivalents; other absolute paths
 * are replaced with just the basename.
 */
export function sanitizePathsInMessage(message: string, cwd: string): string {
  const normCwd = cwd.replace(/\/+$/, '');
  // Match absolute Unix paths (at least 2 segments)
  return message.replace(/\/(?:home|tmp|var|usr|opt|etc|root)\/[^\s"',;)\]}>]+/g, (match) => {
    const normMatch = match.replace(/\/+$/, '');
    if (normMatch.startsWith(normCwd + '/')) {
      // Within cwd — make relative
      return normMatch.slice(normCwd.length + 1);
    }
    // Outside cwd — strip to basename
    const base = path.basename(normMatch);
    return base || match;
  });
}
