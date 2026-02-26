import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { TrifectaMode } from './types.js';
import { configDir } from './utils.js';

export type HarnessThinking = {
  /** Format of thinking blocks: 'xml' for <think>...</think>, 'none' for non-reasoning models */
  format: 'xml' | 'none';
  /** Opening tag (e.g. '<think>') */
  openTag?: string;
  /** Closing tag (e.g. '</think>') */
  closeTag?: string;
  /** Strip thinking blocks from history to save tokens */
  strip: boolean;
};

export type HarnessToolCalls = {
  /** Model reliably uses the tool_calls array mechanism */
  reliableToolCallsArray: boolean;
  /** Model likely emits tool calls as JSON in content instead of tool_calls */
  contentFallbackLikely: boolean;
  /** Model can emit multiple tool calls in one response */
  parallelCalls: boolean;
  /** Number of retries on malformed tool-call JSON before breaking */
  retryOnMalformed: number;
};

export type HarnessQuirks = {
  /** Model frequently omits required parameters in tool calls */
  omitsRequiredParams: boolean;
  /** Model enters infinite loops when it gets a tool error response */
  loopsOnToolError: boolean;
  /** Model wraps tool arguments in markdown code fences */
  emitsMarkdownInToolArgs: boolean;
  /** Model needs explicit reminder to use tool_calls, not JSON in content */
  needsExplicitToolCallFormatReminder: boolean;
  /** Override max_iterations (lower for models that make bad decisions) */
  maxIterationsOverride?: number;
  /** Hard cap on cumulative read-only tool calls per ask() (default 20) */
  readBudget?: number;
};

export type Harness = {
  id: string;
  match: Array<string | RegExp>;
  description: string;
  /** Explicit vision capability hint for this model family. */
  supportsVision?: boolean;
  defaults?: {
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    trifecta?: {
      vaultMode?: TrifectaMode;
    };
  };
  thinking: HarnessThinking;
  toolCalls: HarnessToolCalls;
  quirks: HarnessQuirks;
  /** Extra text appended to the first user message (not system prompt — §9b KV cache rule) */
  systemPromptSuffix?: string;
};

/** Default behavioral configs used to fill gaps in user-defined harnesses and inline definitions */
const DEFAULT_THINKING: HarnessThinking = {
  format: 'xml',
  openTag: '<think>',
  closeTag: '</think>',
  strip: true,
};
const DEFAULT_TOOL_CALLS: HarnessToolCalls = {
  reliableToolCallsArray: false,
  contentFallbackLikely: true,
  parallelCalls: true,
  retryOnMalformed: 3,
};
const DEFAULT_QUIRKS: HarnessQuirks = {
  omitsRequiredParams: false,
  loopsOnToolError: false,
  emitsMarkdownInToolArgs: false,
  needsExplicitToolCallFormatReminder: false,
};
const QUIRKS_NEEDS_REMINDER: HarnessQuirks = {
  ...DEFAULT_QUIRKS,
  needsExplicitToolCallFormatReminder: true,
};

