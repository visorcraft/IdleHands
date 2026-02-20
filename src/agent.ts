import type { IdlehandsConfig, ChatMessage, UserContent, ToolSchema, ToolCall, TrifectaMode, ToolCallEvent, ToolResultEvent, TurnEndEvent, ConfirmationProvider, PlanStep, ApprovalMode } from './types.js';
import { OpenAIClient } from './client.js';
import { enforceContextBudget, stripThinking, estimateTokensFromMessages, estimateToolSchemaTokens } from './history.js';
import * as tools from './tools.js';
import { selectHarness, type Harness } from './harnesses.js';
import { checkExecSafety, checkPathSafety } from './safety.js';
import { loadProjectContext } from './context.js';
import { loadGitContext, isGitDirty, stashWorkingTree } from './git.js';
import { projectIndexKeys, parseIndexMeta, isFreshIndex, indexSummaryLine } from './indexer.js';
import { ReplayStore } from './replay.js';
import { VaultStore } from './vault.js';
import { LensStore } from './lens.js';
import { SYS_CONTEXT_SCHEMA, collectSnapshot } from './sys/context.js';
import { MCPManager, type McpServerStatus, type McpToolStatus } from './mcp.js';
import { LspManager, detectInstalledLspServers } from './lsp.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './utils.js';

function makeAbortController() {
  // Node 24: AbortController is global.
  return new AbortController();
}

/** Generate a minimal unified diff for Phase 7 rich display (max 20 lines, truncated). */
function generateMinimalDiff(before: string, after: string, filePath: string): string {
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
function toolResultSummary(name: string, args: Record<string, unknown>, content: string, success: boolean): string {
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

/** Errors that should break the outer agent loop, not be caught by per-tool handlers */
class AgentLoopBreak extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentLoopBreak';
  }
}

export type AgentResult = {
  text: string;
  turns: number;
  toolCalls: number;
};

const SYSTEM_PROMPT = `You are a coding agent with filesystem and shell access. Execute the user's request using the provided tools.

Rules:
- Work in the current directory. Use relative paths for all file operations.
- Do the work directly. Do NOT use spawn_task to delegate the user's primary request — only use it for genuinely independent subtasks that benefit from parallel execution.
- Never use spawn_task to bypass confirmation/safety restrictions (for example blocked package installs). If a command is blocked, adapt the plan or ask the user for approval mode changes.
- Read the target file before editing. You need the exact text for search/replace.
- Use read_file with search=... to jump to relevant code; avoid reading whole files.
- Use edit_file for surgical changes. Never rewrite entire files when a targeted edit works.
- Use insert_file for insertions (prepend/append/line).
- Use exec to run commands, tests, builds; check results before reporting success.
- When running commands in a subdirectory, use exec's cwd parameter — NOT "cd /path && cmd". Each exec call is a fresh shell; cd does not persist.
- Batch work: read all files you need, then apply all edits, then verify.
- Be concise. Report what you changed and why.
- Do NOT read every file in a directory. Use search_files or exec with grep to locate relevant code first, then read only the files that match.
- If search_files returns 0 matches, try a broader pattern or use: exec grep -rn "keyword" path/
- Anton (the autonomous task runner) is ONLY activated when the user explicitly invokes /anton. Never self-activate as Anton or start processing task files on your own.

Tool call format:
- Use tool_calls. Do not write JSON tool invocations in your message text.
`;

const MCP_TOOLS_REQUEST_TOKEN = '[[MCP_TOOLS_REQUEST]]';

const DEFAULT_SUB_AGENT_SYSTEM_PROMPT = `You are a focused coding sub-agent. Execute only the delegated task.
- Work in the current directory. Use relative paths for all file operations.
- Read the target file before editing. You need the exact text for search/replace.
- Keep tool usage tight and efficient.
- Prefer surgical edits over rewrites.
- Do NOT create files outside the working directory unless explicitly requested.
- When running commands in a subdirectory, use exec's cwd parameter — NOT "cd /path && cmd".
- Run verification commands when relevant.
- Return a concise outcome summary.`;

const DEFAULT_SUB_AGENT_RESULT_TOKEN_CAP = 4000;
const APPROVAL_MODE_SET = new Set<ApprovalMode>(['plan', 'reject', 'default', 'auto-edit', 'yolo']);
const LSP_TOOL_NAMES = ['lsp_diagnostics', 'lsp_symbols', 'lsp_hover', 'lsp_definition', 'lsp_references'] as const;
const LSP_TOOL_NAME_SET = new Set<string>(LSP_TOOL_NAMES);
const FILE_MUTATION_TOOL_SET = new Set(['edit_file', 'write_file', 'insert_file']);

function normalizeApprovalMode(value: unknown): ApprovalMode | undefined {
  if (typeof value !== 'string') return undefined;
  const mode = value.trim() as ApprovalMode;
  return APPROVAL_MODE_SET.has(mode) ? mode : undefined;
}

/** Approval mode permissiveness ranking (lower = more restrictive). */
const APPROVAL_MODE_RANK: Record<ApprovalMode, number> = { plan: 0, reject: 1, default: 2, 'auto-edit': 3, yolo: 4 };

/**
 * Cap a sub-agent's approval mode at the parent's level.
 * Sub-agents cannot escalate beyond the parent's approval mode.
 */
function capApprovalMode(requested: ApprovalMode, parentMode: ApprovalMode): ApprovalMode {
  return APPROVAL_MODE_RANK[requested] <= APPROVAL_MODE_RANK[parentMode] ? requested : parentMode;
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0.0s';
  return `${(ms / 1000).toFixed(1)}s`;
}

function looksLikePlanningNarration(text: string, finishReason?: string): boolean {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return false;

  // Incomplete streamed answer: likely still needs another turn.
  if (finishReason === 'length') return true;

  // Strong completion cues: treat as final answer.
  if (/(^|\n)\s*(done|completed|finished|final answer|summary:)\b/.test(s)) return false;

  // Typical "thinking out loud"/plan chatter that should continue with tools.
  return /\b(let me|i(?:'|’)ll|i will|i'm going to|i am going to|next i(?:'|’)ll|first i(?:'|’)ll|i need to|i should|checking|reviewing|exploring|starting by)\b/.test(s);
}

function approxTokenCharCap(maxTokens: number): number {
  const safe = Math.max(64, Math.floor(maxTokens));
  return safe * 4;
}

function capTextByApproxTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const raw = String(text ?? '');
  const maxChars = approxTokenCharCap(maxTokens);
  if (raw.length <= maxChars) return { text: raw, truncated: false };
  const clipped = raw.slice(0, maxChars);
  return {
    text: `${clipped}\n\n[sub-agent] result truncated to ~${maxTokens} tokens (${raw.length} chars original)`,
    truncated: true,
  };
}

function isLikelyBinaryBuffer(buf: Buffer): boolean {
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
function sanitizePathsInMessage(message: string, cwd: string): string {
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

async function buildSubAgentContextBlock(cwd: string, rawFiles: unknown): Promise<{ block: string; included: string[]; skipped: string[] }> {
  const values = Array.isArray(rawFiles) ? rawFiles : [];
  const files = values
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .slice(0, 12);

  if (!files.length) return { block: '', included: [], skipped: [] };

  const MAX_TOTAL_CHARS = 24_000;
  const MAX_PER_FILE_CHARS = 4_000;

  let total = 0;
  const parts: string[] = [];
  const included: string[] = [];
  const skipped: string[] = [];

  for (const rel of files) {
    const abs = path.resolve(cwd, rel);
    const relFromCwd = path.relative(cwd, abs);
    if (relFromCwd.startsWith('..') || path.isAbsolute(relFromCwd)) {
      skipped.push(`${rel} (outside cwd)`);
      continue;
    }

    let stat: any;
    try {
      stat = await fs.stat(abs);
    } catch {
      skipped.push(`${rel} (missing)`);
      continue;
    }

    if (!stat?.isFile()) {
      skipped.push(`${rel} (not a file)`);
      continue;
    }

    const buf = await fs.readFile(abs).catch(() => null);
    if (!buf) {
      skipped.push(`${rel} (unreadable)`);
      continue;
    }

    if (isLikelyBinaryBuffer(buf)) {
      skipped.push(`${rel} (binary)`);
      continue;
    }

    const raw = buf.toString('utf8');
    const body = raw.length > MAX_PER_FILE_CHARS
      ? `${raw.slice(0, MAX_PER_FILE_CHARS)}\n[truncated: ${raw.length} chars total]`
      : raw;

    const section = `[file:${rel}]\n${body}\n[/file:${rel}]`;
    if (total + section.length > MAX_TOTAL_CHARS) {
      skipped.push(`${rel} (context budget reached)`);
      continue;
    }

    parts.push(section);
    included.push(rel);
    total += section.length;
  }

  return { block: parts.join('\n\n'), included, skipped };
}

function extractLensBody(projection: string): string {
  const lines = String(projection ?? '').split(/\r?\n/);
  if (!lines.length) return '';

  let start = 0;
  if (lines[0].startsWith('# ')) start = 1;
  if (lines[start]?.startsWith('# lens:')) start += 1;

  return lines
    .slice(start)
    .filter((line) => line.trim().length > 0)
    .slice(0, 40)
    .join('\n');
}

function buildToolsSchema(opts?: {
  activeVaultTools?: boolean;
  sysMode?: boolean;
  mcpTools?: ToolSchema[];
  lspTools?: boolean;
  allowSpawnTask?: boolean;
}): ToolSchema[] {
  const obj = (properties: Record<string, any>, required: string[] = []) => ({
    type: 'object',
    additionalProperties: false,
    properties,
    required
  });

  const schemas: ToolSchema[] = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read file contents with line numbers. Use search/context to jump to relevant code.',
        parameters: obj(
          {
            path: { type: 'string' },
            offset: { type: 'integer' },
            limit: { type: 'integer' },
            search: { type: 'string' },
            context: { type: 'integer' },
          },
          ['path']
        )
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_files',
        description: 'Batch read multiple files.',
        parameters: obj(
          {
            requests: {
              type: 'array',
              items: obj(
                {
                  path: { type: 'string' },
                  offset: { type: 'integer' },
                  limit: { type: 'integer' },
                  search: { type: 'string' },
                  context: { type: 'integer' },
                },
                ['path']
              )
            }
          },
          ['requests']
        )
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write a file (atomic). Creates parents. Makes a backup first.',
        parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content'])
      }
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Search/replace exact text in a file. Fails if old_text not found.',
        parameters: obj(
          {
            path: { type: 'string' },
            old_text: { type: 'string' },
            new_text: { type: 'string' },
            replace_all: { type: 'boolean' }
          },
          ['path', 'old_text', 'new_text']
        )
      }
    },
    {
      type: 'function',
      function: {
        name: 'insert_file',
        description: 'Insert text at a specific line (0=prepend, -1=append).',
        parameters: obj(
          {
            path: { type: 'string' },
            line: { type: 'integer' },
            text: { type: 'string' }
          },
          ['path', 'line', 'text']
        )
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List directory contents (optional recursive, max depth 3).',
        parameters: obj(
          {
            path: { type: 'string' },
            recursive: { type: 'boolean' },

          },
          ['path']
        )
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Search for a regex pattern in files under a directory.',
        parameters: obj(
          {
            pattern: { type: 'string' },
            path: { type: 'string' },
            include: { type: 'string' },

          },
          ['pattern', 'path']
        )
      }
    },
    {
      type: 'function',
      function: {
        name: 'exec',
        description: 'Run a shell command (bash -c) with timeout; returns JSON rc/out/err. Each call is a new shell — cwd does not persist between calls.',
        parameters: obj(
          {
            command: { type: 'string', description: 'Shell command to run' },
            cwd: { type: 'string', description: 'Working directory (default: project root). Use this instead of cd.' },
            timeout: { type: 'integer', description: 'Timeout in seconds (default: 30, max: 120). Use 60-120 for npm install, builds, or test suites.' }
          },
          ['command']
        )
      }
    }
  ];

  if (opts?.allowSpawnTask !== false) {
    schemas.push({
      type: 'function',
      function: {
        name: 'spawn_task',
        description: 'Delegate a focused task to an isolated sub-agent session (no parent chat history).',
        parameters: obj(
          {
            task: { type: 'string', description: 'Instruction for the sub-agent' },
            context_files: {
              type: 'array',
              description: 'Optional extra files to inject into sub-agent context',
              items: { type: 'string' },
            },
            model: { type: 'string', description: 'Optional model override for this task' },
            endpoint: { type: 'string', description: 'Optional endpoint override for this task' },
            max_iterations: { type: 'integer', description: 'Optional max turn cap for the sub-agent' },
            max_tokens: { type: 'integer', description: 'Optional max completion tokens for the sub-agent' },
            timeout_sec: { type: 'integer', description: 'Optional timeout for this sub-agent run (seconds)' },
            system_prompt: { type: 'string', description: 'Optional sub-agent system prompt override for this task' },
            approval_mode: { type: 'string', enum: ['plan', 'reject', 'default', 'auto-edit', 'yolo'] },
          },
          ['task']
        )
      }
    });
  }

  if (opts?.activeVaultTools) {
    schemas.push(
      {
        type: 'function',
        function: {
          name: 'vault_search',
          description: 'Search vault entries (notes and previous tool outputs) to reuse prior high-signal findings.',
          parameters: obj(
            {
              query: { type: 'string' },
              limit: { type: 'integer' }
            },
            ['query']
          )
        }
      },
      {
        type: 'function',
        function: {
          name: 'vault_note',
          description: 'Persist a concise, high-signal note into the Trifecta vault.',
          parameters: obj(
            {
              key: { type: 'string' },
              value: { type: 'string' }
            },
            ['key', 'value']
          )
        }
      }
    );
  }

  // Phase 9: sys_context tool is only available in sys mode.
  if (opts?.sysMode) {
    schemas.push(SYS_CONTEXT_SCHEMA as any);
  }

  if (opts?.lspTools) {
    schemas.push(
      {
        type: 'function',
        function: {
          name: 'lsp_diagnostics',
          description: 'Get current LSP diagnostics (errors/warnings) for a file or the whole project. Structured — replaces running build commands to check for errors.',
          parameters: obj(
            {
              path: { type: 'string', description: 'File path (omit for project-wide diagnostics)' },
              severity: { type: 'integer', description: '1=Error, 2=Warning, 3=Info, 4=Hint (default: config threshold)' },
            },
            []
          )
        }
      },
      {
        type: 'function',
        function: {
          name: 'lsp_symbols',
          description: 'List all symbols (functions, classes, variables) in a file via LSP.',
          parameters: obj(
            {
              path: { type: 'string' },
            },
            ['path']
          )
        }
      },
      {
        type: 'function',
        function: {
          name: 'lsp_hover',
          description: 'Get type info and documentation for a symbol at a position.',
          parameters: obj(
            {
              path: { type: 'string' },
              line: { type: 'integer' },
              character: { type: 'integer' },
            },
            ['path', 'line', 'character']
          )
        }
      },
      {
        type: 'function',
        function: {
          name: 'lsp_definition',
          description: 'Go to definition of a symbol at a given position.',
          parameters: obj(
            {
              path: { type: 'string' },
              line: { type: 'integer' },
              character: { type: 'integer' },
            },
            ['path', 'line', 'character']
          )
        }
      },
      {
        type: 'function',
        function: {
          name: 'lsp_references',
          description: 'Find all references to a symbol at a given position.',
          parameters: obj(
            {
              path: { type: 'string' },
              line: { type: 'integer' },
              character: { type: 'integer' },
              max_results: { type: 'integer', description: 'Cap results (default 50)' },
            },
            ['path', 'line', 'character']
          )
        }
      },
    );
  }

  if (opts?.mcpTools?.length) {
    schemas.push(...opts.mcpTools);
  }

  return schemas;
}

