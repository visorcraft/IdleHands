import fs from 'node:fs/promises';
import path from 'node:path';

import { clamp } from './shared/math.js';
import type { IdlehandsConfig } from './types.js';
import { estimateTokens } from './utils.js';

async function readIfExists(p: string): Promise<string | null> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return null;
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

function resolveHintPath(abs: string, cwd: string): string {
  const rel = path.relative(cwd, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  return rel;
}

function summarizeProjectContext(text: string, maxTokens = 1024): string {
  const maxChars = Math.max(800, Math.floor(maxTokens * 4));
  const lines = String(text ?? '')
    .replace(/\r/g, '')
    .split('\n');
  const picked: string[] = [];
  const seen = new Set<string>();

  const push = (line: string) => {
    const v = line.trimEnd();
    if (!v.trim()) return;
    if (seen.has(v)) return;
    seen.add(v);
    picked.push(v);
  };

  // Pass 1: headings + immediate key bullets (high signal in AGENTS/README style context files)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (/^\s{0,3}#{1,4}\s+/.test(l)) {
      push(l);
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const nxt = lines[j] ?? '';
        if (/^\s{0,3}#{1,4}\s+/.test(nxt)) break;
        if (
          /^\s*[-*]\s+/.test(nxt) ||
          /\b(TODO|FIXME|NOTE|IMPORTANT|MUST|NEVER|ALWAYS|RULE)\b/i.test(nxt)
        ) {
          push(nxt);
        }
      }
    }
  }

  // Pass 2: global key lines
  for (const l of lines) {
    if (/\b(TODO|FIXME|NOTE|IMPORTANT|MUST|NEVER|ALWAYS|RULE|PRIORITY|WARNING)\b/i.test(l)) {
      push(l);
    }
  }

  // Pass 3: fill with early lines if still sparse
  if (picked.length < 20) {
    for (const l of lines) {
      if (!l.trim()) continue;
      push(l);
      const cur = picked.join('\n');
      if (cur.length >= maxChars) break;
      if (picked.length >= 120) break;
    }
  }

  let out = picked.join('\n');
  if (!out.trim())
    out = lines
      .filter((l) => l.trim())
      .slice(0, 120)
      .join('\n');
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + `\n[summary truncated, source larger than ~${maxTokens} tokens]`;
  }
  return out.trim();
}

export async function loadProjectContext(cfg: IdlehandsConfig): Promise<string> {
  if (cfg.no_context) return '';

  const maxTokens = cfg.context_max_tokens ?? 8192;
  const summarizeByDefault = (cfg as any).context_summarize !== false;
  const summaryTokens = clamp(Number((cfg as any).context_summary_max_tokens ?? 1024), 256, 4096);
  const cwd = cfg.dir ? path.resolve(cfg.dir) : process.cwd();

  // Build candidate list: explicit override first, then search-order names
  const candidates: string[] = [];
  if (cfg.context_file && cfg.context_file.trim()) {
    candidates.push(cfg.context_file.trim());
  }
  const names = cfg.context_file_names?.length ? cfg.context_file_names : [];
  for (const n of names) candidates.push(n);

  // First match wins
  for (const f of candidates) {
    const abs = path.isAbsolute(f) ? f : path.join(cwd, f);
    const txt = await readIfExists(abs);
    if (!txt) continue;

    const body = txt.trim();
    const fullChunk = `[Project context from ${abs}]\n${body}\n[End project context]`;
    const fullTokens = estimateTokens(fullChunk);

    // Keep full context when reasonably small.
    if (fullTokens <= Math.min(maxTokens, summaryTokens)) {
      if (fullTokens > 2048) {
        const warn = `[note: project context is ~${fullTokens} tokens — consider trimming ${path.basename(abs)}]`;
        return `${warn}\n${fullChunk}`;
      }
      return fullChunk;
    }

    if (!summarizeByDefault && fullTokens > maxTokens) {
      throw new Error(
        `Project context file is ~${fullTokens} tokens (${abs}). Max is ${maxTokens}. ` +
          `Trim it or use --no-context to skip.`
      );
    }

    // Priority 5: summarize by default to keep prompt overhead low.
    const summaryBudget = Math.min(maxTokens, summaryTokens);
    let summaryBody = summarizeProjectContext(body, summaryBudget);
    const hintPath = resolveHintPath(abs, cwd);

    let summaryChunk = [
      `[Project context summary from ${abs}]`,
      summaryBody,
      `[End project context summary]`,
      `[full context omitted: ~${fullTokens} tokens. Use read_file(path="${hintPath}", limit=..., search=...) to retrieve exact sections.]`,
    ].join('\n');

    // Ensure summary chunk respects configured max context budget.
    while (estimateTokens(summaryChunk) > maxTokens && summaryBody.length > 400) {
      summaryBody = summaryBody.slice(0, Math.floor(summaryBody.length * 0.85)).trimEnd();
      summaryChunk = [
        `[Project context summary from ${abs}]`,
        summaryBody,
        `[End project context summary]`,
        `[full context omitted: ~${fullTokens} tokens. Use read_file(path="${hintPath}", limit=..., search=...) to retrieve exact sections.]`,
      ].join('\n');
    }

    return summaryChunk;
  }

  return '';
}
