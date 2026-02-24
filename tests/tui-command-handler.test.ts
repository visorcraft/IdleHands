import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registerAll } from '../dist/cli/command-registry.js';
import { runSlashCommand } from '../dist/tui/command-handler.js';

describe('tui command handler live updates', () => {
  it('forwards emitRuntimeUpdate messages for long-running slash commands', async () => {
    const commandName = '/liveupdate-test';
    registerAll([
      {
        name: commandName,
        description: 'test command',
        async execute(ctx: any) {
          ctx.emitRuntimeUpdate?.('live update from command');
          console.log('done');
          return true;
        },
      },
    ]);

    const live: string[] = [];
    const result = await runSlashCommand(
      commandName,
      null,
      { anton: {} } as any,
      null,
      async () => {},
      (text) => live.push(text)
    );

    assert.equal(result.found, true);
    assert.match(result.output, /done/);
    assert.deepEqual(live, ['live update from command']);
  });
});
