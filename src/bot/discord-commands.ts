import fs from 'node:fs/promises';
import path from 'node:path';

import type { Message } from 'discord.js';

import { runAnton } from '../anton/controller.js';
import { parseTaskFile } from '../anton/parser.js';
import {
  formatRunSummary,
  formatProgressBar,
  formatTaskStart,
  formatTaskEnd,
  formatTaskSkip,
  formatToolLoopEvent,
  formatCompactionEvent,
  formatVerificationDetail,
} from '../anton/reporter.js';
import type { AntonRunConfig, AntonProgressCallback } from '../anton/types.js';
import { firstToken } from '../cli/command-utils.js';
import type { BotDiscordConfig, IdlehandsConfig } from '../types.js';
import { PKG_VERSION } from '../utils.js';

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

  if (content === '/cancel') {
    const res = cancelActive(managed);
    await sendUserVisible(msg, res.message).catch(() => { });
    return true;
  }

  if (content === '/start') {
    const agentLine = managed.agentPersona
      ? `Agent: **${managed.agentPersona.display_name || managed.agentId}**`
      : null;
    const lines = [
      '🔧 Idle Hands — Local-first coding agent',
      '',
      ...(agentLine ? [agentLine] : []),
      `Model: \`${managed.session.model}\``,
      `Endpoint: \`${managed.config.endpoint || '?'}\``,
      `Default dir: \`${managed.config.dir || defaultDir}\``,
      '',
      'Send me a coding task, or use /help for commands.',
    ];
    await sendUserVisible(msg, lines.join('\n')).catch(() => { });
    return true;
  }

  if (content === '/help') {
    const lines = [
      'Commands:',
      '/start — Welcome + config summary',
      '/help — This message',
      '/version — Show version',
      '/new — Start a new session',
      '/cancel — Abort current generation',
      '/status — Session stats',
      '/watchdog [status] — Show watchdog settings/status',
      '/agent — Show current agent',
      '/agents — List all configured agents',
      '/escalate [model] — Use larger model for next message',
      '/deescalate — Return to base model',
      '/dir [path] — Get/set working directory',
      '/pin — Pin current working directory',
      '/unpin — Unpin working directory',
      '/model — Show current model',
      '/approval [mode] — Get/set approval mode',
      '/mode [code|sys] — Get/set mode',
      '/subagents [on|off] — Toggle sub-agents',
      '/compact — Trigger context compaction',
      '/changes — Show files modified this session',
      '/undo — Undo last edit',
      '/vault <query> — Search vault entries',
      '/anton <file> — Start autonomous task runner',
      '/anton status | /anton stop | /anton last',
    ];
    await sendUserVisible(msg, lines.join('\n')).catch(() => { });
    return true;
  }

  if (content === '/model') {
    await sendUserVisible(
      msg,
      `Model: \`${managed.session.model}\`\nHarness: \`${managed.session.harness}\``
    ).catch(() => { });
    return true;
  }

  if (content === '/version') {
    await sendUserVisible(msg, `Idle Hands v${PKG_VERSION}`).catch(() => { });
    return true;
  }

  if (content === '/compact') {
    managed.session.reset();
    await sendUserVisible(msg, '🗜 Session context compacted (reset to system prompt).').catch(
      () => { }
    );
    return true;
  }

  if (content === '/dir' || content.startsWith('/dir ')) {
    const arg = content.slice('/dir'.length).trim();
    if (!arg) {
      const lines = [
        `Working directory: \`${managed.config.dir || defaultDir}\``,
        `Directory pinned: ${managed.dirPinned ? 'yes' : 'no'}`,
      ];
      if (!managed.dirPinned && managed.repoCandidates.length > 1) {
        lines.push('Action required: run `/dir <repo-root>` before file edits.');
        lines.push(
          `Detected repos: ${managed.repoCandidates
            .slice(0, 5)
            .map((p) => `\`${p}\``)
            .join(', ')}`
        );
      }
      await sendUserVisible(msg, lines.join('\n')).catch(() => { });
      return true;
    }

    const resolvedDir = path.resolve(expandHome(arg));
    if (!isPathAllowed(resolvedDir, managed.allowedDirs)) {
      await sendUserVisible(
        msg,
        `❌ Directory not allowed. Allowed roots: ${managed.allowedDirs.map((d) => `\`${d}\``).join(', ')}`
      ).catch(() => { });
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
      () => { }
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
        ).catch(() => { });
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
        () => { }
      );
      return true;
    }
  }

  if (content === '/unpin' || content.startsWith('/unpin ')) {
    if (!managed.dirPinned) {
      await sendUserVisible(msg, 'Directory is not pinned.').catch(() => { });
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
      () => { }
    );
    return true;
  }

  if (content === '/approval' || content.startsWith('/approval ')) {
    const arg = content.slice('/approval'.length).trim().toLowerCase();
    const modes = ['plan', 'default', 'auto-edit', 'yolo'] as const;
    if (!arg) {
      await sendUserVisible(
        msg,
        `Approval mode: \`${managed.config.approval_mode || approvalMode}\`\nOptions: ${modes.join(', ')}`
      ).catch(() => { });
      return true;
    }
    if (!modes.includes(arg as any)) {
      await sendUserVisible(msg, `Invalid mode. Options: ${modes.join(', ')}`).catch(() => { });
      return true;
    }
    managed.config.approval_mode = arg as any;
    managed.config.no_confirm = arg === 'yolo';
    await sendUserVisible(msg, `✅ Approval mode set to \`${arg}\``).catch(() => { });
    return true;
  }

  if (content === '/mode' || content.startsWith('/mode ')) {
    const arg = content.slice('/mode'.length).trim().toLowerCase();
    if (!arg) {
      await sendUserVisible(msg, `Mode: \`${managed.config.mode || 'code'}\``).catch(() => { });
      return true;
    }
    if (arg !== 'code' && arg !== 'sys') {
      await sendUserVisible(msg, 'Invalid mode. Options: code, sys').catch(() => { });
      return true;
    }
    managed.config.mode = arg as any;
    if (arg === 'sys' && managed.config.approval_mode === 'auto-edit') {
      managed.config.approval_mode = 'default';
    }
    await sendUserVisible(msg, `✅ Mode set to \`${arg}\``).catch(() => { });
    return true;
  }

  if (content === '/subagents' || content.startsWith('/subagents ')) {
    const arg = content.slice('/subagents'.length).trim().toLowerCase();
    const current = managed.config.sub_agents?.enabled !== false;
    if (!arg) {
      await sendUserVisible(
        msg,
        `Sub-agents: \`${current ? 'on' : 'off'}\`\nUsage: /subagents on | off`
      ).catch(() => { });
      return true;
    }
    if (arg !== 'on' && arg !== 'off') {
      await sendUserVisible(msg, 'Invalid value. Usage: /subagents on | off').catch(() => { });
      return true;
    }
    const enabled = arg === 'on';
    managed.config.sub_agents = { ...(managed.config.sub_agents ?? {}), enabled };
    await sendUserVisible(
      msg,
      `✅ Sub-agents \`${enabled ? 'on' : 'off'}\`${!enabled ? ' — spawn_task disabled for this session' : ''}`
    ).catch(() => { });
    return true;
  }

  if (content === '/changes') {
    const replay = managed.session.replay;
    if (!replay) {
      await sendUserVisible(msg, 'Replay is disabled. No change tracking available.').catch(
        () => { }
      );
      return true;
    }
    try {
      const checkpoints = await replay.list(50);
      if (!checkpoints.length) {
        await sendUserVisible(msg, 'No file changes this session.').catch(() => { });
        return true;
      }
      const byFile = new Map<string, number>();
      for (const cp of checkpoints) byFile.set(cp.filePath, (byFile.get(cp.filePath) ?? 0) + 1);
      const lines = [`Session changes (${byFile.size} files):`];
      for (const [fp, count] of byFile)
        lines.push(`✎ \`${fp}\` (${count} edit${count > 1 ? 's' : ''})`);
      await sendUserVisible(msg, lines.join('\n')).catch(() => { });
    } catch (e: any) {
      await sendUserVisible(msg, `Error listing changes: ${e?.message ?? String(e)}`).catch(
        () => { }
      );
    }
    return true;
  }

  if (content === '/undo') {
    const lastPath = managed.session.lastEditedPath;
    if (!lastPath) {
      await sendUserVisible(msg, 'No recent edits to undo.').catch(() => { });
      return true;
    }
    try {
      const { undo_path } = await import('../tools.js');
      const result = await undo_path(
        { cwd: managed.config.dir || defaultDir, noConfirm: true, dryRun: false } as any,
        { path: lastPath }
      );
      await sendUserVisible(msg, `✅ ${result}`).catch(() => { });
    } catch (e: any) {
      await sendUserVisible(msg, `❌ Undo failed: ${e?.message ?? String(e)}`).catch(() => { });
    }
    return true;
  }

  if (content === '/vault' || content.startsWith('/vault ')) {
    const query = content.slice('/vault'.length).trim();
    if (!query) {
      await sendUserVisible(msg, 'Usage: /vault <search query>').catch(() => { });
      return true;
    }
    const vault = managed.session.vault;
    if (!vault) {
      await sendUserVisible(msg, 'Vault is disabled.').catch(() => { });
      return true;
    }
    try {
      const results = await vault.search(query, 5);
      if (!results.length) {
        await sendUserVisible(msg, `No vault results for "${query}"`).catch(() => { });
        return true;
      }
      const lines = [`Vault results for "${query}":`];
      for (const r of results) {
        const title = r.kind === 'note' ? `note:${r.key}` : `tool:${r.tool || r.key || '?'}`;
        const body = (r.value ?? r.snippet ?? r.content ?? '').replace(/\s+/g, ' ').slice(0, 120);
        lines.push(`• ${title}: ${body}`);
      }
      await sendUserVisible(msg, lines.join('\n')).catch(() => { });
    } catch (e: any) {
      await sendUserVisible(msg, `Error searching vault: ${e?.message ?? String(e)}`).catch(
        () => { }
      );
    }
    return true;
  }

  if (content === '/status') {
    const used = managed.session.currentContextTokens;
    const pct =
      managed.session.contextWindow > 0
        ? Math.min(100, (used / managed.session.contextWindow) * 100).toFixed(1)
        : '?';
    const agentLine = managed.agentPersona
      ? `Agent: ${managed.agentPersona.display_name || managed.agentId}`
      : null;
    await sendUserVisible(
      msg,
      [
        ...(agentLine ? [agentLine] : []),
        `Mode: ${managed.config.mode ?? 'code'}`,
        `Approval: ${managed.config.approval_mode}`,
        `Model: ${managed.session.model}`,
        `Harness: ${managed.session.harness}`,
        `Dir: ${managed.config.dir ?? defaultDir}`,
        `Dir pinned: ${managed.dirPinned ? 'yes' : 'no'}`,
        `Context: ~${used}/${managed.session.contextWindow} (${pct}%)`,
        `State: ${managed.state}`,
        `Queue: ${managed.pendingQueue.length}/${maxQueue}`,
      ].join('\n')
    ).catch(() => { });
    return true;
  }

  if (content === '/watchdog' || content === '/watchdog status') {
    await sendUserVisible(msg, watchdogStatusText(managed)).catch(() => { });
    return true;
  }

  if (content.startsWith('/watchdog ')) {
    await sendUserVisible(msg, 'Usage: /watchdog or /watchdog status').catch(() => { });
    return true;
  }

  if (content === '/agent') {
    if (!managed.agentPersona) {
      await sendUserVisible(msg, 'No agent configured. Using global config.').catch(() => { });
      return true;
    }
    const p = managed.agentPersona;
    const lines = [
      `**Agent: ${p.display_name || managed.agentId}** (\`${managed.agentId}\`)`,
      ...(p.model ? [`Model: \`${p.model}\``] : []),
      ...(p.endpoint ? [`Endpoint: \`${p.endpoint}\``] : []),
      ...(p.approval_mode ? [`Approval: \`${p.approval_mode}\``] : []),
      ...(p.default_dir ? [`Default dir: \`${p.default_dir}\``] : []),
      ...(p.allowed_dirs?.length
        ? [`Allowed dirs: ${p.allowed_dirs.map((d) => `\`${d}\``).join(', ')}`]
        : []),
    ];
    await sendUserVisible(msg, lines.join('\n')).catch(() => { });
    return true;
  }

  if (content === '/agents') {
    const agents = botConfig.agents;
    if (!agents || Object.keys(agents).length === 0) {
      await sendUserVisible(msg, 'No agents configured. Using global config.').catch(() => { });
      return true;
    }
    const lines = ['**Configured Agents:**'];
    for (const [id, p] of Object.entries(agents)) {
      const current = id === managed.agentId ? ' ← current' : '';
      const model = p.model ? ` (${p.model})` : '';
      lines.push(`• **${p.display_name || id}** (\`${id}\`)${model}${current}`);
    }

    const routing = botConfig.routing;
    if (routing) {
      lines.push('', '**Routing:**');
      if (routing.default) lines.push(`Default: \`${routing.default}\``);
      if (routing.users && Object.keys(routing.users).length > 0) {
        lines.push(
          `Users: ${Object.entries(routing.users)
            .map(([u, a]) => `${u}→${a}`)
            .join(', ')}`
        );
      }
      if (routing.channels && Object.keys(routing.channels).length > 0) {
        lines.push(
          `Channels: ${Object.entries(routing.channels)
            .map(([c, a]) => `${c}→${a}`)
            .join(', ')}`
        );
      }
      if (routing.guilds && Object.keys(routing.guilds).length > 0) {
        lines.push(
          `Guilds: ${Object.entries(routing.guilds)
            .map(([g, a]) => `${g}→${a}`)
            .join(', ')}`
        );
      }
    }

    await sendUserVisible(msg, lines.join('\n')).catch(() => { });
    return true;
  }

  if (content === '/escalate' || content.startsWith('/escalate ')) {
    const escalation = managed.agentPersona?.escalation;
    if (!escalation || !escalation.models?.length) {
      await sendUserVisible(msg, '❌ No escalation models configured for this agent.').catch(
        () => { }
      );
      return true;
    }

    const arg = content.slice('/escalate'.length).trim();

    if (!arg) {
      const currentModel = managed.config.model || config.model || 'default';
      const lines = [
        `**Current model:** \`${currentModel}\``,
        `**Escalation models:** ${escalation.models.map((m) => `\`${m}\``).join(', ')}`,
        '',
        'Usage: `/escalate <model>` or `/escalate next`',
        'Then send your message - it will use the escalated model.',
      ];
      if (managed.pendingEscalation) {
        lines.push(
          '',
          `⚡ **Pending escalation:** \`${managed.pendingEscalation}\` (next message will use this)`
        );
      }
      await sendUserVisible(msg, lines.join('\n')).catch(() => { });
      return true;
    }

    let targetModel: string;
    if (arg.toLowerCase() === 'next') {
      const nextIndex = Math.min(managed.currentModelIndex, escalation.models.length - 1);
      targetModel = escalation.models[nextIndex];
    } else {
      if (!escalation.models.includes(arg)) {
        await sendUserVisible(
          msg,
          `❌ Model \`${arg}\` not in escalation chain. Available: ${escalation.models.map((m) => `\`${m}\``).join(', ')}`
        ).catch(() => { });
        return true;
      }
      targetModel = arg;
    }

    managed.pendingEscalation = targetModel;
    await sendUserVisible(
      msg,
      `⚡ Next message will use \`${targetModel}\`. Send your request now.`
    ).catch(() => { });
    return true;
  }

  if (content === '/deescalate') {
    if (managed.currentModelIndex === 0 && !managed.pendingEscalation) {
      await sendUserVisible(msg, 'Already using base model.').catch(() => { });
      return true;
    }

    const baseModel = managed.agentPersona?.model || config.model || 'default';
    managed.pendingEscalation = null;
    managed.currentModelIndex = 0;

    const cfg: IdlehandsConfig = {
      ...managed.config,
      model: baseModel,
    };
    await recreateSession(managed, cfg);
    await sendUserVisible(msg, `✅ Returned to base model: \`${baseModel}\``).catch(() => { });
    return true;
  }

  if (content === '/git_status') {
    const cwd = managed.config.dir || defaultDir;
    if (!cwd) {
      await sendUserVisible(msg, 'No working directory set. Use `/dir` to set one.').catch(() => { });
      return true;
    }

    try {
      const { spawnSync } = await import('node:child_process');

      const statusResult = spawnSync('git', ['status', '-s'], {
        cwd,
        encoding: 'utf8',
        timeout: 5000,
      });

      if (statusResult.status !== 0) {
        const err = String(statusResult.stderr || statusResult.error || 'Unknown error');
        if (err.includes('not a git repository') || err.includes('not in a git')) {
          await sendUserVisible(msg, '❌ Not a git repository.').catch(() => { });
        } else {
          await sendUserVisible(msg, `❌ git status failed: ${err.slice(0, 200)}`).catch(() => { });
        }
        return true;
      }

      const statusOut = String(statusResult.stdout || '').trim();

      const branchResult = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        encoding: 'utf8',
        timeout: 2000,
      });
      const branch = branchResult.status === 0 ? String(branchResult.stdout || '').trim() : 'unknown';

      if (!statusOut) {
        await sendUserVisible(
          msg,
          `📁 \`${cwd}\`\n🌿 Branch: \`${branch}\`\n\n✅ Working tree clean`
        ).catch(() => { });
        return true;
      }

      const lines = statusOut.split('\n').slice(0, 30);
      const truncated = statusOut.split('\n').length > 30;

      const formatted = lines
        .map((line) => `\`${line.slice(0, 2)}\` ${line.slice(3)}`)
        .join('\n');

      await sendUserVisible(
        msg,
        `📁 \`${cwd}\`\n🌿 Branch: \`${branch}\`\n\n\`\`\`\n${formatted}${truncated ? '\n...' : ''}\`\`\``
      ).catch(() => { });
    } catch (e: any) {
      await sendUserVisible(msg, `❌ git status failed: ${e?.message ?? String(e)}`).catch(() => { });
    }
    return true;
  }

  if (content === '/hosts') {
    try {
      const { loadRuntimes, redactConfig } = await import('../runtime/store.js');
      const config = await loadRuntimes();
      const redacted = redactConfig(config);
      if (!redacted.hosts.length) {
        await sendUserVisible(
          msg,
          'No hosts configured. Use `idlehands hosts add` in CLI.'
        ).catch(() => { });
        return true;
      }

      const lines = redacted.hosts.map(
        (h) =>
          `${h.enabled ? '🟢' : '🔴'} ${h.display_name} (\`${h.id}\`)\n  Transport: ${h.transport}`
      );

      const chunks = splitDiscord(lines.join('\n\n'));
      for (const [i, chunk] of chunks.entries()) {
        if (i === 0) await sendUserVisible(msg, chunk).catch(() => { });
        else await (msg.channel as any).send(chunk).catch(() => { });
      }
    } catch (e: any) {
      await sendUserVisible(msg, `❌ Failed to load hosts: ${e?.message ?? String(e)}`).catch(
        () => { }
      );
    }
    return true;
  }

  if (content === '/backends') {
    try {
      const { loadRuntimes, redactConfig } = await import('../runtime/store.js');
      const config = await loadRuntimes();
      const redacted = redactConfig(config);
      if (!redacted.backends.length) {
        await sendUserVisible(
          msg,
          'No backends configured. Use `idlehands backends add` in CLI.'
        ).catch(() => { });
        return true;
      }

      const lines = redacted.backends.map(
        (b) => `${b.enabled ? '🟢' : '🔴'} ${b.display_name} (\`${b.id}\`)\n  Type: ${b.type}`
      );

      const chunks = splitDiscord(lines.join('\n\n'));
      for (const [i, chunk] of chunks.entries()) {
        if (i === 0) await sendUserVisible(msg, chunk).catch(() => { });
        else await (msg.channel as any).send(chunk).catch(() => { });
      }
    } catch (e: any) {
      await sendUserVisible(msg, `❌ Failed to load backends: ${e?.message ?? String(e)}`).catch(
        () => { }
      );
    }
    return true;
  }

  if (content === '/models' || content === '/rtmodels') {
    try {
      const { loadRuntimes } = await import('../runtime/store.js');
      const config = await loadRuntimes();
      if (!config.models.length) {
        await sendUserVisible(msg, 'No runtime models configured.').catch(() => { });
        return true;
      }

      const enabledModels = config.models.filter((m) => m.enabled);
      if (!enabledModels.length) {
        await sendUserVisible(msg, 'No enabled runtime models. Use `idlehands models enable <id>` in CLI.').catch(() => { });
        return true;
      }

      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
      const rows: any[] = [];
      let currentRow = new ActionRowBuilder<any>();

      for (const m of enabledModels) {
        const btn = new ButtonBuilder()
          .setCustomId(`model_switch:${m.id}`)
          .setLabel(m.display_name.slice(0, 80))
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
      }).catch(() => { });
    } catch (e: any) {
      await sendUserVisible(
        msg,
        `❌ Failed to load runtime models: ${e?.message ?? String(e)}`
      ).catch(() => { });
    }
    return true;
  }

  if (content === '/rtstatus') {
    try {
      const { loadActiveRuntime } = await import('../runtime/executor.js');
      const active = await loadActiveRuntime();
      if (!active) {
        await sendUserVisible(msg, 'No active runtime.').catch(() => { });
        return true;
      }

      const lines = [
        'Active Runtime',
        `Model: \`${active.modelId}\``,
        `Backend: \`${active.backendId ?? 'none'}\``,
        `Hosts: ${active.hostIds.map((id) => `\`${id}\``).join(', ') || 'none'}`,
        `Healthy: ${active.healthy ? '✅ yes' : '❌ no'}`,
        `Endpoint: \`${active.endpoint ?? 'unknown'}\``,
        `Started: \`${active.startedAt}\``,
      ];

      const chunks = splitDiscord(lines.join('\n'));
      for (const [i, chunk] of chunks.entries()) {
        if (i === 0) await sendUserVisible(msg, chunk).catch(() => { });
        else await (msg.channel as any).send(chunk).catch(() => { });
      }
    } catch (e: any) {
      await sendUserVisible(
        msg,
        `❌ Failed to read runtime status: ${e?.message ?? String(e)}`
      ).catch(() => { });
    }
    return true;
  }

  if (content === '/switch' || content.startsWith('/switch ')) {
    try {
      const modelId = content.slice('/switch'.length).trim();
      if (!modelId) {
        await sendUserVisible(msg, 'Usage: /switch <model-id>').catch(() => { });
        return true;
      }

      const { plan } = await import('../runtime/planner.js');
      const { execute, loadActiveRuntime } = await import('../runtime/executor.js');
      const { loadRuntimes } = await import('../runtime/store.js');

      const rtConfig = await loadRuntimes();
      const active = await loadActiveRuntime();
      const result = plan({ modelId, mode: 'live' }, rtConfig, active);

      if (!result.ok) {
        await sendUserVisible(msg, `❌ Plan failed: ${result.reason}`).catch(() => { });
        return true;
      }

      if (result.reuse) {
        await sendUserVisible(msg, '✅ Runtime already active and healthy.').catch(() => { });
        return true;
      }

      const statusMsg = await sendUserVisible(
        msg,
        `⏳ Switching to \`${result.model.display_name}\`...`
      ).catch(() => null);

      const execResult = await execute(result, {
        onStep: async (step, status) => {
          if (status === 'done' && statusMsg) {
            await statusMsg.edit(`⏳ ${step.description}... ✓`).catch(() => { });
          }
        },
        confirm: async (prompt) => {
          await sendUserVisible(msg, `⚠️ ${prompt}\nAuto-approving for bot context.`).catch(
            () => { }
          );
          return true;
        },
      });

      if (execResult.ok) {
        if (statusMsg) {
          await statusMsg.edit(`✅ Switched to \`${result.model.display_name}\``).catch(() => { });
        } else {
          await sendUserVisible(msg, `✅ Switched to \`${result.model.display_name}\``).catch(
            () => { }
          );
        }
      } else {
        const err = `❌ Switch failed: ${execResult.error || 'unknown error'}`;
        if (statusMsg) {
          await statusMsg.edit(err).catch(() => { });
        } else {
          await sendUserVisible(msg, err).catch(() => { });
        }
      }
    } catch (e: any) {
      await sendUserVisible(msg, `❌ Switch failed: ${e?.message ?? String(e)}`).catch(() => { });
    }
    return true;
  }

  if (content === '/anton' || content.startsWith('/anton ')) {
    await handleDiscordAnton(managed, msg, content, ctx);
    return true;
  }

  return false;
}

