import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../tools.js';
import { configDir, shellEscape } from '../utils.js';
import type { RuntimesConfig, RuntimeHost, RuntimeBackend, RuntimeModel } from './types.js';

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_ID_LEN = 64;
const ALLOWED_TEMPLATE_VARS = new Set([
  'source', 'port', 'host', 'backend_args', 'backend_env', 'model_id', 'host_id', 'backend_id',
]);

function runtimesPath(): string {
  return path.join(configDir(), 'runtimes.json');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertNoUnknownKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`${where}: unknown key "${key}"`);
  }
}

function assertString(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new Error(`${where}: expected string`);
  return v;
}

function assertBoolean(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${where}: expected boolean`);
  return v;
}

function assertNumber(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: expected number`);
  return v;
}

function validateId(id: unknown, where: string): string {
  const s = assertString(id, `${where}.id`);
  if (s.length > MAX_ID_LEN || !ID_RE.test(s)) throw new Error(`${where}.id: invalid id format`);
  return s;
}

function validateStringArray(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${where}: expected array`);
  return v.map((x, i) => assertString(x, `${where}[${i}]`));
}

function validatePolicy(v: unknown, where: string): 'any' | string[] {
  if (v === 'any') return 'any';
  return validateStringArray(v, where);
}

function validateCommandTemplate(cmd: unknown, where: string, allowNull = false): string | null | undefined {
  if (cmd == null) {
    if (allowNull) return cmd as null | undefined;
    throw new Error(`${where}: expected string`);
  }
  const s = assertString(cmd, where);
  const re = /\{([a-z_][a-z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (!ALLOWED_TEMPLATE_VARS.has(m[1])) throw new Error(`${where}: unknown template variable {${m[1]}}`);
  }
  return s;
}

function validateHost(raw: unknown, index: number): RuntimeHost {
  if (!isRecord(raw)) throw new Error(`hosts[${index}]: expected object`);
  assertNoUnknownKeys(raw, ['id', 'display_name', 'enabled', 'transport', 'connection', 'capabilities', 'health', 'model_control'], `hosts[${index}]`);

  const id = validateId(raw.id, `hosts[${index}]`);
  const display_name = assertString(raw.display_name, `hosts[${index}].display_name`);
  const enabled = assertBoolean(raw.enabled, `hosts[${index}].enabled`);
  const transport = assertString(raw.transport, `hosts[${index}].transport`);
  if (transport !== 'local' && transport !== 'ssh') throw new Error(`hosts[${index}].transport: expected "local" or "ssh"`);

  if (!isRecord(raw.connection)) throw new Error(`hosts[${index}].connection: expected object`);
  for (const key of Object.keys(raw.connection)) {
    if (['host', 'port', 'user', 'key_path', 'password'].includes(key)) continue;
    if (key.endsWith('_ref')) continue;
    throw new Error(`hosts[${index}].connection: unknown key "${key}"`);
  }
  const connection = {
    host: raw.connection.host == null ? undefined : assertString(raw.connection.host, `hosts[${index}].connection.host`),
    port: raw.connection.port == null ? undefined : assertNumber(raw.connection.port, `hosts[${index}].connection.port`),
    user: raw.connection.user == null ? undefined : assertString(raw.connection.user, `hosts[${index}].connection.user`),
    key_path: raw.connection.key_path == null ? undefined : assertString(raw.connection.key_path, `hosts[${index}].connection.key_path`),
    password: raw.connection.password == null ? undefined : assertString(raw.connection.password, `hosts[${index}].connection.password`),
  };

  if (!isRecord(raw.capabilities)) throw new Error(`hosts[${index}].capabilities: expected object`);
  assertNoUnknownKeys(raw.capabilities, ['gpu', 'vram_gb', 'backends'], `hosts[${index}].capabilities`);
  const capabilities = {
    gpu: validateStringArray(raw.capabilities.gpu, `hosts[${index}].capabilities.gpu`),
    vram_gb: raw.capabilities.vram_gb == null ? undefined : assertNumber(raw.capabilities.vram_gb, `hosts[${index}].capabilities.vram_gb`),
    backends: validateStringArray(raw.capabilities.backends, `hosts[${index}].capabilities.backends`),
  };

  if (!isRecord(raw.health)) throw new Error(`hosts[${index}].health: expected object`);
  assertNoUnknownKeys(raw.health, ['check_cmd', 'timeout_sec'], `hosts[${index}].health`);
  const health = {
    check_cmd: validateCommandTemplate(raw.health.check_cmd, `hosts[${index}].health.check_cmd`) as string,
    timeout_sec: raw.health.timeout_sec == null ? undefined : assertNumber(raw.health.timeout_sec, `hosts[${index}].health.timeout_sec`),
  };

  if (!isRecord(raw.model_control)) throw new Error(`hosts[${index}].model_control: expected object`);
  assertNoUnknownKeys(raw.model_control, ['stop_cmd', 'cleanup_cmd'], `hosts[${index}].model_control`);
  const model_control = {
    stop_cmd: validateCommandTemplate(raw.model_control.stop_cmd, `hosts[${index}].model_control.stop_cmd`) as string,
    cleanup_cmd: validateCommandTemplate(raw.model_control.cleanup_cmd, `hosts[${index}].model_control.cleanup_cmd`, true),
  };

  return { id, display_name, enabled, transport, connection, capabilities, health, model_control };
}

function validateBackend(raw: unknown, index: number): RuntimeBackend {
  if (!isRecord(raw)) throw new Error(`backends[${index}]: expected object`);
  assertNoUnknownKeys(raw, ['id', 'display_name', 'enabled', 'type', 'host_filters', 'apply_cmd', 'verify_cmd', 'rollback_cmd', 'env', 'args'], `backends[${index}]`);

  const id = validateId(raw.id, `backends[${index}]`);
  const display_name = assertString(raw.display_name, `backends[${index}].display_name`);
  const enabled = assertBoolean(raw.enabled, `backends[${index}].enabled`);
  const type = assertString(raw.type, `backends[${index}].type`);
  if (!['vulkan', 'rocm', 'cuda', 'metal', 'cpu', 'custom'].includes(type)) throw new Error(`backends[${index}].type: invalid backend type`);

  let env: Record<string, string> | undefined;
  if (raw.env != null) {
    if (!isRecord(raw.env)) throw new Error(`backends[${index}].env: expected object`);
    env = {};
    for (const [k, v] of Object.entries(raw.env)) env[k] = assertString(v, `backends[${index}].env.${k}`);
  }

  return {
    id,
    display_name,
    enabled,
    type: type as RuntimeBackend['type'],
    host_filters: validatePolicy(raw.host_filters, `backends[${index}].host_filters`),
    apply_cmd: validateCommandTemplate(raw.apply_cmd, `backends[${index}].apply_cmd`, true),
    verify_cmd: validateCommandTemplate(raw.verify_cmd, `backends[${index}].verify_cmd`, true),
    rollback_cmd: validateCommandTemplate(raw.rollback_cmd, `backends[${index}].rollback_cmd`, true),
    env,
    args: raw.args == null ? undefined : validateStringArray(raw.args, `backends[${index}].args`),
  };
}

function validateModel(raw: unknown, index: number): RuntimeModel {
  if (!isRecord(raw)) throw new Error(`models[${index}]: expected object`);
  assertNoUnknownKeys(raw, ['id', 'display_name', 'enabled', 'source', 'host_policy', 'backend_policy', 'launch', 'runtime_defaults', 'split_policy'], `models[${index}]`);

  const id = validateId(raw.id, `models[${index}]`);
  const display_name = assertString(raw.display_name, `models[${index}].display_name`);
  const enabled = assertBoolean(raw.enabled, `models[${index}].enabled`);
  const source = assertString(raw.source, `models[${index}].source`);
  const host_policy = validatePolicy(raw.host_policy, `models[${index}].host_policy`);
  const backend_policy = validatePolicy(raw.backend_policy, `models[${index}].backend_policy`);

  if (!isRecord(raw.launch)) throw new Error(`models[${index}].launch: expected object`);
  assertNoUnknownKeys(raw.launch, ['start_cmd', 'probe_cmd', 'probe_timeout_sec', 'probe_interval_ms'], `models[${index}].launch`);
  const launch = {
    start_cmd: validateCommandTemplate(raw.launch.start_cmd, `models[${index}].launch.start_cmd`) as string,
    probe_cmd: validateCommandTemplate(raw.launch.probe_cmd, `models[${index}].launch.probe_cmd`) as string,
    probe_timeout_sec: raw.launch.probe_timeout_sec == null ? undefined : assertNumber(raw.launch.probe_timeout_sec, `models[${index}].launch.probe_timeout_sec`),
    probe_interval_ms: raw.launch.probe_interval_ms == null ? undefined : assertNumber(raw.launch.probe_interval_ms, `models[${index}].launch.probe_interval_ms`),
  };

  let runtime_defaults;
  if (raw.runtime_defaults != null) {
    if (!isRecord(raw.runtime_defaults)) throw new Error(`models[${index}].runtime_defaults: expected object`);
    assertNoUnknownKeys(raw.runtime_defaults, ['port', 'context_window', 'max_tokens'], `models[${index}].runtime_defaults`);
    runtime_defaults = {
      port: raw.runtime_defaults.port == null ? undefined : assertNumber(raw.runtime_defaults.port, `models[${index}].runtime_defaults.port`),
      context_window: raw.runtime_defaults.context_window == null ? undefined : assertNumber(raw.runtime_defaults.context_window, `models[${index}].runtime_defaults.context_window`),
      max_tokens: raw.runtime_defaults.max_tokens == null ? undefined : assertNumber(raw.runtime_defaults.max_tokens, `models[${index}].runtime_defaults.max_tokens`),
    };
  }

  return { id, display_name, enabled, source, host_policy, backend_policy, launch, runtime_defaults, split_policy: raw.split_policy as any };
}

export function validateRuntimes(input: unknown): RuntimesConfig {
  if (!isRecord(input)) throw new Error('runtimes: expected object');

  const topAllowed = ['schema_version', 'hosts', 'backends', 'models'];
  for (const key of Object.keys(input)) {
    if (!topAllowed.includes(key)) console.error(`[runtimes] warning: unknown top-level key "${key}"`);
  }

  if (input.schema_version !== 1) throw new Error('runtimes.schema_version: must be 1');
  if (!Array.isArray(input.hosts)) throw new Error('runtimes.hosts: expected array');
  if (!Array.isArray(input.backends)) throw new Error('runtimes.backends: expected array');
  if (!Array.isArray(input.models)) throw new Error('runtimes.models: expected array');

  const hasSecretRefStub = input.hosts.some((host) => {
    if (!isRecord(host) || !isRecord(host.connection)) return false;
    return Object.keys(host.connection).some((key) => key.endsWith('_ref'));
  });
  if (hasSecretRefStub) {
    console.error('[runtime] warning: Secret refs (*_ref fields) are not yet supported. Use inline values for now.');
  }

  const hosts = input.hosts.map((h, i) => validateHost(h, i));
  const backends = input.backends.map((b, i) => validateBackend(b, i));
  const models = input.models.map((m, i) => validateModel(m, i));

  const hostIds = new Set<string>();
  for (const host of hosts) {
    if (hostIds.has(host.id)) throw new Error(`hosts: duplicate id "${host.id}"`);
    hostIds.add(host.id);
  }

  const backendIds = new Set<string>();
  for (const backend of backends) {
    if (backendIds.has(backend.id)) throw new Error(`backends: duplicate id "${backend.id}"`);
    backendIds.add(backend.id);
    if (backend.host_filters !== 'any') {
      for (const hostId of backend.host_filters) {
        if (!hostIds.has(hostId)) throw new Error(`backends[${backend.id}].host_filters: unknown host id "${hostId}"`);
      }
    }
  }

  for (const model of models) {
    if (model.host_policy !== 'any') {
      for (const hostId of model.host_policy) {
        if (!hostIds.has(hostId)) throw new Error(`models[${model.id}].host_policy: unknown host id "${hostId}"`);
      }
    }
    if (model.backend_policy !== 'any') {
      for (const backendId of model.backend_policy) {
        if (!backendIds.has(backendId)) throw new Error(`models[${model.id}].backend_policy: unknown backend id "${backendId}"`);
      }
    }
  }

  return { schema_version: 1, hosts, backends, models };
}

export function redactConfig(config: RuntimesConfig): RuntimesConfig {
  const clone = JSON.parse(JSON.stringify(config)) as RuntimesConfig;
  for (const host of clone.hosts) {
    if (host.connection.password != null) host.connection.password = '[REDACTED]';
    if (host.connection.key_path != null) host.connection.key_path = '[REDACTED]';
  }
  return clone;
}

async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(data, null, 2) + '\n');
}

export async function bootstrapRuntimes(filePath = runtimesPath()): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeJsonFile(filePath, { schema_version: 1, hosts: [], backends: [], models: [] });
    await fs.chmod(filePath, 0o600);
  }
}

export async function loadRuntimes(filePath = runtimesPath()): Promise<RuntimesConfig> {
  await bootstrapRuntimes(filePath);
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = raw.trim() ? JSON.parse(raw) : { schema_version: 1, hosts: [], backends: [], models: [] };
  return validateRuntimes(parsed);
}

export async function saveRuntimes(config: RuntimesConfig, filePath = runtimesPath()): Promise<void> {
  const validated = validateRuntimes(config);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeJsonFile(filePath, validated);
  await fs.chmod(filePath, 0o600);
}

export function interpolateTemplate(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{([a-z_][a-z0-9_]*)\}/g, (_m, key: string) => {
    if (!ALLOWED_TEMPLATE_VARS.has(key)) throw new Error(`unknown template variable {${key}}`);
    const value = vars[key];
    if (value == null) return '';
    return shellEscape(String(value));
  });
}
