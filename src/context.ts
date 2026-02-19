import fs from 'node:fs/promises';
import path from 'node:path';
import { IdlehandsConfig } from './types.js';
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

export async function loadProjectContext(cfg: IdlehandsConfig): Promise<string> {
  if (cfg.no_context) return '';

  const maxTokens = cfg.context_max_tokens ?? 8192;
  const cwd = cfg.dir ? path.resolve(cfg.dir) : process.cwd();

  // Build candidate list: explicit override first, then search-order names
  const candidates: string[] = [];
  if (cfg.context_file && cfg.context_file.trim()) {
    candidates.push(cfg.context_file.trim());
  }
  const names = cfg.context_file_names?.length ? cfg.context_file_names : [];
  for (const n of names) candidates.push(n);

  // First match wins (plan §9b)
  for (const f of candidates) {
    const abs = path.isAbsolute(f) ? f : path.join(cwd, f);
    const txt = await readIfExists(abs);
    if (!txt) continue;

    const chunk = `[Project context from ${abs}]\n${txt.trim()}\n[End project context]`;
    const t = estimateTokens(chunk);

    if (t > maxTokens) {
      throw new Error(
        `Project context file is ~${t} tokens (${abs}). Max is ${maxTokens}. ` +
        `Trim it or use --no-context to skip.`
      );
    }

    if (t > 2048) {
      // Warn but still include (plan §9b: 2049–8192 range)
      const warn = `[note: project context is ~${t} tokens — consider trimming ${path.basename(abs)}]`;
      return `${warn}\n${chunk}`;
    }

    return chunk;
  }

  return '';
}
