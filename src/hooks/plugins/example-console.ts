import type { HookPlugin } from '../types.js';

/**
 * Example hook plugin.
 *
 * Configure in config.json:
 * {
 *   "hooks": {
 *     "plugin_paths": ["./dist/hooks/plugins/example-console.js"]
 *   }
 * }
 */
const plugin: HookPlugin = {
  name: 'example-console',
  hooks: {
    ask_start: ({ askId, instruction }, ctx) => {
      const preview = instruction.length > 120 ? `${instruction.slice(0, 120)}…` : instruction;
      console.error(
        `[hook:example-console] ask_start ${askId} model=${ctx.model} prompt=${preview}`
      );
    },
    ask_end: ({ askId, turns, toolCalls }) => {
      console.error(
        `[hook:example-console] ask_end ${askId} turns=${turns} toolCalls=${toolCalls}`
      );
    },
  },
};

export default plugin;
