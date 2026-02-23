/**
 * Branch picker — loads conversation branches and handles selection.
 * Extracted from controller.ts to stay within the 400-line TUI file cap.
 */

import fs from 'node:fs/promises';

import type { AgentSession } from '../agent.js';
import { listConversationBranches, conversationBranchPath } from '../cli/session-state.js';

import type { BranchPickerItem } from './types.js';

/** Load branches and return BRANCH_PICKER_OPEN event data. */
export async function loadBranches(action: 'checkout' | 'merge' | 'browse'): Promise<{
  branches: BranchPickerItem[];
  action: 'checkout' | 'merge' | 'browse';
}> {
  const rows = await listConversationBranches();
  const items: BranchPickerItem[] = [];
  for (const r of rows.slice(0, 30)) {
    let preview = '';
    let messageCount = 0;
    try {
      const raw = await fs.readFile(r.path, 'utf8');
      const parsed = JSON.parse(raw);
      const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
      messageCount = msgs.length;
      const last = msgs.filter((m: any) => m.role !== 'system').pop();
      if (last?.content) preview = String(last.content).slice(0, 80).replace(/\n/g, ' ');
    } catch {
      /* skip bad files */
    }
    items.push({ name: r.name, ts: r.ts, messageCount, preview });
  }
  return { branches: items, action };
}

export interface BranchSelectResult {
  ok: boolean;
  message?: string;
  level?: 'info' | 'warn' | 'error';
}

/** Execute the selected branch action (checkout or merge). */
export async function executeBranchSelect(
  session: AgentSession,
  branchName: string,
  action: 'checkout' | 'merge' | 'browse'
): Promise<BranchSelectResult> {
  if (action === 'browse') {
    return { ok: true, message: undefined };
  }

  const filePath = conversationBranchPath(branchName);
  const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
  if (!raw.trim()) {
    return { ok: false, message: `Branch not found: ${branchName}`, level: 'error' };
  }

  try {
    const parsed = JSON.parse(raw);
    const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];

    if (action === 'checkout') {
      if (msgs.length < 2 || msgs[0]?.role !== 'system') {
        return { ok: false, message: `Invalid branch: ${branchName}`, level: 'error' };
      }
      session.restore(msgs as any);
      if (parsed?.model)
        try {
          session.setModel(String(parsed.model));
        } catch {}
      return { ok: true, message: `Checked out '${branchName}' (${msgs.length} messages)` };
    }

    // merge
    const toAppend = msgs.filter((m: any, idx: number) => !(idx === 0 && m?.role === 'system'));
    if (!toAppend.length) {
      return {
        ok: false,
        message: `Branch '${branchName}' has no mergeable messages.`,
        level: 'warn',
      };
    }
    session.restore([...session.messages, ...toAppend] as any);
    return { ok: true, message: `Merged ${toAppend.length} message(s) from '${branchName}'` };
  } catch (e: any) {
    return { ok: false, message: `Failed: ${e?.message ?? e}`, level: 'error' };
  }
}
