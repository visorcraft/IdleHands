/**
 * Custom slash commands (Phase 14c).
 *
 * User-defined commands stored as markdown files with YAML frontmatter:
 *   ~/.config/idlehands/commands/<name>.md  (global)
 *   .idlehands/commands/<name>.md           (project-scoped, overrides global)
 *
 * Format:
 *   ---
 *   name: deploy
 *   description: Deploy current build to staging
 *   ---
 *   Build the project with `npm run build`, then deploy...
 *
 * Args: /deploy production → $1 = production, $2 = ...
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from './utils.js';

interface CustomCommand {
  /** Slash-key used to invoke the command, e.g. "/deploy" */
  key: string;
  /** Human-facing command name from frontmatter (or derived from file name). */
  name: string;
  description: string;
  /** Positional argument labels from frontmatter. */
  args: string[];
  template: string;
  source: 'global' | 'project';
  filePath: string;
}

type CommandFrontmatter = {
  name?: string;
  description?: string;
  args?: string[];
};

/** Directory for user-global custom commands. */
function globalCommandsDir(): string {
  return path.join(configDir(), 'commands');
}

/** Directory for project-scoped custom commands. */
function projectCommandsDir(projectDir: string): string {
  return path.join(projectDir, '.idlehands', 'commands');
}

function parseYamlScalar(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const single = s.match(/^'(.*)'$/);
  if (single) return single[1].replace(/\\'/g, "'");
  const dbl = s.match(/^"(.*)"$/);
  if (dbl) return dbl[1].replace(/\\"/g, '"');
  return s;
}

function parseInlineList(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];

  const bracket = s.match(/^\[(.*)\]$/);
  if (bracket) {
    return bracket[1]
      .split(',')
      .map((v) => parseYamlScalar(v))
      .map((v) => v.trim())
      .filter(Boolean);
  }

  if (s.includes(',')) {
    return s
      .split(',')
      .map((v) => parseYamlScalar(v))
      .map((v) => v.trim())
      .filter(Boolean);
  }

  return [parseYamlScalar(s)].filter(Boolean);
}

/** Parse lightweight YAML frontmatter from markdown command files. */
function parseFrontmatter(content: string): { meta: CommandFrontmatter; body: string } {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content.trim() };

  const meta: CommandFrontmatter = {};
  let activeListKey: 'args' | null = null;

  for (const line of m[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const listItem = line.match(/^\s*-\s*(.+?)\s*$/);
    if (listItem && activeListKey === 'args') {
      if (!meta.args) meta.args = [];
      const value = parseYamlScalar(listItem[1]);
      if (value) meta.args.push(value);
      continue;
    }

    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!kv) {
      activeListKey = null;
      continue;
    }

    const key = kv[1].toLowerCase();
    const value = kv[2];

    if (key === 'name') {
      meta.name = parseYamlScalar(value);
      activeListKey = null;
      continue;
    }

    if (key === 'description') {
      meta.description = parseYamlScalar(value);
      activeListKey = null;
      continue;
    }

    if (key === 'args') {
      if (!value) {
        meta.args = [];
        activeListKey = 'args';
      } else {
        meta.args = parseInlineList(value);
        activeListKey = null;
      }
      continue;
    }

    activeListKey = null;
  }

  return { meta, body: m[2].trim() };
}

function toCommandKey(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '');
  return slug ? `/${slug}` : '';
}

/** Load commands from a directory. */
async function loadFromDir(
  dir: string,
  source: 'global' | 'project',
): Promise<Map<string, CustomCommand>> {
  const cmds = new Map<string, CustomCommand>();
  let entries: any[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true }) as any[];
  } catch {
    return cmds;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const fileSlug = entry.name.replace(/\.md$/, '');
    if (!fileSlug || fileSlug.startsWith('.')) continue;

    const filePath = path.join(dir, entry.name);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      if (!body) continue;

      const derived = toCommandKey(fileSlug);
      const named = meta.name ? toCommandKey(meta.name) : '';
      const key = named || derived;
      if (!key) continue;

      cmds.set(key, {
        key,
        name: meta.name?.trim() || key.slice(1),
        description: meta.description?.trim() || '',
        args: Array.isArray(meta.args) ? meta.args.filter(Boolean) : [],
        template: body,
        source,
        filePath,
      });
    } catch {
      // skip unreadable files
    }
  }

  return cmds;
}

/**
 * Load all custom commands. Project-scoped commands override global ones
 * when they share the same slug.
 */
export async function loadCustomCommands(
  projectDir?: string,
): Promise<Map<string, CustomCommand>> {
  const globalCmds = await loadFromDir(globalCommandsDir(), 'global');
  const merged = new Map(globalCmds);

  if (projectDir) {
    const projectCmds = await loadFromDir(projectCommandsDir(projectDir), 'project');
    for (const [key, cmd] of projectCmds) {
      merged.set(key, cmd); // project overrides global
    }
  }

  return merged;
}

/**
 * Expand $1, $2, ... $N placeholders in a template with positional args.
 * Also replaces $* with all args joined by spaces.
 */
export function expandArgs(template: string, args: string[]): string {
  let result = template;
  for (let i = 0; i < args.length; i++) {
    result = result.replaceAll(`$${i + 1}`, args[i]);
  }
  result = result.replaceAll('$*', args.join(' '));
  // Remove unresolved placeholders so templates stay readable.
  result = result.replace(/\$\d+/g, '');
  return result;
}
