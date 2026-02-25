/**
 * Telegram runtime command handlers extracted from telegram.ts.
 * Handles /hosts, /backends, /models, /rtstatus, /switch and the
 * model-selection callback query.
 */

import path from 'node:path';

import type { Bot } from 'grammy';

/**
 * Register runtime-related command handlers on the bot instance.
 */
export function registerRuntimeCommands(bot: Bot): void {
  bot.command('hosts', async (ctx) => {
    try {
      const { loadRuntimes, redactConfig } = await import('../runtime/store.js');
      const config = await loadRuntimes();
      const redacted = redactConfig(config);
      if (!redacted.hosts.length) {
        await ctx.reply('No hosts configured. Use `idlehands hosts add` in CLI.');
        return;
      }
      const lines = redacted.hosts.map(
        (h) =>
          `${h.enabled ? '🟢' : '🔴'} *${h.display_name}* (\`${h.id}\`)\n  Transport: ${h.transport}`
      );
      await ctx.reply(lines.join('\n\n'), { parse_mode: 'Markdown' });
    } catch (e: any) {
      await ctx.reply(`❌ Failed to load hosts: ${e?.message ?? String(e)}`);
    }
  });

  bot.command('backends', async (ctx) => {
    try {
      const { loadRuntimes, redactConfig } = await import('../runtime/store.js');
      const config = await loadRuntimes();
      const redacted = redactConfig(config);
      if (!redacted.backends.length) {
        await ctx.reply('No backends configured. Use `idlehands backends add` in CLI.');
        return;
      }
      const lines = redacted.backends.map(
        (b) => `${b.enabled ? '🟢' : '🔴'} *${b.display_name}* (\`${b.id}\`)\n  Type: ${b.type}`
      );
      await ctx.reply(lines.join('\n\n'), { parse_mode: 'Markdown' });
    } catch (e: any) {
      await ctx.reply(`❌ Failed to load backends: ${e?.message ?? String(e)}`);
    }
  });

  const handleRuntimeModels = async (ctx: any) => {
    try {
      const { loadRuntimes } = await import('../runtime/store.js');
      const config = await loadRuntimes();
      if (!config.models.length) {
        await ctx.reply('No runtime models configured.');
        return;
      }

      const enabledModels = config.models.filter((m: any) => m.enabled);
      if (!enabledModels.length) {
        await ctx.reply('No enabled runtime models. Use `idlehands models enable <id>` in CLI.');
        return;
      }

      const buttons = enabledModels.map((m: any) => [
        {
          text: `🟢 ${m.display_name}`,
          callback_data: `model_select:${m.id}`,
        },
      ]);

      const keyboard: any[][] = [];
      for (let i = 0; i < buttons.length; i += 2) {
        const row = buttons.slice(i, i + 2).flat();
        keyboard.push(row);
      }

      await ctx.reply('📋 *Select a model to switch to:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (e: any) {
      await ctx.reply(`❌ Failed to load runtime models: ${e?.message ?? String(e)}`);
    }
  };

  bot.command('models', handleRuntimeModels);
  bot.command('rtmodels', handleRuntimeModels);

  bot.command('rtstatus', async (ctx) => {
    try {
      const { loadActiveRuntime } = await import('../runtime/executor.js');
      const active = await loadActiveRuntime();
      if (!active) {
        await ctx.reply('No active runtime.');
        return;
      }

      const lines = [
        '*Active Runtime*',
        `Model: \`${active.modelId}\``,
        `Backend: \`${active.backendId ?? 'none'}\``,
        `Hosts: ${active.hostIds.map((id) => `\`${id}\``).join(', ') || 'none'}`,
        `Healthy: ${active.healthy ? '✅ yes' : '❌ no'}`,
        `Endpoint: \`${active.endpoint ?? 'unknown'}\``,
        `Started: \`${active.startedAt}\``,
      ];
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (e: any) {
      await ctx.reply(`❌ Failed to read runtime status: ${e?.message ?? String(e)}`);
    }
  });

  bot.command('upgrade', async (ctx) => {
    try {
      const { performBotUpgrade } = await import('./upgrade-command.js');
      const statusMsg = await ctx.reply('🔄 Starting upgrade...');
      const progressLines: string[] = [];

      const result = await performBotUpgrade(async (message) => {
        progressLines.push(message);
        const text = progressLines.join('\n');
        await ctx.api
          .editMessageText(ctx.chat.id, statusMsg.message_id, text)
          .catch(() => {});
      });

      const finalText = progressLines.join('\n') + '\n\n' + result.message;
      await ctx.api
        .editMessageText(ctx.chat.id, statusMsg.message_id, finalText)
        .catch(() => {});
    } catch (e: any) {
      await ctx.reply(`❌ Upgrade failed: ${e?.message ?? String(e)}`);
    }
  });

  bot.command('check_template', async (ctx) => {
    try {
      const modelId = ctx.match?.toString().trim();
      const { loadRuntimes, saveRuntimes } = await import('../runtime/store.js');
      const { checkTemplate, checkAndFixTemplate } = await import('../runtime/template-check.js');

      const rtConfig = await loadRuntimes();

      if (!modelId) {
        // Check all enabled models
        await ctx.reply('🔍 Checking templates for all models...');
        const results: string[] = [];
        for (const model of rtConfig.models.filter((m) => m.enabled)) {
          const r = await checkTemplate(model, rtConfig);
          const runIcon = r.runningTemplate === 'passed-in' ? '🟢' :
            r.runningTemplate === 'embedded' ? '🔴' : '⚫';
          const runLabel = r.runningTemplate === 'passed-in' ? 'passed-in' :
            r.runningTemplate === 'embedded' ? 'embedded' : 'not running';
          if (r.error) {
            results.push(`⚠️ *${model.id}* [${runIcon} ${runLabel}]: ${r.error}`);
          } else if (r.match === true) {
            results.push(`✅ *${model.id}* [${runIcon} ${runLabel}]: GGUF matches HF`);
          } else {
            results.push(`❌ *${model.id}* [${runIcon} ${runLabel}]: MISMATCH`);
          }
        }
        await ctx.reply(results.join('\n'), { parse_mode: 'Markdown' });
        return;
      }

      const model = rtConfig.models.find((m) => m.id === modelId);
      if (!model) {
        await ctx.reply(`❌ Model not found: ${modelId}`);
        return;
      }

      await ctx.reply(`🔍 Checking template for *${modelId}*...`, { parse_mode: 'Markdown' });

      const result = await checkAndFixTemplate(model, rtConfig);

      const lines: string[] = [];
      lines.push(`📋 *Template Check: ${modelId}*`);
      lines.push(`Source: \`${path.basename(model.source)}\``);
      lines.push(`HF Repo: ${result.hfRepoUrl || 'unknown'}`);
      lines.push(`GGUF template: ${result.ggufTemplate ? `${result.ggufTemplate.length} chars` : 'not found'}`);
      lines.push(`HF template: ${result.hfTemplate ? `${result.hfTemplate.length} chars` : 'not found'}`);

      const runIcon = result.runningTemplate === 'passed-in' ? '🟢' :
        result.runningTemplate === 'embedded' ? '🔴' : '⚫';
      if (result.runningTemplate === 'passed-in') {
        lines.push(`Running: ${runIcon} Using passed-in template: \`${result.runningTemplatePath}\``);
      } else if (result.runningTemplate === 'embedded') {
        lines.push(`Running: ${runIcon} Using embedded GGUF template (may be incorrect)`);
      } else if (result.runningTemplate === 'not-running') {
        lines.push(`Running: ${runIcon} Not running`);
      }

      if (result.error) {
        lines.push(`\n⚠️ ${result.error}`);
      } else if (result.match === true) {
        lines.push('\n✅ Templates match — no action needed');
      } else if (result.fixed) {
        lines.push(`\n❌ MISMATCH detected`);
        lines.push(`✅ Fixed: saved correct template to \`${result.templatePath}\``);
        lines.push(`Updated model config with \`chat_template: "${model.chat_template}"\``);
        // Save the updated config
        await saveRuntimes(rtConfig);
        lines.push('💾 runtimes.json saved');
      } else {
        lines.push('\n❌ MISMATCH detected but could not auto-fix');
      }

      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (e: any) {
      await ctx.reply(`❌ check_template error: ${e?.message ?? String(e)}`);
    }
  });

  bot.command('switch', async (ctx) => {
    try {
      const modelId = ctx.match?.trim();
      if (!modelId) {
        await ctx.reply('Usage: /switch <model-id>');
        return;
      }

      const { plan } = await import('../runtime/planner.js');
      const { execute, loadActiveRuntime } = await import('../runtime/executor.js');
      const { loadRuntimes } = await import('../runtime/store.js');

      const rtConfig = await loadRuntimes();
      const active = await loadActiveRuntime();
      const forceRestart = active?.modelId === modelId;
      const result = plan({ modelId, mode: 'live', forceRestart }, rtConfig, active);

      if (!result.ok) {
        await ctx.reply(`❌ Plan failed: ${result.reason}`);
        return;
      }

      if (result.reuse) {
        await ctx.reply('✅ Runtime already active and healthy.');
        return;
      }

      const statusMsg = await ctx.reply(`⏳ Switching to *${result.model.display_name}*...`, {
        parse_mode: 'Markdown',
      });

      const execResult = await execute(result, {
        onStep: async (step, status) => {
          if (status === 'done') {
            await ctx.api
              .editMessageText(ctx.chat.id, statusMsg.message_id, `⏳ ${step.description}... ✓`)
              .catch(() => {});
          }
        },
        confirm: async (prompt) => {
          await ctx.reply(`⚠️ ${prompt}\nAuto-approving for bot context.`);
          return true;
        },
      });

      if (execResult.ok) {
        await ctx.reply(`✅ Switched to *${result.model.display_name}*`, {
          parse_mode: 'Markdown',
        });
      } else {
        await ctx.reply(`❌ Switch failed: ${execResult.error || 'unknown error'}`);
      }
    } catch (e: any) {
      await ctx.reply(`❌ Switch failed: ${e?.message ?? String(e)}`);
    }
  });
}

/**
 * Handle the model_select callback query from inline keyboard buttons.
 * Returns true if handled, false if the callback is not a model selection.
 */
export async function handleModelSelectCallback(ctx: any): Promise<boolean> {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith('model_select:')) return false;

  const modelId = data.slice('model_select:'.length);
  await ctx.answerCallbackQuery({ text: `Switching to ${modelId}...` }).catch(() => {});

  try {
    const { plan } = await import('../runtime/planner.js');
    const { execute, loadActiveRuntime } = await import('../runtime/executor.js');
    const { loadRuntimes } = await import('../runtime/store.js');

    const rtConfig = await loadRuntimes();
    const active = await loadActiveRuntime();
    const forceRestart = active?.modelId === modelId;
    const result = plan({ modelId, mode: 'live', forceRestart }, rtConfig, active);

    if (!result.ok) {
      await ctx.editMessageText(`❌ Plan failed: ${result.reason}`).catch(() => {});
      return true;
    }

    if (result.reuse) {
      await ctx
        .editMessageText(`✅ Already using *${result.model.display_name}*`, {
          parse_mode: 'Markdown',
        })
        .catch(() => {});
      return true;
    }

    const execResult = await execute(result, {
      onStep: async (step, status) => {
        if (status === 'done') {
          await ctx.editMessageText(`⏳ ${step.description}... ✓`).catch(() => {});
        }
      },
      confirm: async (prompt) => {
        await ctx.reply(`⚠️ ${prompt}\nAuto-approving for bot context.`);
        return true;
      },
    });

    if (execResult.ok) {
      await ctx
        .editMessageText(`✅ Switched to *${result.model.display_name}*`, {
          parse_mode: 'Markdown',
        })
        .catch(() => {});
    } else {
      await ctx
        .editMessageText(`❌ Switch failed: ${execResult.error || 'unknown error'}`)
        .catch(() => {});
    }
  } catch (e: any) {
    await ctx.editMessageText(`❌ Switch failed: ${e?.message ?? String(e)}`).catch(() => {});
  }
  return true;
}
