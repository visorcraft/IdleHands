/**
 * Format CmdResult into surface-specific output.
 *
 * - formatHtml: Telegram HTML (parse_mode: 'HTML')
 * - formatMarkdown: Discord Markdown
 */

import type { CmdResult, KV } from './command-logic.js';
import { escapeHtml } from './format.js';

// ── Telegram HTML ───────────────────────────────────────────────────

function kvToHtml([label, value, code]: KV): string {
  const val = code ? `<code>${escapeHtml(value)}</code>` : escapeHtml(value);
  return `<b>${escapeHtml(label)}:</b> ${val}`;
}

export function formatHtml(r: CmdResult): string {
  const parts: string[] = [];

  if (r.title) parts.push(`<b>${escapeHtml(r.title)}</b>`);
  if (r.kv?.length) {
    if (parts.length) parts.push('');
    parts.push(...r.kv.map(kvToHtml));
  }
  if (r.success) parts.push(escapeHtml(r.success));
  if (r.error) parts.push(escapeHtml(r.error));
  if (r.lines?.length) parts.push(...r.lines.map((l) => escapeHtml(l)));
  if (r.preformatted != null) parts.push(`<pre>${escapeHtml(r.preformatted)}</pre>`);

  return parts.join('\n');
}

// ── Discord Markdown ────────────────────────────────────────────────

function kvToMarkdown([label, value, code]: KV): string {
  const val = code ? `\`${value}\`` : value;
  return `**${label}:** ${val}`;
}

export function formatMarkdown(r: CmdResult): string {
  const parts: string[] = [];

  if (r.title) parts.push(`**${r.title}**`);
  if (r.kv?.length) {
    if (parts.length) parts.push('');
    parts.push(...r.kv.map(kvToMarkdown));
  }
  if (r.success) parts.push(r.success);
  if (r.error) parts.push(r.error);
  if (r.lines?.length) parts.push(...r.lines);
  if (r.preformatted != null) parts.push(`\`\`\`\n${r.preformatted}\`\`\``);

  return parts.join('\n');
}
