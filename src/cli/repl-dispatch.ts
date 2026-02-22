import { expandArgs } from '../commands.js';
import { warn as warnFmt, err as errFmt } from '../term.js';
import { projectDir } from '../utils.js';

import { findCommand } from './command-registry.js';
import { splitTokens } from './command-utils.js';
import type { ReplContext } from './repl-context.js';
import { runDirectShellCommand } from './shell.js';

export type SessionLike = {
  messages: Array<{ role: string; content: unknown }>;
};

export type ReplPreTurnResult = {
  handled: boolean;
  line: string;
};

/**
 * Handle REPL pre-turn dispatch:
 * - direct shell execution
 * - slash command registry execution
 * - template queueing
 * - custom command expansion
 */
export async function runReplPreTurn(opts: {
  line: string;
  ctx: ReplContext;
  session: SessionLike;
  config: { mode: string; context_max_tokens?: number } & Record<string, unknown>;
  promptTemplates: Record<string, string>;
}): Promise<ReplPreTurnResult> {
  let line = opts.line;
  const { ctx, session, config, promptTemplates } = opts;
  let S = ctx.S;

  // Direct shell execution
  const shouldRunShell = (ctx.shellMode && !line.startsWith('/')) || /^!{1,2}\s*\S/.test(line);
  if (shouldRunShell) {
    const injectOutput = !ctx.shellMode && line.startsWith('!!');
    const command = ctx.shellMode ? line : line.slice(injectOutput ? 2 : 1).trim();
    if (!command) {
      console.log('Usage: !<command> (or !!<command> to also inject output into context)');
      return { handled: true, line };
    }

    const timeoutSec = config.mode === 'sys' ? 60 : 30;
    console.log(S.dim(`[shell] $ ${command}`));
    const result = await runDirectShellCommand({
      command,
      cwd: projectDir(config as any),
      timeoutSec,
      onStart: (proc) => {
        ctx.activeShellProc = proc;
      },
      onStop: () => {
        ctx.activeShellProc = null;
      },
    });

    if (result.timedOut) console.log(warnFmt(`[shell] killed after ${timeoutSec}s timeout`, S));
    if (!result.timedOut && result.rc !== 0)
      console.log(warnFmt(`[shell] exited with rc=${result.rc}`, S));

    if (injectOutput) {
      const merged = `${result.out}${result.err}`.slice(-4000);
      session.messages.push({ role: 'user', content: `[Shell output]\n$ ${command}\n${merged}` });
      console.log(S.dim('[shell] output injected into conversation context.'));
    }

    return { handled: true, line };
  }

  // Slash command dispatch via registry
  const slashTokens = splitTokens(line);
  const slashHead = (slashTokens[0] ?? '').toLowerCase();
  const slashRest = slashTokens.slice(1);

  const registeredCmd = findCommand(line);
  if (registeredCmd) {
    const cmdArgs = line.replace(/^\S+\s*/, '').trim();
    try {
      const handled = await registeredCmd.execute(ctx, cmdArgs, line);
      S = ctx.S; // sync in case command changed styler (e.g. /theme)
      if (handled) return { handled: true, line };
    } catch (e: any) {
      console.error(errFmt(`${registeredCmd.name}: ${e?.message ?? String(e)}`, S));
      return { handled: true, line };
    }
  }

  // Template expansion (fall through to agent turn)
  if (line.startsWith('/') && Object.prototype.hasOwnProperty.call(promptTemplates, slashHead)) {
    const template = promptTemplates[slashHead];
    ctx.pendingTemplate = template;
    console.log(S.dim(`[template] queued from ${slashHead}. Your next prompt will be prefixed.`));
    return { handled: true, line };
  }

  // Custom command expansion (modifies line, falls through to agent turn)
  if (line.startsWith('/') && ctx.customCommands.has(slashHead)) {
    const cmd = ctx.customCommands.get(slashHead)!;
    const expanded = expandArgs(cmd.template, slashRest).trim();
    if (!expanded) {
      console.log(warnFmt(`[command] ${slashHead} expanded to empty prompt.`, S));
      return { handled: true, line };
    }
    line = expanded;
    console.log(S.dim(`[command] ${slashHead} → prompt injected (${cmd.source})`));
  }

  return { handled: false, line };
}
