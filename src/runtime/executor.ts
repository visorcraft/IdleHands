import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  PlanResult,
  PlanStep,
  ExecuteOpts,
  ExecuteResult,
  StepOutcome,
  ActiveRuntime,
} from './types.js';
import { stateDir } from '../utils.js';

/**
 * Derive the API endpoint URL from the plan's host connection + model port.
 * For local hosts, uses 127.0.0.1. For SSH hosts, uses the connection host.
 */
function deriveEndpoint(plan: PlanResult): string {
  const port = plan.model.runtime_defaults?.port ?? 8080;
  const host = plan.hosts[0];
  if (!host) return `http://127.0.0.1:${port}/v1`;
  const addr = host.transport === 'local'
    ? '127.0.0.1'
    : (host.connection.host ?? '127.0.0.1');
  return `http://${addr}:${port}/v1`;
}

const LOCK_PATH = path.join(stateDir(), 'runtime.lock');
const ACTIVE_PATH = path.join(stateDir(), 'runtime-active.json');
const STALE_LOCK_MS = 60 * 60 * 1000;

type RuntimeLock = {
  pid: number;
  startedAt: string;
  model: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockAgeMs(lock: RuntimeLock | null): number | null {
  if (!lock?.startedAt) return null;
  const ts = Date.parse(lock.startedAt);
  if (!Number.isFinite(ts)) return null;
  return Date.now() - ts;
}

function isLockStale(lock: RuntimeLock | null): boolean {
  const age = lockAgeMs(lock);
  return age != null && age > STALE_LOCK_MS;
}

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true });
}

async function readLock(): Promise<RuntimeLock | null> {
  try {
    const raw = await fs.readFile(LOCK_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RuntimeLock>;
    if (typeof parsed?.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
    };
  } catch {
    return null;
  }
}

async function writeLock(modelId: string): Promise<void> {
  await ensureStateDir();
  const payload: RuntimeLock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    model: modelId,
  };
  await fs.writeFile(LOCK_PATH, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx' });
}

async function releaseLock(): Promise<void> {
  try {
    await fs.rm(LOCK_PATH, { force: true });
  } catch {
    // best effort
  }
}

async function acquireRuntimeLock(plan: PlanResult, opts: ExecuteOpts): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await writeLock(plan.model.id);
    return { ok: true };
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
  }

  const existing = await readLock();
  const lockPid = existing?.pid;
  const staleByAge = isLockStale(existing);

  if (staleByAge) {
    const age = lockAgeMs(existing);
    const ageMin = age == null ? 'unknown' : Math.floor(age / 60000);
    if (opts.force) {
      console.error(`[runtime] stale lock detected (${ageMin}m old). --force set; reclaiming runtime lock.`);
    } else {
      console.error(`[runtime] stale lock detected (${ageMin}m old). Reclaiming runtime lock.`);
    }
  }

  if (staleByAge || (lockPid && !isPidAlive(lockPid))) {
    await releaseLock();
    try {
      await writeLock(plan.model.id);
      return { ok: true };
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
    }
  }

  if (!lockPid) {
    return { ok: false, error: 'Runtime lock exists and could not be parsed. Remove runtime.lock and retry.' };
  }

  const approved = await opts.confirm?.(`Runtime lock held by PID ${lockPid}. Force takeover?`);
  if (!approved) {
    return { ok: false, error: `Runtime lock held by PID ${lockPid}` };
  }

  await releaseLock();
  try {
    await writeLock(plan.model.id);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Failed to acquire runtime lock after takeover attempt' };
  }
}

export async function runCommand(cmd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ exitCode: 124, stdout, stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms`.trim() });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${String(err)}`.trim() });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Run a command on a host (local or SSH). Public wrapper for health checks.
 */
export async function runOnHost(
  command: string,
  host: { transport: string; connection: { host?: string; port?: number; user?: string; key_path?: string } },
  timeoutMs = 10000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const step: PlanStep = { kind: 'probe_health', host_id: 'health-check', command, timeout_sec: Math.ceil(timeoutMs / 1000), description: '' };
  const resolved = { id: 'health-check', display_name: '', transport: host.transport as any, connection: host.connection };
  return runPlanStep(step, resolved, timeoutMs);
}