/** @internal Exported for testing. Parses tool calls from model content when tool_calls array is empty. */
export function parseToolCallsFromContent(content: string): ToolCall[] | null {
  // Fallback parser: if model printed JSON tool_calls in content.
  const trimmed = content.trim();

  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  // Case 1: whole content is JSON
  const whole = tryParse(trimmed);
  if (whole?.tool_calls && Array.isArray(whole.tool_calls)) return whole.tool_calls;
  if (whole?.name && whole?.arguments) {
    return [
      {
        id: 'call_0',
        type: 'function',
        function: { name: String(whole.name), arguments: JSON.stringify(whole.arguments) }
      }
    ];
  }

  // Case 2: raw JSON array of tool calls (model writes [{name, arguments}, ...])
  const arrStart = trimmed.indexOf('[');
  const arrEnd = trimmed.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    const arrSub = tryParse(trimmed.slice(arrStart, arrEnd + 1));
    if (Array.isArray(arrSub) && arrSub.length > 0 && arrSub[0]?.name) {
      return arrSub.map((item: any, i: number) => ({
        id: `call_${i}`,
        type: 'function' as const,
        function: {
          name: String(item.name),
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
        }
      }));
    }
  }

  // Case 3: find a JSON object substring (handles tool_calls wrapper OR single tool-call)
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const sub = tryParse(trimmed.slice(start, end + 1));
    if (sub?.tool_calls && Array.isArray(sub.tool_calls)) return sub.tool_calls;
    if (sub?.name && sub?.arguments) {
      return [
        {
          id: 'call_0',
          type: 'function',
          function: { name: String(sub.name), arguments: typeof sub.arguments === 'string' ? sub.arguments : JSON.stringify(sub.arguments) }
        }
      ];
    }
  }

  // Case 4: XML tool calls — used by Qwen, Hermes, and other models whose chat
  // templates emit <tool_call><function=name><parameter=key>value</parameter></function></tool_call>.
  // When llama-server's XML→JSON conversion fails (common with large write_file content),
  // the raw XML leaks into the content field. This recovers it.
  const xmlCalls = parseXmlToolCalls(trimmed);
  if (xmlCalls?.length) return xmlCalls;


  // Case 5: Lightweight function-tag calls (seen in some Qwen content-mode outputs):
  // <function=tool_name>
  // {...json args...}
  // </function>
  // or single-line <function=tool_name>{...}</function>
  const fnTagCalls = parseFunctionTagToolCalls(trimmed);
  if (fnTagCalls?.length) return fnTagCalls;

  return null;
}

/**
 * Parse XML-style tool calls from content.
 * Format: <tool_call><function=name><parameter=key>value</parameter>...</function></tool_call>
 * Handles multiple tool call blocks and arbitrary parameter names/values.
 */
function parseXmlToolCalls(content: string): ToolCall[] | null {
  // Quick bailout: no point parsing if there's no <tool_call> marker
  if (!content.includes('<tool_call>')) return null;

  const calls: ToolCall[] = [];

  // Match each <tool_call>...</tool_call> block.
  // Using a manual scan instead of a single greedy regex to handle nested angle brackets
  // in parameter values (e.g. TypeScript generics, JSX, comparison operators).
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const blockStart = content.indexOf('<tool_call>', searchFrom);
    if (blockStart === -1) break;

    const blockEnd = content.indexOf('</tool_call>', blockStart);
    if (blockEnd === -1) break; // Truncated — can't recover partial tool calls

    const block = content.slice(blockStart + '<tool_call>'.length, blockEnd);
    searchFrom = blockEnd + '</tool_call>'.length;

    // Extract function name: <function=name>...</function>
    const fnMatch = block.match(/<function=(\w[\w.-]*)>/);
    if (!fnMatch) continue;

    const fnName = fnMatch[1];
    const fnStart = block.indexOf(fnMatch[0]) + fnMatch[0].length;
    const fnEnd = block.lastIndexOf('</function>');
    const fnBody = fnEnd !== -1 ? block.slice(fnStart, fnEnd) : block.slice(fnStart);

    // Extract parameters: <parameter=key>value</parameter>
    // Uses bracket-matching (depth counting) so that parameter values containing
    // literal <parameter=...>...</parameter> (e.g. writing XML files) are handled
    // correctly instead of being truncated at the inner close tag.
    const args: Record<string, string> = {};
    const openRe = /<parameter=(\w[\w.-]*)>/g;
    const closeTag = '</parameter>';

    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = openRe.exec(fnBody)) !== null) {
      const paramName = paramMatch[1];
      const valueStart = paramMatch.index + paramMatch[0].length;

      // Bracket-match: find the </parameter> that balances this open tag.
      // Depth starts at 1; nested <parameter=...> increments, </parameter> decrements.
      let depth = 1;
      let scanPos = valueStart;
      let closeIdx = -1;

      while (scanPos < fnBody.length && depth > 0) {
        const nextOpen = fnBody.indexOf('<parameter=', scanPos);
        const nextClose = fnBody.indexOf(closeTag, scanPos);

        if (nextClose === -1) break; // No more close tags — truncated

        if (nextOpen !== -1 && nextOpen < nextClose) {
          // An open tag comes before the next close — increase depth
          depth++;
          scanPos = nextOpen + 1; // advance past '<' to avoid re-matching
        } else {
          // Close tag comes first — decrease depth
          depth--;
          if (depth === 0) {
            closeIdx = nextClose;
          }
          scanPos = nextClose + closeTag.length;
        }
      }

      if (closeIdx === -1) {
        // No matching close tag — take rest of body as value (truncated output)
        args[paramName] = fnBody.slice(valueStart).trim();
        break;
      }

      // Trim exactly the template-added leading/trailing newline, preserve internal whitespace
      let value = fnBody.slice(valueStart, closeIdx);
      if (value.startsWith('\n')) value = value.slice(1);
      if (value.endsWith('\n')) value = value.slice(0, -1);
      args[paramName] = value;

      // Advance the regex past the close tag so the next openRe.exec starts after it
      openRe.lastIndex = closeIdx + closeTag.length;
    }

    if (fnName && Object.keys(args).length > 0) {
      calls.push({
        id: `call_xml_${calls.length}`,
        type: 'function',
        function: {
          name: fnName,
          arguments: JSON.stringify(args)
        }
      });
    }
  }

  return calls.length > 0 ? calls : null;
}

/** Check for missing required params by tool name — universal pre-dispatch validation */
function getMissingRequiredParams(toolName: string, args: Record<string, unknown>): string[] {
  const required: Record<string, string[]> = {
    read_file: ['path'],
    read_files: ['requests'],
    write_file: ['path', 'content'],
    edit_file: ['path', 'old_text', 'new_text'],
    insert_file: ['path', 'line', 'text'],
    list_dir: ['path'],
    search_files: ['pattern', 'path'],
    exec: ['command'],
    spawn_task: ['task'],
    sys_context: [],
    vault_search: ['query'],
    vault_note: ['key', 'value']
  };
  const req = required[toolName];
  if (!req) return [];
  return req.filter(p => args[p] === undefined || args[p] === null);
}

/** Strip markdown code fences (```json ... ```) from tool argument strings */
function stripMarkdownFences(s: string): string {
  const trimmed = s.trim();
  // Match ```json\n...\n``` or ```\n...\n```
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(trimmed);
  return m ? m[1] : s;
}

function isReadOnlyTool(name: string) {
  return name === 'read_file' || name === 'read_files' || name === 'list_dir' || name === 'search_files' || name === 'vault_search' || name === 'sys_context';
}

/** Human-readable summary of what a blocked tool call would do. */
function planModeSummary(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'write_file':
      return `write ${args.path ?? 'unknown'} (${typeof args.content === 'string' ? args.content.split('\n').length : '?'} lines)`;
    case 'edit_file':
      return `edit ${args.path ?? 'unknown'} (replace ${typeof args.old_text === 'string' ? args.old_text.split('\n').length : '?'} lines)`;
    case 'insert_file':
      return `insert into ${args.path ?? 'unknown'} at line ${args.line ?? '?'}`;
    case 'exec':
      return `run: ${typeof args.command === 'string' ? args.command.slice(0, 80) : 'unknown'}`;
    case 'spawn_task':
      return `spawn sub-agent task: ${typeof args.task === 'string' ? args.task.slice(0, 80) : 'unknown'}`;
    case 'vault_note':
      return `vault note: ${args.key ?? 'unknown'}`;
    default:
      return `${name}(${Object.keys(args).join(', ')})`;
  }
}

function userContentToText(content: UserContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p: any) => p.text)
    .join('\n')
    .trim();
}

