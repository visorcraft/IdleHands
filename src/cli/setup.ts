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
import type {
  RuntimesConfig,
  RuntimeHost,
  RuntimeBackend,
  RuntimeModel,
} from '../runtime/types.js';
import {
  HIDE_CURSOR,
  SHOW_CURSOR,
  ERASE_LINE,
  enterFullScreen as enterFullScreenBase,
  leaveFullScreen as leaveFullScreenBase,
  clearScreen,
} from '../tui/screen.js';

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
import { splitTokens } from './command-utils.js';
import { getActiveRuntimeEndpoint } from './runtime-detect.js';

// ── ANSI codes ───────────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

// ── ASCII art ────────────────────────────────────────────────────────

// ANSI Shadow logo (74 chars wide — fits 80-col terminals with indent)
const LOGO_WIDE = [
  `${CYAN} ██╗██████╗ ██╗     ███████╗${RESET}    ${BOLD}██╗  ██╗ █████╗ ███╗   ██╗██████╗ ███████╗${RESET}`,
  `${CYAN} ██║██╔══██╗██║     ██╔════╝${RESET}    ${BOLD}██║  ██║██╔══██╗████╗  ██║██╔══██╗██╔════╝${RESET}`,
  `${CYAN} ██║██║  ██║██║     █████╗${RESET}      ${BOLD}███████║███████║██╔██╗ ██║██║  ██║███████╗${RESET}`,
  `${CYAN} ██║██║  ██║██║     ██╔══╝${RESET}      ${BOLD}██╔══██║██╔══██║██║╚██╗██║██║  ██║╚════██║${RESET}`,
  `${CYAN} ██║██████╔╝███████╗███████╗${RESET}    ${BOLD}██║  ██║██║  ██║██║ ╚████║██████╔╝███████║${RESET}`,
  `${CYAN} ╚═╝╚═════╝ ╚══════╝╚══════╝${RESET}    ${BOLD}╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝${RESET}`,
];

// Compact fallback for narrow terminals
const LOGO_NARROW = [`  ${CYAN}${BOLD}I D L E${RESET}   ${BOLD}H A N D S${RESET}`];

// ── Screen helpers ───────────────────────────────────────────────────

let inAltScreen = false;

function enterFullScreen(): void {
  enterFullScreenBase();
  inAltScreen = true;
}

function leaveFullScreen(): void {
  leaveFullScreenBase();
  inAltScreen = false;
}

function drawHeader(stepLabel?: string): void {
  clearScreen();
  const cols = process.stdout.columns ?? 80;
  const logo = cols >= 78 ? LOGO_WIDE : LOGO_NARROW;
  console.log();
  for (const line of logo) {
    console.log(line);
  }
  console.log(`  ${DIM}Local-first coding agent${RESET}`);
  if (stepLabel) {
    console.log();
    const bar = '─'.repeat(Math.min(cols - 4, 60));
    console.log(`  ${DIM}${bar}${RESET}`);
    console.log(`  ${BOLD}${stepLabel}${RESET}`);
  }
  console.log();
}

// ── Input helpers ────────────────────────────────────────────────────

function info(text: string): void {
  console.log(`  ${DIM}${text}${RESET}`);
}

function success(text: string): void {
  console.log(`  ${GREEN}✓${RESET} ${text}`);
}

function warn(text: string): void {
  console.log(`  ${YELLOW}⚠${RESET} ${text}`);
}

async function ask(rl: readline.Interface, prompt: string, fallback = ''): Promise<string> {
  process.stdout.write(SHOW_CURSOR);
  const hint = fallback ? ` ${DIM}[${fallback}]${RESET}` : '';
  const ans = (await rl.question(`  ${prompt}${hint}: `)).trim();
  return ans || fallback;
}

async function pause(): Promise<void> {
  return new Promise<void>((resolve) => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(`  ${DIM}Press any key to continue...${RESET}`);
    const onData = (buf: Buffer) => {
      const key = buf.toString();
      if (key === '\x03') {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(wasRaw ?? false);
        leaveFullScreen();
        process.exit(0);
      }
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw ?? false);
      resolve();
    };
    process.stdin.on('data', onData);
  });
}

