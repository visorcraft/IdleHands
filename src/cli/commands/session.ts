/**
 * Session commands: /quit, /exit, /new, /clear, /compact, /save, /load,
 * /sessions, /conv, /history, /status, /subagents, /help, /about.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { scaffoldHookPlugin } from '../../hooks/index.js';
import { err as errFmt } from '../../term.js';
import {
  WATCHDOG_RECOMMENDED_TUNING_TEXT,
  resolveWatchdogSettings,
  shouldRecommendWatchdogTuning,
} from '../../watchdog.js';
import type { SlashCommand } from '../command-registry.js';
import { restTokens } from '../command-utils.js';
import {
  conversationBranchPath,
  isSafeBranchName,
  saveSessionFile,
  listSavedSessions,
  listConversationBranches,
} from '../session-state.js';
import { formatStatusLine } from '../status.js';

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
          '/help /quit /edit [seed text] /about /mode [code|sys] /status /toolstats /watchdog [status] /hooks [status|errors|slow|plugins] /plugin init <name> [dir] [--force] /stats /server /perf /offline [on|off|status] /system [edit|reset|tokens] /lsp [status] /mcp [desc|restart <name>|enable <tool>|disable <tool>] /statusbar on|off /approval [mode] /plan /step [on|off] /approve [N] /reject /history /new /compact [topic|hard|dry] /init /git [/diff] /branch [name] /changes [--stat|--full|--since N|reset|<file>] /watch [off|status|<path...> [--max N]] /sessions /conv branch|branches|checkout|merge ... /cost /model <name> /escalate [next|N|model] /deescalate /capture on|off|last /index [run|status|stats|clear] /undo [path] /save <path> /load <path> /vault <query> /notes /note <key> <value> /checkpoints /rewind <id> /diff <id> /subagents [on|off] /theme [name|list] /vim /commands /exit-shell' +
          '\n' +
          ctx.S.dim('Shell: !<cmd> run once, !!<cmd> run + inject output, ! toggles shell mode') +
          '\n' +
          ctx.S.dim(
            'Templates: /fix /review /test /explain /refactor, plus custom markdown commands in ~/.config/idlehands/commands/'
          )
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
    name: '/version',
    description: 'Show version only',
    async execute(ctx) {
      console.log(ctx.version);
      return true;
    },
  },
  {
    name: '/status',
    async execute(ctx) {
      ctx.lastStatusLine = formatStatusLine(ctx.session, ctx.config, ctx.S);
      console.log(ctx.lastStatusLine);
      const getter = (ctx.session as any)?.getToolLoopStats;
      if (typeof getter === 'function') {
        const stats = getter();
        const t = stats?.telemetry;
        if (t) {
          const cachePct = Number.isFinite(t.readCacheHitRate)
            ? `${(t.readCacheHitRate * 100).toFixed(1)}%`
            : '0.0%';
          const dedupePct = Number.isFinite(t.dedupeRate)
            ? `${(t.dedupeRate * 100).toFixed(1)}%`
            : '0.0%';
          console.log(
            ctx.S.dim(
              `tool-loop: warn=${t.warnings} critical=${t.criticals} cache=${t.readCacheHits}/${t.readCacheLookups} (${cachePct}) dedupe=${t.dedupedReplays}/${t.callsRegistered} (${dedupePct})`
            )
          );
        }
      }
      return true;
    },
  },
  {
    name: '/toolstats',
    description: 'Show tool-loop guard signature/outcome stats for this session',
    async execute(ctx) {
      const getter = (ctx.session as any)?.getToolLoopStats;
      if (typeof getter !== 'function') {
        console.log('Tool-loop stats unavailable for this session.');
        return true;
      }

      const stats = getter();
      const sigs = Array.isArray(stats?.signatures) ? stats.signatures.slice(0, 8) : [];
      const outcomes = Array.isArray(stats?.outcomes) ? stats.outcomes.slice(0, 8) : [];
      const t = stats?.telemetry;

      console.log('Tool Loop Stats');
      console.log(`  History entries: ${Number(stats?.totalHistory ?? 0)}`);
      if (t) {
        const cachePct = Number.isFinite(t.readCacheHitRate)
          ? `${(t.readCacheHitRate * 100).toFixed(1)}%`
          : '0.0%';
        const dedupePct = Number.isFinite(t.dedupeRate)
          ? `${(t.dedupeRate * 100).toFixed(1)}%`
          : '0.0%';
        console.log(`  Calls registered: ${t.callsRegistered}`);
        console.log(`  Dedupe replays: ${t.dedupedReplays} (${dedupePct})`);
        console.log(`  Read-cache hits: ${t.readCacheHits}/${t.readCacheLookups} (${cachePct})`);
        console.log(
          `  Loop detections: warnings=${t.warnings}, critical=${t.criticals}, recovery=${t.recoveryRecommended}`
        );
      }
      console.log('  Top signatures:');
      if (!sigs.length) console.log('    (none)');
      else for (const row of sigs) console.log(`    - ${row.count}x ${row.signature}`);

      console.log('  Top outcome keys:');
      if (!outcomes.length) console.log('    (none)');
      else for (const row of outcomes) console.log(`    - ${row.count}x ${row.key}`);
      return true;
    },
  },
  {
    name: '/watchdog',
    description: 'Show active watchdog settings',
    async execute(ctx, args) {
      const arg = args.trim().toLowerCase();
      if (arg && arg !== 'status') {
        console.log('Usage: /watchdog or /watchdog status');
        return true;
      }

      const settings = resolveWatchdogSettings(undefined, ctx.config);

      const lines = [
        'Watchdog Status',
        `Timeout: ${settings.timeoutMs.toLocaleString()} ms (${Math.round(settings.timeoutMs / 1000)}s)`,
        `Max compactions: ${settings.maxCompactions}`,
        `Grace windows: ${settings.idleGraceTimeouts}`,
        `Debug abort reason: ${settings.debugAbortReason ? 'on' : 'off'}`,
      ];

      if (shouldRecommendWatchdogTuning(settings)) {
        lines.push('');
        lines.push(`Recommended tuning: ${WATCHDOG_RECOMMENDED_TUNING_TEXT}`);
      }

      console.log(lines.join('\n'));
      return true;
    },
  },
  {
    name: '/hooks',
    description: 'Inspect loaded hooks/plugins and runtime stats',
    async execute(ctx, args) {
      const mode = args.trim().toLowerCase();
      const manager = ctx.session?.hookManager;
      if (!manager || typeof manager.getSnapshot !== 'function') {
        console.log('Hooks: unavailable for this session.');
        return true;
      }

      const snap = manager.getSnapshot();
      const totalEvents = Object.values(snap.eventCounts).reduce(
        (a: number, b: any) => a + Number(b || 0),
        0
      );

      if (mode === 'errors') {
        console.log('Hook Errors (recent):');
        if (!snap.recentErrors.length) console.log('  none');
        else for (const e of snap.recentErrors) console.log(`  - ${e}`);
        return true;
      }

      if (mode === 'slow') {
        console.log('Slow Hook Handlers (recent):');
        if (!snap.recentSlowHandlers.length) console.log('  none');
        else for (const e of snap.recentSlowHandlers) console.log(`  - ${e}`);
        return true;
      }

      if (mode === 'plugins') {
        console.log('Hook Plugins:');
        if (!snap.plugins.length) console.log('  none');
        else {
          for (const p of snap.plugins) {
            console.log(`  - ${p.name} (${p.source})`);
            console.log(`      granted: ${p.grantedCapabilities.join(', ') || 'none'}`);
            if (p.deniedCapabilities.length) {
              console.log(`      denied:  ${p.deniedCapabilities.join(', ')}`);
            }
          }
        }
        return true;
      }

      if (mode && mode !== 'status') {
        console.log('Usage: /hooks [status|errors|slow|plugins]');
        return true;
      }

      const lines = [
        'Hooks Status',
        `Enabled: ${snap.enabled ? 'yes' : 'no'}`,
        `Strict mode: ${snap.strict ? 'yes' : 'no'}`,
        `Allowed capabilities: ${snap.allowedCapabilities.join(', ')}`,
        `Plugins: ${snap.plugins.length}`,
        `Handlers: ${snap.handlers.length}`,
        `Events observed: ${totalEvents}`,
        `Recent errors: ${snap.recentErrors.length}`,
        `Recent slow handlers: ${snap.recentSlowHandlers.length}`,
      ];
      console.log(lines.join('\n'));
      return true;
    },
  },
  {
    name: '/plugin',
    description: 'Scaffold hook plugins (/plugin init <name> [dir] [--force])',
    async execute(ctx, args) {
      const parts = restTokens(args);
      const sub = (parts[0] || '').toLowerCase();

      if (!sub || sub === 'help') {
        console.log('Usage: /plugin init <name> [dir] [--force]');
        return true;
      }

      if (sub !== 'init') {
        console.log('Usage: /plugin init <name> [dir] [--force]');
        return true;
      }

      const name = (parts[1] || '').trim();
      if (!name) {
        console.log('Usage: /plugin init <name> [dir] [--force]');
        return true;
      }

      const force = parts.includes('--force');
      const dirArg = parts.find((p, i) => i >= 2 && p !== '--force');
      const baseDir = dirArg
        ? path.resolve(ctx.config.dir || process.cwd(), dirArg)
        : path.resolve(ctx.config.dir || process.cwd(), 'plugins');

      try {
        const result = await scaffoldHookPlugin({
          pluginName: name,
          baseDir,
          force,
        });

        console.log(`Scaffolded plugin '${result.pluginName}' at ${result.targetDir}`);
        for (const f of result.files) console.log(`  - ${f}`);
        console.log('\nNext steps:');
        console.log(
          `1) Build plugin TS to JS (example target: ${path.join(result.targetDir, 'dist/index.js')})`
        );
        console.log('2) Add plugin path to config.hooks.plugin_paths');
        console.log('3) Restart Idle Hands');
      } catch (e: any) {
        console.error(errFmt(`PLUGIN: ${e?.message ?? String(e)}`, ctx.S));
      }

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
      console.log(
        `✅ Sub-agents ${enabled ? 'on' : 'off'}${!enabled ? ' — spawn_task disabled for this session' : ''}`
      );
      return true;
    },
  },
  {
    name: '/compact',
    description: 'Compact conversation history',
    async execute(ctx, args) {
      const hard = /^hard\b/i.test(args);
      const dry = /^dry\b/i.test(args);
      const topic = !hard && !dry && args ? args : undefined;

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
    async execute(_ctx) {
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
    async execute(ctx, _args, line) {
      const parts = restTokens(line);
      const sub = (parts[0] || '').toLowerCase();

      if (!sub || sub === 'help') {
        console.log(
          'Usage: /conv branch <name> | /conv branches | /conv checkout <name> | /conv merge <name>'
        );
        return true;
      }

      if (sub === 'branch') {
        const name = (parts[1] || '').trim();
        if (!name) {
          console.log('Usage: /conv branch <name>');
          return true;
        }
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
        const name = (parts[1] || '').trim();
        if (!name) {
          console.log('Usage: /conv checkout <name>');
          return true;
        }
        if (!isSafeBranchName(name)) {
          console.log('Invalid branch name.');
          return true;
        }
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
            try {
              ctx.session.setModel(String(parsed.model));
            } catch {}
          }
          console.log(`[conv] checked out '${name}' (${msgs.length} messages)`);
        } catch (e: any) {
          console.log(`Failed to load conversation branch '${name}': ${e?.message ?? e}`);
        }
        return true;
      }

      if (sub === 'merge') {
        const name = (parts[1] || '').trim();
        if (!name) {
          console.log('Usage: /conv merge <name>');
          return true;
        }
        if (!isSafeBranchName(name)) {
          console.log('Invalid branch name.');
          return true;
        }
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
          const toAppend = msgs.filter(
            (m: any, idx: number) => !(idx === 0 && m?.role === 'system')
          );
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

      console.log(
        'Usage: /conv branch <name> | /conv branches | /conv checkout <name> | /conv merge <name>'
      );
      return true;
    },
  },
];
