/**
 * Trifecta commands: /vault, /notes, /note, /checkpoints, /rewind, /statusbar, /diff.
 */

import fs from 'node:fs/promises';

import { atomicWrite, unifiedDiffFromBuffers } from '../../replay_cli.js';
import { colorizeUnifiedDiff, err as errFmt, warn as warnFmt } from '../../term.js';
import type { SlashCommand } from '../command-registry.js';

export const trifectaCommands: SlashCommand[] = [
  {
    name: '/vault',
    description: 'Search vault',
    async execute(ctx, args) {
      if (!ctx.session.vault) {
        console.log('Vault is disabled. Enable by removing --no-vault/--no-trifecta.');
        return true;
      }
      if (!args) {
        console.log('Usage: /vault <query>');
        return true;
      }
      try {
        const results = await ctx.session.vault.search(args, 20);
        if (!results.length) {
          console.log('No vault entries found.');
          return true;
        }
        for (const r of results) {
          const key = r.kind === 'note' ? (r.key ?? 'note') : (r.tool ?? 'tool');
          const snippet = (r.value ?? r.snippet ?? '').replace(/\s+/g, ' ').slice(0, 220);
          console.log(`${r.updatedAt} [${r.kind}] ${key}: ${snippet}`);
        }
      } catch (e: any) {
        console.error(errFmt(`VAULT: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/notes',
    description: 'List vault notes',
    async execute(ctx) {
      if (!ctx.session.vault) {
        console.log('Vault is disabled. Enable by removing --no-vault/--no-trifecta.');
        return true;
      }
      try {
        const results = await ctx.session.vault.list(20);
        if (!results.length) {
          console.log('No vault notes yet.');
          return true;
        }
        for (const r of results.filter((x: any) => x.kind === 'note')) {
          const value = (r.value ?? '').replace(/\s+/g, ' ').slice(0, 220);
          console.log(`${r.updatedAt} ${r.key}: ${value}`);
        }
      } catch (e: any) {
        console.error(errFmt(`NOTES: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/note',
    description: 'Save a vault note',
    async execute(ctx, args) {
      if (!ctx.session.vault) {
        console.log('Vault is disabled. Enable by removing --no-vault/--no-trifecta.');
        return true;
      }
      const idx = args.indexOf(' ');
      if (!args || idx === -1) {
        console.log('Usage: /note <key> <value>');
        return true;
      }
      const key = args.slice(0, idx).trim();
      const value = args.slice(idx + 1).trim();
      if (!key || !value) {
        console.log('Usage: /note <key> <value>');
        return true;
      }
      try {
        const id = await ctx.session.vault.note(key, value);
        console.log(`vault note saved: ${id}`);
      } catch (e: any) {
        console.error(errFmt(`NOTE: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/checkpoints',
    description: 'List replay checkpoints',
    async execute(ctx) {
      if (!ctx.session.replay) {
        console.log('Replay is disabled. Enable by omitting --no-trifecta/--no-replay.');
        return true;
      }
      try {
        const cps = await ctx.session.replay.list(50);
        if (!cps.length) {
          console.log('No checkpoints yet.');
          return true;
        }
        for (const c of cps) {
          const note = c.note ? `  [${String(c.note).slice(0, 80)}]` : '';
          console.log(`${c.id}  ${c.op}  ${c.filePath}${note}`);
        }
      } catch (e: any) {
        console.error(errFmt(`CHECKPOINTS: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/rewind',
    description: 'Rewind to checkpoint',
    async execute(ctx, args) {
      if (!ctx.session.replay) {
        console.log('Replay is disabled. Enable by omitting --no-trifecta/--no-replay.');
        return true;
      }
      if (!args) {
        console.log('Usage: /rewind <checkpoint-id>');
        return true;
      }
      try {
        const { cp } = await ctx.session.replay.get(args);
        const filePath = cp.filePath;
        const msg = await ctx.session.replay.rewind(
          args,
          async () => {
            try {
              return await fs.readFile(filePath);
            } catch (e: any) {
              if (e?.code === 'ENOENT') return Buffer.alloc(0);
              throw e;
            }
          },
          async (buf: Buffer) => await atomicWrite(filePath, buf)
        );
        console.log(msg);
      } catch (e: any) {
        console.error(errFmt(`REWIND: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/diff',
    description: 'Show checkpoint diff',
    async execute(ctx, args) {
      if (!ctx.session.replay) {
        console.log('Replay is disabled.');
        return true;
      }
      if (!args) {
        console.log('Usage: /diff <checkpoint-id>');
        return true;
      }
      try {
        const got = await ctx.session.replay.get(args);
        const before = got.before.toString('utf8');
        const after = (got.after ?? Buffer.from('')).toString('utf8');
        if (before === after) {
          console.log('No diff (before == after).');
        } else {
          if (got.cp.note) console.log(ctx.S.dim(`[structural note] ${got.cp.note}`));
          const out = await unifiedDiffFromBuffers(got.before, got.after ?? Buffer.from(''));
          if (out.trim()) console.log(colorizeUnifiedDiff(out.trimEnd(), ctx.S));
          else {
            console.log(ctx.S.dim('--- before'));
            console.log(before.slice(0, 800));
            console.log(ctx.S.dim('--- after'));
            console.log(after.slice(0, 800));
            console.log(warnFmt('[diff output truncated]', ctx.S));
          }
        }
      } catch (e: any) {
        console.error(errFmt(`DIFF: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/statusbar',
    description: 'Toggle status bar',
    async execute(ctx, args) {
      const arg = args.toLowerCase();
      if (!arg) {
        console.log(`Status bar: ${ctx.statusBarEnabled ? 'on' : 'off'}`);
      } else if (arg === 'on') {
        if (!ctx.statusBar.canUse()) {
          console.log('Status bar not supported (requires TTY and terminal height >= 10 rows).');
        } else {
          ctx.statusBarEnabled = true;
          ctx.statusBar.setEnabled(true);
          ctx.statusBar.render(ctx.lastStatusLine);
          console.log('Status bar: on');
        }
      } else if (arg === 'off') {
        ctx.statusBarEnabled = false;
        ctx.statusBar.setEnabled(false);
        console.log('Status bar: off');
      } else {
        console.log('Usage: /statusbar on|off');
      }
      return true;
    },
  },
];
