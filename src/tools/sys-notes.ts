import fs from 'node:fs/promises';

import type { VaultStore } from '../vault.js';

/** Patterns that indicate system-modifying commands worth auto-noting. */
const SYS_CHANGE_PATTERNS = [
  /\b(apt|apt-get|dnf|yum|pacman|pip|npm)\s+(install|remove|purge|upgrade|update)\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
  /\bufw\s+(allow|deny|delete|enable|disable)\b/i,
  /\biptables\s+(-A|-I|-D)\b/i,
  /\buseradd\b/i,
  /\buserdel\b/i,
  /\bcrontab\b/i,
];

/** Auto-note significant system changes to Vault (sys mode only). */
export async function autoNoteSysChange(
  vault: VaultStore,
  command: string,
  output: string
): Promise<void> {
  const isSignificant = SYS_CHANGE_PATTERNS.some((p) => p.test(command));
  if (!isSignificant) return;

  const summary = output.length > 200 ? output.slice(0, 197) + '...' : output;
  const value = `Command: ${command}\nOutput: ${summary}`;
  await vault.note(`sys:${command.slice(0, 80)}`, value);
}

/** Snapshot a file's contents to Vault before editing (for /etc/ config tracking). */
export async function snapshotBeforeEdit(vault: VaultStore, filePath: string): Promise<void> {
  if (!filePath.startsWith('/etc/')) return;
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const snippet = content.length > 500 ? content.slice(0, 497) + '...' : content;
    await vault.note(`sys:pre-edit:${filePath}`, `Snapshot before edit:\n${snippet}`);
  } catch {
    // File doesn't exist yet or not readable — skip
  }
}
