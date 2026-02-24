/**
 * Anton autonomous task runner — prompt protocol and context injection.
 *
 * Builds prompts with task context, vault search results, and structured result parsing.
 */

import type { LensStore } from '../lens.js';
import { estimateTokens } from '../utils.js';
import type { VaultStore } from '../vault.js';

import type { AntonTask, AntonTaskFile, AntonRunConfig, AntonAgentResult } from './types.js';

export interface AntonPromptOpts {
  task: AntonTask;
  taskFile: AntonTaskFile;
  taskFilePath: string;
  projectDir: string;
  config: AntonRunConfig;
  retryContext: string | undefined;
  taskPlanFile?: string;
  vault: VaultStore | undefined;
  lens: LensStore | undefined;
  maxContextTokens: number;
}

/**
 * Build the complete Anton prompt from task context and configuration.
 */
export async function buildAntonPrompt(opts: AntonPromptOpts): Promise<string> {
  const sections: string[] = [];

  // 1. Preamble - rules and instructions
  sections.push(buildPreamble(opts.config));

  // 1b. Decomposition nudge for complex tasks
  if (opts.config.decompose && classifyTaskComplexity(opts.task.text) === 'complex') {
    sections.push(`## Task Analysis

CRITICAL: You have NO tools in this session. Do NOT emit <tool:...> tags — they will NOT execute.
This task involves changes across multiple files/modules.
Your ONLY job is to emit an <anton-result> block with status: decompose and a list of subtasks.
Each subtask should touch 1-3 files maximum.
Do NOT attempt to read files. Do NOT narrate. Output ONLY the <anton-result> block.`);
  }

  // 2. Current task - task details and location
  sections.push(buildCurrentTaskSection(opts.task, opts.taskFilePath));

  // 3. Progress summary - completion status
  sections.push(buildProgressSummary(opts.taskFile, opts.task));

  // 4. Codebase file listing
  const snapshot = await buildCodebaseSnapshot(opts.projectDir);
  if (snapshot) {
    sections.push(snapshot);
  }

  // 5. Relevant context from Vault (if available)
  if (opts.vault) {
    const vaultSection = await buildVaultContextSection(
      opts.task,
      opts.vault,
      opts.maxContextTokens
    );
    if (vaultSection) {
      sections.push(vaultSection);
    }
  }

  // 6. Vetted plan file context (optional)
  if (opts.taskPlanFile) {
    sections.push(buildTaskPlanFileSection(opts.taskPlanFile));
  }

  // 7. Retry context (if retrying)
  if (opts.retryContext) {
    sections.push(buildRetryContextSection(opts.retryContext));
  }

  // 8. Structured result instructions
  sections.push(buildResultInstructions(opts.config.decompose));

  return sections.join('\n\n');
}

/**
 * Parse the structured result block from agent output.
 */
export function parseAntonResult(agentOutput: string): AntonAgentResult {
  // Find all <anton-result> blocks (use last one if multiple)
  const blockRegex = /<anton-result>([\s\S]*?)<\/anton-result>/g;
  const matches = Array.from(agentOutput.matchAll(blockRegex));

  if (matches.length === 0) {
    return {
      status: 'blocked',
      reason: 'Agent did not emit structured result',
      subtasks: [],
    };
  }

  const lastMatch = matches[matches.length - 1];
  const blockContent = lastMatch[1].trim();

  // Parse status line
  const statusMatch = blockContent.match(/^status:\s*(.+)$/m);
  if (!statusMatch) {
    return {
      status: 'blocked',
      reason: 'No status line found in result block',
      subtasks: [],
    };
  }

  const status = statusMatch[1].trim();
  if (status !== 'done' && status !== 'blocked' && status !== 'decompose' && status !== 'failed') {
    return {
      status: 'blocked',
      reason: `Unknown status: ${status}`,
      subtasks: [],
    };
  }

  // Parse reason line (if present)
  const reasonMatch = blockContent.match(/^reason:\s*(.+)$/m);
  const reason = reasonMatch ? reasonMatch[1].trim() : undefined;

  // Parse subtasks section (if present)
  const subtasks: string[] = [];
  const subtaskMatches = blockContent.matchAll(/^-\s*(.+)$/gm);
  for (const match of subtaskMatches) {
    subtasks.push(match[1].trim());
  }

  return {
    status: status as any,
    reason,
    subtasks,
  };
}

export function classifyTaskComplexity(taskText: string): 'simple' | 'complex' {
  const complexPatterns = [
    /\b(extract|refactor)\b.*\b(across|all|every|each)\b/i,
    /\badd\s+(service\s+)?layer\b/i,
    /\bmigrate\b.*\b(from|to)\b/i,
    /\breplace\b.*\b(throughout|everywhere)\b/i,
    /\bsplit\b.*\binto\b/i,
    /\bconvert\b.*\b(all|every)\b/i,
  ];
  return complexPatterns.some((p) => p.test(taskText)) ? 'complex' : 'simple';
}

function buildPreamble(config: AntonRunConfig): string {
  let preamble = `You are an autonomous coding agent working on exactly ONE task at a time.
Complete ONLY the task described below, then emit exactly one \`<anton-result>\` block at the very end of your response, even if you fail.

RULES:
- Do NOT work on any task other than the one specified below.
- Do NOT modify or check off tasks in the task file.
- Do NOT create files, functions, or code that belong to other tasks.
- Keep changes minimal, focused, and scoped to the current task only.
- If the task references other code that doesn't exist yet, stub or mock it — do NOT build it.`;

  preamble += `

## Context Efficiency

You have a limited context window. Work smart:
1. Use search_files FIRST to locate relevant code — never browse directories reading files one by one.
2. Use read_file with search="keyword" to jump to specific sections instead of reading entire files.
3. Identify ALL files you need before reading any — batch your reads.`;

  if (config.decompose) {
    preamble += `\n4. For tasks touching more than 5 files, emit status: decompose to break into focused subtasks (1-3 files each).`;
  }

  if (config.decompose) {
    preamble += `\n\nIf a task is too large or complex, you can decompose it into smaller subtasks.
Maximum decomposition depth: ${config.maxDecomposeDepth}
Only decompose when truly necessary - prefer completing tasks directly when possible.`;
  }

  return preamble;
}

