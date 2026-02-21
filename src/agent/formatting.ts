import path from 'node:path';

/** Generate a minimal unified diff for Phase 7 rich display (max 20 lines, truncated). */
export function generateMinimalDiff(before: string, after: string, filePath: string): string {
  const bLines = before.split('\n');
  const aLines = after.split('\n');
  const out: string[] = [];
  out.push(`--- a/${filePath}`);
  out.push(`+++ b/${filePath}`);

  // Simple line-by-line diff (find changed region)
  let diffStart = 0;
  while (diffStart < bLines.length && diffStart < aLines.length && bLines[diffStart] === aLines[diffStart]) diffStart++;
  let bEnd = bLines.length - 1;
  let aEnd = aLines.length - 1;
  while (bEnd > diffStart && aEnd > diffStart && bLines[bEnd] === aLines[aEnd]) { bEnd--; aEnd--; }

  const contextBefore = Math.max(0, diffStart - 2);
  const contextAfter = Math.min(Math.max(bLines.length, aLines.length) - 1, Math.max(bEnd, aEnd) + 2);
  const bEndContext = Math.min(bLines.length - 1, contextAfter);
  const aEndContext = Math.min(aLines.length - 1, contextAfter);

  out.push(`@@ -${contextBefore + 1},${bEndContext - contextBefore + 1} +${contextBefore + 1},${aEndContext - contextBefore + 1} @@`);

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
  for (let i = afterStart; i <= contextAfter && i < Math.max(bLines.length, aLines.length) && lineCount < MAX_LINES; i++) {
    const line = i < aLines.length ? aLines[i] : bLines[i] ?? '';
    out.push(` ${line}`);
    lineCount++;
  }

  const totalChanges = (bEnd - diffStart + 1) + (aEnd - diffStart + 1);
  if (lineCount >= MAX_LINES && totalChanges > MAX_LINES) {
    out.push(`[+${totalChanges - MAX_LINES} more lines]`);
  }

  return out.join('\n');
}

/** Generate a one-line summary of a tool result for hooks/display. */
export function toolResultSummary(name: string, args: Record<string, unknown>, content: string, success: boolean): string {
  if (!success) return content.slice(0, 120);
  switch (name) {
    case 'read_file':
    case 'read_files': {
      const lines = content.split('\n').length;
      return `${lines} lines read`;
    }
    case 'write_file':
      return `wrote ${(args.path as string) || 'file'}`;
    case 'edit_file':
      return content.startsWith('ERROR') ? content.slice(0, 120) : `applied edit`;
    case 'insert_file':
      return `inserted at line ${args.line ?? '?'}`;
    case 'exec': {
      try {
        const r = JSON.parse(content);
        const lines = (r.out || '').split('\n').filter(Boolean).length;
        return `rc=${r.rc}, ${lines} lines`;
      } catch { return content.slice(0, 80); }
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

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0.0s';
  return `${(ms / 1000).toFixed(1)}s`;
}

export function looksLikePlanningNarration(text: string, finishReason?: string): boolean {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return false;

  // Incomplete streamed answer: likely still needs another turn.
  if (finishReason === 'length') return true;

  // Strong completion cues: treat as final answer.
  if (/(^|\n)\s*(done|completed|finished|final answer|summary:)\b/.test(s)) return false;

  // Typical "thinking out loud"/plan chatter that should continue with tools.
  return /\b(let me|i(?:'|’)ll|i will|i'm going to|i am going to|next i(?:'|’)ll|first i(?:'|’)ll|i need to|i should|checking|reviewing|exploring|starting by)\b/.test(s);
}

export function approxTokenCharCap(maxTokens: number): number {
  const safe = Math.max(64, Math.floor(maxTokens));
  return safe * 4;
}

export function capTextByApproxTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
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