const DISCORD_RATE_LIMIT_MS = 15_000;

export async function handleDiscordAnton(
  managed: ManagedSession,
  msg: Message,
  content: string,
  ctx: Pick<DiscordCommandContext, 'sendUserVisible'>
): Promise<void> {
  const { sendUserVisible } = ctx;
  const args = content.replace(/^\/anton\s*/, '').trim();
  const sub = firstToken(args);

  if (!sub || sub === 'status') {
    if (!managed.antonActive) {
      await sendUserVisible(msg, 'No Anton run in progress.').catch(() => { });
    } else if (managed.antonAbortSignal?.aborted) {
      await sendUserVisible(
        msg,
        '🛑 Anton is stopping. Please wait for the current attempt to unwind.'
      ).catch(() => { });
    } else if (managed.antonProgress) {
      const line1 = formatProgressBar(managed.antonProgress);
      if (managed.antonProgress.currentTask) {
        await sendUserVisible(
          msg,
          `${line1}\n\n**Working on:** *${managed.antonProgress.currentTask}* (Attempt ${managed.antonProgress.currentAttempt})`
        ).catch(() => { });
      } else {
        await sendUserVisible(msg, line1).catch(() => { });
      }
    } else {
      await sendUserVisible(msg, '🤖 Anton is running (no progress data yet).').catch(() => { });
    }
    return;
  }

  if (sub === 'stop') {
    if (!managed.antonActive || !managed.antonAbortSignal) {
      await sendUserVisible(msg, 'No Anton run in progress.').catch(() => { });
      return;
    }
    managed.lastActivity = Date.now();
    managed.antonAbortSignal.aborted = true;
    await sendUserVisible(msg, '🛑 Anton stop requested.').catch(() => { });
    return;
  }

  if (sub === 'last') {
    if (!managed.antonLastResult) {
      await sendUserVisible(msg, 'No previous Anton run.').catch(() => { });
      return;
    }
    await sendUserVisible(msg, formatRunSummary(managed.antonLastResult)).catch(() => { });
    return;
  }

  const filePart = sub === 'run' ? args.replace(/^\S+\s*/, '').trim() : args;
  if (!filePart) {
    await sendUserVisible(
      msg,
      '/anton <file> — start | /anton status | /anton stop | /anton last'
    ).catch(() => { });
    return;
  }

  if (managed.antonActive) {
    const staleMs = Date.now() - managed.lastActivity;
    if (staleMs > 120_000) {
      managed.antonActive = false;
      managed.antonAbortSignal = null;
      managed.antonProgress = null;
      await sendUserVisible(
        msg,
        '♻️ Recovered stale Anton run state. Starting a fresh run...'
      ).catch(() => { });
    } else {
      const runningMsg = managed.antonAbortSignal?.aborted
        ? '🛑 Anton is still stopping. Please wait a moment, then try again.'
        : '⚠️ Anton is already running. Use /anton stop first.';
      await sendUserVisible(msg, runningMsg).catch(() => { });
      return;
    }
  }

  const cwd = managed.config.dir || process.cwd();
  const filePath = path.resolve(cwd, filePart);

  try {
    await fs.stat(filePath);
  } catch {
    await sendUserVisible(msg, `File not found: ${filePath}`).catch(() => { });
    return;
  }

  const defaults = (managed.config as any).anton || {};
  const runConfig: AntonRunConfig = {
    taskFile: filePath,
    projectDir: defaults.project_dir || cwd,
    maxRetriesPerTask: defaults.max_retries ?? 3,
    maxIterations: defaults.max_iterations ?? 200,
    taskMaxIterations: defaults.task_max_iterations ?? 50,
    taskTimeoutSec: defaults.task_timeout_sec ?? 600,
    totalTimeoutSec: defaults.total_timeout_sec ?? 7200,
    maxTotalTokens: defaults.max_total_tokens ?? Infinity,
    maxPromptTokensPerAttempt: defaults.max_prompt_tokens_per_attempt ?? 128_000,
    autoCommit: defaults.auto_commit ?? true,
    branch: false,
    allowDirty: false,
    aggressiveCleanOnFail: false,
    verifyAi: defaults.verify_ai ?? true,
    verifyModel: undefined,
    decompose: defaults.decompose ?? true,
    maxDecomposeDepth: defaults.max_decompose_depth ?? 2,
    maxTotalTasks: defaults.max_total_tasks ?? 500,
    buildCommand: defaults.build_command ?? undefined,
    testCommand: defaults.test_command ?? undefined,
    lintCommand: defaults.lint_command ?? undefined,
    skipOnFail: defaults.skip_on_fail ?? false,
    skipOnBlocked: defaults.skip_on_blocked ?? true,
    rollbackOnFail: defaults.rollback_on_fail ?? false,
    maxIdenticalFailures: defaults.max_identical_failures ?? 5,
    approvalMode: (defaults.approval_mode ?? 'yolo') as AntonRunConfig['approvalMode'],
    verbose: false,
    dryRun: false,
  };

  const abortSignal = { aborted: false };
  managed.antonActive = true;
  managed.antonAbortSignal = abortSignal;
  managed.antonProgress = null;

  let lastProgressAt = 0;
  const channel = msg.channel as { send: (c: string) => Promise<any> };

  const progress: AntonProgressCallback = {
    onTaskStart(task, attempt, prog) {
      managed.antonProgress = prog;
      managed.lastActivity = Date.now();
      const now = Date.now();
      if (now - lastProgressAt >= DISCORD_RATE_LIMIT_MS) {
        lastProgressAt = now;
        channel.send(formatTaskStart(task, attempt, prog)).catch(() => { });
      }
    },
    onTaskEnd(task, result, prog) {
      managed.antonProgress = prog;
      managed.lastActivity = Date.now();
      const now = Date.now();
      if (now - lastProgressAt >= DISCORD_RATE_LIMIT_MS) {
        lastProgressAt = now;
        channel.send(formatTaskEnd(task, result, prog)).catch(() => { });
      }
    },
    onTaskSkip(task, reason) {
      managed.lastActivity = Date.now();
      channel.send(formatTaskSkip(task, reason)).catch(() => { });
    },
    onRunComplete(result) {
      managed.lastActivity = Date.now();
      managed.antonLastResult = result;
      managed.antonActive = false;
      managed.antonAbortSignal = null;
      managed.antonProgress = null;
      channel.send(formatRunSummary(result)).catch(() => { });
    },
    onHeartbeat() {
      managed.lastActivity = Date.now();
    },
    onToolLoop(taskText, event) {
      managed.lastActivity = Date.now();
      if (defaults.progress_events !== false) {
        channel.send(formatToolLoopEvent(taskText, event)).catch(() => { });
      }
    },
    onCompaction(taskText, event) {
      managed.lastActivity = Date.now();
      if (defaults.progress_events !== false && event.droppedMessages >= 5) {
        channel.send(formatCompactionEvent(taskText, event)).catch(() => { });
      }
    },
    onVerification(taskText, verification) {
      managed.lastActivity = Date.now();
      if (defaults.progress_events !== false && !verification.passed) {
        channel.send(formatVerificationDetail(taskText, verification)).catch(() => { });
      }
    },
  };

  let pendingCount = 0;
  try {
    const tf = await parseTaskFile(filePath);
    pendingCount = tf.pending.length;
  } catch { }

  await sendUserVisible(
    msg,
    `🤖 Anton started on ${filePart} (${pendingCount} tasks pending)`
  ).catch(() => { });

  runAnton({
    config: runConfig,
    idlehandsConfig: managed.config,
    progress,
    abortSignal,
    vault: managed.session.vault,
    lens: managed.session.lens,
  }).catch((err: Error) => {
    managed.lastActivity = Date.now();
    managed.antonActive = false;
    managed.antonAbortSignal = null;
    managed.antonProgress = null;
    channel.send(`Anton error: ${err.message}`).catch(() => { });
  });
}
