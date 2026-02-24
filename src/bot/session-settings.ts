import type { CmdResult, KV, ManagedLike } from './command-logic.js';

const APPROVAL_MODES = ['plan', 'default', 'auto-edit', 'yolo'] as const;

// ── Dir / pin / unpin ───────────────────────────────────────────────

export function dirShowCommand(managed: ManagedLike | undefined): CmdResult {
  const dir = managed?.workingDir ?? '(no session)';
  const kv: KV[] = [['Working directory', dir, true]];
  const lines: string[] = [];

  if (managed) {
    kv.push(['Directory pinned', managed.dirPinned ? 'yes' : 'no']);
    if (!managed.dirPinned && managed.repoCandidates.length > 1) {
      lines.push('Action required: run /dir <repo-root> before file edits.');
      lines.push(`Detected repos: ${managed.repoCandidates.slice(0, 5).join(', ')}`);
    }
  }

  return { kv, lines: lines.length ? lines : undefined };
}

export function dirSetOk(resolvedDir: string): CmdResult {
  return { success: `✅ Working directory pinned to ${resolvedDir}` };
}

export function dirSetFail(): CmdResult {
  return {
    error:
      '❌ Directory not allowed or session error. Check bot.telegram.allowed_dirs / persona.allowed_dirs.',
  };
}

export function pinOk(dir: string): CmdResult {
  return { success: `✅ Working directory pinned to ${dir}` };
}

export function pinFail(): CmdResult {
  return dirSetFail();
}

export function unpinOk(dir: string): CmdResult {
  return { success: `✅ Directory unpinned. Working directory remains at ${dir}` };
}

export function unpinNotPinned(): CmdResult {
  return { error: 'Directory is not pinned.' };
}

export function unpinFail(): CmdResult {
  return { error: '❌ Failed to unpin directory.' };
}

// ── Approval / mode / subagents ─────────────────────────────────────

export function approvalShowCommand(managed: ManagedLike, fallback?: string): CmdResult {
  const current = managed.config.approval_mode ?? managed.approvalMode ?? fallback ?? 'auto-edit';
  return {
    kv: [['Approval mode', current, true]],
    lines: [`Options: ${APPROVAL_MODES.join(', ')}`],
  };
}

export function approvalSetCommand(managed: ManagedLike, arg: string): CmdResult | null {
  if (!APPROVAL_MODES.includes(arg as any)) {
    return { error: `Invalid mode. Options: ${APPROVAL_MODES.join(', ')}` };
  }
  managed.config.approval_mode = arg as any;
  managed.config.no_confirm = arg === 'yolo';
  if ('approvalMode' in managed) (managed as any).approvalMode = arg;
  return { success: `✅ Approval mode set to ${arg}` };
}

export function modeShowCommand(managed: ManagedLike): CmdResult {
  return { kv: [['Mode', managed.config.mode ?? 'code', true]] };
}

export function modeSetCommand(managed: ManagedLike, arg: string): CmdResult {
  if (arg !== 'code' && arg !== 'sys') {
    return { error: 'Invalid mode. Options: code, sys' };
  }
  managed.config.mode = arg;
  if (arg === 'sys' && managed.config.approval_mode === 'auto-edit') {
    managed.config.approval_mode = 'default';
    if ('approvalMode' in managed) (managed as any).approvalMode = 'default';
  }
  return { success: `✅ Mode set to ${arg}` };
}

export function subagentsShowCommand(managed: ManagedLike): CmdResult {
  const current = managed.config.sub_agents?.enabled !== false;
  return {
    kv: [['Sub-agents', current ? 'on' : 'off', true]],
    lines: ['Usage: /subagents on | off'],
  };
}

export function subagentsSetCommand(managed: ManagedLike, arg: string): CmdResult {
  if (arg !== 'on' && arg !== 'off') {
    return { error: 'Invalid value. Usage: /subagents on | off' };
  }
  const enabled = arg === 'on';
  managed.config.sub_agents = { ...(managed.config.sub_agents ?? {}), enabled };
  return {
    success: `✅ Sub-agents ${enabled ? 'on' : 'off'}${!enabled ? ' — spawn_task disabled for this session' : ''}`,
  };
}
