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

  // 2. Current task - task details and location
  sections.push(buildCurrentTaskSection(opts.task, opts.taskFilePath));

  // 3. Progress summary - completion status
  sections.push(buildProgressSummary(opts.taskFile, opts.task));

  // 4. Relevant context from Vault (if available)
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

  // 5. Retry context (if retrying)
  if (opts.retryContext) {
    sections.push(buildRetryContextSection(opts.retryContext));
  }

  // 6. Structured result instructions
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
  if (status !== 'done' && status !== 'blocked' && status !== 'decompose') {
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

function buildPreamble(config: AntonRunConfig): string {
  let preamble = `You are an autonomous coding agent working on ONE task.
Complete the task, then emit exactly one \`<anton-result>\` block.
Do NOT edit the task file checkboxes.
Keep changes minimal and focused.`;

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

function buildProgressSummary(taskFile: AntonTaskFile, currentTask: AntonTask): string {
  const completed = taskFile.completed.length;
  const total = taskFile.totalCount;
  const phase = currentTask.phasePath.length > 0 ? currentTask.phasePath[0] : 'Unknown';

  return `## Progress Summary

${completed}/${total} complete. Phase: ${phase}.`;
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

function buildRetryContextSection(retryContext: string): string {
  return `## Previous Attempt Failed

${retryContext}

Do not repeat the same mistake.`;
}

function buildResultInstructions(decomposeEnabled: boolean): string {
  let instructions = `## Instructions

When finished, emit exactly this block at the end of your response:

\`\`\`
<anton-result>
status: done
</anton-result>
\`\`\`

If blocked:

\`\`\`
<anton-result>
status: blocked
reason: <why>
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