const HARNESS: Harness[] = [
  {
    id: 'qwen3-coder',
    match: [/qwen3-coder/i],
    description: 'Qwen3-Coder family (tool-native MoE)',
    defaults: {
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 32768,
      frequency_penalty: 0.1,
      presence_penalty: 0.1,
      trifecta: { vaultMode: 'active' },
    },
    thinking: { format: 'xml', openTag: '<think>', closeTag: '</think>', strip: true },
    toolCalls: {
      reliableToolCallsArray: false,
      contentFallbackLikely: true,
      parallelCalls: true,
      retryOnMalformed: 3,
    },
    quirks: { ...DEFAULT_QUIRKS, readBudget: 20 },
    systemPromptSuffix:
      'Prefer apply_patch or edit_range for most edits. Use write_file for full rewrites, and use edit_file only for exact old_text replacement when necessary.\nWhen answering questions about code, search first (search_files or grep), then read only the relevant files. Never scan an entire directory by reading files one by one.\nEmit multiple tool calls in a single response when possible (e.g., read 3 files together with read_files, not one read_file at a time).\nNever use sed/awk via exec to read file sections. Use read_file with offset/limit instead.\nPrefer search_files over exec grep — it is faster and produces structured results.\nAfter a test passes, stop and report the result. Do not re-run the same test without making code changes first.\nWhen searching for a string, start at the broadest reasonable scope (project root or relevant subtree). Do not search a single file first and then widen — search broadly once.\nAfter reading a file, remember its contents. Do not re-read the same file unless you have edited it since the last read.',
  },
  {
    id: 'qwen3-moe',
    match: [/qwen3/i],
    description: 'Qwen3 MoE family (non-coder variants)',
    defaults: {
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 16384,
      trifecta: { vaultMode: 'passive' },
    },
    thinking: { format: 'xml', openTag: '<think>', closeTag: '</think>', strip: true },
    toolCalls: {
      reliableToolCallsArray: true,
      contentFallbackLikely: true,
      parallelCalls: true,
      retryOnMalformed: 2,
    },
    quirks: QUIRKS_NEEDS_REMINDER,
    systemPromptSuffix:
      'When answering questions about code, search first (search_files or grep), then read only the relevant files. Never scan an entire directory by reading files one by one.',
  },
  {
    id: 'qwen',
    match: [/qwen/i],
    description: 'Qwen family (generic, includes Qwen2.5)',
    defaults: {
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 16384,
      trifecta: { vaultMode: 'passive' },
    },
    thinking: { format: 'none', strip: false },
    toolCalls: {
      reliableToolCallsArray: true,
      contentFallbackLikely: true,
      parallelCalls: true,
      retryOnMalformed: 2,
    },
    quirks: QUIRKS_NEEDS_REMINDER,
  },
  {
    id: 'nemotron',
    match: [/nemotron/i],
    description: 'Nemotron family — loops on errors, omits params, low agent quality',
    defaults: {
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 16384,
      trifecta: { vaultMode: 'passive' },
    },
    thinking: { format: 'none', strip: false },
    toolCalls: {
      reliableToolCallsArray: false,
      contentFallbackLikely: true,
      parallelCalls: false,
      retryOnMalformed: 1,
    },
    quirks: {
      ...QUIRKS_NEEDS_REMINDER,
      omitsRequiredParams: true,
      loopsOnToolError: true,
      maxIterationsOverride: 10,
    },
  },
  {
    id: 'mistral',
    match: [/mistral/i],
    description: 'Mistral family — no thinking tokens, may need chat-template-file',
    defaults: {
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 16384,
      trifecta: { vaultMode: 'passive' },
    },
    thinking: { format: 'none', strip: false },
    toolCalls: {
      reliableToolCallsArray: true,
      contentFallbackLikely: false,
      parallelCalls: true,
      retryOnMalformed: 2,
    },
    quirks: DEFAULT_QUIRKS,
  },
  {
    id: 'gpt-oss',
    match: [/gpt-oss/i, /gpt_oss/i],
    description: 'GPT-OSS — correct tool format but bad decisions, scans everything',
    defaults: {
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 16384,
      trifecta: { vaultMode: 'passive' },
    },
    thinking: { format: 'none', strip: false },
    toolCalls: {
      reliableToolCallsArray: true,
      contentFallbackLikely: false,
      parallelCalls: true,
      retryOnMalformed: 2,
    },
    quirks: { ...DEFAULT_QUIRKS, maxIterationsOverride: 10 },
    systemPromptSuffix:
      'When answering questions about code, search first (search_files or grep), then read only the relevant files. Never scan an entire directory by reading files one by one.',
  },
  {
    id: 'llama',
    match: [/llama/i],
    description: 'Llama family (llama.cpp style)',
    defaults: {
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 16384,
      trifecta: { vaultMode: 'passive' },
    },
    thinking: { format: 'none', strip: false },
    toolCalls: {
      reliableToolCallsArray: false,
      contentFallbackLikely: true,
      parallelCalls: false,
      retryOnMalformed: 2,
    },
    quirks: QUIRKS_NEEDS_REMINDER,
    systemPromptSuffix:
      'When answering questions about code, search first (search_files or grep), then read only the relevant files. Never scan an entire directory by reading files one by one.',
  },
  {
    id: 'generic',
    match: [/.*/],
    description: 'Generic fallback harness — conservative, all fallbacks enabled',
    defaults: {
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: 16384,
      trifecta: { vaultMode: 'passive' },
    },
    thinking: { format: 'xml', openTag: '<think>', closeTag: '</think>', strip: true },
    toolCalls: {
      reliableToolCallsArray: false,
      contentFallbackLikely: true,
      parallelCalls: true,
      retryOnMalformed: 3,
    },
    quirks: DEFAULT_QUIRKS,
    systemPromptSuffix:
      'When answering questions about code, search first (search_files or grep), then read only the relevant files. Never scan an entire directory by reading files one by one.',
  },
];

