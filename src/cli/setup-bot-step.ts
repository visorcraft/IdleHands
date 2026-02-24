import type readline from 'node:readline/promises';

import { parseUserIds, validateBotConfig, type BotSetupConfig } from './bot.js';
import { ask, drawHeader, info, pause, warn } from './setup-ui.js';

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

export async function setupBotStep(
  rl: readline.Interface,
  target: 'Telegram' | 'Discord',
  defaultDir: string,
  existing: BotSetupConfig | null
): Promise<BotSetupConfig | null> {
  const isTg = target === 'Telegram';
  drawHeader(`Step 7 of 7 — Bot Setup: ${target}`);

  console.log(`  ${BOLD}Bot token${RESET}`);
  info(
    isTg ? 'Get one from @BotFather on Telegram.' : 'Get one from the Discord Developer Portal.'
  );
  const token = await ask(rl, 'Token', existing?.token ?? '');
  if (!token.trim()) {
    warn(`No token provided. Skipping ${target}.`);
    await pause();
    return existing;
  }

  console.log();
  console.log(`  ${BOLD}Allowed users${RESET}`);
  info('Comma-separated numeric user IDs that are allowed to use the bot.');
  const usersRaw = await ask(
    rl,
    'User IDs',
    existing?.allowed_users?.length ? existing.allowed_users.join(',') : ''
  );
  const users = parseUserIds(usersRaw);
  if (!users.length) {
    warn('No valid user IDs entered. Skipping bot setup.');
    await pause();
    return existing;
  }

  let guildId: string | undefined;
  if (!isTg) {
    console.log();
    console.log(`  ${BOLD}Guild / server${RESET}`);
    info('Leave blank for DM-only mode.');
    const gid = await ask(rl, 'Guild ID', existing?.guild_id ?? '');
    guildId = gid.trim() || undefined;
  }

  console.log();
  console.log(`  ${BOLD}Working directory${RESET}`);
  info('Default project directory for bot sessions.');
  const dir = await ask(rl, 'Path', existing?.default_dir ?? defaultDir);
  const cfg: BotSetupConfig = {
    token: token.trim(),
    allowed_users: users,
    default_dir: dir.trim() || defaultDir,
    ...(guildId ? { guild_id: guildId, allow_guilds: true } : {}),
  };
  const err = validateBotConfig(cfg);
  if (err) {
    warn(err);
    await pause();
    return existing;
  }
  return cfg;
}
