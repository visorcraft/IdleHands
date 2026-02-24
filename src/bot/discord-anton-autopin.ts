import path from 'node:path';

import type { Message } from 'discord.js';

import type { IdlehandsConfig } from '../types.js';

import { shouldAutoPinBeforeAntonStart } from './anton-auto-pin.js';
import { detectRepoCandidates, expandHome, isPathAllowed } from './dir-guard.js';
import type { ManagedSession } from './discord.js';

/** Best-effort auto-pin before `/anton <file>` when configured and not already pinned. */
export async function maybeAutoPinDiscordAntonStart(
  managed: ManagedSession,
  msg: Message,
  args: string,
  defaultDir: string,
  recreateSession: (managed: ManagedSession, cfg: IdlehandsConfig) => Promise<void>,
  sendUserVisible: (msg: Message, text: string) => Promise<Message>
): Promise<{ handled: boolean }> {
  const autoPinEnabled = managed.config?.anton?.auto_pin_current_dir === true;
  if (!shouldAutoPinBeforeAntonStart({ args, autoPinEnabled, dirPinned: managed.dirPinned })) {
    return { handled: false };
  }

  const currentDir = path.resolve(expandHome(managed.config.dir || defaultDir));
  if (!isPathAllowed(currentDir, managed.allowedDirs)) {
    await sendUserVisible(
      msg,
      '❌ Anton auto-pin failed: current directory is not allowed. Use /dir <path> first.'
    ).catch(() => {});
    return { handled: true };
  }

  const repoCandidates = await detectRepoCandidates(currentDir, managed.allowedDirs).catch(
    () => managed.repoCandidates
  );
  const cfg: IdlehandsConfig = {
    ...managed.config,
    dir: currentDir,
    allowed_write_roots: managed.allowedDirs,
    dir_pinned: true,
    repo_candidates: repoCandidates,
  };

  await recreateSession(managed, cfg);
  managed.dirPinned = true;
  managed.repoCandidates = repoCandidates;
  await sendUserVisible(msg, `📌 Anton auto-pinned working directory to \`${currentDir}\``).catch(
    () => {}
  );

  return { handled: false };
}
