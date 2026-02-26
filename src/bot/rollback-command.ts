import type { CmdResult, ManagedLike } from './command-logic.js';

export function rollbackCommand(managed: ManagedLike): CmdResult {
  const session = managed.session;
  if (typeof session.rollback !== 'function') {
    return { error: 'Rollback is not available in this session.' };
  }

  const result = session.rollback();
  if (!result) {
    return { error: 'Nothing to roll back — no previous turns.' };
  }

  return {
    success: `✅ Rolled back ${result.removedMessages} message(s). Last turn: "${result.preview}"`,
  };
}

export function checkpointsCommand(managed: ManagedLike): CmdResult {
  const session = managed.session;
  if (typeof session.listCheckpoints !== 'function') {
    return { error: 'Checkpoints are not available in this session.' };
  }

  const cps = session.listCheckpoints();
  if (!cps.length) {
    return { lines: ['No checkpoints available.'] };
  }

  const lines = cps.map((cp, i) => {
    const ago = Math.round((Date.now() - cp.createdAt) / 1000);
    const agoStr = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
    return `  ${i + 1}. [${agoStr}] "${cp.preview}" (${cp.messageCount} msgs)`;
  });

  return {
    title: `Rollback checkpoints (${cps.length})`,
    lines,
  };
}
