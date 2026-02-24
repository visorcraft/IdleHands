import type { VaultStore } from '../vault.js';

export type VaultToolContext = {
  dryRun: boolean;
  vault?: VaultStore;
};

export async function vaultNoteTool(ctx: VaultToolContext, args: any): Promise<string> {
  const key = typeof args?.key === 'string' ? args.key.trim() : '';
  const value = typeof args?.value === 'string' ? args.value : undefined;

  if (!key) throw new Error('vault_note: missing key');
  if (value == null) throw new Error('vault_note: missing value');

  if (ctx.dryRun) return `dry-run: would add vault note ${JSON.stringify(key)}`;

  if (!ctx.vault) {
    throw new Error('vault_note: vault disabled');
  }

  const id = await ctx.vault.note(key, String(value));
  return `vault_note: saved ${id}`;
}

export async function vaultSearchTool(ctx: VaultToolContext, args: any): Promise<string> {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  const limit = Number(args?.limit);

  if (!query) return 'vault_search: missing query';
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.max(1, Math.floor(limit))) : 8;

  if (!ctx.vault) return 'vault disabled';

  const results = await ctx.vault.search(query, n);
  if (!results.length) {
    return `vault_search: no results for ${JSON.stringify(query)}`;
  }

  const lines = results.map((r) => {
    const title = r.kind === 'note' ? `note:${r.key}` : `tool:${r.tool || r.key || 'unknown'}`;
    const body = r.value ?? r.snippet ?? r.content ?? '';
    const short = body.replace(/\s+/g, ' ').slice(0, 160);
    return `${r.updatedAt} ${title} ${JSON.stringify(short)}`;
  });

  return lines.join('\n');
}
