/**
 * Session commands: /quit, /exit, /new, /clear, /compact, /save, /load,
 * /sessions, /conv, /history, /status, /subagents, /help, /about.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type { SlashCommand } from '../command-registry.js';
import { formatStatusLine } from '../status.js';
import {
  conversationBranchPath, isSafeBranchName,
  saveSessionFile, listSavedSessions, listConversationBranches,
} from '../session-state.js';
import { err as errFmt } from '../../term.js';

export const sessionCommands: SlashCommand[] = [
  {
    name: '/quit',
    aliases: ['/exit'],
    description: 'Exit the session',
    async execute(ctx) {
      await ctx.shutdown(0);
      return true;
    },
  },
  {
    name: '/help',
    description: 'Show available commands',
    async execute(ctx) {
      console.log(
        ctx.S.dim('Commands: ') +
          '/help /quit /edit [seed text] /about /mode [code|sys] /status /stats /server /perf /offline [on|off|status] /system [edit|reset|tokens] /lsp [status] /mcp [desc|restart <name>|enable <tool>|disable <tool>] /statusbar on|off /approval [mode] /plan /step [on|off] /approve [N] /reject /history /new /compact [topic|hard|dry] /init /git [/diff] /branch [name] /changes [--stat|--full|--since N|reset|<file>] /watch [off|status|<path...> [--max N]] /sessions /conv branch|branches|checkout|merge ... /cost /model <name> /escalate [next|N|model] /deescalate /capture on|off|last /index [run|status|stats|clear] /undo [path] /save <path> /load <path> /vault <query> /notes /note <key> <value> /checkpoints /rewind <id> /diff <id> /subagents [on|off] /theme [name|list] /vim /commands /exit-shell' +
          '\n' + ctx.S.dim('Shell: !<cmd> run once, !!<cmd> run + inject output, ! toggles shell mode') +
          '\n' + ctx.S.dim('Templates: /fix /review /test /explain /refactor, plus custom markdown commands in ~/.config/idlehands/commands/')
      );
      return true;
    },
  },
  {
    name: '/about',
    description: 'Show version and system info',
    async execute(ctx) {
      const lines = [
        `Idle Hands v${ctx.version}`,
        `Model: ${ctx.session.model}`,
        `Endpoint: ${ctx.config.endpoint}`,
        `Harness: ${ctx.session.harness}`,
        `Node: ${process.version}`,
        `OS: ${process.platform} ${process.arch}`,
      ];
      console.log(lines.join('\n'));
      return true;
    },
  },
  {
    name: '/status',
    description: 'Show context usage',
    async execute(ctx) {
      ctx.lastStatusLine = formatStatusLine(ctx.session, ctx.config, ctx.S);
      console.log(ctx.lastStatusLine);
      return true;
    },
  },
  {
    name: '/history',
    description: 'Show recent messages',
    async execute(ctx) {
      const tail = ctx.session.messages.slice(-20);
      for (const m of tail) {
        const head = m.role.toUpperCase().padEnd(9, ' ');
        const c = (m as any).content ?? '';
        console.log(`${head}: ${String(c).slice(0, 400)}`);
      }
      return true;
    },
  },
  {
    name: '/new',
    description: 'Start a new session',
    async execute(ctx) {
      ctx.session.reset();
      console.log('✨ New session started.');
      return true;
    },
  },
  {
    name: '/subagents',
    description: 'Toggle sub-agents on/off',
    async execute(ctx, args) {
      const arg = args.trim().toLowerCase();
      const current = ctx.config.sub_agents?.enabled !== false;
      if (!arg) {
        console.log(`Sub-agents: ${current ? 'on' : 'off'} (usage: /subagents on | off)`);
        return true;
      }
      if (arg !== 'on' && arg !== 'off') {
        console.log('Invalid value. Usage: /subagents on | off');
        return true;
      }
      const enabled = arg === 'on';
      ctx.config.sub_agents = { ...(ctx.config.sub_agents ?? {}), enabled };
      console.log(`✅ Sub-agents ${enabled ? 'on' : 'off'}${!enabled ? ' — spawn_task disabled for this session' : ''}`);
      return true;
    },
  },
  {
    name: '/compact',
    description: 'Compact conversation history',
    async execute(ctx, args) {
      const hard = /^hard\b/i.test(args);
      const dry = /^dry\b/i.test(args);
      const topic = (!hard && !dry && args) ? args : undefined;

      try {
        const res = await ctx.session.compactHistory({ topic, hard, dry });
        const modeTag = dry ? '[compact dry]' : '[compact]';
        const summary = `${modeTag} ${res.beforeMessages} messages → ${res.afterMessages} messages | ~${res.freedTokens} tokens freed | ${res.archivedToolMessages} tool messages archived to Vault`;
        console.log(summary);
        if (!dry && res.droppedMessages > 0 && topic) {
          console.log(ctx.S.dim(`[compact] topic focus preserved: "${topic}"`));
        }
      } catch (e: any) {
        console.error(errFmt(`COMPACT: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/save',
    description: 'Save session to file',
    async execute(ctx, args) {
      if (!args) {
        console.log('Usage: /save <path>');
        return true;
      }
      const outPath = path.resolve(ctx.config.dir!, args);
      const payload = {
        savedAt: new Date().toISOString(),
        model: ctx.session.model,
        harness: ctx.session.harness,
        contextWindow: ctx.session.contextWindow,
        messages: ctx.session.messages,
      };
      await fs.writeFile(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      console.log(`Saved session to ${outPath}`);
      return true;
    },
  },
  {
    name: '/load',
    description: 'Load session from file',
    async execute(ctx, args) {
      if (!args) {
        console.log('Usage: /load <path>');
        return true;
      }
      const inPath = path.resolve(ctx.config.dir!, args);
      const raw = await fs.readFile(inPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed?.messages || !Array.isArray(parsed.messages)) {
        console.log('Invalid session file: missing messages[]');
        return true;
      }
      ctx.session.restore(parsed.messages);
      console.log(`Loaded session from ${inPath}`);
      return true;
    },
  },
  {
    name: '/sessions',
    description: 'List saved named sessions',
    async execute(ctx) {
      const rows = await listSavedSessions();
      if (!rows.length) {
        console.log('No saved named sessions.');
      } else {
        for (const r of rows.slice(0, 30)) {
          const when = new Date(r.ts).toLocaleString();
          console.log(`${r.name}  (${when})`);
        }
      }
      return true;
    },
  },
  {
    name: '/conv',
    description: 'Conversation branches',
    async execute(ctx, args, line) {
      const parts = line.split(/\s+/).filter(Boolean);
      const sub = (parts[1] || '').toLowerCase();

      if (!sub || sub === 'help') {
        console.log('Usage: /conv branch <name> | /conv branches | /conv checkout <name> | /conv merge <name>');
        return true;
      }

      if (sub === 'branch') {
        const name = (parts[2] || '').trim();
        if (!name) { console.log('Usage: /conv branch <name>'); return true; }
        if (!isSafeBranchName(name)) {
          console.log('Invalid branch name. Allowed: letters, numbers, dot, underscore, hyphen.');
          return true;
        }
        const payload = {
          savedAt: new Date().toISOString(),
          name,
          model: ctx.session.model,
          harness: ctx.session.harness,
          contextWindow: ctx.session.contextWindow,
          messages: ctx.session.messages,
        };
        const filePath = conversationBranchPath(name);
        await saveSessionFile(filePath, payload);
        console.log(`[conv] saved branch '${name}' (${ctx.session.messages.length} messages)`);
        return true;
      }

      if (sub === 'branches') {
        const rows = await listConversationBranches();
        if (!rows.length) {
          console.log('No conversation branches saved.');
          return true;
        }
        for (const r of rows.slice(0, 50)) {
          const when = new Date(r.ts).toLocaleString();
          console.log(`${r.name}  (${when})`);
        }
        return true;
      }

      if (sub === 'checkout') {
        const name = (parts[2] || '').trim();
        if (!name) { console.log('Usage: /conv checkout <name>'); return true; }
        if (!isSafeBranchName(name)) { console.log('Invalid branch name.'); return true; }
        const filePath = conversationBranchPath(name);
        const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
        if (!raw.trim()) {
          console.log(`Conversation branch not found: ${name}`);
          return true;
        }
        try {
          const parsed = JSON.parse(raw);
          const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
          if (msgs.length < 2 || msgs[0]?.role !== 'system') {
            console.log(`Invalid conversation branch: ${name}`);
            return true;
          }
          ctx.session.restore(msgs as any);
          if (parsed?.model) {
            try { ctx.session.setModel(String(parsed.model)); } catch {}
          }
          console.log(`[conv] checked out '${name}' (${msgs.length} messages)`);
        } catch (e: any) {
          console.log(`Failed to load conversation branch '${name}': ${e?.message ?? e}`);
        }
        return true;
      }

      if (sub === 'merge') {
        const name = (parts[2] || '').trim();
        if (!name) { console.log('Usage: /conv merge <name>'); return true; }
        if (!isSafeBranchName(name)) { console.log('Invalid branch name.'); return true; }
        const filePath = conversationBranchPath(name);
        const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
        if (!raw.trim()) {
          console.log(`Conversation branch not found: ${name}`);
          return true;
        }
        try {
          const parsed = JSON.parse(raw);
          const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
          if (!msgs.length) {
            console.log(`Conversation branch '${name}' has no messages.`);
            return true;
          }
          const toAppend = msgs.filter((m: any, idx: number) => !(idx === 0 && m?.role === 'system'));
          if (!toAppend.length) {
            console.log(`Conversation branch '${name}' has no mergeable messages.`);
            return true;
          }
          ctx.session.restore([...ctx.session.messages, ...toAppend] as any);
          console.log(`[conv] merged ${toAppend.length} message(s) from '${name}'`);
        } catch (e: any) {
          console.log(`Failed to merge conversation branch '${name}': ${e?.message ?? e}`);
        }
        return true;
      }

      console.log('Usage: /conv branch <name> | /conv branches | /conv checkout <name> | /conv merge <name>');
      return true;
    },
  },
];
