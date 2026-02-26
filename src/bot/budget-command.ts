import type { CmdResult, ManagedLike } from './command-logic.js';

/**
 * /budget — Show where context tokens are being spent.
 */
export function budgetCommand(managed: ManagedLike): CmdResult {
  const session = managed.session;
  const contextWindow = session.contextWindow;
  const currentTokens = session.currentContextTokens;
  const pct = contextWindow > 0 ? Math.round((currentTokens / contextWindow) * 100) : 0;

  // Estimate system prompt tokens (~4 chars per token).
  const messages = (session as any).messages as Array<{ role: string; content: any }> | undefined;
  let systemTokens = 0;
  let conversationTokens = 0;
  let assistantCount = 0;
  let toolResultCount = 0;
  let userCount = 0;

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const len = typeof msg.content === 'string'
        ? msg.content.length
        : JSON.stringify(msg.content ?? '').length;
      const tokens = Math.ceil(len / 4);
      if (msg.role === 'system') {
        systemTokens += tokens;
      } else {
        conversationTokens += tokens;
        if (msg.role === 'assistant') assistantCount++;
        else if (msg.role === 'tool') toolResultCount++;
        else if (msg.role === 'user') userCount++;
      }
    }
  }

  // Tool schema tokens estimate.
  const toolSchemaTokens = (session.lastTurnDebug as any)?.toolSchemaTokens ?? 0;
  const toolCount = (session.lastTurnDebug as any)?.toolCount ?? 0;

  const available = Math.max(0, contextWindow - currentTokens);
  const bar = renderBar(pct);

  const lines: string[] = [
    `${bar} ${pct}% used (${fmtK(currentTokens)} / ${fmtK(contextWindow)})`,
    '',
    `  System prompt:   ${fmtK(systemTokens)} (${pctOf(systemTokens, contextWindow)})`,
    `  Tool schemas:    ${fmtK(toolSchemaTokens)} · ${toolCount} tools (${pctOf(toolSchemaTokens, contextWindow)})`,
    `  Conversation:    ${fmtK(conversationTokens)} (${pctOf(conversationTokens, contextWindow)})`,
    `    ${userCount} user · ${assistantCount} assistant · ${toolResultCount} tool results`,
    '',
    `  Available:       ${fmtK(available)} (${pctOf(available, contextWindow)})`,
  ];

  if (pct > 80) {
    lines.push('');
    lines.push('⚠️ Context is getting full. Auto-compaction may trigger soon.');
  }

  return { title: 'Context Budget', lines };
}

function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function pctOf(n: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

function renderBar(pct: number): string {
  const width = 10;
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const icon = pct > 80 ? '🔴' : pct > 50 ? '🟡' : '🟢';
  return `${icon} [${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}
