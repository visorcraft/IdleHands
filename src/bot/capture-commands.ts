import type { CmdResult, ManagedLike } from './command-logic.js';

function usage(): CmdResult {
  return {
    lines: [
      'Usage: /capture on [path] | off | last [path] | redact on|off | open',
      'Tip: use /capture on before sending a prompt to inspect model payloads.',
    ],
  };
}

export function captureShowCommand(managed: ManagedLike): CmdResult {
  const path = managed.session.capturePath;
  const redact = managed.session.captureGetRedact?.() ?? true;
  return {
    kv: [
      ['Capture', path ? `on (${path})` : 'off', true],
      ['Redact', redact ? 'on' : 'off'],
    ],
    lines: ['Usage: /capture on [path] | off | last [path] | redact on|off | open'],
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

  if (normalized === 'redact') {
    if (typeof session.captureSetRedact !== 'function') {
      return { error: 'Capture redaction is unavailable in this session.' };
    }
    const arg = (pathArg || '').toLowerCase();
    if (arg === 'on' || arg === '1' || arg === 'true') {
      session.captureSetRedact(true);
      return { success: '✅ Capture redaction enabled (API keys/tokens will be redacted).' };
    }
    if (arg === 'off' || arg === '0' || arg === 'false') {
      session.captureSetRedact(false);
      return { success: '⚠️ Capture redaction disabled — captures will include raw credentials.' };
    }
    return { error: 'Usage: /capture redact on|off' };
  }

  if (normalized === 'open') {
    if (typeof session.captureOpen !== 'function') {
      return { error: 'Capture open is unavailable in this session.' };
    }
    const current = session.captureOpen();
    if (!current) {
      return { error: 'No capture file is active. Use /capture on first.' };
    }
    return {
      success: `📂 Current capture file: ${current}`,
      lines: ['Use /capture last [path] to export the most recent exchange.'],
    };
  }

  return usage();
}