function userDisallowsDelegation(content: UserContent): boolean {
  const text = userContentToText(content).toLowerCase();
  if (!text) return false;

  const mentionsDelegation = /\b(?:spawn[_\-\s]?task|sub[\-\s]?agents?|delegate|delegation)\b/.test(text);
  if (!mentionsDelegation) return false;

  const negationNearDelegation =
    /\b(?:do not|don't|dont|no|without|avoid|skip|never)\b[^\n.]{0,90}\b(?:spawn[_\-\s]?task|sub[\-\s]?agents?|delegate|delegation)\b/.test(text) ||
    /\b(?:spawn[_\-\s]?task|sub[\-\s]?agents?|delegate|delegation)\b[^\n.]{0,50}\b(?:do not|don't|dont|not allowed|forbidden|no)\b/.test(text);

  return negationNearDelegation;
}

function supportsVisionModel(model: string, modelMeta: any, harness: Harness): boolean {
  if (typeof harness.supportsVision === 'boolean') return harness.supportsVision;
  if (typeof modelMeta?.vision === 'boolean') return modelMeta.vision;

  const inputModalities = modelMeta?.input_modalities;
  if (Array.isArray(inputModalities) && inputModalities.some((m) => String(m).toLowerCase().includes('image'))) {
    return true;
  }

  const modalities = modelMeta?.modalities;
  if (Array.isArray(modalities) && modalities.some((m) => String(m).toLowerCase().includes('image'))) {
    return true;
  }

  const id = model.toLowerCase();
  if (/(vision|multimodal|\bvl\b|llava|qwen2\.5-vl|gpt-4o|gemini|claude-3)/i.test(id)) return true;

  if (harness.id.includes('vision') || harness.id.includes('vl')) return true;

  return false;
}

function normalizeModelsResponse(raw: any): { data: Array<{ id: string; [k: string]: any }> } {
  if (Array.isArray(raw)) {
    return {
      data: raw
        .map((m: any) => {
          if (!m) return null;
          if (typeof m === 'string') return { id: m };
          if (typeof m.id === 'string' && m.id) return m;
          return null;
        })
        .filter(Boolean) as Array<{ id: string; [k: string]: any }>
    };
  }

  if (raw && Array.isArray(raw.data)) {
    return {
      data: raw.data
        .map((m: any) => (m && typeof m.id === 'string' && m.id ? m : null))
        .filter(Boolean) as Array<{ id: string; [k: string]: any }>
    };
  }

  return { data: [] };
}

export type AgentRuntime = {
  client?: OpenAIClient;
  vault?: VaultStore;
  replay?: ReplayStore;
  lens?: LensStore;
};

export type AgentHooks = {
  signal?: AbortSignal;
  onToken?: (t: string) => void;
  onFirstDelta?: () => void;
  onToolCall?: (call: ToolCallEvent) => void;
  onToolResult?: (result: ToolResultEvent) => void | Promise<void>;
  onTurnEnd?: (stats: TurnEndEvent) => void | Promise<void>;
};

export type ServerHealthSnapshot = {
  ok: boolean;
  checkedAt: string;
  model?: string;
  status?: string;
  contextUsedTokens?: number;
  contextTotalTokens?: number;
  kvPct?: number;
  pendingRequests?: number;
  ppTokensPerSec?: number;
  tgTokensPerSec?: number;
  slotCount?: number;
  error?: string;
  raw?: any;
};

export type TurnPerformance = {
  totalMs: number;
  ttftMs?: number;
  promptTokens: number;
  completionTokens: number;
  ppTokensPerSec?: number;
  tgTokensPerSec?: number;
  health?: ServerHealthSnapshot;
};

export type PerfSummary = {
  turns: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  avgTtftMs?: number;
  avgTtcMs: number;
  p50TtcMs: number;
  p95TtcMs: number;
  avgPpTokensPerSec?: number;
  avgTgTokensPerSec?: number;
};

export type CaptureRecord = {
  timestamp: string;
  request: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSchema[];
    temperature: number;
    top_p: number;
    max_tokens: number;
    endpoint?: string;
  };
  response: any;
  metrics: {
    ttft_ms?: number;
    tg_speed?: number;
    total_ms: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

export type AgentSession = {
  model: string;
  harness: string;
  endpoint: string;
  contextWindow: number;
  supportsVision: boolean;
  messages: ChatMessage[];
  usage: { prompt: number; completion: number };
  ask: (instruction: UserContent, hooks?: ((t: string) => void) | AgentHooks) => Promise<AgentResult>;
  setModel: (name: string) => void;
  setEndpoint: (endpoint: string, modelName?: string) => Promise<void>;
  listModels: () => Promise<string[]>;
  refreshServerHealth: () => Promise<ServerHealthSnapshot | null>;
  getPerfSummary: () => PerfSummary;
  captureOn: (filePath?: string) => Promise<string>;
  captureOff: () => void;
  captureLast: (filePath?: string) => Promise<string>;
  capturePath?: string;
  getSystemPrompt: () => string;
  setSystemPrompt: (prompt: string) => void;
  resetSystemPrompt: () => void;
  listMcpServers: () => McpServerStatus[];
  listMcpTools: (opts?: { includeDisabled?: boolean }) => McpToolStatus[];
  restartMcpServer: (name: string) => Promise<{ ok: boolean; message: string }>;
  enableMcpTool: (name: string) => boolean;
  disableMcpTool: (name: string) => boolean;
  mcpWarnings: () => string[];
  listLspServers: () => { language: string; command: string; running: boolean }[];
  setVerbose: (on: boolean) => void;
  close: () => Promise<void>;
  reset: () => void;
  cancel: () => void;
  restore: (messages: ChatMessage[]) => void;
  replay?: ReplayStore;
  vault?: VaultStore;
  lens?: LensStore;
  lastEditedPath?: string;
  lastTurnMetrics?: TurnPerformance;
  lastServerHealth?: ServerHealthSnapshot;
  /** Plan mode: accumulated steps from the last ask() in plan mode */
  planSteps: PlanStep[];
  /** Execute a specific plan step (or all if no index given). Returns results. */
  executePlanStep: (index?: number) => Promise<string[]>;
  /** Clear accumulated plan steps */
  clearPlan: () => void;
  /** Manual context compaction. */
  compactHistory: (opts?: { topic?: string; hard?: boolean; dry?: boolean }) => Promise<{
    beforeMessages: number;
    afterMessages: number;
    freedTokens: number;
    archivedToolMessages: number;
    droppedMessages: number;
    dryRun: boolean;
  }>;
};

export async function createSession(opts: {
  config: IdlehandsConfig;
  apiKey?: string;
  confirm?: (prompt: string) => Promise<boolean>;          // legacy — use confirmProvider instead
  confirmProvider?: ConfirmationProvider;
  runtime?: AgentRuntime;
  allowSpawnTask?: boolean;
}): Promise<AgentSession> {
  const cfg = opts.config;
  let client = opts.runtime?.client ?? new OpenAIClient(cfg.endpoint, opts.apiKey, cfg.verbose);
  if (typeof (client as any).setVerbose === 'function') {
    (client as any).setVerbose(cfg.verbose);
  }
  if (typeof cfg.response_timeout === 'number' && cfg.response_timeout > 0) {
    client.setResponseTimeout(cfg.response_timeout);
  }

  // Health check + model list (cheap, avoids wasting GPU on chat warmups if unreachable)
  let modelsList = normalizeModelsResponse(await client.models().catch(() => null));

  let model = cfg.model && cfg.model.trim().length
    ? cfg.model
    : await autoPickModel(client, modelsList);

  let harness = selectHarness(model, cfg.harness && cfg.harness.trim() ? cfg.harness.trim() : undefined);

  // Try to derive context window from /v1/models (if provided by server).
  const explicitContextWindow = cfg.context_window != null;
  const modelMeta = modelsList?.data?.find((m: any) => m.id === model);
  const derivedCtx =
    (modelMeta?.context_window ?? modelMeta?.context_length ?? modelMeta?.max_context_length) as number | undefined;
  let contextWindow = cfg.context_window ?? derivedCtx ?? 131072;
  let supportsVision = supportsVisionModel(model, modelMeta, harness);

  if (!cfg.i_know_what_im_doing && contextWindow > 131072) {
    console.warn('[warn] context_window is above 131072; this can increase memory usage and hurt throughput. Use --i-know-what-im-doing to proceed.');
  }

  // Apply harness defaults for values the user didn't explicitly override.
  // Config always fills max_tokens from DEFAULTS (16384), so we need to check
  // whether the harness wants a higher value — harness.defaults.max_tokens wins
  // when it's larger than the base default (16384), unless the user explicitly
  // configured a value in their config file or CLI.
  const BASE_MAX_TOKENS = 16384;
  let maxTokens = cfg.max_tokens ?? BASE_MAX_TOKENS;
  if (maxTokens === BASE_MAX_TOKENS && harness.defaults?.max_tokens && harness.defaults.max_tokens > BASE_MAX_TOKENS) {
    maxTokens = harness.defaults.max_tokens;
  }
  let temperature = cfg.temperature ?? harness.defaults?.temperature ?? 0.2;
  let topP = cfg.top_p ?? harness.defaults?.top_p ?? 0.95;

  const harnessVaultMode: TrifectaMode = harness.defaults?.trifecta?.vaultMode || 'off';
  const vaultMode = (cfg.trifecta?.vault?.mode || harnessVaultMode) as TrifectaMode;
  const vaultEnabled = cfg.trifecta?.enabled !== false && cfg.trifecta?.vault?.enabled !== false;
  let activeVaultTools = vaultEnabled && vaultMode === 'active';

  const lensEnabled = cfg.trifecta?.enabled !== false && cfg.trifecta?.lens?.enabled !== false;

  const spawnTaskEnabled = opts.allowSpawnTask !== false && cfg.sub_agents?.enabled !== false;

  const mcpServers = Array.isArray(cfg.mcp?.servers) ? cfg.mcp!.servers : [];
  const mcpEnabledTools = Array.isArray(cfg.mcp?.enabled_tools) ? cfg.mcp?.enabled_tools : undefined;
  const mcpToolBudget = Number.isFinite(cfg.mcp_tool_budget)
    ? Number(cfg.mcp_tool_budget)
    : (Number.isFinite(cfg.mcp?.tool_budget) ? Number(cfg.mcp?.tool_budget) : 1000);
  const mcpCallTimeoutSec = Number.isFinite(cfg.mcp_call_timeout_sec)
    ? Number(cfg.mcp_call_timeout_sec)
    : (Number.isFinite(cfg.mcp?.call_timeout_sec) ? Number(cfg.mcp?.call_timeout_sec) : 30);

  const builtInToolNames = [
    'read_file', 'read_files', 'write_file', 'edit_file', 'insert_file',
    'list_dir', 'search_files', 'exec', 'vault_search', 'vault_note', 'sys_context',
    ...(spawnTaskEnabled ? ['spawn_task'] : []),
  ];

  const mcpManager = mcpServers.length
    ? new MCPManager({
        servers: mcpServers,
        toolBudgetTokens: mcpToolBudget,
        callTimeoutMs: Math.max(1000, Math.floor(mcpCallTimeoutSec * 1000)),
        offline: cfg.offline === true,
        builtInToolNames,
        enabledTools: mcpEnabledTools,
      })
    : null;

  if (mcpManager) {
    await mcpManager.init();
  }

  // LSP integration (Phase 17)
  const lspCfg = cfg.lsp;
  const lspEnabled = lspCfg?.enabled === true;
  let lspManager: LspManager | null = null;

  if (lspEnabled) {
    lspManager = new LspManager({
      rootPath: cfg.dir ?? process.cwd(),
      severityThreshold: lspCfg?.diagnostic_severity_threshold ?? 1,
      quiet: Boolean(process.env.IDLEHANDS_QUIET_WARNINGS),
    });

    // Add explicitly configured servers.
    if (Array.isArray(lspCfg?.servers)) {
      for (const srv of lspCfg.servers) {
        await lspManager.addServer(srv);
      }
    }

    // Auto-detect servers on PATH if configured.
    if (lspCfg?.auto_detect !== false) {
      const detected = detectInstalledLspServers();
      for (const d of detected) {
        await lspManager.addServer({
          language: d.language,
          command: d.command,
          args: d.args,
        });
      }
    }
  }

  const mcpHasEnabledTools = (mcpManager?.listTools().length ?? 0) > 0;
  const mcpLazySchemaMode = Boolean(mcpManager && mcpHasEnabledTools);
  let mcpToolsLoaded = !mcpLazySchemaMode;

  const getToolsSchema = () => buildToolsSchema({
    activeVaultTools,
    sysMode: cfg.mode === 'sys',
    lspTools: lspManager?.hasServers() === true,
    mcpTools: mcpToolsLoaded ? (mcpManager?.getEnabledToolSchemas() ?? []) : [],
    allowSpawnTask: spawnTaskEnabled,
  });

  const vault = vaultEnabled ? (opts.runtime?.vault ?? new VaultStore()) : undefined;
  if (vault) {
    // Scope vault entries by project directory to prevent cross-project context leaks
    vault.setProjectDir(cfg.dir ?? process.cwd());
  }
  if (vaultEnabled && !opts.runtime?.vault) {
    await vault?.init().catch((e: any) => {
      // If vault storage is unavailable (e.g., sandboxed FS / disk I/O),
      // degrade gracefully by disabling active vault tools for this run.
      activeVaultTools = false;
      const msg = String(e?.message ?? e ?? 'unknown error');
      const isDiskLike = /disk i\/o|sqlite|readonly|read-only|permission denied/i.test(msg);
      if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
        if (isDiskLike) {
          console.warn('[warn] vault disabled for this session (storage unavailable).');
        } else {
          console.warn(`[warn] vault init failed: ${msg}`);
        }
      }
    });
  }

  const lens = lensEnabled ? (opts.runtime?.lens ?? new LensStore()) : undefined;
  if (!opts.runtime?.lens && lens) {
    await lens.init().catch((e: any) => {
      console.warn(`[warn] lens init failed: ${e?.message ?? e}`);
    });
  }

  const projectCtx = await loadProjectContext(cfg).catch((e: any) => {
    console.warn(`[warn] project context disabled for startup: ${e?.message ?? e}`);
    return '';
  });
  const gitCtx = await loadGitContext(cfg.dir ?? process.cwd()).catch((e: any) => {
    console.warn(`[warn] git context disabled for startup: ${e?.message ?? e}`);
    return '';
  });

  let freshIndexSummary = '';
  if (vault) {
    try {
      const keys = projectIndexKeys(cfg.dir ?? process.cwd());
      const metaRow = await vault.getLatestByKey(keys.metaKey, 'system');
      if (metaRow?.value) {
        const meta = parseIndexMeta(metaRow.value);
        if (meta && isFreshIndex(meta, 24 * 60 * 60 * 1000)) {
          const summaryRow = await vault.getLatestByKey(keys.summaryKey, 'system');
          freshIndexSummary = summaryRow?.value || indexSummaryLine(meta);
        }
      }
    } catch {
      // best effort only
    }
  }

  let sessionMeta =
    `[cwd: ${cfg.dir}]\n[harness: ${harness.id}]` +
    (gitCtx ? `\n\n${gitCtx}` : '') +
    (projectCtx ? `\n\n${projectCtx}` : '') +
    (freshIndexSummary ? `\n\n${freshIndexSummary}` : '');

  if (vaultEnabled && vaultMode === 'active') {
    sessionMeta +=
      '\n\n[Trifecta Vault] Active vault mode is enabled. Record high-signal decisions and reuse them with vault tools when needed.';
  }

  if (lensEnabled) {
    sessionMeta += '\n\n[Trifecta Lens] Structural projection is enabled where available.';
  }

  if (lspManager?.hasServers()) {
    const lspServers = lspManager.listServers();
    const running = lspServers.filter((s) => s.running).length;
    sessionMeta += `\n\n[LSP] ${running} language server(s) active: ${lspServers.map((s) => `${s.language} (${s.command})`).join(', ')}.`;
    sessionMeta += '\n[LSP] Use lsp_diagnostics, lsp_symbols, lsp_hover, lsp_definition, lsp_references tools for semantic code intelligence.';
    if (lensEnabled) {
      sessionMeta += '\n[LSP+Lens] lsp_symbols combines semantic symbol data with structural Lens context when available.';
    }
    if (lspCfg?.proactive_diagnostics !== false) {
      sessionMeta += '\n[LSP] Proactive diagnostics enabled: errors will be reported automatically after file edits.';
    }
  }

  if (mcpManager) {
    const mcpServers = mcpManager.listServers();
    const connected = mcpServers.filter((s) => s.connected).length;
    const enabledTools = mcpManager.listTools().length;
    sessionMeta += `\n\n[MCP] ${connected}/${mcpServers.length} servers connected; ${enabledTools} tools enabled.`;
    if (mcpLazySchemaMode) {
      sessionMeta += `\n[MCP] Lazy schema mode on. MCP tools are hidden until requested.`;
      sessionMeta += `\n[MCP] If external tools are needed, reply exactly with ${MCP_TOOLS_REQUEST_TOKEN}.`;
    }
    for (const w of mcpManager.getWarnings()) {
      sessionMeta += `\n[MCP warning] ${w}`;
    }
  }

  if (spawnTaskEnabled) {
    const subDefaults = cfg.sub_agents ?? {};
    const subMaxIter = Number.isFinite(subDefaults.max_iterations)
      ? Math.max(1, Math.floor(Number(subDefaults.max_iterations)))
      : 50;
    sessionMeta += `\n\n[Sub-agents] spawn_task is available (isolated context, sequential queue, default max_iterations=${subMaxIter}).`;
  }

  // Harness-driven suffix: append to first user message (NOT system prompt — §9b KV cache rule)
  // Check if model needs content-mode tool calls (known incompatible templates)
  // This runs before harness checks so it works regardless of quirk flags.
  {
    const modelName = cfg.model ?? '';
    const { OpenAIClient: OAIClient } = await import('./client.js');
    if (!client.contentModeToolCalls && OAIClient.needsContentMode(modelName)) {
      client.contentModeToolCalls = true;
      client.recordKnownPatternMatch();
      if (cfg.verbose) {
        console.warn(`[info] Model "${modelName}" matched known content-mode pattern — using content-based tool calls`);
      }
    }
  }

  if (harness.quirks.needsExplicitToolCallFormatReminder) {
    if (client.contentModeToolCalls) {
      // In content mode, tell the model to use JSON tool calls in its output
      sessionMeta += '\n\nYou have access to the following tools. To call a tool, output a JSON block in your response like this:\n```json\n{"name": "tool_name", "arguments": {"param": "value"}}\n```\nAvailable tools:\n';
      const toolSchemas = getToolsSchema();
      for (const t of toolSchemas) {
        const fn = (t as any).function;
        if (fn) {
          const params = fn.parameters?.properties
            ? Object.entries(fn.parameters.properties).map(([k, v]: [string, any]) => `${k}: ${v.type ?? 'any'}`).join(', ')
            : '';
          sessionMeta += `- ${fn.name}(${params}): ${fn.description ?? ''}\n`;
        }
      }
      sessionMeta += '\nIMPORTANT: Output tool calls as JSON blocks in your message. Do NOT use the tool_calls API mechanism.\nIf you use XML/function tags (e.g. <function=name>), include a full JSON object of arguments between braces.';
    } else {
      sessionMeta += '\n\nIMPORTANT: Use the tool_calls mechanism to invoke tools. Do NOT write JSON tool invocations in your message text.';
    }

    // One-time tool-call template smoke test (first ask() call only, skip in content mode)
    if (!client.contentModeToolCalls && !(client as any).__toolCallSmokeTested) {
      (client as any).__toolCallSmokeTested = true;
      try {
        const smokeErr = await client.smokeTestToolCalls(cfg.model ?? 'default');
        if (smokeErr) {
          console.error(`\x1b[33m[warn] Tool-call smoke test failed: ${smokeErr}\x1b[0m`);
          console.error(`\x1b[33m  This model/server may not support tool-call replay correctly.\x1b[0m`);
          console.error(`\x1b[33m  Consider using a different model or updating llama.cpp.\x1b[0m`);
        }
      } catch {}
    }
  }
  if (harness.systemPromptSuffix) {
    sessionMeta += '\n\n' + harness.systemPromptSuffix;
  }

  // Phase 9: sys-eager — inject full system snapshot into first message
  if (cfg.sys_eager && cfg.mode === 'sys') {
    try {
      const snapshot = await collectSnapshot('all');
      sessionMeta += '\n\n' + snapshot;
    } catch (e: any) {
      console.warn(`[warn] sys-eager snapshot failed: ${e?.message ?? e}`);
    }
  }


  const defaultSystemPrompt = SYSTEM_PROMPT;
  let activeSystemPrompt = (cfg.system_prompt_override ?? '').trim() || defaultSystemPrompt;

  let messages: ChatMessage[] = [
    { role: 'system', content: activeSystemPrompt }
  ];
  let sessionMetaPending: string | null = sessionMeta;

  const setSystemPrompt = (prompt: string) => {
    const next = String(prompt ?? '').trim();
    if (!next) throw new Error('system prompt cannot be empty');
    activeSystemPrompt = next;
    if (messages.length > 0 && messages[0].role === 'system') {
      messages[0] = { role: 'system', content: activeSystemPrompt };
    } else {
      messages.unshift({ role: 'system', content: activeSystemPrompt });
    }
  };

  const resetSystemPrompt = () => {
    setSystemPrompt(defaultSystemPrompt);
  };

  const reset = () => {
    messages = [
      { role: 'system', content: activeSystemPrompt }
    ];
    sessionMetaPending = sessionMeta;
    lastEditedPath = undefined;
    mcpToolsLoaded = !mcpLazySchemaMode;
  };

  const restore = (next: ChatMessage[]) => {
    if (!Array.isArray(next) || next.length < 2) {
      throw new Error('restore: invalid messages array');
    }
    if (next[0].role !== 'system') {
      throw new Error('restore: first message must be system');
    }
    messages = next;
    activeSystemPrompt = String(next[0].content ?? defaultSystemPrompt);

    if (mcpManager) {
      const usedMcpTool = next.some((msg: any) => {
        if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) return false;
        return msg.tool_calls.some((tc: any) => mcpManager.hasTool(String(tc?.function?.name ?? '')));
      });
      mcpToolsLoaded = usedMcpTool || !mcpLazySchemaMode;
    }
  };

  let reqCounter = 0;
  let inFlight: AbortController | null = null;
  let lastEditedPath: string | undefined;

  // Plan mode state (Phase 8)
  let planSteps: PlanStep[] = [];

  // Sub-agent queue state (Phase 18): enforce sequential execution on single-GPU setups.
  let subTaskSeq = 0;
  let subTaskQueuePending = 0;
  let subTaskQueueTail: Promise<void> = Promise.resolve();

  const enqueueSubTask = async <T>(runner: (queuePosition: number) => Promise<T>): Promise<T> => {
    const queuePosition = subTaskQueuePending + 1;
    subTaskQueuePending += 1;

    const waitFor = subTaskQueueTail;
    let release!: () => void;
    subTaskQueueTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await waitFor;
      return await runner(queuePosition);
    } finally {
      subTaskQueuePending = Math.max(0, subTaskQueuePending - 1);
      release();
    }
  };

  const summarizeReplayDelta = async (beforeIds: Set<string> | null): Promise<string[]> => {
    if (!replay || !beforeIds) return [];
    const rows = await replay.list(10000);
    const byFile = new Map<string, number>();
    for (const row of rows) {
      if (beforeIds.has(row.id)) continue;
      byFile.set(row.filePath, (byFile.get(row.filePath) ?? 0) + 1);
    }
    return [...byFile.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([filePath, edits]) => `${filePath}${edits > 1 ? ` (${edits} edits)` : ''}`);
  };

  const runSpawnTaskCore = async (
    args: any,
    options?: {
      signal?: AbortSignal;
      emitStatus?: (taskId: number, status: 'queued' | 'running' | 'completed' | 'failed', detail?: string) => void;
    }
  ): Promise<string> => {
    if (!spawnTaskEnabled) {
      throw new Error('spawn_task: disabled in this session');
    }

    const task = typeof args?.task === 'string' ? args.task.trim() : '';
    if (!task) {
      throw new Error('spawn_task: missing task');
    }

    // Prevent using delegation to bypass package-install confirmation restrictions.
    const taskSafety = checkExecSafety(task);
    if (!cfg.no_confirm && taskSafety.tier === 'cautious' && taskSafety.reason === 'package install/remove') {
      throw new Error(
        'spawn_task: blocked — package install/remove is restricted in the current approval mode. ' +
        'Do not delegate this to bypass confirmation requirements; ask the user to run with --no-confirm/--yolo instead.'
      );
    }

    const defaults = cfg.sub_agents ?? {};
    const taskId = ++subTaskSeq;
    const emitStatus = options?.emitStatus ?? (() => {});

    const maxIterations = Number.isFinite(args?.max_iterations)
      ? Math.max(1, Math.floor(Number(args.max_iterations)))
      : (Number.isFinite(defaults.max_iterations)
          ? Math.max(1, Math.floor(Number(defaults.max_iterations)))
          : 50);

    const timeoutSec = Number.isFinite(args?.timeout_sec)
      ? Math.max(1, Math.floor(Number(args.timeout_sec)))
      : (Number.isFinite(defaults.timeout_sec)
          ? Math.max(1, Math.floor(Number(defaults.timeout_sec)))
          : Math.max(60, cfg.timeout));

    const subMaxTokens = Number.isFinite(args?.max_tokens)
      ? Math.max(128, Math.floor(Number(args.max_tokens)))
      : (Number.isFinite(defaults.max_tokens)
          ? Math.max(128, Math.floor(Number(defaults.max_tokens)))
          : maxTokens);

    const resultTokenCap = Number.isFinite(defaults.result_token_cap)
      ? Math.max(256, Math.floor(Number(defaults.result_token_cap)))
      : DEFAULT_SUB_AGENT_RESULT_TOKEN_CAP;

    const parentApproval = cfg.approval_mode ?? 'default';
    const rawApproval = normalizeApprovalMode(args?.approval_mode)
      ?? normalizeApprovalMode(defaults.approval_mode)
      ?? parentApproval;
    // Sub-agents cannot escalate beyond the parent's approval mode.
    const approvalMode = capApprovalMode(rawApproval, parentApproval);

    const requestedModel = typeof args?.model === 'string' && args.model.trim()
      ? args.model.trim()
      : (typeof defaults.model === 'string' && defaults.model.trim() ? defaults.model.trim() : model);

    const requestedEndpoint = typeof args?.endpoint === 'string' && args.endpoint.trim()
      ? args.endpoint.trim()
      : (typeof defaults.endpoint === 'string' && defaults.endpoint.trim() ? defaults.endpoint.trim() : cfg.endpoint);

    const requestedSystemPrompt = typeof args?.system_prompt === 'string' && args.system_prompt.trim()
      ? args.system_prompt.trim()
      : (typeof defaults.system_prompt === 'string' && defaults.system_prompt.trim()
          ? defaults.system_prompt.trim()
          : DEFAULT_SUB_AGENT_SYSTEM_PROMPT);

    const cwd = cfg.dir ?? process.cwd();
    const ctxFiles = await buildSubAgentContextBlock(cwd, args?.context_files);

    let delegatedInstruction = task;
    // Explicitly inject cwd into the delegated task so the sub-agent knows where to work.
    delegatedInstruction += `\n\nIMPORTANT: Your working directory is "${cwd}". Create ALL files inside this directory using relative paths. Do NOT create files or directories outside this path.`;
    if (ctxFiles.block) {
      delegatedInstruction += `\n\n[Delegated context files]\n${ctxFiles.block}`;
    }
    if (ctxFiles.skipped.length) {
      delegatedInstruction += `\n\n[context skipped]\n- ${ctxFiles.skipped.join('\n- ')}`;
    }

    return await enqueueSubTask(async (queuePosition) => {
      if (queuePosition > 1) {
        emitStatus(taskId, 'queued', `position ${queuePosition}`);
      }

      const startedAt = Date.now();
      emitStatus(taskId, 'running', `${task.slice(0, 80)}${task.length > 80 ? '…' : ''}`);

      const replayBeforeIds = replay
        ? new Set((await replay.list(10000)).map((row) => row.id))
        : null;

      const subConfig: IdlehandsConfig = {
        ...cfg,
        endpoint: requestedEndpoint,
        model: requestedModel,
        max_iterations: maxIterations,
        max_tokens: subMaxTokens,
        timeout: timeoutSec,
        approval_mode: approvalMode,
        // Sub-agent inherits parent's no_confirm. If parent runs --no-confirm,
        // sub-agent also auto-confirms. Don't override based on approval_mode alone
        // (that made auto-edit behave like yolo only for sub-agents).
        no_confirm: cfg.no_confirm || approvalMode === 'yolo',
        system_prompt_override: requestedSystemPrompt,
      };

      if (defaults.inherit_context_file === false) {
        subConfig.no_context = true;
      }

      const subRuntime: AgentRuntime = {
        replay,
        lens,
        vault: defaults.inherit_vault === false ? undefined : vault,
      };

      const sameEndpoint = requestedEndpoint.replace(/\/+$/, '') === cfg.endpoint.replace(/\/+$/, '');
      if (sameEndpoint && opts.runtime?.client) {
        subRuntime.client = opts.runtime.client;
      }

      const subSession = await createSession({
        config: subConfig,
        apiKey: opts.apiKey,
        confirm: opts.confirm,
        confirmProvider: opts.confirmProvider,
        runtime: subRuntime,
        allowSpawnTask: false,
      });

      let subTurns = 0;
      let subToolCalls = 0;
      let failedMessage = '';
      let resultText = '';

      try {
        const subResult = await subSession.ask(delegatedInstruction, {
          signal: options?.signal,
          onTurnEnd: (ev) => {
            subTurns = ev.turn;
            subToolCalls = ev.toolCalls;
            emitStatus(taskId, 'running', `turn ${ev.turn}/${maxIterations}`);
          },
        });
        subTurns = subResult.turns;
        subToolCalls = subResult.toolCalls;
        resultText = subResult.text;
      } catch (e: any) {
        failedMessage = e?.message ?? String(e);
      } finally {
        await subSession.close().catch(() => {});
      }

      const duration = Date.now() - startedAt;
      const filesChanged = await summarizeReplayDelta(replayBeforeIds);

      if (failedMessage) {
        emitStatus(taskId, 'failed', failedMessage.slice(0, 120));
        return [
          `[sub-agent] status=failed`,
          `task: ${task}`,
          `duration: ${formatDurationMs(duration)}`,
          `model: ${requestedModel}`,
          `endpoint: ${requestedEndpoint}`,
          `approval_mode: ${approvalMode}`,
          `error: ${failedMessage}`,
          filesChanged.length ? `files_changed: ${filesChanged.join(', ')}` : 'files_changed: none',
        ].join('\n');
      }

      const capped = capTextByApproxTokens(resultText, resultTokenCap);
      emitStatus(taskId, 'completed', `${subTurns} turns, ${subToolCalls} tool calls`);

      return [
        `[sub-agent] status=completed`,
        `task: ${task}`,
        `duration: ${formatDurationMs(duration)}`,
        `model: ${requestedModel}`,
        `endpoint: ${requestedEndpoint}`,
        `approval_mode: ${approvalMode}`,
        `turns: ${subTurns}`,
        `tool_calls: ${subToolCalls}`,
        `files_changed: ${filesChanged.length ? filesChanged.join(', ') : 'none'}`,
        capped.truncated ? `[sub-agent] summarized result capped to ~${resultTokenCap} tokens` : `[sub-agent] summarized result within cap`,
        `result:\n${capped.text}`,
      ].join('\n');
    });
  };

  // Build a ToolContext — shared between plan-step execution and the agent loop.
  const buildToolCtx = (overrides?: {
    signal?: AbortSignal;
    onMutation?: (absPath: string) => void;
    confirmBridge?: (prompt: string, bridgeCtx?: { tool?: string; args?: Record<string, unknown>; diff?: string }) => Promise<boolean>;
  }) => {
    const defaultConfirmBridge = opts.confirmProvider
      ? async (prompt: string) => opts.confirmProvider!.confirm({
          tool: '', args: {}, summary: prompt, mode: cfg.approval_mode,
        })
      : opts.confirm;
    return {
      cwd: cfg.dir ?? process.cwd(),
      noConfirm: cfg.no_confirm || cfg.approval_mode === 'yolo',
      dryRun: cfg.dry_run,
      mode: cfg.mode ?? 'code',
      confirm: overrides?.confirmBridge ?? defaultConfirmBridge,
      replay,
      vault,
      lens,
      signal: overrides?.signal ?? inFlight?.signal,
      onMutation: overrides?.onMutation ?? ((absPath: string) => { lastEditedPath = absPath; }),
    };
  };

  const executePlanStep = async (index?: number): Promise<string[]> => {
    if (!planSteps.length) return ['No plan steps to execute.'];

    const toExec = index != null
      ? planSteps.filter(s => s.index === index && s.blocked && !s.executed)
      : planSteps.filter(s => s.blocked && !s.executed);

    if (!toExec.length) return ['No pending blocked steps to execute.'];

    const ctx = buildToolCtx();
    const results: string[] = [];

    for (const step of toExec) {
      const fn = (tools as any)[step.tool] as Function | undefined;

      try {
        let content = '';

        if (fn) {
          const value = await fn(ctx, step.args);
          content = typeof value === 'string' ? value : JSON.stringify(value);
        } else if (step.tool === 'spawn_task') {
          content = await runSpawnTaskCore(step.args, { signal: inFlight?.signal });
        } else if (LSP_TOOL_NAME_SET.has(step.tool) && lspManager) {
          if (step.tool === 'lsp_diagnostics') {
            content = await lspManager.getDiagnostics(
              typeof step.args?.path === 'string' ? step.args.path : undefined,
              typeof step.args?.severity === 'number' ? step.args.severity : undefined,
            );
          } else if (step.tool === 'lsp_symbols') {
            content = await lspManager.getSymbols(String(step.args?.path ?? ''));
          } else if (step.tool === 'lsp_hover') {
            content = await lspManager.getHover(
              String(step.args?.path ?? ''),
              Number(step.args?.line ?? 0),
              Number(step.args?.character ?? 0),
            );
          } else if (step.tool === 'lsp_definition') {
            content = await lspManager.getDefinition(
              String(step.args?.path ?? ''),
              Number(step.args?.line ?? 0),
              Number(step.args?.character ?? 0),
            );
          } else if (step.tool === 'lsp_references') {
            content = await lspManager.getReferences(
              String(step.args?.path ?? ''),
              Number(step.args?.line ?? 0),
              Number(step.args?.character ?? 0),
              typeof step.args?.max_results === 'number' ? step.args.max_results : 50,
            );
          }
        } else if (mcpManager?.hasTool(step.tool)) {
          const callArgs = step.args && typeof step.args === 'object' && !Array.isArray(step.args)
            ? step.args as Record<string, unknown>
            : {};
          content = await mcpManager.callTool(step.tool, callArgs);
        } else {
          throw new Error(`unknown tool: ${step.tool}`);
        }

        step.executed = true;
        step.result = content;
        results.push(`#${step.index} ✓ ${step.summary}`);
        // Inject the result into conversation so the model knows it was executed
        messages.push({
          role: 'user',
          content: `[Plan step #${step.index} executed] ${step.tool}: ${content.slice(0, 500)}`,
        });
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        step.result = `ERROR: ${msg}`;
        results.push(`#${step.index} ✗ ${step.summary}: ${msg}`);
      }
    }

    return results;
  };

  const clearPlan = () => {
    planSteps = [];
  };

  // Session-level vault context injection: search vault for entries relevant to
  // the last user message and inject them into the conversation. Used after any
  // compaction to restore context the model lost when messages were dropped.
  let lastVaultInjectionQuery = '';
  const injectVaultContext = async () => {
    if (!vault) return;
    let lastUser: any = null;
    for (let j = messages.length - 1; j >= 0; j--) { if (messages[j].role === 'user') { lastUser = messages[j]; break; } }
    const userText = userContentToText((lastUser?.content ?? '') as UserContent).trim();
    if (!userText) return;
    const query = userText.slice(0, 200);
    if (query === lastVaultInjectionQuery) return;
    const hits = await vault.search(query, 4);
    if (!hits.length) return;
    const lines = hits.map(
      (r) => `${r.updatedAt} ${r.kind} ${r.key ?? r.tool ?? r.id} ${String(r.value ?? r.snippet ?? '').replace(/\s+/g, ' ').slice(0, 180)}`
    );
    if (!lines.length) return;
    lastVaultInjectionQuery = query;
    const vaultContextHeader = vaultMode === 'passive'
      ? '[Trifecta Vault (passive)]'
      : '[Vault context after compaction]';
    messages.push({
      role: 'user',
      content: `${vaultContextHeader} Relevant entries for "${query}":\n${lines.join('\n')}`
    });
  };

  const compactHistory = async (opts?: { topic?: string; hard?: boolean; dry?: boolean }) => {
    const beforeMessages = messages.length;
    const beforeTokens = estimateTokensFromMessages(messages);

    let compacted: ChatMessage[];
    if (opts?.hard) {
      const sys = messages[0]?.role === 'system' ? [messages[0]] : [];
      const tail = messages.slice(-2);
      compacted = [...sys, ...tail];
    } else {
      compacted = enforceContextBudget({
        messages,
        contextWindow,
        maxTokens,
        minTailMessages: 12,
        compactAt: cfg.compact_at ?? 0.8,
        toolSchemaTokens: estimateToolSchemaTokens(getToolsSchema()),
      });
    }

    const compactedByRefs = new Set(compacted);
    let dropped = messages.filter((m) => !compactedByRefs.has(m));

    if (opts?.topic) {
      const topic = opts.topic.toLowerCase();
      dropped = dropped.filter((m) => !userContentToText((m as any).content ?? '').toLowerCase().includes(topic));
      const keepFromTopic = messages.filter((m) => userContentToText((m as any).content ?? '').toLowerCase().includes(topic));
      compacted = [...compacted, ...keepFromTopic.filter((m) => !compactedByRefs.has(m))];
    }

    const archivedToolMessages = dropped.filter((m) => m.role === 'tool').length;
    const afterMessages = compacted.length;
    const afterTokens = estimateTokensFromMessages(compacted);
    const freedTokens = Math.max(0, beforeTokens - afterTokens);

    if (!opts?.dry) {
      if (dropped.length && vault) {
        try {
          await vault.archiveToolMessages(dropped as ChatMessage[], new Map());
          await vault.note('compaction_summary', `Dropped ${dropped.length} messages (${freedTokens} tokens).`);
        } catch {
          // best-effort
        }
      }
      messages = compacted;
      if (dropped.length) {
        messages.push({ role: 'system', content: `[compacted: ${dropped.length} messages archived to Vault - vault_search to recall]` });
        await injectVaultContext().catch(() => {});
      }
    }

    return {
      beforeMessages,
      afterMessages,
      freedTokens,
      archivedToolMessages,
      droppedMessages: dropped.length,
      dryRun: !!opts?.dry,
    };
  };

  const cumulativeUsage = { prompt: 0, completion: 0 };
  const turnDurationsMs: number[] = [];
  const ttftSamplesMs: number[] = [];
  const ppSamples: number[] = [];
  const tgSamples: number[] = [];
  let lastTurnMetrics: TurnPerformance | undefined;
  let lastServerHealth: ServerHealthSnapshot | undefined;
  let lastModelsProbeMs = 0;

  const capturesDir = path.join(stateDir(), 'captures');
  let captureEnabled = false;
  let capturePath: string | undefined;
  let lastCaptureRecord: any | null = null;

  const defaultCapturePath = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(capturesDir, `${stamp}.jsonl`);
  };

  const appendCaptureRecord = async (record: any, outPath: string) => {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.appendFile(outPath, JSON.stringify(record) + '\n', 'utf8');
  };

  const wireCaptureHook = () => {
    if (typeof (client as any).setExchangeHook !== 'function') return;
    (client as any).setExchangeHook(async (record: any) => {
      lastCaptureRecord = record;
      if (!captureEnabled) return;
      const target = capturePath || defaultCapturePath();
      capturePath = target;
      await appendCaptureRecord(record, target);
    });
  };

  wireCaptureHook();

  const replayEnabled = cfg.trifecta?.enabled !== false && cfg.trifecta?.replay?.enabled !== false;
  const replay = replayEnabled ? (opts.runtime?.replay ?? new ReplayStore()) : undefined;
  // Init is best-effort; Replay must never crash the agent.
  if (replayEnabled && !opts.runtime?.replay && replay) {
    await replay.init().catch((e: any) => {
      console.warn(`[warn] replay init failed: ${e?.message ?? e}`);
    });
  }

  const cancel = () => {
    try {
      inFlight?.abort();
    } catch {
      // ignore
    }
  };

  const asNumber = (...values: any[]): number | undefined => {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
      }
    }
    return undefined;
  };

  const normalizeHealth = (raw: any): ServerHealthSnapshot => {
    const modelName =
      (typeof raw?.model === 'string' ? raw.model : undefined) ??
      raw?.model?.id ??
      raw?.model?.name ??
      raw?.loaded_model ??
      raw?.model_path;

    const contextUsedTokens = asNumber(
      raw?.kv_cache?.used_tokens,
      raw?.kv_used_tokens,
      raw?.cache?.used_tokens,
      raw?.context_used,
      raw?.ctx_used,
    );

    const contextTotalTokens = asNumber(
      raw?.kv_cache?.total_tokens,
      raw?.kv_total_tokens,
      raw?.cache?.total_tokens,
      raw?.context_size,
      raw?.ctx_size,
    );

    const kvPct =
      contextUsedTokens != null && contextTotalTokens != null && contextTotalTokens > 0
        ? (contextUsedTokens / contextTotalTokens) * 100
        : asNumber(raw?.kv_cache?.pct, raw?.kv_pct);

    const pendingRequests = asNumber(
      raw?.pending_requests,
      raw?.queue?.pending,
      raw?.n_pending_requests,
      raw?.requests_pending,
    );

    const ppTokensPerSec = asNumber(
      raw?.speed?.prompt_tokens_per_second,
      raw?.prompt_tokens_per_second,
      raw?.pp_tps,
      raw?.timings?.prompt_per_second,
    );

    const tgTokensPerSec = asNumber(
      raw?.speed?.tokens_per_second,
      raw?.tokens_per_second,
      raw?.tg_tps,
      raw?.timings?.tokens_per_second,
      raw?.generation_tokens_per_second,
    );

    const slotCount = Array.isArray(raw?.slots)
      ? raw.slots.length
      : asNumber(raw?.slot_count, raw?.n_slots);

    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      model: modelName ? String(modelName) : undefined,
      status: typeof raw?.status === 'string' ? raw.status : 'ok',
      contextUsedTokens,
      contextTotalTokens,
      kvPct,
      pendingRequests,
      ppTokensPerSec,
      tgTokensPerSec,
      slotCount,
      raw,
    };
  };

  const refreshServerHealth = async (): Promise<ServerHealthSnapshot | null> => {
    if (typeof (client as any).health !== 'function') {
      return null;
    }

    try {
      const raw = await client.health();
      const snapshot = normalizeHealth(raw);
      lastServerHealth = snapshot;
      return snapshot;
    } catch (e: any) {
      const snapshot: ServerHealthSnapshot = {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: e?.message ?? String(e),
      };
      if (lastServerHealth?.ok !== false) {
        console.warn(`[server] health check failed: ${snapshot.error}`);
      }
      lastServerHealth = snapshot;
      return snapshot;
    }
  };

  const listModels = async (): Promise<string[]> => {
    const fresh = normalizeModelsResponse(await client.models());
    modelsList = fresh;
    return fresh.data.map((m) => m.id).filter(Boolean);
  };

  const setModel = (name: string) => {
    model = name;
    harness = selectHarness(model, cfg.harness && cfg.harness.trim() ? cfg.harness.trim() : undefined);
    const nextMeta = modelsList?.data?.find((m: any) => m.id === model);
    supportsVision = supportsVisionModel(model, nextMeta, harness);

    if (!explicitContextWindow) {
      const derived = asNumber(nextMeta?.context_window, nextMeta?.context_length, nextMeta?.max_context_length);
      if (derived && derived > 0) {
        contextWindow = derived;
      }
    }

    maxTokens = cfg.max_tokens ?? BASE_MAX_TOKENS;
    if (maxTokens === BASE_MAX_TOKENS && harness.defaults?.max_tokens && harness.defaults.max_tokens > BASE_MAX_TOKENS) {
      maxTokens = harness.defaults.max_tokens;
    }
    temperature = cfg.temperature ?? harness.defaults?.temperature ?? 0.2;
    topP = cfg.top_p ?? harness.defaults?.top_p ?? 0.95;
  };

  const setEndpoint = async (endpoint: string, modelName?: string): Promise<void> => {
    const normalized = endpoint.replace(/\/+$/, '');
    cfg.endpoint = normalized;

    if (opts.runtime?.client) {
      (opts.runtime.client as any).setEndpoint?.(normalized);
      client = opts.runtime.client;
    } else {
      client = new OpenAIClient(normalized, opts.apiKey, cfg.verbose);
    }

    if (typeof (client as any).setVerbose === 'function') {
      (client as any).setVerbose(cfg.verbose);
    }

    wireCaptureHook();

    modelsList = normalizeModelsResponse(await client.models());

    const chosen = modelName?.trim()
      ? modelName.trim()
      : (modelsList.data.find((m) => m.id === model)?.id ?? await autoPickModel(client, modelsList));

    setModel(chosen);
  };

  const captureOn = async (filePath?: string): Promise<string> => {
    const target = filePath?.trim() ? path.resolve(filePath) : defaultCapturePath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, '', 'utf8');
    captureEnabled = true;
    capturePath = target;
    return target;
  };

  const captureOff = () => {
    captureEnabled = false;
  };

  const captureLast = async (filePath?: string): Promise<string> => {
    if (!lastCaptureRecord) {
      throw new Error('No captured request/response pair is available yet.');
    }
    const target = filePath?.trim()
      ? path.resolve(filePath)
      : (capturePath || defaultCapturePath());
    await appendCaptureRecord(lastCaptureRecord, target);
    return target;
  };

  const listMcpServers = (): McpServerStatus[] => {
    return mcpManager?.listServers() ?? [];
  };

  const listMcpTools = (opts?: { includeDisabled?: boolean }): McpToolStatus[] => {
    return mcpManager?.listTools(opts) ?? [];
  };

  const restartMcpServer = async (name: string): Promise<{ ok: boolean; message: string }> => {
    if (!mcpManager) return { ok: false, message: 'MCP is not configured' };
    return await mcpManager.restartServer(String(name || '').trim());
  };

  const enableMcpTool = (name: string): boolean => {
    if (!mcpManager) return false;
    return mcpManager.enableTool(String(name || '').trim());
  };

  const disableMcpTool = (name: string): boolean => {
    if (!mcpManager) return false;
    return mcpManager.disableTool(String(name || '').trim());
  };

  const mcpWarnings = (): string[] => {
    return mcpManager?.getWarnings() ?? [];
  };

  const listLspServers = () => {
    return lspManager?.listServers() ?? [];
  };

  const close = async () => {
    await mcpManager?.close().catch(() => {});
    await lspManager?.close().catch(() => {});
    vault?.close();
    lens?.close();
  };

  const setVerbose = (on: boolean) => {
    cfg.verbose = !!on;
    if (typeof (client as any).setVerbose === 'function') {
      (client as any).setVerbose(cfg.verbose);
    }
  };

  const getPerfSummary = (): PerfSummary => {
    const totalPromptTokens = cumulativeUsage.prompt;
    const totalCompletionTokens = cumulativeUsage.completion;
    const totalTokens = totalPromptTokens + totalCompletionTokens;

    const sorted = [...turnDurationsMs].sort((a, b) => a - b);
    const quantile = (q: number): number => {
      if (!sorted.length) return 0;
      const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
      return sorted[idx];
    };

    const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : undefined);

    return {
      turns: turnDurationsMs.length,
      totalTokens,
      totalPromptTokens,
      totalCompletionTokens,
      avgTtftMs: avg(ttftSamplesMs),
      avgTtcMs: avg(turnDurationsMs) ?? 0,
      p50TtcMs: quantile(0.5),
      p95TtcMs: quantile(0.95),
      avgPpTokensPerSec: avg(ppSamples),
      avgTgTokensPerSec: avg(tgSamples),
    };
  };

  const maybeAutoDetectModelChange = async () => {
    if (cfg.auto_detect_model_change === false) return;

    const now = Date.now();
    if (now - lastModelsProbeMs < 30_000) return;
    lastModelsProbeMs = now;

    let fresh: { data: Array<{ id: string; [k: string]: any }> };
    try {
      fresh = normalizeModelsResponse(await client.models());
    } catch {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      const spinnerStart = Date.now();
      let spinnerIdx = 0;
      let spinnerTimer: NodeJS.Timeout | undefined;

      if (process.stderr.isTTY) {
        spinnerTimer = setInterval(() => {
          const elapsedSec = Math.floor((Date.now() - spinnerStart) / 1000);
          const frame = frames[spinnerIdx % frames.length];
          spinnerIdx++;
          process.stderr.write(`\r${frame} Server unavailable - waiting for reconnect (${elapsedSec}s)...`);
        }, 120);
      } else {
        console.warn('[model] Server unavailable - waiting for reconnect...');
      }

      try {
        await client.waitForReady({ timeoutMs: 120_000, pollMs: 2_000 });
        fresh = normalizeModelsResponse(await client.models());
        console.warn('[model] Reconnected to server.');
      } catch {
        return;
      } finally {
        if (spinnerTimer) {
          clearInterval(spinnerTimer);
          process.stderr.write('\r\x1b[K');
        }
      }
    }

    modelsList = fresh;
    if (!fresh.data.length) return;

    const exists = fresh.data.some((m) => m.id === model);
    if (exists) return;

    const previousModel = model;
    const nextModel = fresh.data[0].id;
    setModel(nextModel);
    messages.push({
      role: 'system',
      content: '[system] Model changed mid-session. Previous context may not transfer perfectly.'
    });
    console.warn(`[model] Server model changed: ${previousModel} → ${nextModel} - switching harness to ${harness.id}`);
  };

  const ask = async (instruction: UserContent, hooks?: ((t: string) => void) | AgentHooks): Promise<AgentResult> => {
    // Harness can override max_iterations for models that make bad decisions (§4i)
    const maxIters = harness.quirks.maxIterationsOverride
      ? Math.min(cfg.max_iterations, harness.quirks.maxIterationsOverride)
      : cfg.max_iterations;
    const wallStart = Date.now();

    const delegationForbiddenByUser = userDisallowsDelegation(instruction);

    // Prepend session meta to the first user instruction (§9b: variable context
    // goes in first user message, not system prompt, to preserve KV cache).
    // This avoids two consecutive user messages without an assistant response.
    let userContent: UserContent = instruction;
    if (sessionMetaPending) {
      if (typeof instruction === 'string') {
        userContent = `${sessionMetaPending}\n\n${instruction}`;
      } else {
        userContent = [{ type: 'text', text: sessionMetaPending }, ...instruction];
      }
      sessionMetaPending = null;
    }
    messages.push({ role: 'user', content: userContent });

    const hookObj: AgentHooks =
      typeof hooks === 'function' ? { onToken: hooks } : hooks ?? {};

    let turns = 0;
    let toolCalls = 0;

    // Read-only tool call budgets (§ anti-scan guardrails)
    const READ_ONLY_PER_TURN_CAP = 6;
    const READ_BUDGET_WARN = 15;
    const READ_BUDGET_HARD = harness.quirks.readBudget ?? 20;
    let cumulativeReadOnlyCalls = 0;

    // Directory scan detection: track unique file paths per parent dir.
    // Only counts distinct files (re-reads of the same file after editing are normal).
    const readDirFiles = new Map<string, Set<string>>();
    const blockedDirs = new Set<string>();

    // Same-search detection: track search= params across read_file calls
    const searchTermFiles = new Map<string, Set<string>>(); // search term → set of file paths

    // identical tool call signature counts across this ask() run
    const sigCounts = new Map<string, number>();
    const toolNameByCallId = new Map<string, string>();

    // Loop-break helper state: bump mutationVersion whenever a tool mutates files.
    // We also record the mutationVersion at which a given signature was last seen.
    let mutationVersion = 0;
    const mutationVersionBySig = new Map<string, number>();

    // Consecutive-repeat tracking for read-only tools: only count identical calls
    // that happen back-to-back with no other tool calls in between.
    let lastTurnSigs = new Set<string>();
    const consecutiveCounts = new Map<string, number>();

    let malformedCount = 0;
    let noProgressTurns = 0;
    const NO_PROGRESS_TURN_CAP = 3;
    let noToolTurns = 0;
    const NO_TOOL_REPROMPT_THRESHOLD = 2;
    let repromptUsed = false;
    // Track blocked command loops by exact reason+command signature.
    const blockedExecAttemptsBySig = new Map<string, number>();
    // Keep a lightweight breadcrumb for diagnostics on partial failures.
    let lastSuccessfulTestRun: any = null;
    // One-time nudge to prevent post-success churn after green test runs.
    let finalizeAfterTestsNudgeUsed = false;

    const archiveToolOutputForVault = async (msg: ChatMessage) => {
      if (!lens || !vault || msg.role !== 'tool' || typeof msg.content !== 'string') return msg;
      const tool = msg.tool_call_id ? toolNameByCallId.get(msg.tool_call_id) : undefined;
      if (!tool) return msg;
      try {
        const compact = await lens.summarizeToolOutput(msg.content, tool);
        if (typeof compact === 'string' && compact.length && compact.length < msg.content.length) {
          return { ...msg, content: compact };
        }
      } catch {
        // ignore and store raw tool output
      }
      return msg;
    };

    const persistFailure = async (error: unknown, contextLine?: string) => {
      if (!vault) return;
      const reason = error instanceof Error ? error.message : String(error);
      // Strip absolute paths from failure messages to prevent cross-project leaks in vault.
      // Replace /home/.../project/file.ts with just file.ts (relative to cwd) or the basename.
      const sanitized = sanitizePathsInMessage(`agent abort: ${contextLine ?? ''} ${reason}`, cfg.dir ?? process.cwd());
      const compact = lens ? await lens.summarizeFailureMessage(sanitized) : sanitized;
      try {
        await vault.note('agent failure', compact);
      } catch {
        // best-effort only
      }
    };

    const emitSubAgentStatus = (taskId: number, status: 'queued' | 'running' | 'completed' | 'failed', detail?: string) => {
      if (!hookObj.onToken) return;
      const tail = detail ? ` — ${detail}` : '';
      hookObj.onToken(`\n[sub-agent #${taskId}] ${status}${tail}\n`);
    };

    const buildLspLensSymbolOutput = async (filePathRaw: string): Promise<string> => {
      if (!lspManager) return '[lsp] unavailable';

      const semantic = await lspManager.getSymbols(filePathRaw);
      if (!lens) return semantic;

      const cwd = cfg.dir ?? process.cwd();
      const absPath = filePathRaw.startsWith('/') ? filePathRaw : path.resolve(cwd, filePathRaw);
      const body = await fs.readFile(absPath, 'utf8').catch(() => '');
      if (!body) return semantic;

      const projection = await lens.projectFile(absPath, body).catch(() => '');
      const structural = extractLensBody(projection);
      if (!structural) return semantic;

      return `${semantic}\n\n[lens] Structural skeleton:\n${structural}`;
    };

    const runSpawnTask = async (args: any): Promise<string> => {
      if (delegationForbiddenByUser) {
        throw new Error('spawn_task: blocked — user explicitly asked for no delegation/sub-agents in this request. Continue directly in the current session.');
      }
      return await runSpawnTaskCore(args, {
        signal: hookObj.signal,
        emitStatus: emitSubAgentStatus,
      });
    };

    // tool-loop
    try {
      while (turns < maxIters) {
        // Immediate bail if cancelled (Ctrl+C)
        if (inFlight?.signal?.aborted) break;

        turns++;

        const wallElapsed = (Date.now() - wallStart) / 1000;
        if (wallElapsed > cfg.timeout) {
          throw new Error(`session timeout exceeded (${cfg.timeout}s) after ${wallElapsed.toFixed(1)}s`);
        }

        await maybeAutoDetectModelChange();

        const beforeMsgs = messages;
        const beforeTokens = estimateTokensFromMessages(beforeMsgs);
        const compacted = enforceContextBudget({
          messages: beforeMsgs,
          contextWindow,
          maxTokens: maxTokens,
          minTailMessages: 12,
          compactAt: cfg.compact_at ?? 0.8,
          toolSchemaTokens: estimateToolSchemaTokens(getToolsSchema()),
        });

        const compactedDropped = beforeMsgs.length > compacted.length || estimateTokensFromMessages(compacted) < beforeTokens;
        const compactedByRefs = new Set(compacted);
        const dropped = beforeMsgs.filter((m) => !compactedByRefs.has(m));

        if (dropped.length && vault) {
          try {
            const toArchive = lens
              ? await Promise.all(dropped.map((m) => archiveToolOutputForVault(m as ChatMessage)))
              : dropped;
            await vault.archiveToolMessages(toArchive as ChatMessage[], toolNameByCallId);
          } catch (e) {
            console.warn(`[warn] vault archive failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        messages = compacted;

        if (dropped.length) {
          messages.push({ role: 'system', content: `[auto-compacted: ${dropped.length} old messages dropped to stay within context budget. Do NOT re-read files or re-run commands you have already seen — use vault_search to recall prior results if needed.]` } as ChatMessage);
          await injectVaultContext().catch(() => {});
        }

        const ac = makeAbortController();
        inFlight = ac;

        // If caller provided an AbortSignal (bench iteration timeout, etc), propagate it.
        const callerSignal = hookObj.signal;
        const onCallerAbort = () => ac.abort();
        callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

        // Per-request timeout: the lesser of response_timeout (default 300s) or the remaining session wall time.
        // This prevents a single slow request from consuming the entire session budget.
        const perReqCap = cfg.response_timeout && cfg.response_timeout > 0 ? cfg.response_timeout : 300;
        const wallRemaining = Math.max(0, cfg.timeout - (Date.now() - wallStart) / 1000);
        const reqTimeout = Math.min(perReqCap, Math.max(10, wallRemaining));
        const timer = setTimeout(() => ac.abort(), reqTimeout * 1000);
        reqCounter++;

        const turnStartMs = Date.now();
        let ttftMs: number | undefined;

        const onFirstDelta = () => {
          if (ttftMs === undefined) {
            ttftMs = Date.now() - turnStartMs;
          }
          hookObj.onFirstDelta?.();
        };

        let resp;
        try {
          resp = await client.chatStream({
            model,
            messages,
            tools: getToolsSchema(),
            tool_choice: 'auto',
            temperature,
            top_p: topP,
            max_tokens: maxTokens,
            extra: { cache_prompt: cfg.cache_prompt ?? true },
            signal: ac.signal,
            requestId: `r${reqCounter}`,
            onToken: hookObj.onToken,
            onFirstDelta,
          });
        } finally {
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', onCallerAbort);
          inFlight = null;
        }

        const ttcMs = Date.now() - turnStartMs;
        const promptTokensTurn = resp.usage?.prompt_tokens ?? 0;
        const completionTokensTurn = resp.usage?.completion_tokens ?? 0;

        // Track server-reported usage when available
        if (resp.usage) {
          cumulativeUsage.prompt += promptTokensTurn;
          cumulativeUsage.completion += completionTokensTurn;
        }

        const ppTps = ttftMs && ttftMs > 0 && promptTokensTurn > 0
          ? promptTokensTurn / (ttftMs / 1000)
          : undefined;

        const genWindowMs = Math.max(1, ttcMs - (ttftMs ?? 0));
        const tgTps = completionTokensTurn > 0
          ? completionTokensTurn / (genWindowMs / 1000)
          : undefined;

        if (ttcMs > 0) turnDurationsMs.push(ttcMs);
        if (ttftMs != null && ttftMs > 0) ttftSamplesMs.push(ttftMs);
        if (ppTps != null && Number.isFinite(ppTps) && ppTps > 0) ppSamples.push(ppTps);
        if (tgTps != null && Number.isFinite(tgTps) && tgTps > 0) tgSamples.push(tgTps);

        const slowThreshold = cfg.slow_tg_tps_threshold ?? 10;
        if (tgTps != null && Number.isFinite(tgTps) && tgTps > 0 && tgTps < slowThreshold) {
          console.warn(`[perf] Generation slowed to ${tgTps.toFixed(1)} t/s - context may be too large`);
        }

        let healthSnapshot: ServerHealthSnapshot | undefined;
        if (cfg.show_server_metrics !== false) {
          const health = await refreshServerHealth();
          if (health) healthSnapshot = health;
        }

        lastTurnMetrics = {
          totalMs: ttcMs,
          ttftMs,
          promptTokens: promptTokensTurn,
          completionTokens: completionTokensTurn,
          ppTokensPerSec: ppTps,
          tgTokensPerSec: tgTps,
          health: healthSnapshot,
        };

        const legacyChoice = (resp as any)?.role
          ? {
              finish_reason: (resp as any)?.finish_reason ?? 'stop',
              message: {
                role: (resp as any)?.role ?? 'assistant',
                content: (resp as any)?.content ?? '',
                tool_calls: (resp as any)?.tool_calls,
              },
            }
          : undefined;
        const choice0 = resp.choices?.[0] ?? legacyChoice;
        const finishReason = choice0?.finish_reason ?? 'unknown';
        const msg = choice0?.message;
        const content = msg?.content ?? '';

        // Conditionally strip thinking blocks based on harness config (§4i).
        // Non-reasoning models (thinking.strip === false) never emit <think> blocks,
        // so stripping is a no-op — but we skip the regex work entirely.
        const st = harness.thinking.strip ? stripThinking(content) : { visible: content, thinking: '' };
        // Strip XML tool-call tag fragments that leak into visible narration
        // when llama-server partially parses Qwen/Hermes XML tool calls.
        const visible = st.visible
          .replace(/<\/?tool_call>/g, '')
          .replace(/<function=[\w.-]+>/g, '')
          .replace(/<\/function>/g, '')
          .replace(/<parameter=[\w.-]+>/g, '')
          .replace(/<\/parameter>/g, '')
          .trim();

        // Show thinking tokens in verbose mode (plan §10)
        if (cfg.verbose && st.thinking) {
          console.warn(`[thinking] ${st.thinking}`);
        }

        let toolCallsArr = msg?.tool_calls;

        // For models with unreliable tool_calls arrays, validate entries and
        // fall through to content parsing if they look malformed (§4i).
        if (toolCallsArr?.length && !harness.toolCalls.reliableToolCallsArray) {
          const hasValid = toolCallsArr.some(tc =>
            tc.function?.name && typeof tc.function.name === 'string' && tc.function.name.length > 0
          );
          if (!hasValid) {
            if (cfg.verbose) {
              console.warn(`[harness] tool_calls array present but no valid entries (reliableToolCallsArray=false), trying content fallback`);
            }
            toolCallsArr = undefined;
          }
        }

        if ((!toolCallsArr || !toolCallsArr.length) && content) {
          const fallback = parseToolCallsFromContent(content);
          if (fallback?.length) {
            toolCallsArr = fallback;
            if (cfg.verbose) {
              console.warn(`[harness] extracted ${fallback.length} tool call(s) from content (contentFallbackLikely=${harness.toolCalls.contentFallbackLikely})`);
            }
          }
        }

        // Strip markdown code fences from tool arguments if harness says model does this
        if (toolCallsArr?.length && harness.quirks.emitsMarkdownInToolArgs) {
          for (const tc of toolCallsArr) {
            if (tc.function?.arguments) {
              tc.function.arguments = stripMarkdownFences(tc.function.arguments);
            }
          }
        }

        if (cfg.verbose) {
          console.warn(
            `[turn ${turns}] finish_reason=${finishReason} content_chars=${content.length} visible_chars=${visible.length} tool_calls=${toolCallsArr?.length ?? 0}`
          );
        }

        const narration = (visible || content || '').trim();
        if ((!toolCallsArr || !toolCallsArr.length) && narration.length === 0) {
          noProgressTurns += 1;
          if (cfg.verbose) {
            console.warn(`[loop] no-progress turn ${noProgressTurns}/${NO_PROGRESS_TURN_CAP} (empty response)`);
          }
          if (noProgressTurns >= NO_PROGRESS_TURN_CAP) {
            throw new Error(
              `no progress for ${NO_PROGRESS_TURN_CAP} consecutive turns (empty responses with no tool calls). ` +
              `Likely malformed/empty model output loop; stopping early.`
            );
          }
          messages.push({
            role: 'user',
            content: '[system] Your previous response was empty (no text, no tool calls). Continue by either calling a tool with valid JSON arguments or giving a final answer.',
          });
          await hookObj.onTurnEnd?.({
            turn: turns,
            toolCalls,
            promptTokens: cumulativeUsage.prompt,
            completionTokens: cumulativeUsage.completion,
            promptTokensTurn,
            completionTokensTurn,
            ttftMs,
            ttcMs,
            ppTps,
            tgTps,
          });
          continue;
        }
        noProgressTurns = 0;

        if (toolCallsArr && toolCallsArr.length) {
          noToolTurns = 0;
          // Deduplicate ghost tool calls: if llama-server's XML parser splits one
          // tool call into two entries (one with full args, one empty/partial),
          // drop the empty one. Only removes entries where a richer version of the
          // same tool name exists with strictly more params. Preserves genuine
          // parallel calls (e.g. 13x list_dir with same args = intentional).
          if (toolCallsArr.length > 1) {
            const byName = new Map<string, { tc: ToolCall; argCount: number }[]>();
            for (const tc of toolCallsArr) {
              const n = tc.function?.name ?? '';
              let argCount = 0;
              try { argCount = Object.keys(JSON.parse(tc.function?.arguments ?? '{}')).length; } catch {}
              if (!byName.has(n)) byName.set(n, []);
              byName.get(n)!.push({ tc, argCount });
            }
            const deduped: ToolCall[] = [];
            for (const [, group] of byName) {
              if (group.length > 1) {
                const maxArgs = Math.max(...group.map(g => g.argCount));
                // Drop entries with strictly fewer args than the richest (ghost duplicates).
                // Keep ALL entries that have the max arg count (genuine parallel calls).
                for (const g of group) {
                  if (g.argCount >= maxArgs || maxArgs === 0) {
                    deduped.push(g.tc);
                  }
                }
              } else {
                deduped.push(group[0].tc);
              }
            }
            if (deduped.length < toolCallsArr.length) {
              if (cfg.verbose) console.warn(`[dedup] dropped ${toolCallsArr.length - deduped.length} ghost tool call(s)`);
            }
            toolCallsArr = deduped;
          }

          // Newline after model narration before tool execution, so the next
          // narration chunk starts on a fresh line (avoids wall-of-text output).
          if (visible && hookObj.onToken) hookObj.onToken('\n');

          toolCalls += toolCallsArr.length;
          messages.push({ role: 'assistant', content: visible || '', tool_calls: toolCallsArr });

          // sigCounts is scoped to the entire ask() run (see above)

          // Bridge ConfirmationProvider → legacy confirm callback for tools.
          // If a ConfirmationProvider is given, wrap it; otherwise fall back to raw callback.
          // The bridge accepts an optional context object for rich confirm data.
          const confirmBridge = opts.confirmProvider
            ? async (prompt: string, bridgeCtx?: { tool?: string; args?: Record<string, unknown>; diff?: string }) => opts.confirmProvider!.confirm({
                tool: bridgeCtx?.tool ?? '', args: bridgeCtx?.args ?? {}, summary: prompt,
                diff: bridgeCtx?.diff, mode: cfg.approval_mode,
              })
            : opts.confirm;

          const ctx = buildToolCtx({
            signal: ac.signal,
            confirmBridge,
            onMutation: (absPath: string) => {
              lastEditedPath = absPath;
              mutationVersion++;
            },
          });

          const isReadOnlyToolDynamic = (toolName: string) => {
            return isReadOnlyTool(toolName) || LSP_TOOL_NAME_SET.has(toolName) || Boolean(mcpManager?.isToolReadOnly(toolName));
          };

          const fileMutationsInTurn = toolCallsArr.filter((tc) => FILE_MUTATION_TOOL_SET.has(tc.function?.name)).length;
          if (fileMutationsInTurn >= 3 && isGitDirty(ctx.cwd)) {
            const shouldStash = confirmBridge
              ? await confirmBridge(
                  `Working tree is dirty and the agent plans ${fileMutationsInTurn} file edits. Stash current changes first? [Y/n]`,
                  { tool: 'git_stash', args: { fileMutationsInTurn } }
                )
              : false;
            if (shouldStash) {
              const stashed = stashWorkingTree(ctx.cwd);
              if (!stashed.ok) {
                console.warn(`[warn] auto-stash failed: ${stashed.message}`);
              }
            }
          }

          const resolveCallId = (tc: ToolCall) => tc.id || `call_${Date.now()}_${toolNameByCallId.size}`;

          // Pre-dispatch loop detection: check tool calls against previous turns.
          // We deduplicate within a single response (a model may emit multiple identical
          // read_file calls in one parallel batch — that's fine). We only count unique
          // signatures per LLM response, then check across responses.
          //
          // Important: repeated `exec {command:"npm test"}` can be normal during fix loops.
          // We only treat repeated exec as a loop if no file mutations happened since the
          // last time we saw that exact exec signature.
          const turnSigs = new Set<string>();
          for (const tc of toolCallsArr) {
            const sig = `${tc.function.name}:${tc.function.arguments ?? '{}'}`;
            turnSigs.add(sig);
          }

          // Track whether a mutation happened since a given signature was last seen.
          // (Tool-loop is single-threaded across turns; this is safe to keep in-memory.)

          for (const sig of turnSigs) {
            sigCounts.set(sig, (sigCounts.get(sig) ?? 0) + 1);
            const toolName = sig.split(':')[0];

            // For exec loops, only break if nothing changed since last identical exec.
            if (toolName === 'exec') {
              // If this exact exec signature was seen before, record the mutation version at that time.
              // (First time we see it, assume it's OK.)
              const seenAt = mutationVersionBySig.get(sig);
              const hasMutatedSince = seenAt === undefined ? true : mutationVersion !== seenAt;

              // Update to "now" for next turn.
              mutationVersionBySig.set(sig, mutationVersion);

              if (!hasMutatedSince) {
                const count = sigCounts.get(sig) ?? 0;
                const loopThreshold = harness.quirks.loopsOnToolError ? 3 : 6;
                // At 3x, inject vault context so the model gets the data it needs
                if (count >= 3 && count < loopThreshold) {
                  await injectVaultContext().catch(() => {});
                }
                if (count >= loopThreshold) {
                  const args = sig.slice(toolName.length + 1);
                  const argsPreview = args.length > 220 ? args.slice(0, 220) + '…' : args;
                  throw new Error(
                    `tool ${toolName}: identical call repeated ${loopThreshold}x across turns; breaking loop. ` +
                      `args=${argsPreview}`
                  );
                }
              }

              continue;
            }

            // Read-only tools: only count consecutive identical calls (back-to-back turns
            // with no other tool calls in between). A read → edit → read cycle is normal
            // and resets the counter. After 4 consecutive identical reads, inject a hint.
            if (isReadOnlyTool(toolName)) {
              // Check if this sig was also in the previous turn's set
              if (lastTurnSigs.has(sig)) {
                consecutiveCounts.set(sig, (consecutiveCounts.get(sig) ?? 1) + 1);
              } else {
                consecutiveCounts.set(sig, 1);
              }
              const consec = consecutiveCounts.get(sig) ?? 1;
              if (consec >= 3) {
                await injectVaultContext().catch(() => {});
              }
              // Hard-break: after 6 consecutive identical reads, stop the session
              if (consec >= 6) {
                throw new Error(
                  `tool ${toolName}: identical read repeated ${consec}x consecutively; breaking loop. ` +
                  `The resource content has not changed between reads.`
                );
              }
              continue;
            }

            // Default behavior for mutating/other tools: break on repeated identical signature.
            const loopThreshold = harness.quirks.loopsOnToolError ? 2 : 3;
            if ((sigCounts.get(sig) ?? 0) >= loopThreshold) {
              const args = sig.slice(toolName.length + 1);
              const argsPreview = args.length > 220 ? args.slice(0, 220) + '…' : args;
              throw new Error(
                `tool ${toolName}: identical call repeated ${loopThreshold}x across turns; breaking loop. ` +
                  `args=${argsPreview}\n` +
                  `Hint: you repeated the same tool call ${loopThreshold} times with identical arguments. ` +
                  `If the call succeeded, move on to the next step. ` +
                  `If it failed, check that all required parameters are present and correct. ` +
                  `For write_file/edit_file, ensure 'content'/'old_text'/'new_text' are included as strings.`
              );
            }
          }

          // Update consecutive tracking: save this turn's signatures for next turn comparison.
          lastTurnSigs = turnSigs;

          const runOne = async (tc: ToolCall) => {
            const name = tc.function.name;
            const rawArgs = tc.function.arguments ?? '{}';
            const callId = resolveCallId(tc);
            toolNameByCallId.set(callId, name);

            let args: any;
            try {
              args = rawArgs ? JSON.parse(rawArgs) : {};
            } catch {
              // Respect harness retry limit for malformed JSON (§4i)
              malformedCount++;
              if (malformedCount > harness.toolCalls.retryOnMalformed) {
                // Break the outer loop — this model won't self-correct
                throw new AgentLoopBreak(`tool ${name}: malformed JSON exceeded retry limit (${harness.toolCalls.retryOnMalformed}): ${rawArgs.slice(0, 200)}`);
              }
              throw new Error(`tool ${name}: arguments not valid JSON: ${rawArgs.slice(0, 200)}`);
            }

            const builtInFn = (tools as any)[name] as Function | undefined;
            const isLspTool = LSP_TOOL_NAME_SET.has(name);
            const isSpawnTask = name === 'spawn_task';
            const hasMcpTool = mcpManager?.hasTool(name) === true;
            if (!builtInFn && !isLspTool && !hasMcpTool && !isSpawnTask) throw new Error(`unknown tool: ${name}`);

            // Pre-dispatch check for missing required params.
            // Universal: catches omitted params early with a clear, instructive error
            // before the tool itself throws a less helpful message.
            if (builtInFn || isSpawnTask) {
              const missing = getMissingRequiredParams(name, args);
              if (missing.length) {
                throw new Error(`REQUIRED parameter(s) ${missing.map(p => `'${p}'`).join(', ')} missing. You MUST include ${missing.join(', ')} in every ${name} call.`);
              }
            }

            // ── Pre-dispatch safety screening (Phase 9) ──
            // Catches forbidden commands at the agent level before tool execution.
            // This enables showBlocked notifications and plan mode integration.
            if (name === 'exec' && typeof args.command === 'string') {
              const sv = checkExecSafety(args.command);
              if (sv.tier === 'forbidden') {
                const reason = sv.reason || 'forbidden command';
                opts.confirmProvider?.showBlocked?.({ tool: name, args, reason });
                throw new Error(`exec: ${reason} — command: ${args.command}`);
              }
            }
            if (FILE_MUTATION_TOOL_SET.has(name) && typeof args.path === 'string') {
              const absPath = args.path.startsWith('/') ? args.path : `${cfg.dir ?? process.cwd()}/${args.path}`;
              const pv = checkPathSafety(absPath);
              if (pv.tier === 'forbidden') {
                const reason = pv.reason || 'protected path';
                opts.confirmProvider?.showBlocked?.({ tool: name, args, reason });
                throw new Error(`${name}: ${reason}`);
              }
            }

            // ── Anti-scan: read_file guardrails (Fix 1/2/3) ──
            if (name === 'read_file' || name === 'read_files') {
              const filePath = typeof args.path === 'string' ? args.path : '';
              const searchTerm = typeof args.search === 'string' ? args.search : '';

              // Fix 1: Hard cumulative budget — refuse reads past hard cap
              if (cumulativeReadOnlyCalls > READ_BUDGET_HARD) {
                hookObj.onToolCall?.({ id: callId, name, args });
                hookObj.onToolResult?.({ id: callId, name, success: false, summary: 'read budget exhausted', result: '' });
                return { id: callId, content: `STOP: Read budget exhausted (${cumulativeReadOnlyCalls}/${READ_BUDGET_HARD} calls). Do NOT read more files. Use search_files or exec: grep -rn "pattern" path/ to find what you need.` };
              }

              // Fix 2: Directory scan detection — counts unique files per dir (re-reads are OK)
              if (filePath) {
                const absFilePath = filePath.startsWith('/') ? filePath : path.resolve(cfg.dir ?? process.cwd(), filePath);
                const parentDir = path.dirname(absFilePath);
                if (!readDirFiles.has(parentDir)) readDirFiles.set(parentDir, new Set());
                readDirFiles.get(parentDir)!.add(absFilePath);
                const uniqueCount = readDirFiles.get(parentDir)!.size;
                if (uniqueCount > 8 && !blockedDirs.has(parentDir)) {
                  blockedDirs.add(parentDir);
                }
                if (blockedDirs.has(parentDir) && uniqueCount > 8) {
                  hookObj.onToolCall?.({ id: callId, name, args });
                  hookObj.onToolResult?.({ id: callId, name, success: false, summary: 'dir scan blocked', result: '' });
                  return { id: callId, content: `STOP: Directory scan detected — you've read ${uniqueCount} unique files from ${parentDir}/. Use search_files(pattern, '${parentDir}') or exec: grep -rn "pattern" ${parentDir}/ instead of reading files individually.` };
                }
              }

              // Fix 3: Same-search-term detection
              if (searchTerm && filePath) {
                const key = searchTerm.toLowerCase();
                if (!searchTermFiles.has(key)) searchTermFiles.set(key, new Set());
                searchTermFiles.get(key)!.add(filePath);
                if (searchTermFiles.get(key)!.size >= 3) {
                  hookObj.onToolCall?.({ id: callId, name, args });
                  hookObj.onToolResult?.({ id: callId, name, success: false, summary: 'use search_files', result: '' });
                  return { id: callId, content: `STOP: You've searched ${searchTermFiles.get(key)!.size} files for "${searchTerm}" one at a time. This is what search_files does in one call. Use: search_files(pattern="${searchTerm}", path=".") or exec: grep -rn "${searchTerm}" .` };
                }
              }
            }

            // ── Plan mode blocking (Phase 8) ──
            // In plan mode, mutating tools return blocked stubs instead of executing.
            // Read-only tools still execute normally.
            if (cfg.approval_mode === 'plan' && !isReadOnlyToolDynamic(name)) {
              const summary = planModeSummary(name, args);
              const step: PlanStep = {
                index: planSteps.length + 1,
                tool: name,
                args,
                blocked: true,
                summary,
              };
              planSteps.push(step);

              const blockedMsg = `[blocked: approval_mode=plan] Would ${summary}`;

              // Notify via confirmProvider.showBlocked if available
              opts.confirmProvider?.showBlocked?.({ tool: name, args, reason: `plan mode: ${summary}` });

              // Hook: onToolCall + onToolResult for plan-blocked actions
              hookObj.onToolCall?.({ id: callId, name, args });
              hookObj.onToolResult?.({ id: callId, name, success: true, summary: `⏸ ${summary} (blocked)`, result: blockedMsg });

              return { id: callId, content: blockedMsg };
            }

            // Hook: onToolCall (Phase 8.5)
            hookObj.onToolCall?.({ id: callId, name, args });

            if (cfg.step_mode) {
              const stepPrompt = `Step mode: execute ${name}(${JSON.stringify(args).slice(0, 200)}) ? [Y/n]`;
              const ok = confirmBridge ? await confirmBridge(stepPrompt, { tool: name, args }) : true;
              if (!ok) {
                return { id: callId, content: '[skipped by user: step mode]' };
              }
            }

            let content = '';
            if (isSpawnTask) {
              content = await runSpawnTask(args);
            } else if (builtInFn) {
              const value = await builtInFn(ctx as any, args);
              content = typeof value === 'string' ? value : JSON.stringify(value);
              if (name === 'exec') {
                // Successful exec clears blocked-loop counters.
                blockedExecAttemptsBySig.clear();
                // Capture successful test runs for better partial-failure diagnostics.
                try {
                  const parsed = JSON.parse(content);
                  const cmd = String(args?.command ?? '');
                  const out = String(parsed?.out ?? '');
                  const rc = Number(parsed?.rc ?? NaN);
                  const looksLikeTest = /(^|\s)(node\s+--test|npm\s+test|pnpm\s+test|yarn\s+test|pytest|go\s+test|cargo\s+test|ctest)(\s|$)/i.test(cmd);
                  if (looksLikeTest && Number.isFinite(rc) && rc === 0) {
                    lastSuccessfulTestRun = {
                      command: cmd,
                      outputPreview: out.slice(0, 400),
                    };
                  }
                } catch {
                  // Ignore parse issues; non-JSON exec output is tolerated.
                }
              }
            } else if (isLspTool && lspManager) {
              // LSP tool dispatch
              if (name === 'lsp_diagnostics') {
                content = await lspManager.getDiagnostics(
                  typeof args.path === 'string' ? args.path : undefined,
                  typeof args.severity === 'number' ? args.severity : undefined,
                );
              } else if (name === 'lsp_symbols') {
                content = await buildLspLensSymbolOutput(String(args.path ?? ''));
              } else if (name === 'lsp_hover') {
                content = await lspManager.getHover(
                  String(args.path ?? ''),
                  Number(args.line ?? 0),
                  Number(args.character ?? 0),
                );
              } else if (name === 'lsp_definition') {
                content = await lspManager.getDefinition(
                  String(args.path ?? ''),
                  Number(args.line ?? 0),
                  Number(args.character ?? 0),
                );
              } else if (name === 'lsp_references') {
                content = await lspManager.getReferences(
                  String(args.path ?? ''),
                  Number(args.line ?? 0),
                  Number(args.character ?? 0),
                  typeof args.max_results === 'number' ? args.max_results : 50,
                );
              }
            } else {
              if (mcpManager == null) {
                throw new Error(`unknown tool: ${name}`);
              }

              const mcpReadOnly = isReadOnlyToolDynamic(name);
              if (!cfg.step_mode && !ctx.noConfirm && !mcpReadOnly) {
                const prompt = `Execute MCP tool '${name}'? [Y/n]`;
                const ok = confirmBridge ? await confirmBridge(prompt, { tool: name, args }) : true;
                if (!ok) {
                  return { id: callId, content: '[skipped by user: approval]' };
                }
              }

              const callArgs = args && typeof args === 'object' && !Array.isArray(args)
                ? args as Record<string, unknown>
                : {};
              content = await mcpManager.callTool(name, callArgs);
            }

            // Hook: onToolResult (Phase 8.5 + Phase 7 rich display)
            const summary = toolResultSummary(name, args, content, true);
            const resultEvent: ToolResultEvent = { id: callId, name, success: true, summary, result: content };

            // Phase 7: populate rich display fields
            if (name === 'exec') {
              try {
                const parsed = JSON.parse(content);
                if (parsed.out) resultEvent.execOutput = parsed.out;
              } catch {}
            } else if (name === 'search_files') {
              const lines = content.split('\n').filter(Boolean);
              if (lines.length > 0) resultEvent.searchMatches = lines.slice(0, 20);
            } else if (FILE_MUTATION_TOOL_SET.has(name) && replay) {
              // Grab the most recent checkpoint for a diff preview
              try {
                const cps = await replay.list(1);
                if (cps.length > 0) {
                  const got = await replay.get(cps[0].id);
                  const before = got.before.toString('utf8');
                  const after = (got.after ?? Buffer.from('')).toString('utf8');
                  if (before !== after) {
                    // Generate a minimal unified diff
                    resultEvent.diff = generateMinimalDiff(before, after, cps[0].filePath);
                  }
                }
              } catch {}
            }

            hookObj.onToolResult?.(resultEvent);

            // Proactive LSP diagnostics after file mutations
            if (lspManager?.hasServers() && lspCfg?.proactive_diagnostics !== false) {
              if (FILE_MUTATION_TOOL_SET.has(name)) {
                const mutatedPath = typeof args.path === 'string' ? args.path : '';
                if (mutatedPath) {
                  try {
                    const absPath = mutatedPath.startsWith('/') ? mutatedPath : path.join(cfg.dir ?? process.cwd(), mutatedPath);
                    const fileText = await fs.readFile(absPath, 'utf8');
                    await lspManager.ensureOpen(absPath, fileText);
                    await lspManager.notifyDidSave(absPath, fileText);
                    // Small delay so the server can process diagnostics
                    await new Promise((r) => setTimeout(r, 200));
                    const diags = await lspManager.getDiagnostics(absPath);
                    if (diags && !diags.startsWith('No diagnostics') && !diags.startsWith('[lsp] no language')) {
                      content += `\n\n[lsp] Diagnostics after edit:\n${diags}`;
                    }
                  } catch {
                    // Best-effort; never block the agent loop.
                  }
                }
              }
            }

            return { id: callId, content };
          };

          const results: Array<{ id: string; content: string }> = [];

          // Helper: catch tool errors but re-throw AgentLoopBreak (those must break the outer loop)
          const catchToolError = (e: any, tc: ToolCall) => {
            if (e instanceof AgentLoopBreak) throw e;
            const msg = e?.message ?? String(e);

            // Fast-fail repeated blocked command loops with accurate reason labeling.
            // Applies to direct exec attempts and spawn_task delegation attempts.
            if (tc.function.name === 'exec' || tc.function.name === 'spawn_task') {
              const blockedMatch = msg.match(/^exec:\s*blocked\s*\(([^)]+)\)\s*without --no-confirm\/--yolo:\s*(.*)$/i)
                || msg.match(/^(spawn_task):\s*blocked\s*—\s*(.*)$/i);
              if (blockedMatch) {
                const reason = (blockedMatch[1] || blockedMatch[2] || 'blocked command').trim();
                let parsedArgs: any = {};
                try { parsedArgs = JSON.parse(tc.function.arguments ?? '{}'); } catch {}
                const cmd = tc.function.name === 'exec'
                  ? String(parsedArgs?.command ?? '')
                  : String(parsedArgs?.task ?? '');
                const normalizedReason = reason.toLowerCase();
                const aggregateByReason = normalizedReason.includes('package install/remove');
                const sig = aggregateByReason
                  ? `${tc.function.name}|${reason}`
                  : `${tc.function.name}|${reason}|${cmd}`;
                const count = (blockedExecAttemptsBySig.get(sig) ?? 0) + 1;
                blockedExecAttemptsBySig.set(sig, count);
                if (count >= 2) {
                  throw new AgentLoopBreak(
                    `${tc.function.name}: repeated blocked command attempts (${reason}) in current approval mode. ` +
                    'Do not retry the same blocked command. Choose a safe alternative, skip cleanup, or ask the user to restart with --no-confirm/--yolo.'
                  );
                }
              }
            }

            // Hook: onToolResult for errors (Phase 8.5)
            const callId = resolveCallId(tc);
            hookObj.onToolResult?.({ id: callId, name: tc.function.name, success: false, summary: msg || 'unknown error', result: `ERROR: ${msg || 'unknown error'}` });
            // Never return undefined error text; it makes bench failures impossible to debug.
            return { id: callId, content: `ERROR: ${msg || 'unknown tool error'}` };
          };

          // ── Anti-scan guardrails (§ read budget, dir scan, same-search) ──
          const readOnlyInTurn = toolCallsArr.filter((tc) => isReadOnlyToolDynamic(tc.function.name));

          // Fix 5: Per-turn cap — drop excess read-only calls in a single response
          if (readOnlyInTurn.length > READ_ONLY_PER_TURN_CAP) {
            const kept = new Set(readOnlyInTurn.slice(0, READ_ONLY_PER_TURN_CAP).map((tc) => tc.id ?? tc.function.name));
            const droppedCount = readOnlyInTurn.length - READ_ONLY_PER_TURN_CAP;
            toolCallsArr = toolCallsArr.filter((tc) =>
              !isReadOnlyToolDynamic(tc.function.name) || kept.has(tc.id ?? tc.function.name)
            );
            for (const tc of readOnlyInTurn.slice(READ_ONLY_PER_TURN_CAP)) {
              const callId = resolveCallId(tc);
              results.push({
                id: callId,
                content: `STOP: Per-turn read limit (${READ_ONLY_PER_TURN_CAP}). Use search_files or exec with grep instead of reading files one by one.`
              });
            }
            if (cfg.verbose) {
              console.warn(`[guardrail] capped ${droppedCount} read-only tool calls (per-turn limit ${READ_ONLY_PER_TURN_CAP})`);
            }
          }

          // Fix 1: Hard cumulative read budget — escalating enforcement
          const readOnlyThisTurn = toolCallsArr.filter((tc) => isReadOnlyToolDynamic(tc.function.name));
          cumulativeReadOnlyCalls += readOnlyThisTurn.length;

          if (harness.toolCalls.parallelCalls) {
            // Models that support parallel calls: read-only in parallel, mutations sequential
            const readonly = toolCallsArr.filter((tc) => isReadOnlyToolDynamic(tc.function.name));
            const others = toolCallsArr.filter((tc) => !isReadOnlyToolDynamic(tc.function.name));

            const ro = await Promise.all(
              readonly.map((tc) =>
                runOne(tc)
                  .catch((e: any) => catchToolError(e, tc))
              )
            );
            results.push(...ro);

            for (const tc of others) {
              if (ac.signal.aborted) break;
              try {
                results.push(await runOne(tc));
              } catch (e: any) {
                results.push(catchToolError(e, tc));
              }
            }
          } else {
            // Models with parallelCalls=false: run ALL calls sequentially (§4i).
            // These models lose track of results when calls are batched in parallel.
            for (const tc of toolCallsArr) {
              if (ac.signal.aborted) break;
              try {
                results.push(await runOne(tc));
              } catch (e: any) {
                results.push(catchToolError(e, tc));
              }
            }
          }

          // Bail immediately if cancelled during tool execution
          if (ac.signal.aborted) break;

          for (const r of results) {
            messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
          }

          // If tests are green and we've already made edits, nudge for final summary
          // once to avoid extra non-essential demo/cleanup turns.
          if (!finalizeAfterTestsNudgeUsed && lastSuccessfulTestRun && mutationVersion > 0) {
            finalizeAfterTestsNudgeUsed = true;
            messages.push({
              role: 'user' as const,
              content:
                '[system] Tests passed successfully. If the requested work is complete, provide the final summary now and stop. ' +
                'Only continue with additional commands if the user explicitly requested extra demos/cleanup.',
            });
          }

          // ── Escalating cumulative read budget (§ anti-scan guardrails) ──
          // Warn zone: append warnings to each read result when approaching the hard cap
          if (cumulativeReadOnlyCalls > READ_BUDGET_WARN && cumulativeReadOnlyCalls <= READ_BUDGET_HARD) {
            const remaining = READ_BUDGET_HARD - cumulativeReadOnlyCalls;
            messages.push({
              role: 'user' as const,
              content: `[System] ⚠ Read budget: ${cumulativeReadOnlyCalls}/${READ_BUDGET_HARD}. ${remaining} reads remaining before hard stop. Use search_files or exec grep — do NOT continue reading files one at a time.`,
            });
          }

          // Hook: onTurnEnd (Phase 8.5)
          await hookObj.onTurnEnd?.({
            turn: turns,
            toolCalls,
            promptTokens: cumulativeUsage.prompt,
            completionTokens: cumulativeUsage.completion,
            promptTokensTurn,
            completionTokensTurn,
            ttftMs,
            ttcMs,
            ppTps,
            tgTps,
          });

          continue;
        }

        if (
          mcpManager &&
          !mcpToolsLoaded &&
          (visible || content || '').toUpperCase().includes(MCP_TOOLS_REQUEST_TOKEN.toUpperCase())
        ) {
          mcpToolsLoaded = true;
          messages.push({ role: 'assistant', content: visible || content || '' });
          messages.push({
            role: 'user',
            content: '[system] MCP tools are now enabled for this task. Continue and call tools as needed.'
          });
          continue;
        }

        const assistantText = visible || content || '';

        // Recovery fuse: if the model keeps narrating/planning without tool use,
        // nudge it once with the original task. Never resend more than once per ask().
        if (looksLikePlanningNarration(assistantText, finishReason)) {
          noToolTurns += 1;

          messages.push({ role: 'assistant', content: assistantText });

          if (noToolTurns >= NO_TOOL_REPROMPT_THRESHOLD) {
            if (!repromptUsed) {
              repromptUsed = true;
              noToolTurns = 0;
              const reminder = userContentToText(instruction).trim();
              const clippedReminder = reminder.length > 4000 ? `${reminder.slice(0, 4000)}\n[truncated]` : reminder;
              messages.push({
                role: 'user',
                content: `[system] You seem to be stuck narrating without using tools. Resume execution now.\n` +
                  `Original task:\n${clippedReminder}\n\n` +
                  `Call the needed tools directly. If everything is truly complete, provide the final answer.`
              });

              await hookObj.onTurnEnd?.({
                turn: turns,
                toolCalls,
                promptTokens: cumulativeUsage.prompt,
                completionTokens: cumulativeUsage.completion,
                promptTokensTurn,
                completionTokensTurn,
                ttftMs,
                ttcMs,
                ppTps,
                tgTps,
              });
              continue;
            }

            throw new Error(
              `no-tool loop detected: model produced planning/narration without tool calls for ${NO_TOOL_REPROMPT_THRESHOLD} turns even after one recovery reprompt`
            );
          }

          messages.push({
            role: 'user',
            content: '[system] Continue executing the task. Use tools now (do not just narrate plans). If complete, give the final answer.'
          });

          await hookObj.onTurnEnd?.({
            turn: turns,
            toolCalls,
            promptTokens: cumulativeUsage.prompt,
            completionTokens: cumulativeUsage.completion,
            promptTokensTurn,
            completionTokensTurn,
            ttftMs,
            ttcMs,
            ppTps,
            tgTps,
          });
          continue;
        }

        noToolTurns = 0;

        // final assistant message
        messages.push({ role: 'assistant', content: assistantText });
        await hookObj.onTurnEnd?.({
          turn: turns,
          toolCalls,
          promptTokens: cumulativeUsage.prompt,
          completionTokens: cumulativeUsage.completion,
          promptTokensTurn,
          completionTokensTurn,
          ttftMs,
          ttcMs,
          ppTps,
          tgTps,
        });
        return { text: assistantText, turns, toolCalls };
      }

      const reason = `max iterations exceeded (${maxIters})`;
      const diag = lastSuccessfulTestRun
        ? ` Last successful test run: ${lastSuccessfulTestRun.command}`
        : '';
      throw new Error(reason + diag);
    } catch (e: unknown) {
      // Some code paths (or upstream libs) may incorrectly throw `undefined`.
      // Convert it to a real Error so benches can be stable and debuggable.
      if (e === undefined) {
        const lastMsg = messages[messages.length - 1];
        const lastMsgPreview = (() => {
          try {
            const c = (lastMsg as any)?.content;
            if (typeof c === 'string') return c.slice(0, 200);
            return JSON.stringify(c).slice(0, 200);
          } catch {
            return '';
          }
        })();
        const err = new Error(`BUG: threw undefined in agent.ask() (turn=${turns}). lastMsg=${lastMsg?.role ?? 'unknown'}:${lastMsgPreview}`);
        await persistFailure(err, `ask turn ${turns}`);
        throw err;
      }

      await persistFailure(e, `ask turn ${turns}`);
      const lastTestCmd = lastSuccessfulTestRun?.command;
      if (e instanceof AgentLoopBreak && lastTestCmd) {
        (e as Error).message += `\n[diagnostic] last successful test run: ${lastTestCmd}`;
      }
      // Never rethrow undefined; normalize to Error for debuggability.
      if (e === undefined) {
        throw new Error('BUG: threw undefined (normalized at ask() boundary)');
      }
      throw e;
    }

  };

  // expose via getters so setModel() / reset() don't break references
  return {
    get model() { return model; },
    get harness() { return harness.id; },
    get endpoint() { return cfg.endpoint; },
    get contextWindow() { return contextWindow; },
    get supportsVision() { return supportsVision; },
    get messages() {
      return messages;
    },
    get usage() {
      return { ...cumulativeUsage };
    },
    ask,
    setModel,
    setEndpoint,
    listModels,
    refreshServerHealth,
    getPerfSummary,
    captureOn,
    captureOff,
    captureLast,
    get capturePath() {
      return capturePath;
    },
    getSystemPrompt: () => activeSystemPrompt,
    setSystemPrompt,
    resetSystemPrompt,
    listMcpServers,
    listMcpTools,
    restartMcpServer,
    enableMcpTool,
    disableMcpTool,
    mcpWarnings,
    listLspServers,
    setVerbose,
    close,
    reset,
    cancel,
    restore,
    replay,
    vault,
    lens,
    get lastEditedPath() {
      return lastEditedPath;
    },
    get lastTurnMetrics() {
      return lastTurnMetrics;
    },
    get lastServerHealth() {
      return lastServerHealth;
    },
    get planSteps() {
      return planSteps;
    },
    executePlanStep,
    clearPlan,
    compactHistory
  };
}