async function runPlanStep(step: PlanStep, host: PlanResult['hosts'][number], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (host.transport === 'local') {
    return runCommand(step.command, timeoutMs);
  }

  const targetHost = host.connection.host;
  if (!targetHost) {
    return { exitCode: 1, stdout: '', stderr: `SSH host missing for ${host.id}` };
  }
  const target = host.connection.user ? `${host.connection.user}@${targetHost}` : targetHost;

  const sshArgs: string[] = [];
  if (host.connection.key_path) sshArgs.push('-i', host.connection.key_path);
  if (host.connection.port && host.connection.port !== 22) sshArgs.push('-p', String(host.connection.port));
  sshArgs.push(target, step.command);

  return new Promise((resolve) => {
    const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ exitCode: 124, stdout, stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms`.trim() });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${String(err)}`.trim() });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function runStepWithRetry(step: PlanStep, host: PlanResult['hosts'][number]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const started = Date.now();
  const timeoutMs = Math.max(1, step.timeout_sec * 1000);

  if (step.kind !== 'probe_health') {
    return runPlanStep(step, host, timeoutMs);
  }

  let last = { exitCode: 1, stdout: '', stderr: '' };
  while (Date.now() - started < timeoutMs) {
    const remaining = Math.max(1, timeoutMs - (Date.now() - started));
    last = await runPlanStep(step, host, remaining);
    if (last.exitCode === 0) return last;
    await sleep(step.probe_interval_ms ?? 1000);
  }

  return last;
}

/**
 * Read active runtime state. Returns null if missing/corrupt.
 */
export async function loadActiveRuntime(): Promise<ActiveRuntime | null> {
  try {
    const raw = await fs.readFile(ACTIVE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as ActiveRuntime;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.modelId !== 'string') return null;
    if (!Array.isArray(parsed.hostIds)) return null;
    if (typeof parsed.startedAt !== 'string') return null;
    if (typeof parsed.healthy !== 'boolean') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save active runtime state.
 */
async function saveActiveRuntime(state: ActiveRuntime): Promise<void> {
  await ensureStateDir();
  await fs.writeFile(ACTIVE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function clearActiveRuntime(): Promise<void> {
  try {
    await fs.rm(ACTIVE_PATH, { force: true });
  } catch {
    // best effort
  }
}

async function teardownPartialStart(plan: PlanResult, outcomes: StepOutcome[]): Promise<void> {
  const startedHosts = new Set(
    outcomes.filter((o) => o.status === 'ok' && o.step.kind === 'start_model').map((o) => o.step.host_id),
  );
  if (startedHosts.size === 0) return;

  const stopByHost = new Map<string, PlanStep>();
  for (const step of plan.steps) {
    if (step.kind === 'stop_model' && !stopByHost.has(step.host_id)) {
      stopByHost.set(step.host_id, step);
    }
  }

  for (const hostId of startedHosts) {
    const stopStep = stopByHost.get(hostId);
    const host = plan.hosts.find((h) => h.id === hostId);
    if (!stopStep || !host) continue;
    const stopResult = await runStepWithRetry(stopStep, host);
    outcomes.push({
      step: stopStep,
      status: stopResult.exitCode === 0 ? 'ok' : 'error',
      exit_code: stopResult.exitCode,
      stdout: stopResult.stdout,
      stderr: stopResult.stderr,
      duration_ms: 0,
    });
  }
}

/**
 * Execute a runtime plan.
 */
export async function execute(plan: PlanResult, opts: ExecuteOpts = {}): Promise<ExecuteResult> {
  const lock = await acquireRuntimeLock(plan, opts);
  if (!lock.ok) {
    return { ok: false, reused: false, steps: [], error: lock.error };
  }

  const outcomes: StepOutcome[] = [];
  const startedAt = new Date().toISOString();

  try {
    if (opts.signal?.aborted) {
      await teardownPartialStart(plan, outcomes);
      await clearActiveRuntime();
      return { ok: false, reused: false, steps: outcomes, error: 'Execution aborted' };
    }

    if (plan.reuse === true) {
      const probe = plan.steps.find((s) => s.kind === 'probe_health');
      if (probe) {
        const host = plan.hosts.find((h) => h.id === probe.host_id);
        if (host) {
          const result = await runStepWithRetry(probe, host);
          if (result.exitCode === 0) {
            return { ok: true, reused: true, steps: [] };
          }
        }
      }
    }

    for (const step of plan.steps) {
      if (opts.signal?.aborted) {
        await teardownPartialStart(plan, outcomes);
        await clearActiveRuntime();
        return { ok: false, reused: false, steps: outcomes, error: 'Execution aborted' };
      }

      const host = plan.hosts.find((h) => h.id === step.host_id);
      if (!host) {
        const failed: StepOutcome = {
          step,
          status: 'error',
          exit_code: 1,
          stderr: `Host not found: ${step.host_id}`,
          duration_ms: 0,
        };
        outcomes.push(failed);
        opts.onStep?.(step, 'error', failed.stderr);
        await teardownPartialStart(plan, outcomes);
        await clearActiveRuntime();
        return { ok: false, reused: false, steps: outcomes, error: failed.stderr };
      }

      opts.onStep?.(step, 'start');
      const stepStarted = Date.now();
      const result = await runStepWithRetry(step, host);
      const duration = Date.now() - stepStarted;

      if (result.exitCode === 0) {
        outcomes.push({
          step,
          status: 'ok',
          exit_code: 0,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: duration,
        });
        opts.onStep?.(step, 'done');
        continue;
      }

      // When probe fails, check the start log on the host for the real error
      let startLog = '';
      if (step.kind === 'probe_health') {
        const logCheck = await runPlanStep(
          { ...step, command: 'cat /tmp/llama-server.log 2>/dev/null | tail -5' },
          host,
          5000,
        );
        if (logCheck.exitCode === 0 && logCheck.stdout.trim()) {
          startLog = logCheck.stdout.trim();
        }
      }

      const errorParts = [result.stderr, startLog].filter(Boolean);
      let detail = errorParts.join('\n').trim();

      // Friendly rewrite for common errors
      const notFoundMatch = detail.match(/failed to run command '([^']+)': No such file or directory/);
      if (notFoundMatch) {
        const cmd = notFoundMatch[1];
        detail = `${host.id} doesn't have '${cmd}' in PATH for non-interactive SSH.\n`
          + `Either add it to PATH in ~/.bashrc on ${host.id}, or use the full path in your start command.\n`
          + `Find it with: ssh ${host.connection.user ? host.connection.user + '@' : ''}${host.connection.host ?? host.id} 'which ${cmd} || find /usr -name ${cmd} 2>/dev/null'`;
      }

      opts.onStep?.(step, 'error', detail || undefined);
      let rollbackDetails = '';
      if (step.rollback_cmd) {
        const rollbackResult = await runCommand(step.rollback_cmd, Math.max(1000, step.timeout_sec * 1000));
        rollbackDetails = `\nRollback attempted: exit=${rollbackResult.exitCode}; stderr=${rollbackResult.stderr ?? ''}`;
      }

      outcomes.push({
        step,
        status: 'error',
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: `${detail}${rollbackDetails}`.trim(),
        duration_ms: duration,
      });

      await teardownPartialStart(plan, outcomes);
      await clearActiveRuntime();

      const errorMsg = detail || `exit code ${result.exitCode}`;
      return {
        ok: false,
        reused: false,
        steps: outcomes,
        error: `Step failed: ${step.kind} on ${step.host_id}${result.exitCode === 124 ? ' (timed out)' : ''}\n${errorMsg}`,
      };
    }

    const active: ActiveRuntime = {
      modelId: plan.model.id,
      backendId: plan.backend?.id,
      hostIds: plan.hosts.map((h) => h.id),
      healthy: true,
      startedAt,
      pid: process.pid,
      endpoint: deriveEndpoint(plan),
    };

    await saveActiveRuntime(active);
    return { ok: true, reused: false, steps: outcomes };
  } finally {
    await releaseLock();
  }
}
