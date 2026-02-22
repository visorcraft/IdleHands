import type { SlashCommand } from '../command-registry.js';
import {
  runBackendsSubcommand,
  runHostsSubcommand,
  runModelsSubcommand,
  runSelectSubcommand,
} from '../runtime-cmds.js';

export const runtimeCommands: SlashCommand[] = [
  {
    name: '/hosts',
    description: 'List runtime hosts',
    async execute(ctx) {
      await runHostsSubcommand({ _: ['hosts'] }, ctx.config);
      return true;
    },
  },
  {
    name: '/backends',
    description: 'List runtime backends',
    async execute(ctx) {
      await runBackendsSubcommand({ _: ['backends'] }, ctx.config);
      return true;
    },
  },
  {
    name: '/models',
    aliases: ['/runtimes'],
    description: 'List runtime models',
    async execute(ctx) {
      await runModelsSubcommand({ _: ['models'] }, ctx.config);
      return true;
    },
  },
  {
    name: '/runtime',
    description: 'Show active runtime status',
    async execute() {
      const { loadActiveRuntime } = await import('../../runtime/executor.js');
      const active = await loadActiveRuntime();
      if (!active) {
        console.log('No active runtime.');
      } else {
        console.log(`Active runtime:`);
        console.log(`  Model:   ${active.modelId}`);
        if (active.backendId) console.log(`  Backend: ${active.backendId}`);
        console.log(`  Hosts:   ${active.hostIds.join(', ')}`);
        console.log(`  Healthy: ${active.healthy ? 'yes' : 'no'}`);
        console.log(`  Started: ${active.startedAt}`);
      }
      return true;
    },
  },
  {
    name: '/select',
    description: 'Switch runtime model',
    async execute(_ctx, args) {
      const model = (args || '').trim();
      if (!model) {
        console.log('Usage: /select <model-id>');
        return true;
      }
      await runSelectSubcommand({ _: ['select'], model }, _ctx.config);
      return true;
    },
  },
  {
    name: '/restart-bot',
    description: 'Restart the idlehands-bot service',
    async execute() {
      const { spawn } = await import('node:child_process');
      console.log('🔄 Restarting idlehands-bot service...');
      spawn('systemctl', ['--user', 'restart', 'idlehands-bot'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return true;
    },
  },
];
