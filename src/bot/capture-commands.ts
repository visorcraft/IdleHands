import type { CmdResult, ManagedLike } from './command-logic.js';

function usage(): CmdResult {
  return {
    lines: [
      'Usage: /capture on [path] | /capture off | /capture last [path]',
      'Tip: use /capture on before sending a prompt to inspect model payloads.',
    ],
  };
}

export function captureShowCommand(managed: ManagedLike): CmdResult {
  const path = managed.session.capturePath;
  return {
    kv: [['Capture', path ? `on (${path})` : 'off', true]],
    lines: ['Usage: /capture on [path] | /capture off | /capture last [path]'],
  };
}

export async function captureSetCommand(
  managed: ManagedLike,
  mode: string,
  filePath?: string
): Promise<CmdResult> {
  const session = managed.session;
  const normalized = (mode || '').trim().toLowerCase();
  const pathArg = filePath?.trim() || undefined;

  if (!normalized) return usage();

  if (normalized === 'on') {
    if (typeof session.captureOn !== 'function') {
      return { error: 'Capture is unavailable in this session.' };
    }
    const target = await session.captureOn(pathArg);
    return { success: `✅ Capture enabled: ${target}` };
  }

  if (normalized === 'off') {
    if (typeof session.captureOff !== 'function') {
      return { error: 'Capture is unavailable in this session.' };
    }
    session.captureOff();
    return { success: '✅ Capture disabled.' };
  }

  if (normalized === 'last') {
    if (typeof session.captureLast !== 'function') {
      return { error: 'Capture is unavailable in this session.' };
    }
    try {
      const target = await session.captureLast(pathArg);
      return { success: `✅ Wrote last capture to ${target}` };
    } catch (e: any) {
      return { error: e?.message ?? String(e) };
    }
  }

  return usage();
}
