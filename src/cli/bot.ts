/**
 * Bot subcommand: `idlehands bot telegram` / `idlehands bot discord` / `idlehands bot --all`.
 *
 * Handles interactive Telegram/Discord setup wizard, systemd service management,
 * and bot startup for both frontends.
 */

import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';

import { loadConfig } from '../config.js';
import { projectDir } from '../utils.js';

// ── Exported types + helpers (shared with setup.ts) ──────────────────

export interface BotSetupConfig {
  token: string;
  allowed_users: number[];
  default_dir: string;
  guild_id?: string; // Discord only
  allow_guilds?: boolean; // Discord only
}

export function parseUserIds(raw: string): number[] {
  return raw
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function validateBotConfig(cfg: Partial<BotSetupConfig>): string | null {
  if (!cfg.token?.trim()) return 'Bot token is required.';
  if (!cfg.allowed_users?.length) return 'At least one allowed user ID is required.';
  return null;
}

export function maskToken(token: string): string {
  if (!token || token.length < 12) return '****';
  return token.slice(0, 4) + '...' + token.slice(-4);
}

// ── Unified service name ─────────────────────────────────────────────

const UNIFIED_SERVICE = 'idlehands-bot.service';
const OLD_SERVICES = ['idlehands-bot-telegram.service', 'idlehands-bot-discord.service'];

// ── systemd helpers (exported for setup.ts + service.ts) ─────────────

export function hasSystemd(): boolean {
  const r = spawnSync('systemctl', ['--user', '--version'], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0;
}

export function serviceState(serviceName?: string) {
  const name = serviceName ?? UNIFIED_SERVICE;
  const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', name);
  const exists = fsSync.existsSync(unitPath);

  const enabledProc = spawnSync('systemctl', ['--user', 'is-enabled', name], { encoding: 'utf8' });
  const activeProc = spawnSync('systemctl', ['--user', 'is-active', name], { encoding: 'utf8' });

  const enabled = enabledProc.status === 0;
  const active = activeProc.status === 0;
  return { exists, enabled, active, unitPath, name };
}

export async function migrateOldServices(): Promise<string[]> {
  const migrated: string[] = [];
  for (const name of OLD_SERVICES) {
    const st = serviceState(name);
    if (st.exists) {
      if (st.active || st.enabled) {
        spawnSync('systemctl', ['--user', 'disable', '--now', name], { stdio: 'pipe' });
      }
      await fs.unlink(st.unitPath).catch(() => {});
      migrated.push(name);
    }
  }
  if (migrated.length > 0) {
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  }
  return migrated;
}

export async function installBotService(): Promise<boolean> {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, UNIFIED_SERVICE);
  await fs.mkdir(unitDir, { recursive: true });

  const content =
    [
      '[Unit]',
      'Description=Idle Hands Bot Service',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      // Resolve idlehands via PATH at service start time so upgrades/install-prefix
      // changes do not bake in a stale absolute script path.
      'ExecStart=/usr/bin/env idlehands bot --all',
      'Restart=on-failure',
      'RestartSec=10',
      `Environment=PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      '',
      '[Install]',
      'WantedBy=default.target',
    ].join('\n') + '\n';

  await fs.writeFile(unitPath, content, 'utf8');
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  spawnSync('systemctl', ['--user', 'enable', '--now', UNIFIED_SERVICE], { stdio: 'pipe' });
  return true;
}

export async function uninstallBotService(): Promise<boolean> {
  const st = serviceState(UNIFIED_SERVICE);
  if (!st.exists) return false;
  if (st.active || st.enabled) {
    spawnSync('systemctl', ['--user', 'disable', '--now', UNIFIED_SERVICE], { stdio: 'pipe' });
  }
  await fs.unlink(st.unitPath).catch(() => {});
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  return true;
}

export function checkLingerEnabled(): boolean {
  const user = os.userInfo().username;
  // Check /var/lib/systemd/linger/<user> (standard location)
  return fsSync.existsSync(`/var/lib/systemd/linger/${user}`);
}

// ── Config patch helper ──────────────────────────────────────────────

type JsonObj = Record<string, any>;

async function writeConfigPatch(configPath: string, patch: JsonObj): Promise<void> {
  let raw: JsonObj = {};
  try {
    const txt = await fs.readFile(configPath, 'utf8');
    raw = txt.trim() ? JSON.parse(txt) : {};
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  raw.bot = raw.bot ?? {};
  if (patch.bot?.telegram) {
    raw.bot.telegram = { ...(raw.bot.telegram ?? {}), ...patch.bot.telegram };
  }
  if (patch.bot?.discord) {
    raw.bot.discord = { ...(raw.bot.discord ?? {}), ...patch.bot.discord };
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

// ── Help ─────────────────────────────────────────────────────────────

export function printBotHelp(): void {
  console.log(`Usage:
  idlehands bot telegram     Start Telegram bot
  idlehands bot discord      Start Discord bot
  idlehands bot --all        Start all configured bots

Starts a bot frontend (long-running daemon).

Telegram config (bot.telegram):
  Required: bot.telegram.token, bot.telegram.allowed_users
  Env:      IDLEHANDS_TG_TOKEN, IDLEHANDS_TG_ALLOWED_USERS

Discord config (bot.discord):
  Required: bot.discord.token, bot.discord.allowed_users
  Env:      IDLEHANDS_DISCORD_TOKEN, IDLEHANDS_DISCORD_ALLOWED_USERS

Optional (both):
  default_dir, session_timeout_min, max_sessions, max_queue,
  confirm_timeout_sec, approval_mode
`);
}

// ── Bot subcommand entry point ───────────────────────────────────────

interface BotSubcommandOpts {
  botTarget: string;
  config: any;
  configPath: string;
  cliCfg: any;
  all?: boolean;
}

export async function runBotSubcommand(opts: BotSubcommandOpts): Promise<void> {
  const { botTarget, config, configPath, cliCfg } = opts;

  // ── bot --all: start all configured bots concurrently ────────
  if (opts.all || botTarget === 'all') {
    const promises: Promise<void>[] = [];
    const tgCfg = config.bot?.telegram ?? {};
    const dcCfg = config.bot?.discord ?? {};
    const tgToken = process.env.IDLEHANDS_TG_TOKEN || tgCfg.token;
    const dcToken = process.env.IDLEHANDS_DISCORD_TOKEN || dcCfg.token;

    if (tgToken) {
      const { startTelegramBot } = await import('../bot/telegram.js');
      promises.push(startTelegramBot(config, { ...tgCfg, token: tgToken }));
    }
    if (dcToken) {
      const { startDiscordBot } = await import('../bot/discord.js');
      promises.push(startDiscordBot(config, { ...dcCfg, token: dcToken }));
    }
    if (promises.length === 0) {
      console.log('[bot] No bots configured. Run: idlehands setup');
      process.exit(0);
    }
    console.log(`[bot] Starting ${promises.length} bot(s)...`);
    await Promise.all(promises);
    return;
  }

  // ── bot telegram ─────────────────────────────────────────────
  if (botTarget === 'telegram') {
    const isTTY = !!(process.stdin.isTTY && process.stdout.isTTY);
    const serviceName = UNIFIED_SERVICE;

    let botConfig = config.bot?.telegram ?? {};
    const envToken = process.env.IDLEHANDS_TG_TOKEN;
    const envAllowed = process.env.IDLEHANDS_TG_ALLOWED_USERS;
    const effectiveAllowed = envAllowed
      ? parseUserIds(envAllowed)
      : Array.isArray(botConfig.allowed_users)
        ? botConfig.allowed_users
        : [];
    const hasConfig = Boolean(envToken || botConfig.token) && effectiveAllowed.length > 0;

    if (!hasConfig) {
      if (!isTTY) {
        console.error('[bot] Telegram bot not configured. Run: idlehands setup');
        process.exit(0);
      }

      const rlSetup = readline.createInterface({ input, output });
      try {
        console.log('[bot] Telegram setup wizard');
        const tokenIn = (await rlSetup.question('Bot token (from @BotFather): ')).trim();
        const usersIn = (
          await rlSetup.question('Allowed Telegram user IDs (comma-separated): ')
        ).trim();
        const dirDefault = botConfig.default_dir || projectDir(config);
        const dirIn = (await rlSetup.question(`Default working dir [${dirDefault}]: `)).trim();

        const ids = parseUserIds(usersIn);
        if (!tokenIn || ids.length === 0) {
          console.error(
            '[bot] Setup cancelled: token and at least one allowed user ID are required.'
          );
          process.exit(0);
        }

        await writeConfigPatch(configPath, {
          bot: {
            telegram: { token: tokenIn, allowed_users: ids, default_dir: dirIn || dirDefault },
          },
        });

        const loaded = await loadConfig({ configPath, cli: cliCfg });
        botConfig = loaded.config.bot?.telegram ?? {};
        console.log(`[bot] Saved Telegram config to ${configPath}`);
      } finally {
        rlSetup.close();
      }
    }

    // Check service state and offer foreground debug if active
    const st = serviceState(serviceName);
    if (isTTY && st.active) {
      const rlDbg = readline.createInterface({ input, output });
      try {
        const ans = (
          await rlDbg.question(
            `Service ${serviceName} is active. Run in debug foreground instead? [y/N] `
          )
        )
          .trim()
          .toLowerCase();
        if (ans !== 'y' && ans !== 'yes') {
          console.log('[bot] Service is active. Nothing else to do.');
          return;
        }
        const confirm = (
          await rlDbg.question('Debug mode will stop the service temporarily. Continue? [y/N] ')
        )
          .trim()
          .toLowerCase();
        if (confirm !== 'y' && confirm !== 'yes') {
          console.log('[bot] Keeping service mode. Exiting.');
          return;
        }
        spawnSync('systemctl', ['--user', 'stop', serviceName], { stdio: 'inherit' });
        console.log(
          `[bot] Service stopped for debug. Restart with: systemctl --user start ${serviceName}`
        );
      } finally {
        rlDbg.close();
      }
    }

    const { startTelegramBot } = await import('../bot/telegram.js');
    await startTelegramBot(config, botConfig);
    return;
  }

  // ── bot discord ──────────────────────────────────────────────
  if (botTarget === 'discord') {
    const { startDiscordBot } = await import('../bot/discord.js');
    const botConfig = config.bot?.discord ?? {};
    await startDiscordBot(config, botConfig);
    return;
  }

  console.error(`Unknown bot target: ${botTarget}. Supported: telegram, discord, --all`);
  process.exit(0);
}
