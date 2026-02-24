/**
 * Shared helper: run an agent turn with spinner, hooks, and git change summary.
 *
 * Deduplicates the identical spinner+hooks+ask+changes pattern used in:
 * - REPL agent turn (index.ts)
 * - /edit command (commands/editing.ts)
 * - watch mode re-run (index.ts runWatchPrompt)
 */

import type { AgentHooks } from '../agent.js';
import type { UserContent } from '../types.js';
import { projectDir } from '../utils.js';

import { getGitShortStat } from './init.js';
import type { ReplContext } from './repl-context.js';

export interface AgentTurnResult {
  text: string;
  turns?: number;
  toolCalls?: number;
}

/**
 * Runs session.ask() wrapped in a CliSpinner with appropriate hooks,
 * prints git change summary if files were modified, and returns the result.
 */
export async function runAgentTurnWithSpinner(
  ctx: ReplContext,
  input: UserContent
): Promise<AgentTurnResult> {
  const { CliSpinner } = await import('../spinner.js');
  const spinner = new CliSpinner({ styler: ctx.S, verbose: ctx.config.verbose });
  spinner.start();

  const uiMode = ctx.config.verbose ? 'verbose' : ctx.config.quiet ? 'quiet' : 'normal';
  const hooks: AgentHooks =
    uiMode === 'quiet'
      ? {
          onToken: (t) => {
            spinner.onFirstDelta();
            process.stdout.write(t);
          },
          onFirstDelta: () => spinner.onFirstDelta(),
          onTurnEnd: (stats) => ctx.maybePrintTurnMetrics(stats),
        }
      : {
          onToken: (t) => {
            spinner.onFirstDelta();
            process.stdout.write(t);
          },
          onFirstDelta: () => spinner.onFirstDelta(),
          onToolCall: (e) => spinner.onToolCall(e),
          onToolResult: (e) => spinner.onToolResult(e),
          onTurnEnd: (stats) => ctx.maybePrintTurnMetrics(stats),
        };

  const prevEditedPath = ctx.session.lastEditedPath;

  let askInput = input;
  if (ctx.antonActive) {
    if (typeof askInput === 'string') {
      askInput = `${askInput}\n\n[System Runtime Context: Anton task runner is CURRENTLY ACTIVE and running autonomously in the background for this project.]`;
    } else if (
      Array.isArray(askInput) &&
      askInput.length > 0 &&
      typeof askInput[0] === 'object' &&
      askInput[0].type === 'text'
    ) {
      const texts = [...askInput];
      const first = texts[0] as { type: 'text'; text: string };
      texts[0] = {
        type: 'text',
        text: `${first.text}\n\n[System Runtime Context: Anton task runner is CURRENTLY ACTIVE and running autonomously in the background for this project.]`,
      };
      askInput = texts;
    }
  }

  const res = await ctx.session.ask(askInput, hooks);
  spinner.stop();
  process.stdout.write('\n');

  if (ctx.session.lastEditedPath && ctx.session.lastEditedPath !== prevEditedPath) {
    const short = getGitShortStat(projectDir(ctx.config));
    if (short && ctx.config.show_change_summary !== false) {
      console.log(`[changes] ${short}`);
    }
  }

  return res;
}
