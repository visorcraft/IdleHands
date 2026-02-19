import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'node:child_process';
import type { RuntimeBackend, RuntimeHost, RuntimeModel } from '../runtime/types.js';
import {
  loadRuntimes,
  saveRuntimes,
  validateRuntimes,
  redactConfig,
  bootstrapRuntimes,
  interpolateTemplate,
} from '../runtime/store.js';
import { configDir, shellEscape } from '../utils.js';

function runtimesFilePath(): string {
  return path.join(configDir(), 'runtimes.json');
}

function isTTY(): boolean {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

function printList<T>(items: T[]): void {
  if (process.stdout.isTTY) {
    console.table(items as any[]);
  } else {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n');
  }
}

async function ask(rl: readline.Interface, prompt: string, fallback = ''): Promise<string> {
  const q = fallback ? `${prompt} [${fallback}]: ` : `${prompt}: `;
  const ans = (await rl.question(q)).trim();
  return ans || fallback;
}

function runLocalCommand(command: string, timeoutSec = 5): { ok: boolean; code: number | null; stdout: string; stderr: string } {
  const p = spawnSync('bash', ['-lc', command], { encoding: 'utf8', timeout: timeoutSec * 1000 });
  return {
    ok: p.status === 0,
    code: p.status,
    stdout: p.stdout ?? '',
    stderr: p.stderr ?? '',
  };
}

function runHostCommand(host: RuntimeHost, command: string, timeoutSec = 5): { ok: boolean; code: number | null; stdout: string; stderr: string } {
  if (host.transport === 'local') return runLocalCommand(command, timeoutSec);

  const target = `${host.connection.user ? `${host.connection.user}@` : ''}${host.connection.host ?? ''}`;
  const sshArgs = [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${timeoutSec}`,
  ];
  if (host.connection.port) sshArgs.push('-p', String(host.connection.port));
  if (host.connection.key_path) sshArgs.push('-i', shellEscape(host.connection.key_path));
  sshArgs.push(shellEscape(target));
  sshArgs.push(shellEscape(command));

  return runLocalCommand(sshArgs.join(' '), timeoutSec + 1);
}

function usage(kind: 'hosts' | 'backends' | 'models'): void {
  console.log(`Usage:\n  idlehands ${kind}\n  idlehands ${kind} show <id>\n  idlehands ${kind} add\n  idlehands ${kind} edit <id>\n  idlehands ${kind} remove <id>\n  idlehands ${kind} validate\n  idlehands ${kind} test <id>\n  idlehands ${kind} doctor`);
}

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
        transport: ((await ask(rl, 'Transport (local/ssh)', 'local')).toLowerCase() === 'ssh' ? 'ssh' : 'local'),
        connection: {
          host: undefined,
          port: undefined,
          user: undefined,
          key_path: undefined,
          password: undefined,
        },
        capabilities: {
          gpu: (await ask(rl, 'GPU tags (comma-separated)', '')).split(',').map((s) => s.trim()).filter(Boolean),
          vram_gb: (() => {
            const raw = args['vram-gb'] ?? undefined;
            return raw == null ? undefined : Number(raw);
          })(),
          backends: (await ask(rl, 'Supported backends (comma-separated)', '')).split(',').map((s) => s.trim()).filter(Boolean),
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
    const res = runHostCommand(host, command, host.health.timeout_sec ?? 5);
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
        const ping = runHostCommand(host, 'echo ok', 5);
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
      const firstToken = checkCmd.trim().split(/\s+/)[0] || '';
      if (firstToken) {
        const checkBin = runLocalCommand(`command -v ${shellEscape(firstToken)} >/dev/null 2>&1`, 3);
        if (!checkBin.ok) problems.push(`[${host.id}] missing local binary: ${firstToken}`);
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
    printList(runtimes.backends.map((b) => ({
      id: b.id,
      name: b.display_name,
      enabled: b.enabled,
      type: b.type,
      host_filters: b.host_filters === 'any' ? 'any' : b.host_filters.join(','),
    })));
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
        type: (await ask(rl, 'Type (vulkan|rocm|cuda|metal|cpu|custom)', 'custom')) as RuntimeBackend['type'],
        host_filters: (() => {
          const raw = (args.hosts ?? '').toString();
          return raw ? raw.split(',').map((s: string) => s.trim()).filter(Boolean) : 'any';
        })(),
        apply_cmd: await ask(rl, 'Apply command (optional)', ''),
        verify_cmd: await ask(rl, 'Verify command (optional)', ''),
        rollback_cmd: await ask(rl, 'Rollback command (optional)', ''),
        env: undefined,
        args: undefined,
      };
      const filters = await ask(rl, 'Host filters (any or comma-separated ids)', 'any');
      backend.host_filters = filters === 'any' ? 'any' : filters.split(',').map((s) => s.trim()).filter(Boolean);
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
      backend_env: Object.entries(backend.env ?? {}).map(([k, v]) => `${k}=${v}`).join(' '),
      host: '', host_id: '', model_id: '', source: '', port: '',
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
        const token = c.trim().split(/\s+/)[0] || '';
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
    printList(runtimes.models.map((m) => ({
      id: m.id,
      name: m.display_name,
      enabled: m.enabled,
      source: m.source,
      hosts: m.host_policy === 'any' ? 'any' : m.host_policy.join(','),
      backends: m.backend_policy === 'any' ? 'any' : m.backend_policy.join(','),
    })));
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
      const model: RuntimeModel = {
        id: await ask(rl, 'Model id'),
        display_name: await ask(rl, 'Display name'),
        enabled: (await ask(rl, 'Enabled (y/n)', 'y')).toLowerCase().startsWith('y'),
        source: await ask(rl, 'Model source (path or URL)'),
        host_policy: 'any',
        backend_policy: 'any',
        launch: {
          start_cmd: await ask(rl, 'Start command'),
          probe_cmd: await ask(rl, 'Probe command', 'curl -fsS http://127.0.0.1:{port}/health'),
          probe_timeout_sec: Number(await ask(rl, 'Probe timeout sec', '60')),
          probe_interval_ms: Number(await ask(rl, 'Probe interval ms', '1000')),
        },
        runtime_defaults: {
          port: Number(await ask(rl, 'Default port', '8080')),
        },
        split_policy: null,
      };
      const hp = await ask(rl, 'Host policy (any or comma-separated ids)', 'any');
      const bp = await ask(rl, 'Backend policy (any or comma-separated ids)', 'any');
      model.host_policy = hp === 'any' ? 'any' : hp.split(',').map((s) => s.trim()).filter(Boolean);
      model.backend_policy = bp === 'any' ? 'any' : bp.split(',').map((s) => s.trim()).filter(Boolean);
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

    const host = model.host_policy === 'any'
      ? runtimes.hosts.find((h) => h.enabled)
      : model.host_policy.map((hid) => runtimes.hosts.find((h) => h.id === hid && h.enabled)).find(Boolean);
    if (!host) throw new Error(`no eligible host for model: ${model.id}`);

    const backend = model.backend_policy === 'any'
      ? runtimes.backends.find((b) => b.enabled)
      : model.backend_policy.map((bid) => runtimes.backends.find((b) => b.id === bid && b.enabled)).find(Boolean);

    const port = model.runtime_defaults?.port ?? 8080;
    const backendArgs = backend?.args?.map((a) => shellEscape(a)).join(' ') ?? '';
    const backendEnv = backend?.env
      ? Object.entries(backend.env).map(([k, v]) => `${k}=${shellEscape(String(v))}`).join(' ')
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

    const res = runHostCommand(host, cmdText, model.launch.probe_timeout_sec ?? 60);
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
        for (const h of m.host_policy) if (!hostIds.has(h)) problems.push(`[${m.id}] unknown host in host_policy: ${h}`);
      }
      if (m.backend_policy !== 'any') {
        for (const b of m.backend_policy) if (!backendIds.has(b)) problems.push(`[${m.id}] unknown backend in backend_policy: ${b}`);
      }
      for (const c of [m.launch.start_cmd, m.launch.probe_cmd]) {
        const token = c.trim().split(/\s+/)[0] || '';
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

  if (!modelId) {
    console.log('Usage: idlehands select --model <id> [--backend <id>] [--host <id>] [--dry-run] [--json] [--force]');
    console.log('       idlehands select status');
    return;
  }

  const { plan } = await import('../runtime/planner.js');
  const { execute, loadActiveRuntime } = await import('../runtime/executor.js');

  const rtConfig = await loadRuntimes();
  const active = await loadActiveRuntime();
  const mode = dryRun ? 'dry-run' as const : 'live' as const;

  const result = plan({ modelId, backendOverride, hostOverride, mode }, rtConfig, active);

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
        console.log('  → Current runtime matches. No changes needed.');
      } else {
        for (const step of result.steps) {
          console.log(`  [${step.kind}] ${step.description} (timeout: ${step.timeout_sec}s)`);
        }
      }
    }
    return;
  }

  // Live execution
  const rl = await import('node:readline/promises');
  const iface = rl.createInterface({ input: process.stdin, output: process.stdout });

  const execResult = await execute(result, {
    onStep: (step, status) => {
      if (status === 'start') process.stdout.write(`  ${step.description}...`);
      else if (status === 'done') process.stdout.write(' ✓\n');
      else if (status === 'error') process.stdout.write(' ✗\n');
    },
    confirm: async (prompt) => {
      const ans = (await iface.question(`${prompt} [y/N] `)).trim().toLowerCase();
      return ans === 'y' || ans === 'yes';
    },
    force,
  });

  iface.close();

  if (jsonOut) {
    console.log(JSON.stringify(execResult, null, 2));
  } else if (execResult.ok) {
    if (execResult.reused) {
      console.log('Runtime already active and healthy. No changes needed.');
    } else {
      console.log(`Runtime switched to "${result.model.display_name}" successfully.`);
    }
    // Show the derived endpoint so the user knows where requests will go
    const { loadActiveRuntime: loadAR } = await import('../runtime/executor.js');
    const activeNow = await loadAR();
    if (activeNow?.endpoint) {
      console.log(`Endpoint: ${activeNow.endpoint}`);
    }
  } else {
    console.error(`Execution failed: ${execResult.error || 'unknown error'}`);
    process.exitCode = 1;
  }
}

// ── Health check ──────────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

export async function runHealthSubcommand(_args: any, _config: any): Promise<void> {
  const { runOnHost } = await import('../runtime/executor.js');

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

  if (enabledHosts.length === 0) {
    console.log('No enabled hosts configured. Run `idlehands setup` first.');
    return;
  }

  let anyFailed = false;

  // ── Host health checks ──────────────────────────────────────────

  console.log(`\n${BOLD}Hosts${RESET}`);

  for (const host of enabledHosts) {
    const label = host.transport === 'ssh'
      ? `${host.id} (${host.connection.user ? host.connection.user + '@' : ''}${host.connection.host ?? '?'})`
      : `${host.id} (local)`;

    const cmd = host.health.check_cmd;
    const timeoutMs = (host.health.timeout_sec ?? 5) * 1000;

    process.stdout.write(`  ${label}... `);
    const result = await runOnHost(cmd, host, timeoutMs);

    if (result.exitCode === 0) {
      console.log(`${GREEN}✓${RESET}`);
    } else {
      console.log(`${RED}✗${RESET}`);
      if (result.stderr.trim()) {
        for (const line of result.stderr.trim().split('\n').slice(0, 4)) {
          console.log(`    ${DIM}${line}${RESET}`);
        }
      }
      anyFailed = true;
    }
  }

  // ── Model probe checks ─────────────────────────────────────────

  if (enabledModels.length > 0) {
    console.log(`\n${BOLD}Models${RESET}`);

    for (const model of enabledModels) {
      // Figure out which hosts this model can run on
      const targetHosts = model.host_policy === 'any'
        ? enabledHosts
        : enabledHosts.filter((h) => (model.host_policy as string[]).includes(h.id));

      // Find applicable backend for template vars
      const backend = model.backend_policy === 'any'
        ? enabledBackends[0] ?? null
        : enabledBackends.find((b) => (model.backend_policy as string[]).includes(b.id)) ?? null;

      for (const host of targetHosts) {
        const port = String(model.runtime_defaults?.port ?? 8080);
        const backendArgs = backend?.args?.map((a) => shellEscape(a)).join(' ') ?? '';
        const backendEnv = backend?.env
          ? Object.entries(backend.env).map(([k, v]) => `${k}=${shellEscape(String(v))}`).join(' ')
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

        const label = `${model.id} on ${host.id} (${probeCmd})`;
        const timeoutMs = (model.launch.probe_timeout_sec ?? 60) * 1000;

        process.stdout.write(`  ${model.display_name} on ${host.id}... `);
        const result = await runOnHost(probeCmd, host, timeoutMs);

        if (result.exitCode === 0) {
          const body = result.stdout.trim();
          console.log(`${GREEN}✓${RESET}${body ? ` ${DIM}${body.split('\n')[0].slice(0, 80)}${RESET}` : ''}`);
        } else {
          console.log(`${RED}✗${RESET}`);
          const detail = (result.stderr || result.stdout).trim();
          if (detail) {
            for (const line of detail.split('\n').slice(0, 4)) {
              console.log(`    ${DIM}${line}${RESET}`);
            }
          }
          anyFailed = true;
        }
      }
    }
  }

  console.log();
  if (anyFailed) {
    process.exitCode = 1;
  }
}
