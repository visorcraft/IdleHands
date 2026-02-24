/**
 * TUI /upgrade command — self-upgrade IdleHands.
 */

import type { SlashCommand } from '../command-registry.js';

export const upgradeCommands: SlashCommand[] = [
  {
    name: '/upgrade',
    description: 'Upgrade IdleHands to the latest version',
    async execute(ctx) {
      const { performBotUpgrade } = await import('../../bot/upgrade-command.js');

      console.log('🔄 Starting upgrade...\n');

      const result = await performBotUpgrade(async (message) => {
        // Strip markdown bold for terminal output
        const plain = message.replace(/\*\*/g, '');
        console.log(plain);
      });

      // Print final result
      const finalMessage = result.message.replace(/\*\*/g, '');
      console.log('\n' + finalMessage);

      if (result.needsRestart && result.success) {
        console.log('\n⚠️  Please restart idlehands to use the new version.');
        console.log('   Run: idlehands (or restart your bot service)');
      }

      return true;
    },
  },
];