/**
 * Load user-defined harnesses from ~/.config/idlehands/harnesses/*.json
 * User harnesses with the same `id` override built-ins.
 * Match patterns are converted from strings to RegExps (case-insensitive).
 */
function loadUserHarnesses(): Harness[] {
  const dir = join(configDir(), 'harnesses');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const result: Harness[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!raw.id || !raw.match) continue;

      const harness: Harness = {
        id: String(raw.id),
        match: (Array.isArray(raw.match) ? raw.match : [raw.match]).map(
          (m: unknown) => new RegExp(String(m), 'i')
        ),
        description: String(raw.description ?? `User harness: ${raw.id}`),
        supportsVision: typeof raw.supportsVision === 'boolean' ? raw.supportsVision : undefined,
        defaults: {
          temperature: raw.params?.temperature ?? raw.defaults?.temperature,
          top_p: raw.params?.top_p ?? raw.defaults?.top_p,
          max_tokens: raw.params?.max_tokens ?? raw.defaults?.max_tokens,
          trifecta: raw.defaults?.trifecta,
        },
        thinking: { ...DEFAULT_THINKING, ...(raw.thinking ?? {}) },
        toolCalls: { ...DEFAULT_TOOL_CALLS, ...(raw.toolCalls ?? {}) },
        quirks: { ...DEFAULT_QUIRKS, ...(raw.quirks ?? {}) },
        systemPromptSuffix: raw.systemPromptSuffix,
      };
      result.push(harness);
    } catch (e) {
      console.warn(
        `[warn] failed to load harness ${f}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  return result;
}

let _mergedHarnesses: Harness[] | null = null;

/** Get the merged harness list (built-in + user overrides). Cached after first call. */
function getMergedHarnesses(): Harness[] {
  if (_mergedHarnesses) return _mergedHarnesses;

  const user = loadUserHarnesses();
  if (!user.length) {
    _mergedHarnesses = HARNESS;
    return HARNESS;
  }

  // User harnesses override built-ins by id, then remaining built-ins follow
  const userIds = new Set(user.map((h) => h.id));
  const merged = [...user, ...HARNESS.filter((h) => !userIds.has(h.id))];
  _mergedHarnesses = merged;
  return merged;
}

/** Reset the cached harness list (for testing) */
export function _resetHarnessCache(): void {
  _mergedHarnesses = null;
}

export function selectHarness(modelId: string, overrideId?: string): Harness {
  const harnesses = getMergedHarnesses();
  if (overrideId) {
    const h = harnesses.find((x) => x.id === overrideId);
    if (h) return h;
  }
  for (const h of harnesses) {
    for (const m of h.match) {
      if (typeof m === 'string' && modelId.includes(m)) return h;
      if (m instanceof RegExp && m.test(modelId)) return h;
    }
  }
  return harnesses[harnesses.length - 1];
}