async function askYN(rl: readline.Interface, prompt: string, defaultYes = true): Promise<boolean> {
  process.stdout.write(SHOW_CURSOR);
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const ans = (await rl.question(`  ${prompt} ${DIM}[${hint}]${RESET}: `)).trim().toLowerCase();
  if (!ans) return defaultYes;
  return ans.startsWith('y');
}

// ── Arrow-key selector ───────────────────────────────────────────────

function MOVE_UP(n: number): string {
  return n > 0 ? `\x1b[${n}A` : '';
}

async function selectChoice(
  choices: { value: string; desc?: string }[],
  defaultValue: string
): Promise<string> {
  const defaultIdx = Math.max(
    0,
    choices.findIndex((c) => c.value === defaultValue)
  );
  let selected = defaultIdx;

  function render(firstDraw: boolean): void {
    // +2 for the blank line + hint line after choices
    if (!firstDraw) {
      process.stdout.write(MOVE_UP(choices.length + 2));
    }
    const maxLen = Math.max(...choices.map((c) => c.value.length));
    for (let i = 0; i < choices.length; i++) {
      const c = choices[i];
      const arrow = i === selected ? `${GREEN}❯${RESET}` : ' ';
      const padded = c.value.padEnd(maxLen);
      const label = i === selected ? `${BOLD}${padded}${RESET}` : `${DIM}${padded}${RESET}`;
      const desc = c.desc ? `  ${DIM}${c.desc}${RESET}` : '';
      process.stdout.write(`${ERASE_LINE}  ${arrow} ${label}${desc}\n`);
    }
    process.stdout.write(`${ERASE_LINE}\n`);
    process.stdout.write(`${ERASE_LINE}  ${DIM}↑/↓ to move, Enter to select${RESET}\n`);
  }

  process.stdout.write('\n');
  process.stdout.write(HIDE_CURSOR);
  render(true);

  return new Promise<string>((resolve) => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (buf: Buffer) => {
      const key = buf.toString();
      if (key === '\x1b[A' || key === 'k') {
        selected = (selected - 1 + choices.length) % choices.length;
        render(false);
      } else if (key === '\x1b[B' || key === 'j') {
        selected = (selected + 1) % choices.length;
        render(false);
      } else if (key === '\r' || key === '\n') {
        cleanup();
        resolve(choices[selected].value);
      } else if (key === '\x03') {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(wasRaw ?? false);
        leaveFullScreen();
        process.exit(0);
      }
    };

    function cleanup(): void {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdout.write(MOVE_UP(1));
      process.stdout.write(`${ERASE_LINE}  ${GREEN}✓${RESET} ${choices[selected].value}\n`);
    }

    process.stdin.on('data', onData);
  });
}

// ── Runtime detection ────────────────────────────────────────────────

// ── Fullscreen TUI runtime add forms ─────────────────────────────────

async function addHostTUI(
  rl: readline.Interface,
  existing?: RuntimeHost
): Promise<RuntimeHost | null> {
  const editing = !!existing;
  drawHeader(editing ? `Runtime — Edit Host: ${existing!.id}` : 'Runtime — Add Host');
  info('A host is a machine that runs inference.');
  console.log();

  if (!editing) {
    console.log(`  ${BOLD}Location${RESET}`);
    info('Where is this host?');
  }
  const currentTransport = existing?.transport === 'ssh' ? 'remote' : 'local';
  const transportLabel = await selectChoice(
    [
      { value: 'local', desc: 'This machine' },
      { value: 'remote', desc: 'A remote server on your network' },
    ],
    currentTransport
  );
  const transport = (transportLabel === 'remote' ? 'ssh' : 'local') as 'local' | 'ssh';

  console.log();
  console.log(`  ${BOLD}Identity${RESET}`);
  info('A short id and display name for this host.');
  const id = await ask(rl, 'Host id (e.g. my-gpu-box)', existing?.id ?? '');
  if (!id) return null;
  const displayName = await ask(rl, 'Display name', existing?.display_name ?? id);

  let connection: RuntimeHost['connection'] = {};
  if (transport === 'ssh') {
    console.log();
    console.log(`  ${BOLD}SSH connection${RESET}`);
    info('How to reach this host over the network.');
    connection.host = await ask(rl, 'Hostname or IP', existing?.connection?.host ?? '');
    const portStr = await ask(rl, 'Port', String(existing?.connection?.port ?? 22));
    connection.port = Number(portStr) || 22;
    const user = await ask(rl, 'User', existing?.connection?.user ?? '');
    if (user) connection.user = user;
    const keyPath = await ask(rl, 'Key path', existing?.connection?.key_path ?? '');
    if (keyPath) connection.key_path = keyPath;
  }

  console.log();
  console.log(`  ${BOLD}Capabilities${RESET}`);
  info('Hardware tags for matching models to hosts.');
  const gpuRaw = await ask(
    rl,
    'GPU tags, comma-separated (e.g. RTX 4090)',
    existing?.capabilities?.gpu?.join(', ') ?? ''
  );
  const gpu = gpuRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const backendsRaw = await ask(
    rl,
    'Backends, comma-separated (e.g. cuda,rocm,vulkan)',
    existing?.capabilities?.backends?.join(', ') ?? ''
  );
  const backends = backendsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  console.log();
  console.log(`  ${BOLD}Commands${RESET}`);
  info('Shell commands for lifecycle management.');
  const stopCmd = await ask(
    rl,
    'Stop model command',
    existing?.model_control?.stop_cmd ?? 'pkill -f llama-server || true'
  );
  const healthCmd = await ask(rl, 'Health check command', existing?.health?.check_cmd ?? 'true');

  return {
    id,
    display_name: displayName,
    enabled: existing?.enabled ?? true,
    transport,
    connection,
    capabilities: { gpu, backends },
    health: { check_cmd: healthCmd, timeout_sec: existing?.health?.timeout_sec ?? 5 },
    model_control: { stop_cmd: stopCmd, cleanup_cmd: existing?.model_control?.cleanup_cmd ?? null },
  };
}

