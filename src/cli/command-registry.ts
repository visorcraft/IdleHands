import type { ReplContext } from './repl-context.js';

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description?: string;
  execute(ctx: ReplContext, args: string, line: string): Promise<boolean>;
}

const registry = new Map<string, SlashCommand>();

export function registerCommand(cmd: SlashCommand): void {
  registry.set(cmd.name.toLowerCase(), cmd);
  for (const a of cmd.aliases ?? []) registry.set(a.toLowerCase(), cmd);
}

export function registerAll(cmds: SlashCommand[]): void {
  for (const c of cmds) registerCommand(c);
}

export function findCommand(line: string): SlashCommand | null {
  const head = (line.trim().split(/\s+/)[0] || '').toLowerCase();
  if (!head.startsWith('/')) return null;
  return registry.get(head) ?? null;
}

export function allCommandNames(): string[] {
  return [...new Set([...registry.values()].map((c) => c.name))].sort();
}
