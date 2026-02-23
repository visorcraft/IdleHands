/**
 * Shared parsing helpers for command-style input.
 *
 * Centralizing this logic avoids repeated `split(/\s+/)` snippets and keeps
 * command handling consistent across CLI and bot entry points.
 */

const WHITESPACE = /\s+/;

/**
 * Split a command input into normalized tokens.
 */
export function splitTokens(input: string): string[] {
  const normalized = input.trim();
  return normalized ? normalized.split(WHITESPACE).filter(Boolean) : [];
}

/**
 * Return the first token of a command input (command/subcommand), lowercased.
 */
export function firstToken(input: string): string {
  return splitTokens(input)[0]?.toLowerCase() ?? '';
}

/**
 * Return the remaining tokens after the first.
 */
export function restTokens(input: string): string[] {
  return splitTokens(input).slice(1);
}
