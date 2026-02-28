/**
 * Discord bot command handlers.
 *
 * Business logic lives in command-logic.ts; this file is a thin dispatcher
 * that maps Discord message → shared logic → Markdown reply.
 */

import path from 'node:path';

import type { Message } from 'discord.js';

import type { BotDiscordConfig, IdlehandsConfig } from '../types.js';
import { PKG_VERSION } from '../utils.js';
import {
  DISCORD_MODELS_PER_PAGE,
  buildRuntimeModelPickerPage,
  filterRuntimeModels,
  formatRuntimeModelPickerText,
  truncateLabel,
} from './runtime-model-picker.js';

import {
  startCommand,
  helpCommand,
  modelCommand,
  compactCommand,
  captureSetCommand,
  captureShowCommand,
  statusCommand,
  slotCommand,
  dirShowCommand,
  approvalShowCommand,
  approvalSetCommand,
  modeShowCommand,
  modeSetCommand,
  modeStatusCommand,
  routingModeShowCommand,
  routingModeSetCommand,
  routingModeStatusCommand,
  subagentsShowCommand,
  subagentsSetCommand,
  changesCommand,
  undoCommand,
  rollbackCommand,
  checkpointsCommand,
  budgetCommand,
  diffCommand,
  costCommand,
  metricsCommand,
  mcpDiscoverCommand,
  hooksCommand,
  vaultCommand,
  agentCommand,
  agentsCommand,
  escalateShowCommand,
  escalateSetCommand,
  deescalateCommand,
  gitStatusCommand,
  type CmdResult,
  type ManagedLike,
} from './command-logic.js';
import { detectRepoCandidates, expandHome, isPathAllowed } from './dir-guard.js';
import { performBotUpgrade } from './upgrade-command.js';
import { maybeAutoPinDiscordAntonStart } from './discord-anton-autopin.js';
import { handleDiscordAnton } from './discord-anton.js';
import { sendDiscordResult } from './discord-result.js';
import { splitDiscord } from './discord-routing.js';
import type { ManagedSession } from './discord.js';

const modelQueryRegistry = new Map<string, string>();
const MODEL_QUERY_REGISTRY_LIMIT = 200;

function registerModelQuery(query: string): string {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return '-';
  const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  modelQueryRegistry.set(key, trimmed);
  if (modelQueryRegistry.size > MODEL_QUERY_REGISTRY_LIMIT) {
    const oldest = modelQueryRegistry.keys().next().value;
    if (oldest) modelQueryRegistry.delete(oldest);
  }
  return key;
}

export function readDiscordModelQuery(key: string | undefined): string {
  if (!key || key === '-') return '';
  return modelQueryRegistry.get(key) ?? '';
}

export interface DiscordCommandContext {
  sendUserVisible: (msg: Message, text: string) => Promise<Message>;
  cancelActive: (managed: ManagedSession) => { message: string };
  recreateSession: (managed: ManagedSession, cfg: IdlehandsConfig) => Promise<void>;
  watchdogStatusText: (managed?: ManagedSession) => string;
  defaultDir: string;
  config: IdlehandsConfig;
  botConfig: BotDiscordConfig;
  approvalMode: string;
  maxQueue: number;
}

/**
 * Handle text-based commands from Discord messages.
 * Returns true if a command was handled, false if the message should be
 * processed as a regular agent message.
 */
