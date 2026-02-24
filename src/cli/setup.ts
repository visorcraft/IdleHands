/**
 * Interactive first-run setup wizard (full-screen TUI).
 *
 * `idlehands setup` walks the user through configuring their endpoint,
 * model, working directory, and approval mode — then writes config.json.
 *
 * Returns 'run' if the user chose to launch Idle Hands, 'exit' otherwise.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';

import { defaultConfigPath, ensureConfigDir } from '../config.js';
import type { RuntimesConfig } from '../runtime/types.js';

import {
  parseUserIds,
  validateBotConfig,
  maskToken,
  serviceState,
  hasSystemd,
  migrateOldServices,
  installBotService,
  checkLingerEnabled,
  type BotSetupConfig,
} from './bot.js';
import { getActiveRuntimeEndpoint } from './runtime-detect.js';
import { addBackendTUI, addHostTUI, addModelTUI } from './setup-runtime-forms.js';
import {
  ask,
  askYN,
  drawHeader,
  enterFullScreen,
  info,
  isInAltScreen,
  leaveFullScreen,
  pause,
  selectChoice,
  success,
  warn,
} from './setup-ui.js';

// ── Runtime detection ────────────────────────────────────────────────

// ── Fullscreen TUI runtime add forms ─────────────────────────────────

// ── Main wizard ──────────────────────────────────────────────────────

// ── Bot setup helper (used by Step 5) ────────────────────────────────

async function setupBot(
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
  info(`User IDs that can ${isTg ? 'talk to' : 'use'} the bot. Everyone else is ignored.`);
  const usersStr = await ask(
    rl,
    'IDs (comma-separated)',
    existing?.allowed_users?.join(', ') ?? ''
  );
  const users = parseUserIds(usersStr);
  if (users.length === 0) {
    warn(`No valid user IDs. Skipping ${target}.`);
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

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

export type SetupResult = 'run' | 'exit';

export async function runSetup(existingConfigPath?: string): Promise<SetupResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Setup requires an interactive terminal.');
    process.exit(1);
  }

  const configPath = existingConfigPath ?? defaultConfigPath();

  let existingConfig: Record<string, any> | null = null;
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    existingConfig = JSON.parse(raw);
  } catch {
    /* no config yet */
  }

  const { loadRuntimes, saveRuntimes } = await import('../runtime/store.js');

  enterFullScreen();
  const exitHandler = () => {
    if (isInAltScreen()) leaveFullScreen();
  };
  process.on('exit', exitHandler);

  const rl = readline.createInterface({ input, output });
  let result: SetupResult = 'exit';
  let runtimeReady = false;

  try {
    // ── 1. Runtime (hosts → backends → models → select) ───────────

    let runtimes: RuntimesConfig;
    try {
      runtimes = await loadRuntimes();
    } catch {
      runtimes = { schema_version: 1, hosts: [], backends: [], models: [] };
    }

    // ── 1a. Hosts ──────────────────────────────────────────────────

    while (true) {
      runtimes = await loadRuntimes().catch(() => runtimes);
      drawHeader('Step 1 of 7 — Runtime: Hosts');

      if (runtimes.hosts.length === 0) {
        info('No hosts configured yet.');
      } else {
        for (const h of runtimes.hosts) {
          const loc =
            h.transport === 'ssh'
              ? `${h.connection?.user ? h.connection.user + '@' : ''}${h.connection?.host ?? '?'}`
              : 'local';
          success(`${h.id} ${DIM}(${loc})${RESET}`);
        }
      }
      console.log();

      const hostChoices = [
        ...runtimes.hosts.map((h) => ({ value: `edit:${h.id}`, desc: `Edit ${h.display_name}` })),
        { value: 'add', desc: 'Add a new host' },
        { value: 'continue', desc: 'Continue →' },
      ];
      const hostAction = await selectChoice(
        hostChoices,
        runtimes.hosts.length > 0 ? 'continue' : 'add'
      );

      if (hostAction === 'continue') break;
      if (hostAction === 'add') {
        const host = await addHostTUI(rl);
        if (host) {
          runtimes.hosts.push(host);
          await saveRuntimes(runtimes);
        }
      } else if (hostAction.startsWith('edit:')) {
        const idx = runtimes.hosts.findIndex((h) => h.id === hostAction.slice(5));
        if (idx >= 0) {
          const updated = await addHostTUI(rl, runtimes.hosts[idx]);
          if (updated) {
            runtimes.hosts[idx] = updated;
            await saveRuntimes(runtimes);
          }
        }
      }
    }

    // ── 1b. Backends ───────────────────────────────────────────────

    while (true) {
      runtimes = await loadRuntimes().catch(() => runtimes);
      const hostIds = runtimes.hosts.map((h) => h.id);
      drawHeader('Step 1 of 7 — Runtime: Backends');

      if (runtimes.backends.length === 0) {
        info('No backends configured yet.');
      } else {
        for (const b of runtimes.backends) {
          const envCount = b.env ? Object.keys(b.env).length : 0;
          const extra = [
            b.type,
            envCount > 0 ? `${envCount} env` : '',
            b.args?.length ? `${b.args.length} args` : '',
          ]
            .filter(Boolean)
            .join(', ');
          success(`${b.id} ${DIM}(${extra})${RESET}`);
        }
      }
      console.log();

      const backendChoices = [
        ...runtimes.backends.map((b) => ({
          value: `edit:${b.id}`,
          desc: `Edit ${b.display_name}`,
        })),
        { value: 'add', desc: 'Add a new backend' },
        { value: 'continue', desc: 'Continue →' },
      ];
      const backendAction = await selectChoice(
        backendChoices,
        runtimes.backends.length > 0 ? 'continue' : 'add'
      );

      if (backendAction === 'continue') break;
      if (backendAction === 'add') {
        const backend = await addBackendTUI(rl, hostIds);
        if (backend) {
          runtimes.backends.push(backend);
          await saveRuntimes(runtimes);
        }
      } else if (backendAction.startsWith('edit:')) {
        const idx = runtimes.backends.findIndex((b) => b.id === backendAction.slice(5));
        if (idx >= 0) {
          const updated = await addBackendTUI(rl, hostIds, runtimes.backends[idx]);
          if (updated) {
            runtimes.backends[idx] = updated;
            await saveRuntimes(runtimes);
          }
        }
      }
    }

    // ── 1c. Models ─────────────────────────────────────────────────

    while (true) {
      runtimes = await loadRuntimes().catch(() => runtimes);
      const hostIds = runtimes.hosts.map((h) => h.id);
      const backendIds = runtimes.backends.map((b) => b.id);
      drawHeader('Step 1 of 7 — Runtime: Models');

      if (runtimes.models.length === 0) {
        info('No models configured yet.');
      } else {
        for (const m of runtimes.models) {
          const port = m.runtime_defaults?.port ?? 8080;
          success(`${m.id} ${DIM}(port ${port})${RESET}`);
        }
      }
      console.log();

      const modelChoices = [
        ...runtimes.models.map((m) => ({ value: `edit:${m.id}`, desc: `Edit ${m.display_name}` })),
        { value: 'add', desc: 'Add a new model' },
        { value: 'continue', desc: 'Continue →' },
      ];
      const modelAction = await selectChoice(
        modelChoices,
        runtimes.models.length > 0 ? 'continue' : 'add'
      );

      if (modelAction === 'continue') break;
      if (modelAction === 'add') {
        const model = await addModelTUI(rl, hostIds, backendIds);
        if (model) {
          runtimes.models.push(model);
          await saveRuntimes(runtimes);
        }
      } else if (modelAction.startsWith('edit:')) {
        const idx = runtimes.models.findIndex((m) => m.id === modelAction.slice(5));
        if (idx >= 0) {
          const updated = await addModelTUI(rl, hostIds, backendIds, runtimes.models[idx]);
          if (updated) {
            runtimes.models[idx] = updated;
            await saveRuntimes(runtimes);
          }
        }
      }
    }

    // ── 1d. Select a model ─────────────────────────────────────────

    runtimes = await loadRuntimes();
    const enabledModels = runtimes.models.filter((m) => m.enabled);

    if (enabledModels.length > 0) {
      drawHeader('Runtime — Start Model');

      let modelId: string;
      if (enabledModels.length === 1) {
        modelId = enabledModels[0].id;
        info(`Starting model: ${BOLD}${modelId}${RESET}`);
      } else {
        info('Which model should we start?');
        console.log();
        modelId = await selectChoice(
          enabledModels.map((m) => ({ value: m.id, desc: m.display_name })),
          enabledModels[0].id
        );
      }

      console.log();
      info('Starting inference server...');
      console.log();

      try {
        const { plan } = await import('../runtime/planner.js');
        const { execute, loadActiveRuntime } = await import('../runtime/executor.js');
        const active = await loadActiveRuntime();
        const planResult = plan({ modelId, mode: 'live' }, runtimes, active);

        if (!planResult.ok) {
          warn(`Plan failed: ${planResult.reason}`);
        } else if (planResult.reuse) {
          success('Runtime already active and healthy.');
          runtimeReady = true;
        } else {
          const execResult = await execute(planResult, {
            onStep: (step, status, detail) => {
              if (status === 'start')
                process.stdout.write(`  ${DIM}${step.description}...${RESET}`);
              else if (status === 'done') process.stdout.write(` ${GREEN}✓${RESET}\n`);
              else if (status === 'error') {
                process.stdout.write(` ${RED}✗${RESET}\n`);
                if (detail) {
                  for (const line of detail.split('\n').slice(0, 8)) {
                    console.log(`    ${RED}${line}${RESET}`);
                  }
                }
              }
            },
            force: true,
          });

          if (execResult.ok) {
            console.log();
            success('Inference server started!');
            runtimeReady = true;
          } else {
            console.log();
            warn(`Failed to start: ${execResult.error || 'unknown error'}`);
          }
        }
      } catch (e: any) {
        warn(`Error: ${e?.message ?? String(e)}`);
      }

      console.log();
      await pause();
    }

    // ── 2. Working directory ───────────────────────────────────────

    drawHeader('Step 2 of 7 — Working Directory');

    console.log(`  ${BOLD}Default project directory${RESET}`);
    info('Where Idle Hands reads and writes files.');
    info('Override anytime with --dir or /dir in a session.');
    console.log();
    const currentDir = existingConfig?.dir || process.cwd();
    const dir = await ask(rl, 'Path', currentDir);
    const resolvedDir = path.resolve(dir.replace(/^~/, process.env.HOME ?? '~'));

    // ── 2b. Run-as User (optional) ────────────────────────────────

    drawHeader('Step 2b — Run as User (optional)');

    console.log(`  \${BOLD}Sandboxed execution\${RESET}`);
    info('Run Idle Hands as a different Linux user for isolation.');
    info('Leave blank to run as the current user.');
    info('Requires sudo access to switch users.');
    console.log();
    const currentRunAs = existingConfig?.run_as_user || '';
    const runAsUser = await ask(rl, 'Linux user (blank=current)', currentRunAs);
    const resolvedRunAs = runAsUser.trim() || '';

    // ── 3. Approval mode ──────────────────────────────────────────

    drawHeader('Step 3 of 7 — Approval Mode');

    console.log(`  ${BOLD}Safety level${RESET}`);
    info('Controls how much the agent can do without asking you first.');
    console.log();
    const currentApproval = existingConfig?.approval_mode || 'auto-edit';
    const approvalMode = await selectChoice(
      [
        { value: 'plan', desc: 'Read-only. Edits and commands recorded as plans.' },
        { value: 'default', desc: 'Confirms both file edits and shell commands.' },
        { value: 'auto-edit', desc: 'File edits automatic. Shell commands need confirmation.' },
        { value: 'yolo', desc: 'Everything automatic. Trusted codebases only.' },
      ],
      currentApproval
    );

    // ── 4. Response Timeout ─────────────────────────────────────

    drawHeader('Step 4 of 7 — Limits');

    console.log(`  ${BOLD}Response timeout${RESET}`);
    info('How long to wait for a full model reply before giving up.');
    const currentResponseTimeout = existingConfig?.response_timeout ?? 600;
    const responseTimeoutStr = await ask(rl, 'Seconds', String(currentResponseTimeout));
    const responseTimeout = Math.max(10, parseInt(responseTimeoutStr, 10) || 600);

    console.log();
    console.log(`  ${BOLD}Connection/header timeout${RESET}`);
    info('How long to wait for initial HTTP connection/response headers.');
    const currentConnectionTimeout = existingConfig?.connection_timeout ?? currentResponseTimeout;
    const connectionTimeoutStr = await ask(rl, 'Seconds', String(currentConnectionTimeout));
    const connectionTimeout = Math.max(10, parseInt(connectionTimeoutStr, 10) || responseTimeout);

    console.log();
    console.log(`  ${BOLD}Initial connection check${RESET}`);
    info('Run a fast preflight check before first ask to fail quickly when endpoint is down.');
    const currentInitialConnCheck = existingConfig?.initial_connection_check !== false;
    const initialConnectionCheck = await askYN(
      rl,
      'Enable initial connection check?',
      currentInitialConnCheck
    );

    console.log();
    console.log(`  ${BOLD}Initial connection timeout${RESET}`);
    info('Timeout for the first preflight check only.');
    const currentInitialConnTimeout = existingConfig?.initial_connection_timeout ?? 10;
    const initialConnectionTimeoutStr = await ask(rl, 'Seconds', String(currentInitialConnTimeout));
    const initialConnectionTimeout = Math.max(1, parseInt(initialConnectionTimeoutStr, 10) || 10);

    console.log();
    console.log(`  ${BOLD}Max iterations${RESET}`);
    info('Tool rounds per prompt. Higher = more complex tasks.');
    const currentMaxIter = existingConfig?.max_iterations ?? 100;
    const maxIterStr = await ask(rl, 'Value', String(currentMaxIter));
    const maxIterations = Math.max(1, parseInt(maxIterStr, 10) || 100);

    // ── 5. Sub-Agents ─────────────────────────────────────────────

    drawHeader('Step 5 of 7 — Sub-Agents');

    console.log(`  ${BOLD}Task delegation${RESET}`);
    info('Sub-agents let the model delegate independent subtasks in parallel.');
    info('Disable if you prefer single-agent execution or are on limited hardware.');
    console.log();
    const currentSubAgents = existingConfig?.sub_agents?.enabled !== false;
    const subAgentsEnabled = await askYN(rl, 'Enable sub-agents?', currentSubAgents);

    let subMaxIter = existingConfig?.sub_agents?.max_iterations ?? 50;
    let subMaxTokens = existingConfig?.sub_agents?.max_tokens ?? 16384;
    let subTimeoutSec = existingConfig?.sub_agents?.timeout_sec ?? 600;
    let subResultCap = existingConfig?.sub_agents?.result_token_cap ?? 4000;

    if (subAgentsEnabled) {
      const customize = await askYN(rl, 'Customize sub-agent limits?', false);
      if (customize) {
        drawHeader('Step 5 of 7 — Sub-Agent Limits');

        console.log(`  ${BOLD}Max iterations${RESET}`);
        info('Tool rounds a sub-agent gets per task.');
        const iterStr = await ask(rl, 'Value', String(subMaxIter));
        subMaxIter = Math.max(1, parseInt(iterStr, 10) || 50);

        console.log();
        console.log(`  ${BOLD}Max tokens${RESET}`);
        info('Token limit per sub-agent response.');
        const tokStr = await ask(rl, 'Value', String(subMaxTokens));
        subMaxTokens = Math.max(128, parseInt(tokStr, 10) || 16384);

        console.log();
        console.log(`  ${BOLD}Timeout${RESET}`);
        info('Seconds before a sub-agent is stopped.');
        const toStr = await ask(rl, 'Seconds', String(subTimeoutSec));
        subTimeoutSec = Math.max(10, parseInt(toStr, 10) || 600);

        console.log();
        console.log(`  ${BOLD}Result token cap${RESET}`);
        info('How much of the result is sent back to the parent.');
        const rcStr = await ask(rl, 'Value', String(subResultCap));
        subResultCap = Math.max(256, parseInt(rcStr, 10) || 4000);
      }
    }

    // ── 6. Theme ──────────────────────────────────────────────────

    drawHeader('Step 6 of 7 — Theme');

    console.log(`  ${BOLD}Color scheme${RESET}`);
    info('Pick a theme that matches your terminal.');
    console.log();
    const currentTheme = existingConfig?.theme || 'default';
    const theme = await selectChoice(
      [
        { value: 'default', desc: 'Standard colors' },
        { value: 'dark', desc: 'High contrast for dark terminals' },
        { value: 'light', desc: 'For light terminal backgrounds' },
        { value: 'minimal', desc: 'Stripped-down, less color' },
        { value: 'hacker', desc: 'Green on black' },
      ],
      currentTheme
    );

    // ── 7. Bot Setup ──────────────────────────────────────────────

    const existingTg = existingConfig?.bot?.telegram;
    const existingDc = existingConfig?.bot?.discord;

    let botTelegram: BotSetupConfig | null =
      existingTg?.token && existingTg?.allowed_users?.length
        ? {
            token: existingTg.token,
            allowed_users: existingTg.allowed_users,
            default_dir: existingTg.default_dir ?? '',
          }
        : null;
    let botDiscord: BotSetupConfig | null =
      existingDc?.token && existingDc?.allowed_users?.length
        ? {
            token: existingDc.token,
            allowed_users: existingDc.allowed_users,
            default_dir: existingDc.default_dir ?? '',
            guild_id: existingDc.guild_id,
            allow_guilds: existingDc.allow_guilds,
          }
        : null;

    while (true) {
      drawHeader('Step 7 of 7 — Bot Setup');
      info('Configure chat bot frontends (Telegram, Discord).');
      console.log();

      const botChoices: { value: string; desc: string }[] = [];
      if (botTelegram) {
        botChoices.push({
          value: 'edit-tg',
          desc: `\x1b[32m✓\x1b[0m Telegram (${maskToken(botTelegram.token)}, ${botTelegram.allowed_users.length} user${botTelegram.allowed_users.length === 1 ? '' : 's'}) — Edit`,
        });
      } else {
        botChoices.push({ value: 'add-tg', desc: 'Set up Telegram bot' });
      }
      if (botDiscord) {
        botChoices.push({
          value: 'edit-dc',
          desc: `\x1b[32m✓\x1b[0m Discord (${maskToken(botDiscord.token)}, ${botDiscord.allowed_users.length} user${botDiscord.allowed_users.length === 1 ? '' : 's'}) — Edit`,
        });
      } else {
        botChoices.push({ value: 'add-dc', desc: 'Set up Discord bot' });
      }
      botChoices.push({
        value: 'continue',
        desc: botTelegram || botDiscord ? 'Continue →' : 'Skip — no bots',
      });

      const botAction = await selectChoice(botChoices, 'continue');
      if (botAction === 'continue') break;

      if (botAction === 'add-tg' || botAction === 'edit-tg') {
        botTelegram = await setupBot(rl, 'Telegram', resolvedDir, botTelegram);
      }
      if (botAction === 'add-dc' || botAction === 'edit-dc') {
        botDiscord = await setupBot(rl, 'Discord', resolvedDir, botDiscord);
      }
    }

    // ── Summary + Write ───────────────────────────────────────────
    drawHeader('Setup Complete');
    const activeEndpoint = await getActiveRuntimeEndpoint();
    const endpoint = activeEndpoint || existingConfig?.endpoint || 'http://127.0.0.1:8080/v1';

    if (activeEndpoint) {
      console.log(`  Endpoint:      ${CYAN}${activeEndpoint}${RESET} ${DIM}(from runtime)${RESET}`);
    } else {
      console.log(`  Endpoint:      ${DIM}(will be set when a model is started)${RESET}`);
    }
    console.log(`  Directory:     ${CYAN}${resolvedDir}${RESET}`);
    if (resolvedRunAs) {
      console.log(`  Run as user:   ${CYAN}${resolvedRunAs}${RESET}`);
    }
    console.log(`  Approval mode: ${CYAN}${approvalMode}${RESET}`);
    console.log(
      `  Sub-agents:    ${subAgentsEnabled ? `${GREEN}enabled${RESET} ${DIM}(${subMaxIter} iters, ${subTimeoutSec}s timeout, ${subMaxTokens} tokens)${RESET}` : `${YELLOW}disabled${RESET}`}`
    );
    console.log(`  Theme:         ${CYAN}${theme}${RESET}`);
    if (botTelegram) {
      console.log(
        `  Telegram bot:  ${GREEN}✓${RESET} ${DIM}(token: ${maskToken(botTelegram.token)}, ${botTelegram.allowed_users.length} user${botTelegram.allowed_users.length === 1 ? '' : 's'})${RESET}`
      );
    }
    if (botDiscord) {
      console.log(
        `  Discord bot:   ${GREEN}✓${RESET} ${DIM}(token: ${maskToken(botDiscord.token)}, ${botDiscord.allowed_users.length} user${botDiscord.allowed_users.length === 1 ? '' : 's'}${botDiscord.guild_id ? `, guild: ${botDiscord.guild_id}` : ''})${RESET}`
      );
    }
    console.log(`  Config file:   ${DIM}${configPath}${RESET}`);
    console.log();

    const confirmed = await askYN(rl, 'Write this config?', true);
    if (!confirmed) {
      console.log(`\n  ${DIM}Cancelled. No changes written.${RESET}\n`);
    } else {
      const finalConfig: Record<string, any> = existingConfig ? { ...existingConfig } : {};
      finalConfig.endpoint = endpoint;
      finalConfig.model = '';
      finalConfig.dir = resolvedDir;
      if (resolvedRunAs) finalConfig.run_as_user = resolvedRunAs;
      finalConfig.approval_mode = approvalMode;
      finalConfig.no_confirm = approvalMode === 'yolo';
      finalConfig.response_timeout = responseTimeout;
      finalConfig.connection_timeout = connectionTimeout;
      finalConfig.initial_connection_check = initialConnectionCheck;
      finalConfig.initial_connection_timeout = initialConnectionTimeout;
      finalConfig.max_iterations = maxIterations;
      finalConfig.theme = theme;
      finalConfig.sub_agents = {
        ...(finalConfig.sub_agents ?? {}),
        enabled: subAgentsEnabled,
        max_iterations: subMaxIter,
        max_tokens: subMaxTokens,
        timeout_sec: subTimeoutSec,
        result_token_cap: subResultCap,
      };

      if (finalConfig.max_tokens === undefined) finalConfig.max_tokens = 16384;
      if (finalConfig.temperature === undefined) finalConfig.temperature = 0.2;
      if (finalConfig.timeout === undefined) finalConfig.timeout = 600;
      if (finalConfig.max_iterations === undefined) finalConfig.max_iterations = 100;
      if (finalConfig.mode === undefined) finalConfig.mode = 'code';

      // Bot config
      if (botTelegram) {
        finalConfig.bot = finalConfig.bot ?? {};
        finalConfig.bot.telegram = {
          ...(finalConfig.bot.telegram ?? {}),
          token: botTelegram.token,
          allowed_users: botTelegram.allowed_users,
          default_dir: botTelegram.default_dir,
        };
      }
      if (botDiscord) {
        finalConfig.bot = finalConfig.bot ?? {};
        finalConfig.bot.discord = {
          ...(finalConfig.bot.discord ?? {}),
          token: botDiscord.token,
          allowed_users: botDiscord.allowed_users,
          default_dir: botDiscord.default_dir,
          guild_id: botDiscord.guild_id,
          allow_guilds: botDiscord.allow_guilds,
        };
      }

      await ensureConfigDir(configPath);
      await fs.writeFile(configPath, JSON.stringify(finalConfig, null, 2) + '\n', 'utf8');
      success('Config saved!');
    }

    // ── Service installation ─────────────────────────────────────

    if ((botTelegram || botDiscord) && confirmed && hasSystemd()) {
      drawHeader('Background Service');
      const oldMigrated = await migrateOldServices();
      if (oldMigrated.length > 0) info(`Migrated old service(s): ${oldMigrated.join(', ')}`);

      const st = serviceState();
      if (st.active) {
        info('Bot service is already running.');
        if (await askYN(rl, 'Restart to apply new config?', true)) {
          (await import('node:child_process')).spawnSync(
            'systemctl',
            ['--user', 'restart', st.name],
            { stdio: 'pipe' }
          );
          success('Service restarted.');
        }
      } else {
        info('Install a background service so your bot(s) run automatically.');
        info('Uses systemd user service — no sudo required.');
        console.log();
        if (await askYN(rl, 'Install and start service?', true)) {
          await installBotService();
          success('Service installed and started!');
          info('View logs: journalctl --user -u idlehands-bot.service -f');
          if (!checkLingerEnabled()) warn('Linger not enabled. Run: loginctl enable-linger');
        }
      }
      console.log();
      await pause();
    }

    // ── Final action ──────────────────────────────────────────────
    const defaultAction = confirmed && runtimeReady ? 'run' : 'exit';
    const action = await selectChoice(
      [
        { value: 'run', desc: 'Start Idle Hands' },
        { value: 'exit', desc: 'Return to terminal' },
      ],
      defaultAction
    );

    result = action as SetupResult;
  } finally {
    try {
      rl.close();
    } catch {}
    if (isInAltScreen()) leaveFullScreen();
    process.removeListener('exit', exitHandler);
  }

  return result;
}
// ── Guided runtime onboarding (CLI fallback) ─────────────────────────
/** Called from index.ts when createSession fails — suggests setup. */
export async function guidedRuntimeOnboarding(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { loadRuntimes } = await import('../runtime/store.js');
  try {
    const rt = await loadRuntimes();
    if (rt.hosts.length > 0 && rt.backends.length > 0 && rt.models.length > 0) return false;
  } catch {
    return false;
  }
  console.log(
    `\n  ${YELLOW}⚠${RESET} No models found. Run ${BOLD}idlehands setup${RESET} for guided configuration.\n`
  );
  return false;
}
