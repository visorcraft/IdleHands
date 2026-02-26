/**
 * Modular System Prompt Builder
 *
 * Replaces the monolithic SYSTEM_PROMPT constant with composable sections
 * that can be customized, reordered, or overridden per-model or per-config.
 *
 * Inspired by ZeroClaw's `SystemPromptBuilder` with `PromptSection` trait.
 */

// ── Section Interface ────────────────────────────────────────────────────

export interface PromptSection {
  /** Unique section identifier. */
  name: string;
  /** Build the section text. Return empty string to skip. */
  build(ctx: PromptContext): string;
}

export interface PromptContext {
  /** Working directory */
  cwd: string;
  /** Model name for model-specific adjustments */
  model?: string;
  /** Active harness ID */
  harness?: string;
  /** Whether native tool calls are supported */
  nativeToolCalls: boolean;
  /** Whether content-mode tool calls are active */
  contentModeToolCalls: boolean;
  /** Tool schemas (for content-mode tool descriptions) */
  toolSchemas?: Array<{ function: { name: string; description?: string; parameters?: unknown } }>;
  /** Extra context from caller */
  extra?: Record<string, unknown>;
}

// ── Built-In Sections ────────────────────────────────────────────────────

export class IdentitySection implements PromptSection {
  name = 'identity';
  build(_ctx: PromptContext): string {
    return 'You are a coding agent with filesystem and shell access. Execute the user\'s request using the provided tools.';
  }
}

export class RulesSection implements PromptSection {
  name = 'rules';
  build(_ctx: PromptContext): string {
    return `Rules:
- Work in the current directory. Use relative paths for all file operations.
- Do the work directly. Do NOT use spawn_task to delegate the user's primary request — only use it for genuinely independent subtasks that benefit from parallel execution.
- Never use spawn_task to bypass confirmation/safety restrictions (for example blocked package installs). If a command is blocked, adapt the plan or ask the user for approval mode changes.
- Read the target file before editing. You need the exact text for search/replace.
- Use read_file with search=... to jump to relevant code; avoid reading whole files.
- Never call read_file/read_files/list_dir twice in a row with identical arguments (same path/options). Reuse the previous result instead.
- Prefer apply_patch or edit_range for code edits (token-efficient). Use edit_file only when exact old_text replacement is necessary.
- write_file is for new files or explicit full rewrites only. Existing non-empty files require overwrite=true/force=true.
- Use insert_file for insertions (prepend/append/line).
- Use exec to run commands, tests, builds; check results before reporting success.
- When running commands in a subdirectory, use exec's cwd parameter — NOT "cd /path && cmd". Each exec call is a fresh shell; cd does not persist.
- Batch work: read all files you need, then apply all edits, then verify.
- Be concise. Report what you changed and why.
- Do NOT read every file in a directory. Use search_files to locate relevant code first, then read only the files that match.
- If search_files returns 0 matches, try a broader pattern or a different search term.
- Prefer search_files over exec grep — it produces structured results and is tracked by the read budget. Use exec grep only as a last resort.
- Never use sed or awk via exec to read file sections. Use read_file with offset/limit parameters instead.
- When searching for a string, start at the broadest reasonable scope. Do not search a single file first and then progressively widen — search the project root or relevant subtree once.
- Do not re-run a test command that already passed unless you have made code changes since the last run.
- After reading a file, remember its contents. Do not re-read the same file unless you have edited it since the last read.
- Anton (the autonomous task runner) is ONLY activated when the user explicitly invokes /anton. Never self-activate as Anton or start processing task files on your own.`;
  }
}

export class ToolFormatSection implements PromptSection {
  name = 'tool_format';
  build(ctx: PromptContext): string {
    if (ctx.contentModeToolCalls) {
      return `Tool-call arguments MUST be strict JSON (double-quoted keys/strings, no comments, no trailing commas).
- edit_range example: {"path":"src/foo.ts","start_line":10,"end_line":14,"replacement":"line A\\nline B"}
- apply_patch example: {"patch":"--- a/src/foo.ts\\n+++ b/src/foo.ts\\n@@ -10,2 +10,2 @@\\n-old\\n+new","files":["src/foo.ts"]}

Tool call format:
- Output tool calls as JSON blocks in your response.
- Do NOT use the tool_calls API mechanism.
- If you use XML/function tags (e.g. <function=name>), include a full JSON object of arguments between braces.`;
    }
    return `Tool-call arguments MUST be strict JSON (double-quoted keys/strings, no comments, no trailing commas).
- edit_range example: {"path":"src/foo.ts","start_line":10,"end_line":14,"replacement":"line A\\nline B"}
- apply_patch example: {"patch":"--- a/src/foo.ts\\n+++ b/src/foo.ts\\n@@ -10,2 +10,2 @@\\n-old\\n+new","files":["src/foo.ts"]}

Tool call format:
- Use tool_calls. Do not write JSON tool invocations in your message text.`;
  }
}