function buildCurrentTaskSection(task: AntonTask, taskFilePath: string): string {
  let section = `## Current Task

**File:** ${taskFilePath}
**Line:** ${task.line}
**Phase:** ${task.phasePath.join(' → ')}
**Task:** ${task.text}`;

  if (task.children.length > 0) {
    section += '\n\n**Children:**';
    for (const child of task.children) {
      const status = child.checked ? '[x]' : '[ ]';
      section += `\n- ${status} ${child.text}`;
    }
  }

  return section;
}

function buildTaskPlanFileSection(taskPlanFile: string): string {
  return `## Vetted Implementation Plan

Primary plan file: ${taskPlanFile}
Implement according to this vetted plan. If there is any conflict, the current task text is authoritative.`;
}

function buildProgressSummary(taskFile: AntonTaskFile, currentTask: AntonTask): string {
  const completed = taskFile.completed.length;
  const total = taskFile.totalCount;
  const phase = currentTask.phasePath.length > 0 ? currentTask.phasePath[0] : 'Unknown';

  let summary = `## Progress Summary

${completed}/${total} complete. Phase: ${phase}.`;

  // Show upcoming tasks so the agent knows what NOT to do
  const pendingAfterCurrent = taskFile.pending.filter((t) => t.key !== currentTask.key);
  if (pendingAfterCurrent.length > 0) {
    const upcoming = pendingAfterCurrent.slice(0, 5);
    summary += '\n\n**Upcoming tasks (DO NOT work on these):**';
    for (const t of upcoming) {
      summary += `\n- ${t.text}`;
    }
    if (pendingAfterCurrent.length > 5) {
      summary += `\n- ...and ${pendingAfterCurrent.length - 5} more`;
    }
  }

  return summary;
}

async function buildVaultContextSection(
  task: AntonTask,
  vault: VaultStore,
  maxContextTokens: number
): Promise<string | null> {
  // Extract keywords from task text
  const keywords = extractKeywords(task.text);
  if (keywords.length === 0) {
    return null;
  }

  // Search vault for relevant context
  const searchResults = await vault.search(keywords.join(' '), 10);
  if (searchResults.length === 0) {
    return null;
  }

  // Build context section, respecting token budget
  let section = '## Relevant Files\n\n';
  let usedTokens = estimateTokens(section);

  for (const result of searchResults) {
    const content = result.content || result.snippet || '';
    if (!content) continue;

    const itemText = `**${result.key || result.id}**\n${content}\n\n`;
    const itemTokens = estimateTokens(itemText);

    if (usedTokens + itemTokens > maxContextTokens) {
      break;
    }

    section += itemText;
    usedTokens += itemTokens;
  }

  return section.trim() === '## Relevant Files' ? null : section.trim();
}

function extractKeywords(text: string): string[] {
  // Simple keyword extraction: split on whitespace, filter stop words
  const stopWords = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'by',
    'for',
    'from',
    'has',
    'he',
    'in',
    'is',
    'it',
    'its',
    'of',
    'on',
    'that',
    'the',
    'to',
    'was',
    'were',
    'will',
    'with',
    'this',
    'these',
    'they',
    'should',
    'would',
    'could',
    'can',
    'may',
    'might',
    'must',
  ]);

  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .filter((word) => !stopWords.has(word))
    .filter((word) => /^[a-zA-Z]+$/.test(word))
    .slice(0, 10); // Take top 10 keywords
}

async function buildCodebaseSnapshot(projectDir: string): Promise<string> {
  const { execSync } = await import('node:child_process');
  try {
    const tree = execSync(
      `find "${projectDir}" -type f \\( -name '*.ts' -o -name '*.js' -o -name '*.php' -o -name '*.py' -o -name '*.vue' \\) | grep -v node_modules | grep -v vendor | grep -v dist | grep -v .git | sort | head -80`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (!tree) return '';
    return `## Codebase Structure\n\n\`\`\`\n${tree}\n\`\`\``;
  } catch {
    return '';
  }
}

function buildRetryContextSection(retryContext: string): string {
  return `## Previous Attempt Failed — Fix Required

${retryContext}

RETRY RULES (follow exactly):
1. Your previous code changes are STILL IN PLACE. Do NOT start over.
2. The errors above are filtered to show ONLY the issues you need to fix.
3. Open the specific file(s) mentioned, fix the exact error(s), nothing else.
4. Do NOT modify files that are not listed in the errors.
5. After fixing, run the relevant command (lint/build/test) to confirm the fix works.
6. Emit your structured result immediately after confirming.`;
}

function buildResultInstructions(decomposeEnabled: boolean): string {
  let instructions = `## Instructions

When finished, emit exactly this block at the end of your response:

\`\`\`
<anton-result>
status: done
</anton-result>
\`\`\`

If blocked or if you failed:

\`\`\`
<anton-result>
status: failed
reason: <why it failed or why you are blocked>
</anton-result>
\`\`\``;

  if (decomposeEnabled) {
    instructions += `

If task is too large:

\`\`\`
<anton-result>
status: decompose
subtasks:
- <sub-task 1>
- <sub-task 2>
</anton-result>
\`\`\``;
  }

  return instructions;
}