export async function runAgent(opts: {
  config: IdlehandsConfig;
  instruction: string;
  apiKey?: string;
  onToken?: (t: string) => void;
  confirm?: (prompt: string) => Promise<boolean>;
  confirmProvider?: ConfirmationProvider;
  runtime?: AgentRuntime;
}): Promise<AgentResult> {
  const session = await createSession({
    config: opts.config,
    apiKey: opts.apiKey,
    confirm: opts.confirm,
    confirmProvider: opts.confirmProvider,
    runtime: opts.runtime
  });
  return session.ask(opts.instruction, opts.onToken);
}

async function autoPickModel(client: OpenAIClient, cached?: { data: Array<{ id: string }> }): Promise<string> {
  const ac = makeAbortController();
  const timer = setTimeout(() => ac.abort(), 3000);
  try {
    const models = cached ?? normalizeModelsResponse(await client.models(ac.signal));
    const q = models.data.find((m) => /qwen/i.test(m.id));
    if (q) return q.id;
    const first = models.data[0]?.id;
    if (!first) throw new Error('No models found on server. Check your endpoint and that a model is loaded.');
    return first;
  } finally {
    clearTimeout(timer);
  }
}



function parseFunctionTagToolCalls(content: string): ToolCall[] | null {
  const m = content.match(/<function=([\w.-]+)>([\s\S]*?)<\/function>/i);
  if (!m) return null;

  const name = m[1];
  const body = (m[2] ?? '').trim();

  // If body contains JSON object, use it as arguments; else empty object.
  let args = '{}';
  const jsonStart = body.indexOf('{');
  const jsonEnd = body.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    const sub = body.slice(jsonStart, jsonEnd + 1);
    try {
      JSON.parse(sub);
      args = sub;
    } catch {
      // keep {}
    }
  }

  return [{
    id: 'call_0',
    type: 'function',
    function: { name, arguments: args }
  }];
}
