/**
 * Editing/mode commands: /edit, /mode, /system, /approval, /plan, /step,
 * /approve, /reject, /vim, /theme, /quiet, /verbose, /normal.
 */

import { estimateTokensFromMessages } from '../../history.js';
import { setSafetyLogging } from '../../safety.js';
import { makeStyler, err as errFmt } from '../../term.js';
import { resolveTheme, listThemes } from '../../themes.js';
import { projectDir } from '../../utils.js';
import { runAgentTurnWithSpinner } from '../agent-turn.js';
import type { SlashCommand } from '../command-registry.js';
import { expandAtFileRefs, expandPromptImages } from '../input.js';
import { openEditorPrompt } from '../shell.js';
import { formatStatusLine } from '../status.js';

export const editingCommands: SlashCommand[] = [
  {
    name: '/edit',
    description: 'Open external editor for prompt',
    async execute(ctx, args) {
      const editRes = await openEditorPrompt(args, ctx.config.editor);
      if (!editRes.ok) {
        console.log(editRes.reason || 'Editor cancelled.');
        return true;
      }
      const expandedRes = await expandAtFileRefs(
        editRes.text || '',
        projectDir(ctx.config),
        ctx.config.context_max_tokens ?? 8192
      );
      for (const w of expandedRes.warnings) console.log(ctx.S.dim(w));
      const promptText = ctx.pendingTemplate
        ? `${ctx.pendingTemplate}\n\n${expandedRes.text}`
        : expandedRes.text;
      ctx.pendingTemplate = null;
      const imageExpanded = await expandPromptImages(
        promptText,
        projectDir(ctx.config),
        ctx.session.supportsVision
      );
      for (const w of imageExpanded.warnings) console.log(ctx.S.dim(w));
      ctx.lastRunnableInput = imageExpanded.content;
      try {
        const res = await runAgentTurnWithSpinner(ctx, imageExpanded.content);
        await ctx.maybeOfferAutoCommit(editRes.text || '/edit');
        if (ctx.config.verbose) {
          const { renderMarkdown } = await import('../../markdown.js');
          console.log(renderMarkdown(res.text, { color: ctx.S.enabled, verbose: true }));
        }
        ctx.lastStatusLine = formatStatusLine(ctx.session, ctx.config, ctx.S);
        console.log(ctx.lastStatusLine);
        if (ctx.statusBarEnabled) ctx.statusBar.render(ctx.lastStatusLine);
      } catch (e: any) {
        process.stdout.write('\n');
        console.error(errFmt(String(e?.message ?? e), ctx.S));
      }
      return true;
    },
  },
  {
    name: '/mode',
    description: 'Switch code/sys mode',
    async execute(ctx, args) {
      const arg = args.toLowerCase();
      if (!arg) {
        console.log(`Mode: ${ctx.S.bold(ctx.config.mode ?? 'code')}`);
      } else if (arg === 'code' || arg === 'sys') {
        ctx.config.mode = arg as any;
        if (ctx.config.mode === 'sys' && ctx.config.approval_mode === 'auto-edit') {
          ctx.config.approval_mode = 'default';
        }
        console.log(`Mode: ${ctx.S.bold(ctx.config.mode ?? 'code')}`);
        console.log(`Approval mode: ${ctx.S.bold(ctx.config.approval_mode)}`);
      } else {
        console.log('Invalid mode. Options: code, sys');
      }
      return true;
    },
  },
  {
    name: '/system',
    description: 'View/edit system prompt',
    async execute(ctx, args) {
      const arg = args.toLowerCase();
      if (!arg) {
        const prompt = ctx.session.getSystemPrompt();
        const tokens = estimateTokensFromMessages([{ role: 'system', content: prompt }]);
        console.log(ctx.S.dim(`System prompt (${tokens} tokens):`));
        console.log(prompt);
        return true;
      }
      if (arg === 'tokens') {
        const prompt = ctx.session.getSystemPrompt();
        const tokens = estimateTokensFromMessages([{ role: 'system', content: prompt }]);
        console.log(`System prompt tokens: ${tokens}`);
        return true;
      }
      if (arg === 'reset') {
        ctx.session.resetSystemPrompt();
        console.log('System prompt reset to default for this session');
        return true;
      }
      if (arg === 'edit') {
        const current = ctx.session.getSystemPrompt();
        const editRes = await openEditorPrompt(current, ctx.config.editor);
        if (!editRes.ok) {
          console.log(`System prompt unchanged (${editRes.reason ?? 'no changes'})`);
          return true;
        }
        const nextPrompt = (editRes.text ?? '').trim();
        if (!nextPrompt) {
          console.log('System prompt unchanged (empty prompt is not allowed)');
          return true;
        }
        try {
          ctx.session.setSystemPrompt(nextPrompt);
          const tokens = estimateTokensFromMessages([{ role: 'system', content: nextPrompt }]);
          console.log(`System prompt updated (${tokens} tokens)`);
        } catch (e: any) {
          console.log(`System prompt update failed: ${e?.message ?? e}`);
        }
        return true;
      }
      console.log('Usage: /system [edit|reset|tokens]');
      return true;
    },
  },
  {
    name: '/approval',
    description: 'Cycle/set approval mode',
    async execute(ctx, args) {
      const modes = ['plan', 'default', 'auto-edit', 'yolo'] as const;
      if (!args) {
        const idx = modes.indexOf(ctx.config.approval_mode as any);
        ctx.config.approval_mode = modes[(idx + 1) % modes.length];
        console.log(`Approval mode: ${ctx.S.bold(ctx.config.approval_mode)}`);
      } else if (modes.includes(args as any)) {
        ctx.config.approval_mode = args as any;
        console.log(`Approval mode: ${ctx.S.bold(ctx.config.approval_mode)}`);
      } else {
        console.log(`Invalid mode. Options: ${modes.join(', ')}`);
      }
      return true;
    },
  },
  {
    name: '/plan',
    description: 'Plan mode',
    async execute(ctx, args) {
      const arg = args.toLowerCase();
      if (arg === 'on' || arg === 'enable') {
        ctx.config.approval_mode = 'plan';
        console.log('Plan mode: on (approval_mode=plan)');
      } else if (arg === 'off' || arg === 'disable') {
        ctx.config.approval_mode = 'auto-edit';
        console.log('Plan mode: off (approval_mode=auto-edit)');
      } else if (!arg || arg === 'toggle') {
        ctx.config.approval_mode = ctx.config.approval_mode === 'plan' ? 'auto-edit' : 'plan';
        console.log(
          `Plan mode: ${ctx.config.approval_mode === 'plan' ? 'on' : 'off'} (approval_mode=${ctx.config.approval_mode})`
        );
      }
      if (['show', '', 'toggle', 'on', 'off', 'enable', 'disable'].includes(arg)) {
        const steps = ctx.session.planSteps;
        if (!steps.length) {
          console.log(ctx.S.dim('No plan steps accumulated.'));
        } else {
          console.log(ctx.S.bold(`Plan (${steps.length} steps):`));
          for (const step of steps) {
            const icon = step.executed
              ? ctx.S.green('[✓]')
              : step.blocked
                ? ctx.S.yellow('[▸]')
                : '[ ]';
            const result =
              step.executed && step.result ? ctx.S.dim(` → ${step.result.slice(0, 80)}`) : '';
            console.log(`  ${icon} #${step.index} ${step.summary}${result}`);
          }
          console.log(
            ctx.S.dim(
              `\nUse /approve to execute all, /approve <N> for a specific step, /reject to discard.`
            )
          );
        }
      } else if (
        arg !== 'on' &&
        arg !== 'off' &&
        arg !== 'enable' &&
        arg !== 'disable' &&
        arg !== 'toggle' &&
        arg !== 'show'
      ) {
        console.log('Usage: /plan [on|off|toggle|show]');
      }
      return true;
    },
  },
  {
    name: '/step',
    description: 'Toggle step-by-step mode',
    async execute(ctx, args) {
      const arg = args.toLowerCase();
      if (arg === 'on' || arg === 'enable') {
        ctx.config.step_mode = true;
      } else if (arg === 'off' || arg === 'disable') {
        ctx.config.step_mode = false;
      } else if (!arg || arg === 'toggle') {
        ctx.config.step_mode = !ctx.config.step_mode;
      } else {
        console.log('Usage: /step [on|off|toggle]');
        return true;
      }
      console.log(`Step mode: ${ctx.config.step_mode ? 'on' : 'off'}`);
      return true;
    },
  },
  {
    name: '/approve',
    description: 'Approve plan step(s)',
    async execute(ctx, args) {
      const steps = ctx.session.planSteps;
      if (!steps.length) {
        console.log(ctx.S.dim('No plan steps to approve.'));
        return true;
      }
      const idx = args ? parseInt(args, 10) : undefined;
      if (args && (isNaN(idx!) || idx! < 1 || idx! > steps.length)) {
        console.log(`Invalid step number. Range: 1–${steps.length}`);
        return true;
      }
      console.log(
        ctx.S.dim(
          `Executing ${idx != null ? `step #${idx}` : `all ${steps.filter((s: any) => s.blocked && !s.executed).length} blocked steps`}...`
        )
      );
      try {
        const results = await ctx.session.executePlanStep(idx);
        for (const r of results) console.log(`  ${r}`);
      } catch (e: any) {
        console.log(ctx.S.red(`Error executing plan: ${e?.message ?? e}`));
      }
      return true;
    },
  },
  {
    name: '/reject',
    description: 'Reject/clear plan',
    async execute(ctx) {
      const count = ctx.session.planSteps.filter((s: any) => s.blocked && !s.executed).length;
      ctx.session.clearPlan();
      console.log(`Plan discarded (${count} pending steps cleared).`);
      return true;
    },
  },
  {
    name: '/quiet',
    description: 'Quiet output mode',
    async execute(ctx) {
      ctx.config.quiet = true;
      ctx.config.verbose = false;
      ctx.session.setVerbose(false);
      setSafetyLogging(false);
      console.log('Output: quiet');
      return true;
    },
  },
  {
    name: '/verbose',
    description: 'Verbose output mode',
    async execute(ctx) {
      ctx.config.quiet = false;
      ctx.config.verbose = true;
      ctx.session.setVerbose(true);
      setSafetyLogging(true);
      console.log('Output: verbose');
      return true;
    },
  },
  {
    name: '/normal',
    description: 'Normal output mode',
    async execute(ctx) {
      ctx.config.quiet = false;
      ctx.config.verbose = false;
      ctx.session.setVerbose(false);
      setSafetyLogging(false);
      console.log('Output: normal');
      return true;
    },
  },
  {
    name: '/theme',
    description: 'Switch color theme',
    async execute(ctx, args) {
      const arg = args.toLowerCase();
      if (!arg || arg === 'list') {
        const available = await listThemes();
        const current = ctx.config.theme ?? 'default';
        console.log(`Current theme: ${ctx.S.bold(current)}`);
        console.log(
          `Built-in: ${available.builtin.map((t: string) => (t === current ? ctx.S.bold(ctx.S.cyan(t)) : t)).join(', ')}`
        );
        if (available.custom.length) {
          console.log(
            `Custom:   ${available.custom.map((t: string) => (t === current ? ctx.S.bold(ctx.S.cyan(t)) : t)).join(', ')}`
          );
        }
      } else {
        const fns = await resolveTheme(arg);
        if (fns) {
          ctx.config.theme = arg;
          ctx.S = makeStyler(ctx.enabled, fns);
          console.log(`Theme: ${ctx.S.bold(ctx.S.cyan(arg))}`);
        } else {
          console.log(`Unknown theme "${arg}". Use /theme list to see available themes.`);
        }
      }
      return true;
    },
  },
  {
    name: '/vim',
    description: 'Toggle vim mode',
    async execute(ctx) {
      ctx.config.vim_mode = !ctx.config.vim_mode;
      if (ctx.config.vim_mode) {
        ctx.vimState.mode = 'normal';
        ctx.vimState.pendingKey = '';
        const vimTag = ctx.S.dim('[N] ');
        const runModeTag = ctx.config.mode === 'sys' ? ctx.S.dim('[sys] ') : '';
        const approvalTag =
          ctx.config.approval_mode !== 'auto-edit'
            ? ctx.S.dim(`[${ctx.config.approval_mode}] `)
            : '';
        ctx.rl.setPrompt(vimTag + runModeTag + approvalTag + ctx.S.bold(ctx.S.cyan('> ')));
        console.log('Vim mode: on (Escape → normal, i → insert)');
      } else {
        ctx.vimState.mode = 'insert';
        const runModeTag = ctx.config.mode === 'sys' ? ctx.S.dim('[sys] ') : '';
        const approvalTag =
          ctx.config.approval_mode !== 'auto-edit'
            ? ctx.S.dim(`[${ctx.config.approval_mode}] `)
            : '';
        ctx.rl.setPrompt(runModeTag + approvalTag + ctx.S.bold(ctx.S.cyan('> ')));
        console.log('Vim mode: off');
      }
      return true;
    },
  },
];
