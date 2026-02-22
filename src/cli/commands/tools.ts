/**
 * Tool commands: /lsp, /mcp, /commands.
 */

import { loadCustomCommands } from '../../commands.js';
import { projectDir } from '../../utils.js';
import type { SlashCommand } from '../command-registry.js';
import { restTokens } from '../command-utils.js';

export const toolCommands: SlashCommand[] = [
  {
    name: '/lsp',
    description: 'LSP server status',
    async execute(ctx, args) {
      const sub = (restTokens(args)[0] || '').toLowerCase();
      if (!sub || sub === 'status' || sub === 'list') {
        const servers = ctx.session.listLspServers();
        if (!servers.length) {
          console.log('LSP: not configured (set lsp.enabled=true in config)');
        } else {
          console.log(ctx.S.bold(`LSP servers (${servers.length}):`));
          for (const s of servers) {
            const state = s.running ? ctx.S.green('running') : ctx.S.red('stopped');
            console.log(`  ${s.language}: ${s.command} ${state}`);
          }
        }
      } else {
        console.log('Usage: /lsp [status]');
      }
      return true;
    },
  },
  {
    name: '/mcp',
    description: 'MCP server management',
    async execute(ctx, args, _line) {
      const parts = restTokens(args);
      const sub = (parts[0] || '').toLowerCase();

      if (!sub || sub === 'list' || sub === 'status') {
        const servers = ctx.session.listMcpServers();
        if (!servers.length) {
          console.log('MCP: not configured');
          return true;
        }
        console.log(ctx.S.bold(`MCP servers (${servers.length}):`));
        for (const s of servers) {
          const state = s.connected ? ctx.S.green('connected') : ctx.S.red('disconnected');
          const suffix = s.error ? ctx.S.dim(` — ${s.error}`) : '';
          console.log(
            `- ${s.name} (${s.transport}) ${state} | tools ${s.toolsEnabled}/${s.toolsTotal}${suffix}`
          );
        }
        const warnings = ctx.session.mcpWarnings();
        for (const w of warnings) console.log(ctx.S.dim(`[mcp] ${w}`));
        return true;
      }

      if (sub === 'desc') {
        const tools = ctx.session.listMcpTools({ includeDisabled: true });
        if (!tools.length) {
          console.log('MCP: no tools discovered');
          return true;
        }
        console.log(ctx.S.bold(`MCP tools (${tools.length}):`));
        for (const t of tools) {
          const state = t.enabled ? ctx.S.green('enabled') : ctx.S.dim('disabled');
          const ro = t.readOnly ? ctx.S.dim('ro') : ctx.S.dim('rw');
          const desc = t.description ? ` — ${t.description}` : '';
          console.log(
            `- ${t.name} [${t.server}] (${ro}, ~${t.estimatedTokens} tok) ${state}${desc}`
          );
        }
        return true;
      }

      if (sub === 'restart') {
        const name = parts.slice(1).join(' ').trim();
        if (!name) {
          console.log('Usage: /mcp restart <name>');
          return true;
        }
        const res = await ctx.session.restartMcpServer(name);
        console.log(res.ok ? res.message : `MCP restart failed: ${res.message}`);
        return true;
      }

      if (sub === 'enable') {
        const tool = parts.slice(1).join(' ').trim();
        if (!tool) {
          console.log('Usage: /mcp enable <tool>');
          return true;
        }
        const ok = ctx.session.enableMcpTool(tool);
        console.log(
          ok
            ? `MCP tool enabled: ${tool}`
            : `Could not enable MCP tool: ${tool} (not found or exceeds budget)`
        );
        return true;
      }

      if (sub === 'disable') {
        const tool = parts.slice(1).join(' ').trim();
        if (!tool) {
          console.log('Usage: /mcp disable <tool>');
          return true;
        }
        const ok = ctx.session.disableMcpTool(tool);
        console.log(ok ? `MCP tool disabled: ${tool}` : `Could not disable MCP tool: ${tool}`);
        return true;
      }

      console.log('Usage: /mcp [status|desc|restart <name>|enable <tool>|disable <tool>]');
      return true;
    },
  },
  {
    name: '/commands',
    description: 'Reload/list custom commands',
    async execute(ctx) {
      ctx.customCommands = await loadCustomCommands(projectDir(ctx.config));
      if (!ctx.customCommands.size) {
        console.log(ctx.S.dim('No custom commands found.'));
        console.log(
          ctx.S.dim('Create command files in ~/.config/idlehands/commands/ or .idlehands/commands/')
        );
      } else {
        console.log(ctx.S.bold(`Custom commands (${ctx.customCommands.size}):`));
        const rows = [...ctx.customCommands.values()].sort((a: any, b: any) =>
          a.key.localeCompare(b.key)
        );
        for (const cmd of rows) {
          const cmdArgs = cmd.args.length ? ` ${cmd.args.map((a: any) => `<${a}>`).join(' ')}` : '';
          const desc = cmd.description ? ` — ${cmd.description}` : '';
          const src = cmd.source === 'project' ? 'project' : 'global';
          console.log(`  ${ctx.S.cyan(cmd.key)}${cmdArgs}${ctx.S.dim(` (${src})`)}${desc}`);
        }
      }
      return true;
    },
  },
];
