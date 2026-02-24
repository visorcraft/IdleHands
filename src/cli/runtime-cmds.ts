import { spawnSync } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';

import { probeModelsEndpoint, waitForModelsReady } from '../runtime/health.js';
import {
  loadRuntimes,
  saveRuntimes,
  validateRuntimes,
  redactConfig,
  bootstrapRuntimes,
  interpolateTemplate,
} from '../runtime/store.js';
import type { RuntimeBackend, RuntimeHost, RuntimeModel } from '../runtime/types.js';
import { shellEscape } from '../utils.js';

import { firstToken } from './command-utils.js';
import {
  ask,
  isTTY,
  printList,
  runLocalCommand,
  runtimesFilePath,
  usage,
} from './runtime-common.js';
import { runHostCommand } from './runtime-host-command.js';
import { applyDynamicProbeDefaults } from './runtime-probe-defaults.js';
import { parseScanPorts } from './runtime-scan-ports.js';

export async function runHostsSubcommand(args: any, _config: any): Promise<void> {
  await bootstrapRuntimes();
  const cmd = String(args._[1] ?? '').toLowerCase();
  const id = String(args._[2] ?? '');

  const runtimes = await loadRuntimes();

  if (!cmd) {
    const rows = runtimes.hosts.map((h) => ({
      id: h.id,
      name: h.display_name,
      enabled: h.enabled,
      transport: h.transport,
      host: h.connection.host ?? 'local',
      backends: h.capabilities.backends.join(','),
    }));
    printList(rows);
    return;
  }

  if (cmd === 'show') {
    if (!id) throw new Error('hosts show requires <id>');
    const redacted = redactConfig(runtimes);
    const host = redacted.hosts.find((h) => h.id === id);
    if (!host) throw new Error(`host not found: ${id}`);
    process.stdout.write(JSON.stringify(host, null, 2) + '\n');
    return;
  }

  if (cmd === 'add') {
    if (!isTTY()) throw new Error('hosts add requires a TTY');
    const rl = readline.createInterface({ input, output });
    try {
      const host: RuntimeHost = {
        id: await ask(rl, 'Host id (e.g. local-main)'),
        display_name: await ask(rl, 'Display name'),
        enabled: (await ask(rl, 'Enabled (y/n)', 'y')).toLowerCase().startsWith('y'),
        transport:
          (await ask(rl, 'Transport (local/ssh)', 'local')).toLowerCase() === 'ssh'
            ? 'ssh'
            : 'local',
        connection: {
          host: undefined,
          port: undefined,
          user: undefined,
          key_path: undefined,
          password: undefined,
        },
        capabilities: {
          gpu: (await ask(rl, 'GPU tags (comma-separated)', ''))
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          vram_gb: (() => {
            const raw = args['vram-gb'] ?? undefined;
            return raw == null ? undefined : Number(raw);
          })(),
          backends: (await ask(rl, 'Supported backends (comma-separated)', ''))
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
        health: {
          check_cmd: await ask(rl, 'Health check command', 'true'),
          timeout_sec: Number(await ask(rl, 'Health timeout sec', '5')),
        },
        model_control: {
          stop_cmd: await ask(rl, 'Stop model command', 'pkill -f llama-server || true'),
          cleanup_cmd: await ask(rl, 'Cleanup command (optional)', ''),
        },
      };

      if (host.transport === 'ssh') {
        host.connection.host = await ask(rl, 'SSH host');
        host.connection.user = await ask(rl, 'SSH user', '');
        const p = await ask(rl, 'SSH port', '22');
        host.connection.port = Number(p);
        host.connection.key_path = await ask(rl, 'SSH key path (optional)', '');
      }

      if (!host.model_control.cleanup_cmd) host.model_control.cleanup_cmd = null;
      if (!host.connection.user) host.connection.user = undefined;
      if (!host.connection.key_path) host.connection.key_path = undefined;

      const next = { ...runtimes, hosts: [...runtimes.hosts, host] };
      await saveRuntimes(next);
      console.log(`Added host: ${host.id}`);
    } finally {
      rl.close();
    }
    return;
  }

  if (cmd === 'edit') {
    if (!id) throw new Error('hosts edit requires <id>');
    if (!runtimes.hosts.find((h) => h.id === id)) throw new Error(`host not found: ${id}`);
    const editor = process.env.EDITOR || 'vi';
    const file = runtimesFilePath();
    await bootstrapRuntimes(file);
    const p = spawnSync(editor, [file], { stdio: 'inherit' });
    if (p.status !== 0) throw new Error(`editor exited with code ${p.status}`);
    return;
  }

  if (cmd === 'remove') {
    if (!id) throw new Error('hosts remove requires <id>');
    const hit = runtimes.hosts.find((h) => h.id === id);
    if (!hit) throw new Error(`host not found: ${id}`);
    if (!isTTY()) throw new Error('hosts remove requires a TTY confirmation');
    const rl = readline.createInterface({ input, output });
    try {
      const ans = (await rl.question(`Remove host '${id}'? [y/N] `)).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        console.log('Cancelled.');
        return;
      }
    } finally {
      rl.close();
    }
    await saveRuntimes({ ...runtimes, hosts: runtimes.hosts.filter((h) => h.id !== id) });
    console.log(`Removed host: ${id}`);
    return;
  }

  if (cmd === 'validate') {
    try {
      validateRuntimes(runtimes);
      console.log('runtimes.json is valid.');
      process.exitCode = 0;
    } catch (e: any) {
      console.error(`invalid runtimes config: ${e?.message ?? String(e)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'test') {
    if (!id) throw new Error('hosts test requires <id>');
    const host = runtimes.hosts.find((h) => h.id === id);
    if (!host) throw new Error(`host not found: ${id}`);
    const command = interpolateTemplate(host.health.check_cmd, {
      host: host.connection.host,
      host_id: host.id,
      backend_args: '',
      backend_env: '',
      backend_id: '',
      model_id: '',
      source: '',
      port: '',
    });
    const res = await runHostCommand(host, command, host.health.timeout_sec ?? 5);
    console.log(`[${host.id}] ${res.ok ? 'OK' : 'FAIL'} (exit=${res.code ?? -1})`);
    if (res.stdout.trim()) console.log(res.stdout.trim());
    if (res.stderr.trim()) console.error(res.stderr.trim());
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'doctor') {
    const problems: string[] = [];
    for (const host of runtimes.hosts) {
      if (!host.enabled) continue;
      if (host.transport === 'ssh') {
        if (!host.connection.host) {
          problems.push(`[${host.id}] ssh host is missing`);
          continue;
        }
        const ping = await runHostCommand(host, 'echo ok', 5);
        if (!ping.ok) problems.push(`[${host.id}] ssh unreachable (${ping.code ?? -1})`);
      }

      const checkCmd = interpolateTemplate(host.health.check_cmd, {
        host: host.connection.host,
        host_id: host.id,
        backend_args: '',
        backend_env: '',
        backend_id: '',
        model_id: '',
        source: '',
        port: '',
      });
      const commandToken = firstToken(checkCmd);
      if (commandToken) {
        const checkBin = runLocalCommand(
          `command -v ${shellEscape(commandToken)} >/dev/null 2>&1`,
          3
        );
        if (!checkBin.ok) problems.push(`[${host.id}] missing local binary: ${commandToken}`);
      }
    }

    if (!problems.length) {
      console.log('Doctor: no obvious runtime host issues found.');
      return;
    }
    for (const p of problems) console.log(`- ${p}`);
    process.exitCode = 1;
    return;
  }

  usage('hosts');
}

export async function runBackendsSubcommand(args: any, _config: any): Promise<void> {
  await bootstrapRuntimes();
  const cmd = String(args._[1] ?? '').toLowerCase();
  const id = String(args._[2] ?? '');
  const runtimes = await loadRuntimes();

  if (!cmd) {
    printList(
      runtimes.backends.map((b) => ({
        id: b.id,
        name: b.display_name,
        enabled: b.enabled,
        type: b.type,
        host_filters: b.host_filters === 'any' ? 'any' : b.host_filters.join(','),
      }))
    );
    return;
  }

  if (cmd === 'show') {
    if (!id) throw new Error('backends show requires <id>');
    const backend = runtimes.backends.find((b) => b.id === id);
    if (!backend) throw new Error(`backend not found: ${id}`);
    process.stdout.write(JSON.stringify(backend, null, 2) + '\n');
    return;
  }

  if (cmd === 'add') {
    if (!isTTY()) throw new Error('backends add requires a TTY');
    const rl = readline.createInterface({ input, output });
    try {
      const backend: RuntimeBackend = {
        id: await ask(rl, 'Backend id'),
        display_name: await ask(rl, 'Display name'),
        enabled: (await ask(rl, 'Enabled (y/n)', 'y')).toLowerCase().startsWith('y'),
        type: (await ask(
          rl,
          'Type (vulkan|rocm|cuda|metal|cpu|custom)',
          'custom'
        )) as RuntimeBackend['type'],
        host_filters: (() => {
          const raw = (args.hosts ?? '').toString();
          return raw
            ? raw
                .split(',')
                .map((s: string) => s.trim())
                .filter(Boolean)
            : 'any';
        })(),
        apply_cmd: await ask(rl, 'Apply command (optional)', ''),
        verify_cmd: await ask(rl, 'Verify command (optional)', ''),
        rollback_cmd: await ask(rl, 'Rollback command (optional)', ''),
        env: undefined,
        args: undefined,
      };
      const filters = await ask(rl, 'Host filters (any or comma-separated ids)', 'any');
      backend.host_filters =
        filters === 'any'
          ? 'any'
          : filters
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
      if (!backend.apply_cmd) backend.apply_cmd = null;
      if (!backend.verify_cmd) backend.verify_cmd = null;
      if (!backend.rollback_cmd) backend.rollback_cmd = null;
      await saveRuntimes({ ...runtimes, backends: [...runtimes.backends, backend] });
      console.log(`Added backend: ${backend.id}`);
    } finally {
      rl.close();
    }
    return;
  }

  if (cmd === 'edit') {
    if (!id) throw new Error('backends edit requires <id>');
    if (!runtimes.backends.find((b) => b.id === id)) throw new Error(`backend not found: ${id}`);
    const editor = process.env.EDITOR || 'vi';
    const p = spawnSync(editor, [runtimesFilePath()], { stdio: 'inherit' });
    if (p.status !== 0) throw new Error(`editor exited with code ${p.status}`);
    return;
  }

  if (cmd === 'remove') {
    if (!id) throw new Error('backends remove requires <id>');
    if (!runtimes.backends.find((b) => b.id === id)) throw new Error(`backend not found: ${id}`);
    if (!isTTY()) throw new Error('backends remove requires a TTY confirmation');
    const rl = readline.createInterface({ input, output });
    try {
      const ans = (await rl.question(`Remove backend '${id}'? [y/N] `)).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        console.log('Cancelled.');
        return;
      }
    } finally {
      rl.close();
    }
    await saveRuntimes({ ...runtimes, backends: runtimes.backends.filter((b) => b.id !== id) });
    console.log(`Removed backend: ${id}`);
    return;
  }

  if (cmd === 'validate') {
    try {
      validateRuntimes(runtimes);
      console.log('runtimes.json is valid.');
      process.exitCode = 0;
    } catch (e: any) {
      console.error(`invalid runtimes config: ${e?.message ?? String(e)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'test') {
    if (!id) throw new Error('backends test requires <id>');
    const backend = runtimes.backends.find((b) => b.id === id);
    if (!backend) throw new Error(`backend not found: ${id}`);
    if (!backend.verify_cmd) {
      console.log(`[${backend.id}] no verify_cmd configured.`);
      return;
    }
    const cmdText = interpolateTemplate(backend.verify_cmd, {
      backend_id: backend.id,
      backend_args: (backend.args ?? []).join(' '),
      backend_env: Object.entries(backend.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
      host: '',
      host_id: '',
      model_id: '',
      source: '',
      port: '',
    });
    const res = runLocalCommand(cmdText, 8);
    console.log(`[${backend.id}] ${res.ok ? 'OK' : 'FAIL'} (exit=${res.code ?? -1})`);
    if (res.stdout.trim()) console.log(res.stdout.trim());
    if (res.stderr.trim()) console.error(res.stderr.trim());
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'doctor') {
    const problems: string[] = [];
    for (const b of runtimes.backends) {
      if (!b.enabled) continue;
      for (const c of [b.apply_cmd, b.verify_cmd, b.rollback_cmd]) {
        if (!c) continue;
        const token = firstToken(c);
        if (!token) continue;
        const bin = runLocalCommand(`command -v ${shellEscape(token)} >/dev/null 2>&1`, 2);
        if (!bin.ok) problems.push(`[${b.id}] missing local binary: ${token}`);
      }
    }
    if (!problems.length) {
      console.log('Doctor: no obvious backend issues found.');
      return;
    }
    for (const p of problems) console.log(`- ${p}`);
    process.exitCode = 1;
    return;
  }

  usage('backends');
}

export async function runModelsSubcommand(args: any, _config: any): Promise<void> {
  await bootstrapRuntimes();
  const cmd = String(args._[1] ?? '').toLowerCase();
  const id = String(args._[2] ?? '');
  const runtimes = await loadRuntimes();

  if (!cmd) {
    printList(
      runtimes.models.map((m) => ({
        id: m.id,
        name: m.display_name,
        enabled: m.enabled,
        source: m.source,
        hosts: m.host_policy === 'any' ? 'any' : m.host_policy.join(','),
        backends: m.backend_policy === 'any' ? 'any' : m.backend_policy.join(','),
      }))
    );
    return;
  }

  if (cmd === 'show') {
    if (!id) throw new Error('models show requires <id>');
    const model = runtimes.models.find((m) => m.id === id);
    if (!model) throw new Error(`model not found: ${id}`);
    process.stdout.write(JSON.stringify(model, null, 2) + '\n');
    return;
  }

  if (cmd === 'add') {
    if (!isTTY()) throw new Error('models add requires a TTY');
    const rl = readline.createInterface({ input, output });
    try {
      const modelId = await ask(rl, 'Model id');
      const displayName = await ask(rl, 'Display name');
      const enabled = (await ask(rl, 'Enabled (y/n)', 'y')).toLowerCase().startsWith('y');
      const source = await ask(rl, 'Model source (path or URL)');

      // RPC Split detection — applies Strix Halo distributed inference defaults
      const rpcSplit = (await ask(rl, 'RPC Split? (y/n)', 'n')).toLowerCase().startsWith('y');

      let rpcBackendId: string | undefined;
      let rpcHostId: string | undefined;
      let rpcProbeTimeout = 60;
      let rpcProbeInterval = 1000;
      let startCmdDefault = '';

      if (rpcSplit) {
        const rpcAddr = await ask(rl, 'RPC server address (host:port)', '10.77.77.1:50052');
        const tsRatio = await ask(rl, 'Tensor split ratio', '1/1');
        rpcHostId = await ask(rl, 'Client host id (where model files live)');

        // Find or create RPC backend
        const rpcBackendName = `rocm-rpc-${rpcAddr.replace(/[:.]/g, '-')}`;
        let existingBackend = runtimes.backends.find(
          (b) => b.type === 'rocm' && b.args?.some((a) => a === rpcAddr)
        );
        if (!existingBackend) {
          const createBackend = (
            await ask(rl, `Create RPC backend '${rpcBackendName}'? (y/n)`, 'y')
          )
            .toLowerCase()
            .startsWith('y');
          if (createBackend) {
            existingBackend = {
              id: rpcBackendName,
              display_name: `ROCm + RPC (${rpcAddr}, -dio)`,
              enabled: true,
              type: 'rocm',
              host_filters: rpcHostId ? [rpcHostId] : 'any',
              apply_cmd: null,
              verify_cmd: 'rocminfo >/dev/null 2>&1',
              rollback_cmd: null,
              env: { ROCBLAS_USE_HIPBLASLT: '1' },
              args: [
                '-ngl',
                '99',
                '-fa',
                'on',
                '--rpc',
                rpcAddr,
                '-ts',
                tsRatio,
                '-dio',
                '--no-warmup',
              ],
            };
            runtimes.backends.push(existingBackend);
            console.log(`  Created RPC backend: ${rpcBackendName}`);
          }
        } else {
          console.log(`  Reusing existing RPC backend: ${existingBackend.id}`);
        }
        rpcBackendId = existingBackend?.id;

        // Size-aware probe defaults for RPC models (large models take minutes to load)
        rpcProbeTimeout = Number(
          await ask(rl, 'Probe timeout sec (large RPC models need 300-7200)', '3600')
        );
        rpcProbeInterval = Number(await ask(rl, 'Probe interval ms', '5000'));

        // Default start_cmd with -dio baked in (backend_args already includes it from the RPC backend)
        startCmdDefault =
          'nohup env {backend_env} llama-server -m {source} --port {port} --ctx-size 4096 {backend_args} --host 0.0.0.0 > /tmp/llama-server.log 2>&1 &';
      }

      const model: RuntimeModel = {
        id: modelId,
        display_name: displayName,
        enabled,
        source,
        host_policy: 'any',
        backend_policy: 'any',
        launch: {
          start_cmd: await ask(rl, 'Start command', startCmdDefault),
          probe_cmd: await ask(rl, 'Probe command', 'curl -fsS http://127.0.0.1:{port}/health'),
          probe_timeout_sec: rpcSplit
            ? rpcProbeTimeout
            : Number(await ask(rl, 'Probe timeout sec', '60')),
          probe_interval_ms: rpcSplit
            ? rpcProbeInterval
            : Number(await ask(rl, 'Probe interval ms', '1000')),
        },
        runtime_defaults: {
          port: Number(await ask(rl, 'Default port', '8080')),
        },
        split_policy: null,
      };

      if (rpcSplit && rpcHostId) {
        model.host_policy = [rpcHostId];
        model.backend_policy = rpcBackendId ? [rpcBackendId] : 'any';
        console.log(`  Auto-set host_policy=[${rpcHostId}], backend_policy=[${rpcBackendId}]`);
      } else {
        const hp = await ask(rl, 'Host policy (any or comma-separated ids)', 'any');
        const bp = await ask(rl, 'Backend policy (any or comma-separated ids)', 'any');
        model.host_policy =
          hp === 'any'
            ? 'any'
            : hp
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        model.backend_policy =
          bp === 'any'
            ? 'any'
            : bp
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
      }

      await saveRuntimes({ ...runtimes, models: [...runtimes.models, model] });
      console.log(`Added model: ${model.id}`);
    } finally {
      rl.close();
    }
    return;
  }

  if (cmd === 'edit') {
    if (!id) throw new Error('models edit requires <id>');
    if (!runtimes.models.find((m) => m.id === id)) throw new Error(`model not found: ${id}`);
    const editor = process.env.EDITOR || 'vi';
    const p = spawnSync(editor, [runtimesFilePath()], { stdio: 'inherit' });
    if (p.status !== 0) throw new Error(`editor exited with code ${p.status}`);
    return;
  }

  if (cmd === 'remove') {
    if (!id) throw new Error('models remove requires <id>');
    if (!runtimes.models.find((m) => m.id === id)) throw new Error(`model not found: ${id}`);
    if (!isTTY()) throw new Error('models remove requires a TTY confirmation');
    const rl = readline.createInterface({ input, output });
    try {
      const ans = (await rl.question(`Remove model '${id}'? [y/N] `)).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        console.log('Cancelled.');
        return;
      }
    } finally {
      rl.close();
    }
    await saveRuntimes({ ...runtimes, models: runtimes.models.filter((m) => m.id !== id) });
    console.log(`Removed model: ${id}`);
    return;
  }

  if (cmd === 'validate') {
    try {
      validateRuntimes(runtimes);
      console.log('runtimes.json is valid.');
      process.exitCode = 0;
    } catch (e: any) {
      console.error(`invalid runtimes config: ${e?.message ?? String(e)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'test') {
    if (!id) throw new Error('models test requires <id>');
    const model = runtimes.models.find((m) => m.id === id);
    if (!model) throw new Error(`model not found: ${id}`);

    const host =
      model.host_policy === 'any'
        ? runtimes.hosts.find((h) => h.enabled)
        : model.host_policy
            .map((hid) => runtimes.hosts.find((h) => h.id === hid && h.enabled))
            .find(Boolean);
    if (!host) throw new Error(`no eligible host for model: ${model.id}`);

    const backend =
      model.backend_policy === 'any'
        ? runtimes.backends.find((b) => b.enabled)
        : model.backend_policy
            .map((bid) => runtimes.backends.find((b) => b.id === bid && b.enabled))
            .find(Boolean);

    const port = model.runtime_defaults?.port ?? 8080;
    const backendArgs = backend?.args?.map((a) => shellEscape(a)).join(' ') ?? '';
    const backendEnv = backend?.env
      ? Object.entries(backend.env)
          .map(([k, v]) => `${k}=${shellEscape(String(v))}`)
          .join(' ')
      : '';

    const cmdText = interpolateTemplate(model.launch.probe_cmd, {
      model_id: model.id,
      source: model.source,
      port,
      backend_args: backendArgs,
      backend_env: backendEnv,
      backend_id: backend?.id ?? '',
      host: host.connection.host ?? host.id,
      host_id: host.id,
    });

    const res = await runHostCommand(host, cmdText, model.launch.probe_timeout_sec ?? 60);
    console.log(`[${model.id}] host=${host.id} ${res.ok ? 'OK' : 'FAIL'} (exit=${res.code ?? -1})`);
    if (res.stdout.trim()) console.log(res.stdout.trim());
    if (res.stderr.trim()) console.error(res.stderr.trim());
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'doctor') {
    const problems: string[] = [];
    const backendIds = new Set(runtimes.backends.map((b) => b.id));
    const hostIds = new Set(runtimes.hosts.map((h) => h.id));
    for (const m of runtimes.models) {
      if (!m.enabled) continue;
      if (m.host_policy !== 'any') {
        for (const h of m.host_policy)
          if (!hostIds.has(h)) problems.push(`[${m.id}] unknown host in host_policy: ${h}`);
      }
      if (m.backend_policy !== 'any') {
        for (const b of m.backend_policy)
          if (!backendIds.has(b))
            problems.push(`[${m.id}] unknown backend in backend_policy: ${b}`);
      }
      for (const c of [m.launch.start_cmd, m.launch.probe_cmd]) {
        const token = firstToken(c);
        const bin = runLocalCommand(`command -v ${shellEscape(token)} >/dev/null 2>&1`, 2);
        if (!bin.ok) problems.push(`[${m.id}] missing local binary: ${token}`);
      }
    }
    if (!problems.length) {
      console.log('Doctor: no obvious model issues found.');
      return;
    }
    for (const p of problems) console.log(`- ${p}`);
    process.exitCode = 1;
    return;
  }

  usage('models');
}

export async function runSelectSubcommand(args: any, _config: any): Promise<void> {
  const modelId = typeof args.model === 'string' ? args.model : undefined;
  const backendOverride = typeof args.backend === 'string' ? args.backend : undefined;
  const hostOverride = typeof args.host === 'string' ? args.host : undefined;
  const dryRun = !!(args['dry-run'] ?? args.dry_run);
  const jsonOut = !!args.json;

  // Status subcommand
  if (args._?.[1] === 'status') {
    const { loadActiveRuntime } = await import('../runtime/executor.js');
    const active = await loadActiveRuntime();
    if (!active) {
      console.log('No active runtime.');
    } else {
      if (jsonOut) {
        console.log(JSON.stringify(active, null, 2));
      } else {
        console.log(`Active runtime:`);
        console.log(`  Model:   ${active.modelId}`);
        if (active.backendId) console.log(`  Backend: ${active.backendId}`);
        console.log(`  Hosts:   ${active.hostIds.join(', ')}`);
        console.log(`  Healthy: ${active.healthy ? 'yes' : 'no'}`);
        if (active.endpoint) console.log(`  Endpoint: ${active.endpoint}`);
        console.log(`  Started: ${active.startedAt}`);
      }
    }
    return;
  }

  const force = !!args.force;
  const restart = !!args.restart;
  const forceRestart = force || restart;
  const waitReady = !!(args['wait-ready'] ?? args.wait_ready);
  const waitTimeoutSecRaw = Number(args['wait-timeout'] ?? args.wait_timeout ?? args.timeout ?? 0);
  const waitTimeoutSec =
    Number.isFinite(waitTimeoutSecRaw) && waitTimeoutSecRaw > 0 ? waitTimeoutSecRaw : undefined;

  if (!modelId) {
    console.log(
      'Usage: idlehands select --model <id> [--backend <id>] [--host <id>] [--dry-run] [--json] [--force] [--restart] [--wait-ready] [--wait-timeout <sec>]'
    );
    console.log('       idlehands select status');
    return;
  }

  const { plan } = await import('../runtime/planner.js');
  const { execute, loadActiveRuntime, runOnHost } = await import('../runtime/executor.js');

  const rtConfig = await loadRuntimes();
  const active = await loadActiveRuntime();
  const mode = dryRun ? ('dry-run' as const) : ('live' as const);

  const result = plan(
    { modelId, backendOverride, hostOverride, mode, forceRestart },
    rtConfig,
    active
  );

  await applyDynamicProbeDefaults(result, rtConfig, runOnHost);

  if (!result.ok) {
    if (jsonOut) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Plan failed: ${result.reason} (${result.code})`);
    }
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    if (jsonOut) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Plan for model "${result.model.display_name}":`);
      if (result.reuse) {
        console.log('  → Runtime appears to match; will run health re-check probe(s).');
      }
      for (const step of result.steps) {
        console.log(`  [${step.kind}] ${step.description} (timeout: ${step.timeout_sec}s)`);
      }
    }
    return;
  }

  // Live execution
  const rl = await import('node:readline/promises');
  const iface = rl.createInterface({ input: process.stdin, output: process.stdout });

  const executeWithRenderer = async (planResult: typeof result) =>
    execute(planResult, {
      onStep: (step, status, detail) => {
        if (status === 'start') {
          process.stdout.write(`  ${step.description}...`);
        } else if (status === 'done') {
          process.stdout.write(' ✓\n');
        } else if (status === 'error') {
          process.stdout.write(' ✗\n');
          if (detail) {
            for (const line of detail
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(0, 6)) {
              process.stdout.write(`    ${line}\n`);
            }
          }
        }
      },
      confirm: async (prompt) => {
        const ans = (await iface.question(`${prompt} [y/N] `)).trim().toLowerCase();
        return ans === 'y' || ans === 'yes';
      },
      force,
    });

  let executedPlan = result;
  let execResult = await executeWithRenderer(result);

  // Reuse-probe fallback: if reuse validation fails, force restart automatically.
  if (!execResult.ok && result.reuse && !forceRestart) {
    console.error('Reuse health check failed. Retrying with forced restart...');
    const restartPlan = plan(
      { modelId, backendOverride, hostOverride, mode: 'live', forceRestart: true },
      rtConfig,
      active
    );
    if (restartPlan.ok) {
      executedPlan = restartPlan;
      await applyDynamicProbeDefaults(restartPlan, rtConfig, runOnHost);
      execResult = await executeWithRenderer(restartPlan);
    }
  }

  const readyChecks: Array<{
    hostId: string;
    ok: boolean;
    attempts: number;
    reason?: string;
    status?: string;
    httpCode?: number | null;
    modelIds?: string[];
  }> = [];
  let readyOk = true;

  if (execResult.ok && waitReady) {
    const timeoutSec = waitTimeoutSec ?? executedPlan.model.launch.probe_timeout_sec ?? 60;
    for (const resolvedHost of executedPlan.hosts) {
      const hostCfg = rtConfig.hosts.find((h) => h.id === resolvedHost.id);
      if (!hostCfg) continue;
      const port = executedPlan.model.runtime_defaults?.port ?? 8080;

      process.stdout.write(`  Waiting for /v1/models on ${resolvedHost.id}:${port}...`);
      const ready = await waitForModelsReady(runOnHost as any, hostCfg, port, {
        timeoutMs: timeoutSec * 1000,
        intervalMs: executedPlan.model.launch.probe_interval_ms ?? 1500,
      });

      readyChecks.push({
        hostId: resolvedHost.id,
        ok: ready.ok,
        attempts: ready.attempts,
        reason: ready.reason,
        status: ready.last.status,
        httpCode: ready.last.httpCode,
        modelIds: ready.last.modelIds,
      });

      if (ready.ok) {
        process.stdout.write(' ✓\n');
      } else {
        process.stdout.write(' ✗\n');
        if (ready.reason) process.stdout.write(`    ${ready.reason}\n`);
        readyOk = false;
      }
    }
  }

  iface.close();

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          execute: execResult,
          waitReady: waitReady ? { ok: readyOk, checks: readyChecks } : undefined,
        },
        null,
        2
      )
    );
  } else if (execResult.ok) {
    if (execResult.reused) {
      console.log('Runtime already active and healthy. No changes needed.');
    } else {
      console.log(`Runtime switched to "${executedPlan.model.display_name}" successfully.`);
    }
    // Show the derived endpoint so the user knows where requests will go
    const { loadActiveRuntime: loadAR } = await import('../runtime/executor.js');
    const activeNow = await loadAR();
    if (activeNow?.endpoint) {
      console.log(`Endpoint: ${activeNow.endpoint}`);
    }
    if (waitReady && !readyOk) {
      console.error('Wait-ready failed: server did not become ready in time.');
      process.exitCode = 1;
    }
  } else {
    console.error(`Execution failed: ${execResult.error || 'unknown error'}`);
    process.exitCode = 1;
  }
}

// ── Health check ──────────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

export async function runHealthSubcommand(args: any, _config: any): Promise<void> {
  const { runOnHost } = await import('../runtime/executor.js');
  const jsonOut = !!args.json;

  let runtimes;
  try {
    runtimes = await loadRuntimes();
  } catch (e: any) {
    console.error(`Failed to load runtimes: ${e?.message ?? e}`);
    process.exitCode = 1;
    return;
  }

  const enabledHosts = runtimes.hosts.filter((h) => h.enabled);
  const enabledModels = runtimes.models.filter((m) => m.enabled);
  const enabledBackends = runtimes.backends.filter((b) => b.enabled);

  const scanPortsOverride = parseScanPorts(args['scan-ports'] ?? args.scan_ports);

  if (enabledHosts.length === 0) {
    console.log('No enabled hosts configured. Run `idlehands setup` first.');
    return;
  }

  let anyFailed = false;

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    hosts: [] as Array<{
      id: string;
      ok: boolean;
      exitCode: number;
      stdout: string;
      stderr: string;
    }>,
    configuredModels: [] as Array<{
      modelId: string;
      hostId: string;
      ok: boolean;
      exitCode: number;
      detail: string;
    }>,
    discovery: {
      ports: [] as number[],
      hosts: [] as Array<{
        hostId: string;
        services: Array<{
          port: number;
          status: string;
          httpCode: number | null;
          modelIds: string[];
          stderr: string;
          exitCode: number;
        }>;
      }>,
    },
  };

  if (!jsonOut) console.log(`\n${BOLD}Hosts${RESET}`);

  for (const host of enabledHosts) {
    const label =
      host.transport === 'ssh'
        ? `${host.id} (${host.connection.user ? host.connection.user + '@' : ''}${host.connection.host ?? '?'})`
        : `${host.id} (local)`;

    const cmd = host.health.check_cmd;
    const timeoutMs = (host.health.timeout_sec ?? 5) * 1000;

    if (!jsonOut) process.stdout.write(`  ${label}... `);
    const result = await runOnHost(cmd, host, timeoutMs);

    report.hosts.push({
      id: host.id,
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    });

    if (result.exitCode === 0) {
      if (!jsonOut) console.log(`${GREEN}✓${RESET}`);
    } else {
      if (!jsonOut) {
        console.log(`${RED}✗${RESET}`);
        if (result.stderr.trim()) {
          for (const line of result.stderr.trim().split('\n').slice(0, 4)) {
            console.log(`    ${DIM}${line}${RESET}`);
          }
        }
      }
      anyFailed = true;
    }
  }

  if (enabledModels.length > 0 && !jsonOut) {
    console.log(`\n${BOLD}Configured Models${RESET}`);
  }

  for (const model of enabledModels) {
    const targetHosts =
      model.host_policy === 'any'
        ? enabledHosts
        : enabledHosts.filter((h) => (model.host_policy as string[]).includes(h.id));

    const backend =
      model.backend_policy === 'any'
        ? (enabledBackends[0] ?? null)
        : (enabledBackends.find((b) => (model.backend_policy as string[]).includes(b.id)) ?? null);

    for (const host of targetHosts) {
      const port = String(model.runtime_defaults?.port ?? 8080);
      const backendArgs = backend?.args?.map((a) => shellEscape(a)).join(' ') ?? '';
      const backendEnv = backend?.env
        ? Object.entries(backend.env)
            .map(([k, v]) => `${k}=${shellEscape(String(v))}`)
            .join(' ')
        : '';

      const vars: Record<string, string | number | undefined> = {
        source: model.source,
        port,
        host: host.connection.host ?? host.id,
        backend_args: backendArgs,
        backend_env: backendEnv,
        model_id: model.id,
        host_id: host.id,
        backend_id: backend?.id ?? '',
      };

      let probeCmd: string;
      try {
        probeCmd = interpolateTemplate(model.launch.probe_cmd, vars);
      } catch {
        probeCmd = model.launch.probe_cmd;
      }

      const timeoutMs = (model.launch.probe_timeout_sec ?? 60) * 1000;

      if (!jsonOut) process.stdout.write(`  ${model.display_name} on ${host.id}... `);
      const result = await runOnHost(probeCmd, host, timeoutMs);
      const detail = (result.stderr || result.stdout || '').trim();

      report.configuredModels.push({
        modelId: model.id,
        hostId: host.id,
        ok: result.exitCode === 0,
        exitCode: result.exitCode,
        detail,
      });

      if (result.exitCode === 0) {
        if (!jsonOut) {
          const body = result.stdout.trim();
          console.log(
            `${GREEN}✓${RESET}${body ? ` ${DIM}${body.split('\n')[0].slice(0, 80)}${RESET}` : ''}`
          );
        }
      } else {
        if (!jsonOut) {
          console.log(`${RED}✗${RESET}`);
          if (detail) {
            for (const line of detail.split('\n').slice(0, 4)) {
              console.log(`    ${DIM}${line}${RESET}`);
            }
          }
        }
        anyFailed = true;
      }
    }
  }

  let candidatePorts: number[];
  if (scanPortsOverride) {
    candidatePorts = scanPortsOverride;
  } else {
    const configuredPorts = new Set<number>(
      enabledModels.map((m) => m.runtime_defaults?.port ?? 8080)
    );
    for (let p = 8080; p <= 8090; p++) configuredPorts.add(p);
    candidatePorts = Array.from(configuredPorts).sort((a, b) => a - b);
  }
  report.discovery.ports = candidatePorts;
  const configuredModelIds = new Set(enabledModels.map((m) => m.id));

  if (!jsonOut) console.log(`\n${BOLD}Discovered Servers (/v1/models + /health)${RESET}`);

  for (const host of enabledHosts) {
    const hostEntry = {
      hostId: host.id,
      services: [] as Array<{
        port: number;
        status: string;
        httpCode: number | null;
        modelIds: string[];
        stderr: string;
        exitCode: number;
      }>,
    };

    if (!jsonOut) console.log(`  ${host.id}:`);

    for (const port of candidatePorts) {
      const probe = await probeModelsEndpoint(runOnHost as any, host, port, 5000);

      if (probe.status === 'down') continue; // concise display + compact JSON

      hostEntry.services.push({
        port,
        status: probe.status,
        httpCode: probe.httpCode,
        modelIds: probe.modelIds,
        stderr: probe.stderr,
        exitCode: probe.exitCode,
      });

      if (!jsonOut) {
        const icon =
          probe.status === 'ready'
            ? `${GREEN}✓${RESET}`
            : probe.status === 'loading'
              ? `${YELLOW}~${RESET}`
              : `${DIM}?${RESET}`;
        const extras = probe.modelIds.filter((id) => !configuredModelIds.has(id));
        const idsText = probe.modelIds.length ? ` models=${probe.modelIds.join(', ')}` : '';
        const extrasText = extras.length
          ? ` ${YELLOW}(extra/unconfigured: ${extras.join(', ')})${RESET}`
          : '';
        const httpText = probe.httpCode != null ? ` http=${probe.httpCode}` : '';
        console.log(`    ${icon} :${port} ${probe.status}${httpText}${idsText}${extrasText}`);
      }
    }

    report.discovery.hosts.push(hostEntry);
  }

  report.ok = !anyFailed;

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log();
  }

  if (anyFailed) process.exitCode = 1;
}
