import type { CmdResult, ManagedLike } from './command-logic.js';

// ── Changes / undo ──────────────────────────────────────────────────

export async function changesCommand(managed: ManagedLike): Promise<CmdResult> {
  const replay = managed.session.replay;
  if (!replay) return { error: 'Replay is disabled. No change tracking available.' };

  try {
    const checkpoints = await replay.list(50);
    if (!checkpoints.length) return { lines: ['No file changes this session.'] };

    const byFile = new Map<string, number>();
    for (const cp of checkpoints) {
      byFile.set(cp.filePath, (byFile.get(cp.filePath) ?? 0) + 1);
    }

    const lines: string[] = [];
    for (const [fp, count] of byFile) {
      lines.push(`  ✎ ${fp} (${count} edit${count > 1 ? 's' : ''})`);
    }

    return { title: `Session changes (${byFile.size} files)`, lines };
  } catch (e: any) {
    return { error: `Error listing changes: ${e?.message ?? e}` };
  }
}

export async function undoCommand(managed: ManagedLike): Promise<CmdResult> {
  const lastPath = managed.session.lastEditedPath;
  if (!lastPath) return { error: 'No recent edits to undo.' };

  try {
    const { undo_path } = await import('../tools.js');
    const ctx = { cwd: managed.workingDir, noConfirm: true, dryRun: false };
    const result = await undo_path(ctx as any, { path: lastPath });
    return { success: `✅ ${result}` };
  } catch (e: any) {
    return { error: `❌ Undo failed: ${e?.message ?? e}` };
  }
}

// ── Vault ───────────────────────────────────────────────────────────

export async function vaultCommand(managed: ManagedLike, query: string): Promise<CmdResult> {
  const vault = managed.session.vault;
  if (!vault) return { error: 'Vault is disabled.' };
  if (!query) return { lines: ['Usage: /vault <search query>'] };

  try {
    const results = await vault.search(query, 5);
    if (!results.length) return { lines: ['No results.'] };

    const lines = results.map((r) => {
      const title = r.kind === 'note' ? `note:${r.key}` : `tool:${r.tool || r.key || 'unknown'}`;
      const body = r.value ?? r.snippet ?? r.content ?? '';
      const short = body.replace(/\s+/g, ' ').slice(0, 120);
      return `• ${title}: ${short}`;
    });

    return { title: `Vault results for "${query}"`, lines };
  } catch (e: any) {
    return { error: `Vault error: ${e?.message ?? e}` };
  }
}