async function addBackendTUI(
  rl: readline.Interface,
  hosts: string[],
  existing?: RuntimeBackend
): Promise<RuntimeBackend | null> {
  const editing = !!existing;
  drawHeader(editing ? `Runtime — Edit Backend: ${existing!.id}` : 'Runtime — Add Backend');
  info('A backend is a GPU compute layer for running inference.');
  console.log();

  console.log(`  ${BOLD}Identity${RESET}`);
  info('A short id and display name for this backend.');
  const id = await ask(rl, 'Backend id (e.g. vulkan-radv)', existing?.id ?? '');
  if (!id) return null;
  const displayName = await ask(rl, 'Display name', existing?.display_name ?? id);

  console.log();
  console.log(`  ${BOLD}Type${RESET}`);
  info('Which GPU compute layer does this backend use?');
  const type = (await selectChoice(
    [
      { value: 'vulkan', desc: 'Vulkan (RADV, etc.)' },
      { value: 'rocm', desc: 'AMD ROCm' },
      { value: 'cuda', desc: 'NVIDIA CUDA' },
      { value: 'metal', desc: 'Apple Metal' },
      { value: 'cpu', desc: 'CPU only' },
      { value: 'custom', desc: 'Custom backend' },
    ],
    existing?.type ?? 'vulkan'
  )) as RuntimeBackend['type'];

  let hostFilters: 'any' | string[] = existing?.host_filters ?? 'any';
  if (hosts.length > 1) {
    console.log();
    const currentFilters = Array.isArray(hostFilters) ? hostFilters.join(', ') : 'any';
    const filtersRaw = await ask(rl, `Host filter (any, or: ${hosts.join(', ')})`, currentFilters);
    hostFilters =
      filtersRaw === 'any'
        ? 'any'
        : filtersRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
  }

  console.log();
  console.log(`  ${BOLD}Verify command${RESET}`);
  info('Optional shell command to check the backend is working (exit 0 = OK).');
  const verifyCmd = await ask(rl, 'Command', existing?.verify_cmd ?? '');

  console.log();
  console.log(`  ${BOLD}Environment variables${RESET}`);
  info('Passed to all models on this backend.');
  info(`Example: ${DIM}VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/radeon_icd.x86_64.json${RESET}`);
  const existingEnvStr = existing?.env
    ? Object.entries(existing.env)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
    : '';
  const envRaw = await ask(rl, 'KEY=VALUE pairs (space-separated)', existingEnvStr);
  const env: Record<string, string> = {};
  if (envRaw) {
    for (const pair of splitTokens(envRaw)) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) env[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }

  console.log();
  console.log(`  ${BOLD}Extra CLI args${RESET}`);
  info('Appended to all model launch commands on this backend.');
  info(`Example: ${DIM}-fa 1 -mmp 0 -ub 2048 -ctk q4_0 -ctv q4_0 -ngl 0${RESET}`);
  const existingArgsStr = existing?.args?.join(' ') ?? '';
  const argsRaw = await ask(rl, 'Args (space-separated)', existingArgsStr);
  const args = argsRaw ? splitTokens(argsRaw) : [];

  return {
    id,
    display_name: displayName,
    enabled: existing?.enabled ?? true,
    type,
    host_filters: hostFilters,
    apply_cmd: existing?.apply_cmd ?? null,
    verify_cmd: verifyCmd || null,
    rollback_cmd: existing?.rollback_cmd ?? null,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(args.length > 0 ? { args } : {}),
  };
}

