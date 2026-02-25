/**
 * Anton preflight helpers: discovery/review prompts, JSON parsing, and plan-file guards.
 */

import { createHash } from 'node:crypto';

// Force-decision prompts for when the model doesn't return valid JSON in time
export const FORCE_DISCOVERY_DECISION_PROMPT = `STOP. You must return your discovery result NOW.

Return ONLY this JSON (no markdown, no explanation, no tool calls):
{"status":"complete","filename":""}
OR
{"status":"incomplete","filename":"<absolute-path-to-plan-file-you-created>"}

If you wrote a plan file, use that path. If task is already done, use "complete" with empty filename.
JSON only. Nothing else.`;

export const FORCE_REVIEW_DECISION_PROMPT = `STOP. You must return your review result NOW.

Return ONLY this JSON (no markdown, no explanation, no tool calls):
{"status":"ready","filename":"<absolute-path-to-plan-file>"}

Use the plan file path you were reviewing.
JSON only. Nothing else.`;
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AntonTask } from './types.js';

export type AntonDiscoveryResult = {
  status: 'complete' | 'incomplete';
  filename: string;
};

export type AntonRequirementsReviewResult = {
  status: 'ready';
  filename: string;
};

export async function ensureAgentsTasksDir(projectDir: string): Promise<string> {
  const dir = path.resolve(projectDir, '.agents', 'tasks');
  await mkdir(dir, { recursive: true });
  return dir;
}

export function makeUniqueTaskPlanFilename(projectDir: string): string {
  const now = Date.now();
  const hash = createHash('sha1').update(`${now}-${Math.random()}`).digest('hex').slice(0, 12);
  return path.resolve(projectDir, '.agents', 'tasks', `${now}-${hash}.md`);
}

export function isWithinAgentsTasksDir(candidateAbsPath: string, projectDir: string): boolean {
  const root = path.resolve(projectDir, '.agents', 'tasks') + path.sep;
  const target = path.resolve(candidateAbsPath);
  return target.startsWith(root);
}

function extractJsonObject(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('{') && t.endsWith('}')) return t;

  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) {
    const body = fence[1].trim();
    if (body.startsWith('{') && body.endsWith('}')) return body;
  }

  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) return t.slice(first, last + 1);

  throw new Error('preflight-json-missing-object');
}

export function parseDiscoveryResult(raw: string, projectDir: string): AntonDiscoveryResult {
  const parsed = JSON.parse(extractJsonObject(raw));
  if (parsed?.status !== 'complete' && parsed?.status !== 'incomplete') {
    throw new Error(`preflight-discovery-invalid-status:${String(parsed?.status ?? '')}`);
  }
  if (typeof parsed?.filename !== 'string') {
    throw new Error('preflight-discovery-invalid-filename');
  }

  if (parsed.status === 'complete') {
    return { status: 'complete', filename: '' };
  }

  const abs = path.resolve(parsed.filename);
  if (!path.isAbsolute(abs)) throw new Error('preflight-discovery-filename-not-absolute');
  if (!isWithinAgentsTasksDir(abs, projectDir))
    throw new Error('preflight-discovery-filename-outside-agents-tasks');
  return { status: 'incomplete', filename: abs };
}

export function parseRequirementsReviewResult(
  raw: string,
  projectDir: string
): AntonRequirementsReviewResult {
  const parsed = JSON.parse(extractJsonObject(raw));
  if (parsed?.status !== 'ready') {
    throw new Error(`preflight-review-invalid-status:${String(parsed?.status ?? '')}`);
  }
  if (typeof parsed?.filename !== 'string') {
    throw new Error('preflight-review-invalid-filename');
  }

  const abs = path.resolve(parsed.filename);
  if (!path.isAbsolute(abs)) throw new Error('preflight-review-filename-not-absolute');
  if (!isWithinAgentsTasksDir(abs, projectDir))
    throw new Error('preflight-review-filename-outside-agents-tasks');
  return { status: 'ready', filename: abs };
}

export async function assertPlanFileExists(absPath: string): Promise<void> {
  const s = await stat(absPath);
  if (!s.isFile()) throw new Error(`preflight-plan-not-a-file:${absPath}`);
}

/**
 * Ensure a plan file exists. If the model returned a filename but failed to write it,
 * bootstrap a deterministic fallback file so preflight can continue.
 */
export async function ensurePlanFileExistsOrBootstrap(opts: {
  absPath: string;
  task: AntonTask;
  source: 'discovery' | 'requirements-review';
}): Promise<'existing' | 'bootstrapped'> {
  try {
    await assertPlanFileExists(opts.absPath);
    return 'existing';
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/ENOENT/.test(msg)) {
      throw error;
    }

    await mkdir(path.dirname(opts.absPath), { recursive: true });
    const body = [
      '# Anton preflight plan (auto-generated fallback)',
      '',
      `> Generated because ${opts.source} returned a plan filename but did not write a valid file.`,
      '',
      '## Task (verbatim)',
      opts.task.text,
      '',
      '## Missing',
      '- Discovery/review did not persist structured details to disk.',
      '',
      '## Recommendation',
      '- Re-run requirements review to refine this plan before implementation.',
      '- Keep implementation scoped to this task only.',
      '',
      '## Likely files',
      '- TBD',
      '',
    ].join('\n');

    await writeFile(opts.absPath, body, 'utf8');
    return 'bootstrapped';
  }
}

export function buildDiscoveryPrompt(opts: {
  task: AntonTask;
  taskFilePath: string;
  projectDir: string;
  planFilePath: string;
  retryHint?: string;
}): string {
  return `You are running PRE-FLIGHT DISCOVERY for an autonomous coding orchestrator.

CRITICAL: DO NOT COMPLETE THE TASK. DO NOT IMPLEMENT ANY CODE CHANGES.
Your only goals are:
1) Verify whether the task is already fully complete in the current codebase.
2) If incomplete, determine what likely needs to change and which files are likely involved.

Task metadata:
- Task file: ${opts.taskFilePath}
- Task line: ${opts.task.line}
- Phase: ${opts.task.phasePath.join(' > ') || 'N/A'}
- Project dir: ${opts.projectDir}

FULL TASK (VERBATIM):
${opts.task.text}

If task is already complete:
- Return EXACT JSON only:
{"status":"complete","filename":""}

If task is incomplete:
- Create/update this markdown file path exactly: ${opts.planFilePath}
- You MUST NOT modify any files outside: ${path.resolve(opts.projectDir, '.agents', 'tasks')}
- DO NOT call edit_range/apply_patch on source files in discovery.
- The markdown MUST include:
  - The FULL TASK (VERBATIM)
  - What is missing
  - Concrete implementation recommendation
  - Likely files to modify/create (or explicitly state none)
- Then return EXACT JSON only:
{"status":"incomplete","filename":"${opts.planFilePath}"}

${
  opts.retryHint
    ? `RETRY CONTEXT: ${opts.retryHint}
If prior attempts failed, keep output minimal, write/update only the plan file above, and return valid JSON.`
    : ''
}

Return JSON only. No markdown fences. No commentary.`;
}

export function buildRequirementsReviewPrompt(planFilePath: string): string {
  return `Please review this plan file and perform a strict peer review:
${planFilePath}

Treat it as written by an entry-level developer who may miss edge cases and fail to reuse existing code.
Be thorough and precise. Update the SAME file in-place to improve correctness, reuse, and clarity.
Remove ambiguity and tighten implementation steps.

After review, return EXACT JSON only:
{"status":"ready","filename":"${planFilePath}"}

Return JSON only. No markdown fences. No commentary.`;
}