export class SafetySection implements PromptSection {
  name = 'safety';
  build(_ctx: PromptContext): string {
    // Minimal — callers can extend or override
    return '';
  }
}

export class DateTimeSection implements PromptSection {
  name = 'datetime';
  build(_ctx: PromptContext): string {
    const now = new Date();
    return `Current date: ${now.toISOString().slice(0, 10)} (${now.toLocaleTimeString()})`;
  }
}

export class RuntimeSection implements PromptSection {
  name = 'runtime';
  build(ctx: PromptContext): string {
    const parts: string[] = [];
    if (ctx.cwd) parts.push(`Working directory: ${ctx.cwd}`);
    if (ctx.model) parts.push(`Model: ${ctx.model}`);
    if (ctx.harness) parts.push(`Harness: ${ctx.harness}`);
    return parts.join('\n');
  }
}

export class VaultContextSection implements PromptSection {
  name = 'vault_context';

  constructor(private entries: string[] = []) {}

  setEntries(entries: string[]): void {
    this.entries = entries;
  }

  build(_ctx: PromptContext): string {
    if (!this.entries.length) return '';
    return `[Relevant context from vault]\n${this.entries.join('\n')}`;
  }
}

// ── Builder ──────────────────────────────────────────────────────────────

export class SystemPromptBuilder {
  private sections: PromptSection[] = [];

  /** Create a builder with the default section set. */
  static withDefaults(): SystemPromptBuilder {
    const builder = new SystemPromptBuilder();
    builder.addSection(new IdentitySection());
    builder.addSection(new RulesSection());
    builder.addSection(new ToolFormatSection());
    builder.addSection(new SafetySection());
    return builder;
  }

  /** Add a section to the builder. */
  addSection(section: PromptSection): this {
    this.sections.push(section);
    return this;
  }

  /** Insert a section before another section by name. */
  insertBefore(targetName: string, section: PromptSection): this {
    const idx = this.sections.findIndex((s) => s.name === targetName);
    if (idx >= 0) {
      this.sections.splice(idx, 0, section);
    } else {
      this.sections.push(section);
    }
    return this;
  }

  /** Insert a section after another section by name. */
  insertAfter(targetName: string, section: PromptSection): this {
    const idx = this.sections.findIndex((s) => s.name === targetName);
    if (idx >= 0) {
      this.sections.splice(idx + 1, 0, section);
    } else {
      this.sections.push(section);
    }
    return this;
  }

  /** Replace a section by name, or append if not found. */
  replaceSection(name: string, section: PromptSection): this {
    const idx = this.sections.findIndex((s) => s.name === name);
    if (idx >= 0) {
      this.sections[idx] = section;
    } else {
      this.sections.push(section);
    }
    return this;
  }

  /** Remove a section by name. */
  removeSection(name: string): this {
    this.sections = this.sections.filter((s) => s.name !== name);
    return this;
  }

  /** Get a section by name. */
  getSection<T extends PromptSection>(name: string): T | undefined {
    return this.sections.find((s) => s.name === name) as T | undefined;
  }

  /** List section names in order. */
  sectionNames(): string[] {
    return this.sections.map((s) => s.name);
  }

  /** Build the complete system prompt. */
  build(ctx: PromptContext): string {
    const parts: string[] = [];
    for (const section of this.sections) {
      const text = section.build(ctx).trim();
      if (text) parts.push(text);
    }
    return parts.join('\n\n');
  }
}

/**
 * Build a default system prompt string (drop-in replacement for the old
 * SYSTEM_PROMPT constant). Allows callers that don't need customization
 * to get the same result with no refactoring.
 */
export function buildDefaultSystemPrompt(ctx: Partial<PromptContext> = {}): string {
  return SystemPromptBuilder.withDefaults().build({
    cwd: ctx.cwd ?? process.cwd(),
    nativeToolCalls: ctx.nativeToolCalls ?? true,
    contentModeToolCalls: ctx.contentModeToolCalls ?? false,
    ...ctx,
  });
}
