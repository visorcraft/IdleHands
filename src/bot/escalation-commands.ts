import type { AgentPersona } from '../types.js';

import type { AgentsConfig, CmdResult, KV, ManagedLike } from './command-logic.js';

// ── Agent metadata / listing ────────────────────────────────────────

export function agentCommand(managed: ManagedLike): CmdResult {
  if (!managed.agentPersona) {
    return { lines: ['No agent configured. Using global config.'] };
  }

  const p = managed.agentPersona;
  const kv: KV[] = [];
  if (p.model) kv.push(['Model', p.model, true]);
  if (p.endpoint) kv.push(['Endpoint', p.endpoint, true]);
  if (p.approval_mode) kv.push(['Approval', p.approval_mode, true]);
  if (p.default_dir) kv.push(['Default dir', p.default_dir, true]);
  if (p.allowed_dirs?.length) kv.push(['Allowed dirs', p.allowed_dirs.join(', ')]);

  const lines: string[] = [];
  if (p.escalation?.models?.length) {
    lines.push('');
    kv.push(['Escalation models', p.escalation.models.join(', ')]);
    if (managed.currentModelIndex > 0) {
      kv.push(['Current tier', `${managed.currentModelIndex} (escalated)`]);
    }
    if (managed.pendingEscalation) {
      lines.push(
        `⚡ Pending escalation: ${managed.pendingEscalation} (next message will use this)`
      );
    }
  }

  return {
    title: `Agent: ${(p as any).name || p.display_name || 'unnamed'}`,
    kv,
    lines: lines.length ? lines : undefined,
  };
}

export function agentsCommand(managed: ManagedLike, surfaceConfig: AgentsConfig): CmdResult {
  const personas = Object.values(surfaceConfig.agents ?? {}) as AgentPersona[];
  if (!personas.length) {
    return { lines: ['No personas configured.'] };
  }

  const lines: string[] = [];
  for (const p of personas) {
    const active =
      ((managed.agentPersona as any)?.name ?? managed.agentPersona?.display_name) ===
      ((p as any).name ?? p.display_name)
        ? '✅ '
        : '• ';
    const model = p.model ? ` — ${p.model}` : '';
    const name = (p as any).name ?? p.display_name ?? '(unnamed)';
    lines.push(`${active}${name}${model}`);

    if (p.endpoint) lines.push(`    endpoint: ${p.endpoint}`);
    if (p.default_dir) lines.push(`    dir: ${p.default_dir}`);
    if (p.approval_mode) lines.push(`    approval: ${p.approval_mode}`);
    if (p.allowed_dirs?.length) lines.push(`    allowed_dirs: ${p.allowed_dirs.join(', ')}`);
  }

  if (surfaceConfig.routing) {
    lines.push('', 'Routing:');
    const routing = surfaceConfig.routing;
    if (routing.default) lines.push(`Default: ${routing.default}`);
    if (routing.chats && Object.keys(routing.chats).length > 0) {
      lines.push(
        `Chats: ${Object.entries(routing.chats)
          .map(([c, a]) => `${c}→${a}`)
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

  return { title: 'Configured Agents', lines };
}

// ── Escalation / de-escalation ──────────────────────────────────────

export function escalateShowCommand(managed: ManagedLike, baseModel: string): CmdResult {
  const escalation = managed.agentPersona?.escalation;
  if (!escalation?.models?.length) {
    return { error: '❌ No escalation models configured for this agent.' };
  }

  const kv: KV[] = [
    ['Current model', managed.session.model, true],
    ['Base model', baseModel, true],
    ['Escalation models', escalation.models.join(', ')],
  ];

  const lines: string[] = [];
  if (managed.currentModelIndex > 0) {
    kv.push(['Current tier', String(managed.currentModelIndex)]);
  }
  if (managed.pendingEscalation) {
    lines.push(`⚡ Pending escalation: ${managed.pendingEscalation} (next message will use this)`);
  }

  return { title: 'Escalation', kv, lines: lines.length ? lines : undefined };
}

export function escalateSetCommand(managed: ManagedLike, arg: string): CmdResult {
  const escalation = managed.agentPersona?.escalation;
  if (!escalation?.models?.length) {
    return { error: '❌ No escalation models configured for this agent.' };
  }

  let targetModel: string;
  let targetEndpoint: string | undefined;

  if (arg === 'next') {
    const nextIndex = Math.min(managed.currentModelIndex, escalation.models.length - 1);
    targetModel = escalation.models[nextIndex];
    targetEndpoint = escalation.tiers?.[nextIndex]?.endpoint;
  } else {
    if (!escalation.models.includes(arg)) {
      return {
        error: `❌ Model ${arg} not in escalation chain. Available: ${escalation.models.join(', ')}`,
      };
    }
    targetModel = arg;
    const idx = escalation.models.indexOf(arg);
    targetEndpoint = escalation.tiers?.[idx]?.endpoint;
  }

  managed.pendingEscalation = targetModel;
  if ('pendingEscalationEndpoint' in managed) {
    (managed as any).pendingEscalationEndpoint = targetEndpoint || null;
  }

  return {
    success: `⚡ Escalated to ${targetModel} for next message${targetEndpoint ? ` (${targetEndpoint})` : ''}`,
  };
}

export function deescalateCommand(managed: ManagedLike, baseModel: string): CmdResult | 'recreate' {
  if (managed.currentModelIndex === 0 && !managed.pendingEscalation) {
    return { lines: ['Already at base model.'] };
  }

  managed.pendingEscalation = null;
  if ('pendingEscalationEndpoint' in managed) {
    (managed as any).pendingEscalationEndpoint = null;
  }

  const currentEscalated = managed.currentModelIndex > 0 || managed.session.model !== baseModel;
  if (!currentEscalated) {
    return { success: `✅ Next message will use base model: ${baseModel}` };
  }

  return 'recreate';
}
