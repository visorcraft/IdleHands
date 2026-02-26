import { SYS_CONTEXT_SCHEMA } from '../sys/context.js';
import type { ToolSchema } from '../types.js';
import { isLspTool, isMutationTool, isReadOnlyTool } from './tool-policy.js';

const obj = (properties: Record<string, any>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const str = () => ({ type: 'string' });
const bool = () => ({ type: 'boolean' });
const int = (min?: number, max?: number) => ({
  type: 'integer',
  ...(min !== undefined && { minimum: min }),
  ...(max !== undefined && { maximum: max }),
});

const SCHEMA_CACHE = new Map<string, ToolSchema[]>();

/**
 * Tools that are read-only / lightweight — kept in the fast-lane slim schema.
 * Everything else (write, edit, patch, insert, undo, spawn) is omitted.
 */
const FAST_LANE_TOOLS = new Set([
  'read_file', 'read_files', 'list_dir', 'search_files', 'exec',
  'vault_search',
]);

function cacheKey(opts?: {
  activeVaultTools?: boolean;
  passiveVault?: boolean;
  sysMode?: boolean;
  lspTools?: boolean;
  allowSpawnTask?: boolean;
  slimFast?: boolean;
  maxReadLines?: number;
}): string {
  return [
    opts?.activeVaultTools ? 'a1' : 'a0',
    opts?.passiveVault ? 'p1' : 'p0',
    opts?.sysMode ? 's1' : 's0',
    opts?.lspTools ? 'l1' : 'l0',
    opts?.allowSpawnTask === false ? 'sp0' : 'sp1',
    opts?.slimFast ? 'sf1' : 'sf0',
    `rl${opts?.maxReadLines ?? 240}`,
  ].join('|');
}

export function buildToolsSchema(opts?: {
  activeVaultTools?: boolean;
  passiveVault?: boolean;
  sysMode?: boolean;
  mcpTools?: ToolSchema[];
  lspTools?: boolean;
  allowSpawnTask?: boolean;
  /** When true, only include read-only/lightweight tools for fast-lane turns. */
  slimFast?: boolean;
  /** Maximum lines the model can request via read_file limit parameter. Default: 240. */
  maxReadLines?: number;
}): ToolSchema[] {
  const readLineMax = opts?.maxReadLines ?? 240;
  const key = cacheKey(opts);
  const canUseCache = !opts?.mcpTools?.length;
  if (canUseCache) {
    const cached = SCHEMA_CACHE.get(key);
    if (cached) return cached;
  }

  const schemas: ToolSchema[] = [
    // ────────────────────────────────────────────────────────────────────────────
    // Token-safe reads (require limit; allow plain output without per-line numbers)
    // ────────────────────────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          'Read a bounded slice of a file. Never repeat an identical call consecutively; reuse the prior result.',
        parameters: obj(
          {
            path: str(),
            offset: int(1, 1_000_000),
            limit: int(1, readLineMax),
            search: str(),
            context: int(0, 80),
            format: { type: 'string', enum: ['plain', 'numbered', 'sparse'] },
            max_bytes: int(256, 20_000),
          },
          ['path', 'limit']
        ),
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_files',
        description:
          'Batch read bounded file slices. Never repeat an identical call consecutively; reuse the prior result.',
        parameters: obj(
          {
            requests: {
              type: 'array',
              items: obj(
                {
                  path: str(),
                  offset: int(1, 1_000_000),
                  limit: int(1, readLineMax),
                  search: str(),
                  context: int(0, 80),
                  format: { type: 'string', enum: ['plain', 'numbered', 'sparse'] },
                  max_bytes: int(256, 20_000),
                },
                ['path', 'limit']
              ),
            },
          },
          ['requests']
        ),
      },
    },

    // ────────────────────────────────────────────────────────────────────────────
    // Writes/edits
    // ────────────────────────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'write_file',
        description:
          'Write file (atomic, backup). Prefer edit_range/apply_patch for edits to existing files; use write_file mainly for new files or intentional full rewrites. Existing non-empty files require overwrite=true (or force=true). Set normalize_escaped_newlines=true to convert literal "\\n" sequences in content into real newlines when needed.',
        parameters: obj(
          {
            path: str(),
            content: str(),
            overwrite: bool(),
            force: bool(),
            normalize_escaped_newlines: bool(),
          },
          ['path', 'content']
        ),
      },
    },
    {
      type: 'function',
      function: {
        name: 'apply_patch',
        description:
          'Apply unified diff patch (multi-file).\n\nUSAGE EXAMPLE:\n  apply_patch({\n    patch: "--- a/src/file.ts\\n+++ b/src/file.ts\\n@@ -1,5 +1,5 @@\\n-old text\\n+new text\\n",\n    files: ["src/file.ts"]\n  })\n\nThe patch must be valid unified diff text. Tool-call arguments must be valid JSON. Use strip=1 if paths include directory prefixes.\nFiles listed must match the paths in the diff.',
        parameters: obj(
          {
            patch: str(),
            files: { type: 'array', items: str() },
            strip: int(0, 5),
          },
          ['patch', 'files']
        ),
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_range',
        description:
          'Replace a line range in a file.\n\nUSAGE EXAMPLE:\n  edit_range({\n    path: "src/file.ts",\n    start_line: 10,\n    end_line: 15,\n    replacement: "new content\\nmore content"\n  })\n\n- start_line and end_line are 1-indexed (first line is 1, not 0)\n- To delete lines, set replacement to empty string ""\n- To insert at a position, set start_line and end_line to the same value\n- Tool-call arguments must be valid JSON (double quotes, no trailing commas/comments)\n- The replacement text replaces the entire range inclusive',
        parameters: obj(
          {
            path: str(),
            start_line: int(1),
            end_line: int(1),
            replacement: str(),
          },
          ['path', 'start_line', 'end_line', 'replacement']
        ),
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description:
          'Legacy exact replace (requires old_text). Prefer apply_patch/edit_range. Set normalize_escaped_newlines=true to normalize escaped line-break sequences in old_text/new_text before matching/replacing.',
        parameters: obj(
          {
            path: str(),
            old_text: str(),
            new_text: str(),
            replace_all: bool(),
            normalize_escaped_newlines: bool(),
          },
          ['path', 'old_text', 'new_text']
        ),
      },
    },
    {
      type: 'function',
      function: {
        name: 'insert_file',
        description:
          'Insert text at line (0=prepend, -1=append). Escaped newline sequences in text are normalized by default; set normalize_escaped_newlines=false to preserve literal backslash sequences.',
        parameters: obj(
          { path: str(), line: int(), text: str(), normalize_escaped_newlines: bool() },
          ['path', 'line', 'text']
        ),
      },
    },

    // ────────────────────────────────────────────────────────────────────────────
    // Bounded listings/search (expose existing caps)
    // ────────────────────────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description:
          'List directory entries. Never repeat an identical call consecutively for the same path/options; reuse the prior result.',
        parameters: obj({ path: str(), recursive: bool(), max_entries: int(1, 500) }, ['path']),
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Search regex in files.',
        parameters: obj({ pattern: str(), path: str(), include: str(), max_results: int(1, 100) }, [
          'pattern',
          'path',
        ]),
      },
    },

    // ────────────────────────────────────────────────────────────────────────────
    // Exec (minified schema)
    // ────────────────────────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'exec',
        description: 'Run bash -c; returns JSON rc/out/err.',
        parameters: obj({ command: str(), cwd: str(), timeout: int(1, 120) }, ['command']),
      },
    },
  ];

  if (opts?.allowSpawnTask !== false) {
    schemas.push({
      type: 'function',
      function: {
        name: 'spawn_task',
        description: 'Run a sub-agent task (no parent history).',
        parameters: obj(
          {
            task: str(),
            context_files: { type: 'array', items: str() },
            model: str(),
            endpoint: str(),
            max_iterations: int(),
            max_tokens: int(),
            timeout_sec: int(),
            system_prompt: str(),
            approval_mode: {
              type: 'string',
              enum: ['plan', 'reject', 'default', 'auto-edit', 'yolo'],
            },
          },
          ['task']
        ),
      },
    });
  }

  if (opts?.activeVaultTools) {
    schemas.push(
      {
        type: 'function',
        function: {
          name: 'vault_search',
          description: 'Search vault.',
          parameters: obj({ query: str(), limit: int() }, ['query']),
        },
      },
      {
        type: 'function',
        function: {
          name: 'vault_note',
          description: 'Write vault note.',
          parameters: obj({ key: str(), value: str() }, ['key', 'value']),
        },
      }
    );
  } else if (opts?.passiveVault) {
    // In passive mode, expose vault_search (read-only) so the model can recover
    // compacted context on demand, but don't expose vault_note (write).
    schemas.push({
      type: 'function',
      function: {
        name: 'vault_search',
        description:
          'Search vault memory for earlier context that was compacted away. Use sparingly — only when you need to recall specific details from earlier in the conversation.',
        parameters: obj({ query: str(), limit: int() }, ['query']),
      },
    });
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
          description: 'Get LSP diagnostics (errors/warnings) for file or project.',
          parameters: obj({ path: str(), severity: int() }, []),
        },
      },
      {
        type: 'function',
        function: {
          name: 'lsp_symbols',
          description: 'List symbols (functions, classes, vars) in a file.',
          parameters: obj({ path: str() }, ['path']),
        },
      },
      {
        type: 'function',
        function: {
          name: 'lsp_hover',
          description: 'Get type/docs for symbol at position.',
          parameters: obj({ path: str(), line: int(), character: int() }, [
            'path',
            'line',
            'character',
          ]),
        },
      },
      {
        type: 'function',
        function: {
          name: 'lsp_definition',
          description: 'Go to definition of symbol at position.',
          parameters: obj({ path: str(), line: int(), character: int() }, [
            'path',
            'line',
            'character',
          ]),
        },
      },
      {
        type: 'function',
        function: {
          name: 'lsp_references',
          description: 'Find all references to symbol at position.',
          parameters: obj({ path: str(), line: int(), character: int(), max_results: int() }, [
            'path',
            'line',
            'character',
          ]),
        },
      }
    );
  }

  if (opts?.mcpTools?.length) {
    schemas.push(...opts.mcpTools);
  }

  // Fast-lane slim: keep only read-only / lightweight tools to reduce token overhead.
  const final = opts?.slimFast
    ? schemas.filter((t) => FAST_LANE_TOOLS.has(t.function.name))
    : schemas;

  if (canUseCache) {
    SCHEMA_CACHE.set(key, final);
  }
  return final;
}