async function addModelTUI(
  rl: readline.Interface,
  hosts: string[],
  backends: string[],
  existing?: RuntimeModel
): Promise<RuntimeModel | null> {
  const editing = !!existing;
  drawHeader(editing ? `Runtime — Edit Model: ${existing!.id}` : 'Runtime — Add Model');
  info('A model is a GGUF (or other format) with launch and probe commands.');
  info(`Template variables: ${DIM}{backend_env}, {source}, {port}, {backend_args}, {host}${RESET}`);
  console.log();

  console.log(`  ${BOLD}Identity${RESET}`);
  info('A short id, display name, and source path or URL.');
  const id = await ask(rl, 'Model id (e.g. qwen3-coder-q4)', existing?.id ?? '');
  if (!id) return null;
  const displayName = await ask(rl, 'Display name', existing?.display_name ?? id);
  const source = await ask(rl, 'Source (file path or URL)', existing?.source ?? '');

  console.log();
  console.log(`  ${BOLD}Launch${RESET}`);
  info('Commands to start and health-check the inference server.');
  const defaultStart =
    'nohup {backend_env} llama-server -m {source} --port {port} --ctx-size 131072 {backend_args} --host 0.0.0.0 > /tmp/llama-server.log 2>&1 &';
  const startCmd = await ask(rl, 'Start command', existing?.launch?.start_cmd ?? defaultStart);
  const probeCmd = await ask(
    rl,
    'Probe command',
    existing?.launch?.probe_cmd ?? 'curl -fsS http://127.0.0.1:{port}/health'
  );
  const probeTimeoutStr = await ask(
    rl,
    'Probe timeout (seconds)',
    String(existing?.launch?.probe_timeout_sec ?? 60)
  );
  const probeTimeout = Math.max(5, Number(probeTimeoutStr) || 60);

  console.log();
  console.log(`  ${BOLD}Network${RESET}`);
  info('Port the inference server listens on.');
  const portStr = await ask(rl, 'Default port', String(existing?.runtime_defaults?.port ?? 8080));
  const port = Number(portStr) || 8080;

  let hostPolicy: 'any' | string[] = existing?.host_policy ?? 'any';
  let backendPolicy: 'any' | string[] = existing?.backend_policy ?? 'any';
  if (hosts.length > 1) {
    console.log();
    const currentHp = Array.isArray(hostPolicy) ? hostPolicy.join(', ') : 'any';
    const hp = await ask(rl, `Host policy (any, or: ${hosts.join(', ')})`, currentHp);
    hostPolicy =
      hp === 'any'
        ? 'any'
        : hp
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
  }
  if (backends.length > 1) {
    const currentBp = Array.isArray(backendPolicy) ? backendPolicy.join(', ') : 'any';
    const bp = await ask(rl, `Backend policy (any, or: ${backends.join(', ')})`, currentBp);
    backendPolicy =
      bp === 'any'
        ? 'any'
        : bp
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
  }

  return {
    id,
    display_name: displayName,
    enabled: existing?.enabled ?? true,
    source,
    host_policy: hostPolicy,
    backend_policy: backendPolicy,
    launch: {
      start_cmd: startCmd,
      probe_cmd: probeCmd,
      probe_timeout_sec: probeTimeout,
      probe_interval_ms: existing?.launch?.probe_interval_ms ?? 1000,
    },
    runtime_defaults: { port },
    split_policy: existing?.split_policy ?? null,
  };
}

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
    if (inAltScreen) leaveFullScreen();
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
    if (inAltScreen) leaveFullScreen();
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
