/**
 * Discord bot command handlers.
 *
 * Business logic lives in command-logic.ts; this file is a thin dispatcher
 * that maps Discord message → shared logic → Markdown reply.
 */

import path from 'node:path';

import type { Message } from 'discord.js';

import { firstToken } from '../cli/command-utils.js';
import type { BotDiscordConfig, IdlehandsConfig } from '../types.js';
import { PKG_VERSION } from '../utils.js';

import { formatMarkdown } from './command-format.js';
import {
  versionCommand,
  startCommand,
  helpCommand,
  modelCommand,
  compactCommand,
  statusCommand,
  watchdogCommand,
  dirShowCommand,
  approvalShowCommand,
  approvalSetCommand,
  modeShowCommand,
  modeSetCommand,
  subagentsShowCommand,
  subagentsSetCommand,
  changesCommand,
  undoCommand,
  vaultCommand,
  agentCommand,
  agentsCommand,
  escalateShowCommand,
  escalateSetCommand,
  deescalateCommand,
  gitStatusCommand,
  antonCommand,
  type ManagedLike,
} from './command-logic.js';
import {
  detectRepoCandidates,
  expandHome,
  isPathAllowed,
} from './dir-guard.js';
import {
  splitDiscord,
} from './discord-routing.js';

// Type-only import to avoid circular runtime dependency
import type { ManagedSession } from './discord.js';

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

/** Send a CmdResult formatted as Discord Markdown. */
async function sendResult(
  msg: Message,
  sendUserVisible: DiscordCommandContext['sendUserVisible'],
  result: Parameters<typeof formatMarkdown>[0],
): Promise<void> {
  const text = formatMarkdown(result);
  if (!text) return;
  await sendUserVisible(msg, text).catch(() => {});
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
  const { sendUserVisible, cancelActive, recreateSession, watchdogStatusText, defaultDir, config, botConfig, approvalMode, maxQueue } = ctx;
  const m = managed as unknown as ManagedLike;
  const send = (r: Parameters<typeof formatMarkdown>[0]) => sendResult(msg, sendUserVisible, r);

  if (content === '/cancel') {
    const res = cancelActive(managed);
    await sendUserVisible(msg, res.message).catch(() => {});
    return true;
  }

  if (content === '/start') {
    await send(startCommand({
      model: managed.session.model,
      endpoint: managed.config.endpoint || '?',
      defaultDir: managed.config.dir || defaultDir,
      agentName: managed.agentPersona
        ? (managed.agentPersona.display_name || managed.agentId)
        : undefined,
    }));
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

  if (content === '/compact') {
    await send(compactCommand(m));
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
    await sendUserVisible(msg, `✅ Working directory pinned to \`${resolvedDir}\``).catch(
      () => {}
    );
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
    await sendUserVisible(msg, `✅ Directory unpinned. Working directory remains at \`${resolvedDir}\``).catch(
      () => {}
    );
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
    await send(modeSetCommand(m, arg));
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

  if (content === '/vault' || content.startsWith('/vault ')) {
    const query = content.slice('/vault'.length).trim();
    await send(await vaultCommand(m, query));
    return true;
  }

  if (content === '/status') {
    await send(statusCommand(m, { maxQueue }));
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
    await send(agentsCommand(m, {
      agents: botConfig.agents,
      routing: botConfig.routing,
    }));
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
      await sendUserVisible(msg, 'No working directory set. Use `/dir` to set one.').catch(() => {});
      return true;
    }

    try {
      await send(await gitStatusCommand(cwd));
    } catch (e: any) {
      await sendUserVisible(msg, `❌ git status failed: ${e?.message ?? String(e)}`).catch(() => {});
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
        await sendUserVisible(
          msg,
          'No hosts configured. Use `idlehands hosts add` in CLI.'
        ).catch(() => {});
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

  if (content === '/models' || content === '/rtmodels') {
    try {
      const { loadRuntimes } = await import('../runtime/store.js');
      const rtConfig = await loadRuntimes();
      if (!rtConfig.models.length) {
        await sendUserVisible(msg, 'No runtime models configured.').catch(() => {});
        return true;
      }

      const enabledModels = rtConfig.models.filter((mod) => mod.enabled);
      if (!enabledModels.length) {
        await sendUserVisible(msg, 'No enabled runtime models. Use `idlehands models enable <id>` in CLI.').catch(() => {});
        return true;
      }

      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
      const rows: any[] = [];
      let currentRow = new ActionRowBuilder<any>();

      for (const mod of enabledModels) {
        const btn = new ButtonBuilder()
          .setCustomId(`model_switch:${mod.id}`)
          .setLabel(mod.display_name.slice(0, 80))
          .setStyle(ButtonStyle.Primary);

        currentRow.addComponents(btn);

        if (currentRow.components.length >= 5) {
          rows.push(currentRow);
          currentRow = new ActionRowBuilder<any>();
        }
      }
      if (currentRow.components.length > 0) {
        rows.push(currentRow);
      }

      await (msg.channel as any).send({
        content: '📋 **Select a model to switch to:**',
        components: rows.slice(0, 5),
      }).catch(() => {});
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
      const planResult = plan({ modelId, mode: 'live' }, rtConfig, active);

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
          await statusMsg.edit(`✅ Switched to \`${planResult.model.display_name}\``).catch(() => {});
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
    await handleDiscordAnton(managed, msg, content, ctx);
    return true;
  }

  return false;
}

const DISCORD_RATE_LIMIT_MS = 3_000;

export async function handleDiscordAnton(
  managed: ManagedSession,
  msg: Message,
  content: string,
  ctx: Pick<DiscordCommandContext, 'sendUserVisible'>
): Promise<void> {
  const { sendUserVisible } = ctx;
  const args = content.replace(/^\/anton\s*/, '').trim();
  const m = managed as unknown as ManagedLike;
  const channel = msg.channel as { send: (c: string) => Promise<any> };

  let antonStatusMsg: { edit: (content: string) => Promise<any> } | null = null;
  let antonStatusLastText = '';

  const result = await antonCommand(
    m,
    args,
    (t) => {
      const isStatusUpdate = t.startsWith('⏳ Still working:');

      if (!isStatusUpdate) {
        antonStatusMsg = null;
        antonStatusLastText = '';
        channel.send(t).catch(() => {});
        return;
      }

      if (t === antonStatusLastText) return;
      antonStatusLastText = t;

      if (antonStatusMsg) {
        antonStatusMsg.edit(t).catch(() => {
          channel.send(t).then((m: any) => {
            antonStatusMsg = m;
          }).catch(() => {});
        });
        return;
      }

      channel.send(t).then((m: any) => {
        antonStatusMsg = m;
      }).catch(() => {});
    },
    DISCORD_RATE_LIMIT_MS,
  );

  const text = formatMarkdown(result);
  if (text) await sendUserVisible(msg, text).catch(() => {});
}
