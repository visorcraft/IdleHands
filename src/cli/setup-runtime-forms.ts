import type readline from 'node:readline/promises';

import type { RuntimeBackend, RuntimeHost, RuntimeModel } from '../runtime/types.js';

import { splitTokens } from './command-utils.js';
import { ask, drawHeader, info, selectChoice } from './setup-ui.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export async function addHostTUI(
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

export async function addBackendTUI(
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
  const args = await ask(rl, 'Args (space-separated)', existingArgsStr);

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
    ...(args.trim().length > 0 ? { args: splitTokens(args) } : {}),
  };
}

export async function addModelTUI(
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