export async function handleTextCommand(
  managed: ManagedSession,
  msg: Message,
  content: string,
  ctx: DiscordCommandContext
): Promise<boolean> {
  const {
    sendUserVisible,
    cancelActive,
    recreateSession,
    watchdogStatusText,
    defaultDir,
    config,
    botConfig,
    approvalMode,
    maxQueue,
  } = ctx;
  const m = managed as unknown as ManagedLike;
  const send = (r: CmdResult) => sendDiscordResult(msg, sendUserVisible, r);

  if (content === '/cancel') {
    const res = cancelActive(managed);
    await sendUserVisible(msg, res.message).catch(() => {});
    return true;
  }

  if (content === '/start') {
    await send(
      startCommand({
        model: managed.session.model,
        endpoint: managed.config.endpoint || '?',
        defaultDir: managed.config.dir || defaultDir,
        agentName: managed.agentPersona
          ? managed.agentPersona.display_name || managed.agentId
          : undefined,
      })
    );
    return true;
  }

  if (content === '/help') {
    await send(helpCommand('discord'));
    return true;
  }

  if (content === '/model') {
    await send(modelCommand(m));
    return true;
  }

  if (content === '/version') {
    await sendUserVisible(msg, `Idle Hands v${PKG_VERSION}`).catch(() => {});
    return true;
  }

  if (content === '/upgrade') {
    const channel = msg.channel as { send: (c: string) => Promise<any> };
    let statusMsg: any = null;
    const progressLines: string[] = [];

    const result = await performBotUpgrade(async (message) => {
      progressLines.push(message);
      const text = progressLines.join('\n');
      if (statusMsg && statusMsg.edit) {
        await statusMsg.edit(text).catch(() => {});
      } else {
        statusMsg = await channel.send(text).catch(() => null);
      }
    });

    // Send final result
    const finalText = progressLines.join('\n') + '\n\n' + result.message;
    if (statusMsg && statusMsg.edit) {
      await statusMsg.edit(finalText).catch(() => {});
    } else {
      await channel.send(finalText).catch(() => {});
    }
    return true;
  }

  if (content === '/compact') {
    await send(compactCommand(m));
    return true;
  }

  if (content === '/capture' || content.startsWith('/capture ')) {
    const arg = content.slice('/capture'.length).trim();
    if (!arg) {
      await send(captureShowCommand(m));
      return true;
    }

    const [modeToken, ...rest] = arg.split(/\s+/);
    const filePath = rest.join(' ').trim() || undefined;
    await send(await captureSetCommand(m, modeToken.toLowerCase(), filePath));
    return true;
  }

  if (content === '/dir' || content.startsWith('/dir ')) {
    const arg = content.slice('/dir'.length).trim();
    if (!arg) {
      await send(dirShowCommand(m));
      return true;
    }

    const resolvedDir = path.resolve(expandHome(arg));
    if (!isPathAllowed(resolvedDir, managed.allowedDirs)) {
      await sendUserVisible(
        msg,
        `❌ Directory not allowed. Allowed roots: ${managed.allowedDirs.map((d) => `\`${d}\``).join(', ')}`
      ).catch(() => {});
      return true;
    }

    const repoCandidates = await detectRepoCandidates(resolvedDir, managed.allowedDirs).catch(
      () => managed.repoCandidates
    );
    const cfg: IdlehandsConfig = {
      ...managed.config,
      dir: resolvedDir,
      allowed_write_roots: managed.allowedDirs,
      dir_pinned: true,
      repo_candidates: repoCandidates,
    };
    await recreateSession(managed, cfg);
    managed.dirPinned = true;
    managed.repoCandidates = repoCandidates;
    await sendUserVisible(msg, `✅ Working directory pinned to \`${resolvedDir}\``).catch(() => {});
    return true;
  }

  if (content === '/pin' || content.startsWith('/pin ')) {
    const arg = content.slice('/pin'.length).trim();
    const currentDir = managed.config.dir || defaultDir;
    if (!arg) {
      const resolvedDir = path.resolve(expandHome(currentDir));
      if (!isPathAllowed(resolvedDir, managed.allowedDirs)) {
        await sendUserVisible(
          msg,
          `❌ Directory not allowed. Allowed roots: ${managed.allowedDirs.map((d) => `\`${d}\``).join(', ')}`
        ).catch(() => {});
        return true;
      }

      const repoCandidates = await detectRepoCandidates(resolvedDir, managed.allowedDirs).catch(
        () => managed.repoCandidates
      );
      const cfg: IdlehandsConfig = {
        ...managed.config,
        dir: resolvedDir,
        allowed_write_roots: managed.allowedDirs,
        dir_pinned: true,
        repo_candidates: repoCandidates,
      };
      await recreateSession(managed, cfg);
      managed.dirPinned = true;
      managed.repoCandidates = repoCandidates;
      await sendUserVisible(msg, `✅ Working directory pinned to \`${resolvedDir}\``).catch(
        () => {}
      );
      return true;
    }
  }

  if (content === '/unpin' || content.startsWith('/unpin ')) {
    if (!managed.dirPinned) {
      await sendUserVisible(msg, 'Directory is not pinned.').catch(() => {});
      return true;
    }

    const currentDir = managed.config.dir || defaultDir;
    const resolvedDir = path.resolve(expandHome(currentDir));

    const repoCandidates = await detectRepoCandidates(resolvedDir, managed.allowedDirs).catch(
      () => managed.repoCandidates
    );
    const cfg: IdlehandsConfig = {
      ...managed.config,
      dir: undefined,
      allowed_write_roots: managed.allowedDirs,
      dir_pinned: false,
      repo_candidates: repoCandidates,
    };
    await recreateSession(managed, cfg);
    managed.dirPinned = false;
    managed.repoCandidates = repoCandidates;
    await sendUserVisible(
      msg,
      `✅ Directory unpinned. Working directory remains at \`${resolvedDir}\``
    ).catch(() => {});
    return true;
  }

  if (content === '/approval' || content.startsWith('/approval ')) {
    const arg = content.slice('/approval'.length).trim().toLowerCase();
    if (!arg) {
      await send(approvalShowCommand(m, approvalMode));
      return true;
    }
    const result = approvalSetCommand(m, arg);
    if (result) {
      await send(result);
    }
    return true;
  }

  if (content === '/mode' || content.startsWith('/mode ')) {
    const arg = content.slice('/mode'.length).trim().toLowerCase();
    if (!arg) {
      await send(modeShowCommand(m));
      return true;
    }
    // Handle status command
    if (arg === 'status') {
      await send(modeStatusCommand(m));
      return true;
    }
    await send(modeSetCommand(m, arg));
    return true;
  }

  if (content === '/routing_mode' || content.startsWith('/routing_mode ')) {
    const arg = content.slice('/routing_mode'.length).trim().toLowerCase();
    if (!arg) {
      await send(routingModeShowCommand(m));
      return true;
    }
    if (arg === 'status') {
      await send(routingModeStatusCommand(m));
      return true;
    }
    await send(routingModeSetCommand(m, arg));
    return true;
  }

  if (content === '/retry_fast') {
    // Set routing mode to fast
    await send(routingModeSetCommand(m, 'fast'));
    
    // Re-run the last task
    const lastInstruction = managed.session.lastAskInstructionText || '';
    if (!lastInstruction.trim()) {
      await send({ error: '❌ No previous task to retry.' });
      return true;
    }

    // Add to queue for re-processing with new routing mode
    const newMessage = {
      ...msg,
      content: lastInstruction,
    } as Message;

    managed.pendingQueue.push(newMessage);
    await sendUserVisible(msg, '🔄 Added to queue with routing mode set to `fast`.');
    return true;
  }

  if (content === '/retry_heavy') {
    // Set routing mode to heavy
    await send(routingModeSetCommand(m, 'heavy'));
    
    // Re-run the last task
    const lastInstruction = managed.session.lastAskInstructionText || '';
    if (!lastInstruction.trim()) {
      await send({ error: '❌ No previous task to retry.' });
      return true;
    }

    // Add to queue for re-processing with new routing mode
    const newMessage = {
      ...msg,
      content: lastInstruction,
    } as Message;

    managed.pendingQueue.push(newMessage);
    await sendUserVisible(msg, '🔄 Added to queue with routing mode set to `heavy`.');
    return true;
  }

  if (content === '/subagents' || content.startsWith('/subagents ')) {
    const arg = content.slice('/subagents'.length).trim().toLowerCase();
    if (!arg) {
      await send(subagentsShowCommand(m));
      return true;
    }
    await send(subagentsSetCommand(m, arg));
    return true;
  }

  if (content === '/changes') {
    await send(await changesCommand(m));
    return true;
  }

  if (content === '/undo') {
    await send(await undoCommand(m));
    return true;
  }

  if (content === '/rollback') {
    await send(rollbackCommand(m));
    return true;
  }

  if (content === '/checkpoints') {
    await send(checkpointsCommand(m));
    return true;
  }

  if (content === '/budget') {
    await send(budgetCommand(m));
    return true;
  }

  if (content === '/diff') {
    await send(diffCommand(m));
    return true;
  }

  if (content === '/cost') {
    await send(costCommand(m));
    return true;
  }

  if (content === '/metrics') {
    await send(metricsCommand(m));
    return true;
  }

  if (content === '/mcp_discover') {
    await send(await mcpDiscoverCommand(m));
    return true;
  }

  if (content === '/hooks' || content.startsWith('/hooks ')) {
    const arg = content.replace(/^\/hooks\s*/i, '').trim();
    await send(hooksCommand(m, arg));
    return true;
  }

  if (content === '/vault' || content.startsWith('/vault ')) {
    const query = content.slice('/vault'.length).trim();
    await send(await vaultCommand(m, query));
    return true;
  }

  if (content === '/status') {
    await send(statusCommand(m, { maxQueue }));
    return true;
  }

  if (content === '/slot') {
    await send(slotCommand(m));
    return true;
  }

  if (content === '/watchdog' || content === '/watchdog status') {
    await sendUserVisible(msg, watchdogStatusText(managed)).catch(() => {});
    return true;
  }

  if (content.startsWith('/watchdog ')) {
    await sendUserVisible(msg, 'Usage: /watchdog or /watchdog status').catch(() => {});
    return true;
  }

  if (content === '/agent') {
    await send(agentCommand(m));
    return true;
  }

  if (content === '/agents') {
    await send(
      agentsCommand(m, {
        agents: botConfig.agents,
        routing: botConfig.routing,
      })
    );
    return true;
  }

  if (content === '/escalate' || content.startsWith('/escalate ')) {
    const escalation = managed.agentPersona?.escalation;
    if (!escalation || !escalation.models?.length) {
      await sendUserVisible(msg, '❌ No escalation models configured for this agent.').catch(
        () => {}
      );
      return true;
    }

    const arg = content.slice('/escalate'.length).trim();

    if (!arg) {
      const currentModel = managed.config.model || config.model || 'default';
      await send(escalateShowCommand(m, currentModel));
      return true;
    }

    await send(escalateSetCommand(m, arg));
    return true;
  }

  if (content === '/deescalate') {
    const baseModel = managed.agentPersona?.model || config.model || 'default';
    const result = deescalateCommand(m, baseModel);

    if (result !== 'recreate') {
      await send(result);
      return true;
    }

    const cfg: IdlehandsConfig = {
      ...managed.config,
      model: baseModel,
    };
    await recreateSession(managed, cfg);
    await sendUserVisible(msg, `✅ Returned to base model: \`${baseModel}\``).catch(() => {});
    return true;
  }

  if (content === '/git_status') {
    const cwd = managed.config.dir || defaultDir;
    if (!cwd) {
      await sendUserVisible(msg, 'No working directory set. Use `/dir` to set one.').catch(
        () => {}
      );
      return true;
    }

    try {
      await send(await gitStatusCommand(cwd));
    } catch (e: any) {
      await sendUserVisible(msg, `❌ git status failed: ${e?.message ?? String(e)}`).catch(
        () => {}
      );
    }
    return true;
  }

  // ── Discord-only commands (runtime/infra) ──────────────────────────

  if (content === '/hosts') {
    try {
      const { loadRuntimes, redactConfig } = await import('../runtime/store.js');
      const rtConfig = await loadRuntimes();
      const redacted = redactConfig(rtConfig);
      if (!redacted.hosts.length) {
        await sendUserVisible(msg, 'No hosts configured. Use `idlehands hosts add` in CLI.').catch(
          () => {}
        );
        return true;
      }

      const lines = redacted.hosts.map(
        (h) =>
          `${h.enabled ? '🟢' : '🔴'} ${h.display_name} (\`${h.id}\`)\n  Transport: ${h.transport}`
      );

      const chunks = splitDiscord(lines.join('\n\n'));
      for (const [i, chunk] of chunks.entries()) {
        if (i === 0) await sendUserVisible(msg, chunk).catch(() => {});
        else await (msg.channel as any).send(chunk).catch(() => {});
      }
    } catch (e: any) {
      await sendUserVisible(msg, `❌ Failed to load hosts: ${e?.message ?? String(e)}`).catch(
        () => {}
      );
    }
    return true;
  }

  if (content === '/backends') {
    try {
      const { loadRuntimes, redactConfig } = await import('../runtime/store.js');
      const rtConfig = await loadRuntimes();
      const redacted = redactConfig(rtConfig);
      if (!redacted.backends.length) {
        await sendUserVisible(
          msg,
          'No backends configured. Use `idlehands backends add` in CLI.'
        ).catch(() => {});
        return true;
      }

      const lines = redacted.backends.map(
        (b) => `${b.enabled ? '🟢' : '🔴'} ${b.display_name} (\`${b.id}\`)\n  Type: ${b.type}`
      );

      const chunks = splitDiscord(lines.join('\n\n'));
      for (const [i, chunk] of chunks.entries()) {
        if (i === 0) await sendUserVisible(msg, chunk).catch(() => {});
        else await (msg.channel as any).send(chunk).catch(() => {});
      }
    } catch (e: any) {
      await sendUserVisible(msg, `❌ Failed to load backends: ${e?.message ?? String(e)}`).catch(
        () => {}
      );
    }
    return true;
  }

  if (content === '/models' || content.startsWith('/models ')) {
    try {
      const { loadRuntimes } = await import('../runtime/store.js');
      const { loadActiveRuntime } = await import('../runtime/executor.js');
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');

      const query = content
        .replace(/^\/models\s*/i, '')
        .trim();
      const queryKey = registerModelQuery(query);

      const rtConfig = await loadRuntimes();
      if (!rtConfig.models.length) {
        await sendUserVisible(msg, 'No runtime models configured.').catch(() => {});
        return true;
      }

      const filteredModels = filterRuntimeModels(rtConfig.models as any, query);
      if (!filteredModels.length) {
        const q = query ? ` matching "${truncateLabel(query, 48)}"` : '';
        await sendUserVisible(msg, `No enabled runtime models${q}.`).catch(() => {});
        return true;
      }

      const active = await loadActiveRuntime().catch(() => null);
      const modelPage = buildRuntimeModelPickerPage(filteredModels as any, {
        page: 0,
        perPage: DISCORD_MODELS_PER_PAGE,
        activeModelId: active?.modelId,
      });

      const rows: any[] = [];
      let row = new ActionRowBuilder<any>();
      for (const item of modelPage.items) {
        const btn = new ButtonBuilder()
          .setCustomId(`model_switch:${item.id}`)
          .setLabel(item.isActive ? `★${item.ordinal}` : String(item.ordinal))
          .setStyle(item.isActive ? ButtonStyle.Success : ButtonStyle.Primary);

        row.addComponents(btn);
        if (row.components.length >= 5) {
          rows.push(row);
          row = new ActionRowBuilder<any>();
        }
      }
      if (row.components.length > 0) rows.push(row);

      if (modelPage.totalPages > 1) {
        const navRow = new ActionRowBuilder<any>().addComponents(
          new ButtonBuilder()
            .setCustomId(
              modelPage.hasPrev ? `model_page:${modelPage.page - 1}:${queryKey}` : 'model_page_noop'
            )
            .setLabel('⬅ Prev')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!modelPage.hasPrev),
          new ButtonBuilder()
            .setCustomId(`model_page_status:${modelPage.page + 1}`)
            .setLabel(`${modelPage.page + 1}/${modelPage.totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(
              modelPage.hasNext ? `model_page:${modelPage.page + 1}:${queryKey}` : 'model_page_noop'
            )
            .setLabel('Next ➜')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!modelPage.hasNext)
        );
        rows.push(navRow);
      }

      const contentText = formatRuntimeModelPickerText(modelPage, {
        header: '📋 Select a model to switch to',
        maxDisplayName: 68,
        maxModelId: 72,
        query,
      });

      await (msg.channel as any)
        .send({
          content: contentText,
          components: rows.slice(0, 5),
        })
        .catch(() => {});
    } catch (e: any) {
      await sendUserVisible(
        msg,
        `❌ Failed to load runtime models: ${e?.message ?? String(e)}`
      ).catch(() => {});
    }
    return true;
  }

  if (content === '/rtstatus') {
    try {
      const { loadActiveRuntime } = await import('../runtime/executor.js');
      const active = await loadActiveRuntime();
      if (!active) {
        await sendUserVisible(msg, 'No active runtime.').catch(() => {});
        return true;
      }

      const lines = [
        'Active Runtime',
        `Model: \`${active.modelId}\``,
        `Backend: \`${active.backendId ?? 'none'}\``,
        `Hosts: ${active.hostIds.map((id: string) => `\`${id}\``).join(', ') || 'none'}`,
        `Healthy: ${active.healthy ? '✅ yes' : '❌ no'}`,
        `Endpoint: \`${active.endpoint ?? 'unknown'}\``,
        `Started: \`${active.startedAt}\``,
      ];

      const chunks = splitDiscord(lines.join('\n'));
      for (const [i, chunk] of chunks.entries()) {
        if (i === 0) await sendUserVisible(msg, chunk).catch(() => {});
        else await (msg.channel as any).send(chunk).catch(() => {});
      }
    } catch (e: any) {
      await sendUserVisible(
        msg,
        `❌ Failed to read runtime status: ${e?.message ?? String(e)}`
      ).catch(() => {});
    }
    return true;
  }

  if (content === '/switch' || content.startsWith('/switch ')) {
    try {
      const modelId = content.slice('/switch'.length).trim();
      if (!modelId) {
        await sendUserVisible(msg, 'Usage: /switch <model-id>').catch(() => {});
        return true;
      }

      const { plan } = await import('../runtime/planner.js');
      const { execute, loadActiveRuntime } = await import('../runtime/executor.js');
      const { loadRuntimes } = await import('../runtime/store.js');

      const rtConfig = await loadRuntimes();
      const active = await loadActiveRuntime();
      const forceRestart = active?.modelId === modelId;
      const planResult = plan({ modelId, mode: 'live', forceRestart }, rtConfig, active);

      if (!planResult.ok) {
        await sendUserVisible(msg, `❌ Plan failed: ${planResult.reason}`).catch(() => {});
        return true;
      }

      if (planResult.reuse) {
        await sendUserVisible(msg, '✅ Runtime already active and healthy.').catch(() => {});
        return true;
      }

      const statusMsg = await sendUserVisible(
        msg,
        `⏳ Switching to \`${planResult.model.display_name}\`...`
      ).catch(() => null);

      const execResult = await execute(planResult, {
        onStep: async (step, status) => {
          if (status === 'done' && statusMsg) {
            await statusMsg.edit(`⏳ ${step.description}... ✓`).catch(() => {});
          }
        },
        confirm: async (prompt) => {
          await sendUserVisible(msg, `⚠️ ${prompt}\nAuto-approving for bot context.`).catch(
            () => {}
          );
          return true;
        },
      });

      if (execResult.ok) {
        if (statusMsg) {
          await statusMsg
            .edit(`✅ Switched to \`${planResult.model.display_name}\``)
            .catch(() => {});
        } else {
          await sendUserVisible(msg, `✅ Switched to \`${planResult.model.display_name}\``).catch(
            () => {}
          );
        }
      } else {
        const err = `❌ Switch failed: ${execResult.error || 'unknown error'}`;
        if (statusMsg) {
          await statusMsg.edit(err).catch(() => {});
        } else {
          await sendUserVisible(msg, err).catch(() => {});
        }
      }
    } catch (e: any) {
      await sendUserVisible(msg, `❌ Switch failed: ${e?.message ?? String(e)}`).catch(() => {});
    }
    return true;
  }

  if (content === '/anton' || content.startsWith('/anton ')) {
    const args = content.replace(/^\/anton\s*/, '').trim();
    const autoPin = await maybeAutoPinDiscordAntonStart(
      managed,
      msg,
      args,
      defaultDir,
      recreateSession,
      sendUserVisible
    );
    if (autoPin.handled) return true;

    await handleDiscordAnton(managed, msg, content, ctx);
    return true;
  }

  return false;
}