/**
 * Optional context used to append short, high-signal hints to tool descriptions.
 */
export type ToolSchemaContext = {
  /** Most recent tool action. */
  lastTool?: string;
  /** Recent tool names (ordered oldest -> newest). */
  recentTools?: string[];
  /** Recent file-like paths referenced by tools (ordered oldest -> newest). */
  recentPaths?: string[];
};

function dedupeKeepTail(values: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = values.length - 1; i >= 0; i--) {
    const v = (values[i] ?? '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out.reverse();
}

function shortenPath(value: string): string {
  const v = value.trim();
  if (!v) return v;
  if (v.length <= 38) return v;
  const tail = v.slice(-35);
  return `…${tail}`;
}

function contextHints(name: string, ctx: ToolSchemaContext): string[] {
  const lastTool = ctx.lastTool;
  const recentTools = dedupeKeepTail(ctx.recentTools ?? [], 8);
  const rawRecentPaths = dedupeKeepTail(ctx.recentPaths ?? [], 4);
  const recentPaths = rawRecentPaths.map(shortenPath);

  const hints: string[] = [];

  // Focus continuity: if we just read, encourage minimal edits next.
  if (name === 'read_file' || name === 'read_files' || name === 'list_dir') {
    if (isMutationTool(lastTool ?? '')) {
      hints.push('You recently edited files; read the target file to refresh current content first.');
    }
    if (recentPaths.length > 0) {
      hints.push(`Recent targets: ${recentPaths.join(', ')}`);
    }
    if (isMutationTool(name)) {
      // no-op
    }
  } else if (name === 'search_files') {
    if (recentPaths.length > 0) {
      hints.push(`Prefer ${recentPaths[0]} style scope before broad scans.`);
    }
  } else if (isReadOnlyTool(name) && isLspTool(name)) {
    hints.push('Use only where symbol/location context is needed after opening the target file.');
  } else if (isMutationTool(name)) {
    const lastReadPath = recentTools.includes('read_file')
      ? (rawRecentPaths[0] ?? '')
      : rawRecentPaths.at(-1) ?? '';

    if (lastReadPath) {
      hints.push(`Recent-file continuation likely: target ${shortenPath(lastReadPath)} first.`);
    }

    if (recentTools.includes('read_file') || recentTools.includes('read_files')) {
      hints.push('Scope edits from recent reads; avoid broad rewrites.');
    } else {
      hints.push('Read the exact target file first, then apply the smallest edit needed.');
    }
  } else if (name === 'exec') {
    if (recentTools.includes('exec')) {
      hints.push('Avoid re-running identical commands without new context from the previous result.');
    }
    if (isMutationTool(lastTool ?? '')) {
      hints.push('After file edits, run targeted checks (test/lint) if possible.');
    }
  }

  return hints.filter(Boolean).slice(0, 2);
}

/**
 * Return a tool schema array with extra context-specific description hints.
 * This always deep-clones schemas to avoid mutating cached schema lists.
 */
export function applyContextAwareToolDescriptions(
  schemas: ToolSchema[],
  context?: ToolSchemaContext
): ToolSchema[] {
  if (!context || (!context.lastTool && (!context.recentTools?.length || context.recentTools.length === 0) && (!context.recentPaths?.length || context.recentPaths.length === 0))) {
    return schemas;
  }

  return schemas.map((schema) => {
    const name = schema.function.name;
    const hints = contextHints(name, context);
    if (!hints.length) return schema;

    const desc = schema.function.description?.trim() ?? '';
    return {
      ...schema,
      function: {
        ...schema.function,
        description: `${desc} Context: ${hints.join(' ')}`,
      },
    };
  });
}
