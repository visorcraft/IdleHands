import { shellEscape } from '../utils.js';

import type {
  RuntimesConfig,
  PlanRequest,
  PlanOutput,
  PlanResult,
  PlanError,
  PlanStep,
  ActiveRuntime,
  ResolvedHost,
  ResolvedBackend,
  ResolvedModel,
  RuntimeHost,
  RuntimeBackend,
} from './types.js';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

function error(code: string, reason: string): PlanError {
  return { ok: false, code, reason };
}

function sameHostIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function parseRpcArgValues(args: string[] | undefined): string[] {
  if (!args || args.length === 0) return [];
  const out: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--rpc' || a === '-rpc') {
      const next = args[i + 1];
      if (next) out.push(next);
      continue;
    }
    if (a.startsWith('--rpc=')) {
      out.push(a.slice('--rpc='.length));
      continue;
    }
    if (a.startsWith('-rpc=')) {
      out.push(a.slice('-rpc='.length));
      continue;
    }
  }

  return out;
}

function extractHostFromEndpoint(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  if (!trimmed) return null;

  // URL form
  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).hostname || null;
    } catch {
      // fallthrough
    }
  }

  // Bracketed IPv6: [addr]:port
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end > 1) return trimmed.slice(1, end);
  }

  // host:port (IPv4/hostname)
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon > 0 && trimmed.indexOf(':') === lastColon) {
    return trimmed.slice(0, lastColon);
  }

  // hostname or raw address
  return trimmed;
}

function resolveRpcHelperHosts(
  config: RuntimesConfig,
  backendCfg: RuntimeBackend | null,
  targetHosts: RuntimeHost[]
): RuntimeHost[] {
  if (!backendCfg) return [];
  const rpcValues = parseRpcArgValues(backendCfg.args);
  if (rpcValues.length === 0) return [];

  const targetIds = new Set(targetHosts.map((h) => h.id));
  const resolved: RuntimeHost[] = [];
  const seen = new Set<string>();

  for (const raw of rpcValues) {
    for (const endpoint of raw.split(',')) {
      const hostOrId = extractHostFromEndpoint(endpoint);
      if (!hostOrId) continue;

      const host = config.hosts.find(
        (h) => h.enabled && (h.id === hostOrId || h.connection.host === hostOrId)
      );
      if (!host) continue;
      if (targetIds.has(host.id)) continue;
      if (seen.has(host.id)) continue;
      seen.add(host.id);
      resolved.push(host);
    }
  }

  return resolved;
}

function buildVars(
  model: ResolvedModel,
  host: RuntimeHost,
  backend: ResolvedBackend | null,
  backendCfg: RuntimeBackend | null
): Record<string, string> {
  const port = String(model.runtime_defaults?.port ?? 8080);
  const backendArgs = backend?.args?.map((arg) => shellEscape(arg)).join(' ') ?? '';
  const backendEnv = backend?.env
    ? Object.entries(backend.env)
        .map(([k, v]) => `${k}=${shellEscape(String(v))}`)
        .join(' ')
    : '';

  return {
    source: shellEscape(model.source),
    port: shellEscape(port),
    host: shellEscape(host.connection.host ?? host.id),
    backend_args: backendArgs,
    backend_env: backendEnv,
    model_id: shellEscape(model.id),
    host_id: shellEscape(host.id),
    backend_id: shellEscape(backend?.id ?? backendCfg?.id ?? ''),
    chat_template_args: model.chat_template
      ? /\.jinja\b|[/\\]/.test(model.chat_template)
        ? `--chat-template-file '${model.chat_template.replace(/^.*[/\\]/, '')}'`
        : `--chat-template ${shellEscape(model.chat_template)}`
      : '',
  };
}

/**
 * Pure planning function. Same inputs → same output. No side effects.
 */
export function plan(
  request: PlanRequest,
  config: RuntimesConfig,
  activeState: ActiveRuntime | null
): PlanOutput {
  if (request.forceSplit === true) {
    return error(
      'SPLIT_NOT_IMPLEMENTED',
      'Multi-host split (tensor/pipeline parallel) is not yet implemented.'
    );
  }

  const modelCfg = config.models.find((m) => m.id === request.modelId && m.enabled);
  if (!modelCfg) return error('MODEL_NOT_FOUND', `Model not found or disabled: ${request.modelId}`);

  let targetHosts: RuntimeHost[] = [];

  if (request.hostOverride) {
    const host = config.hosts.find((h) => h.id === request.hostOverride && h.enabled);
    if (!host)
      return error('NO_ELIGIBLE_HOST', `Host not found or disabled: ${request.hostOverride}`);
    if (Array.isArray(modelCfg.host_policy) && !modelCfg.host_policy.includes(host.id)) {
      return error(
        'HOST_POLICY_VIOLATION',
        `Host ${host.id} violates host policy for model ${modelCfg.id}`
      );
    }
    targetHosts = [host];
  } else if (modelCfg.host_policy === 'any') {
    const firstEnabled = config.hosts.find((h) => h.enabled);
    if (firstEnabled) targetHosts = [firstEnabled];
  } else {
    for (const hostId of modelCfg.host_policy) {
      const host = config.hosts.find((h) => h.id === hostId && h.enabled);
      if (host) {
        targetHosts = [host];
        break;
      }
    }
  }

  if (targetHosts.length === 0) {
    return error('NO_ELIGIBLE_HOST', `No eligible host found for model ${modelCfg.id}`);
  }

  let backendCfg: RuntimeBackend | null = null;

  if (request.backendOverride) {
    backendCfg = config.backends.find((b) => b.id === request.backendOverride && b.enabled) ?? null;
    if (!backendCfg) {
      return error(
        'BACKEND_NOT_FOUND',
        `Backend not found or disabled: ${request.backendOverride}`
      );
    }
  } else if (modelCfg.backend_policy === 'any') {
    backendCfg = null;
  } else {
    for (const backendId of modelCfg.backend_policy) {
      const backend = config.backends.find((b) => b.id === backendId && b.enabled);
      if (backend) {
        backendCfg = backend;
        break;
      }
    }
    if (!backendCfg) {
      return error('BACKEND_NOT_FOUND', `No eligible backend found for model ${modelCfg.id}`);
    }
  }

  const rpcHelperHosts = resolveRpcHelperHosts(config, backendCfg, targetHosts);
  const isRpcBacked = rpcHelperHosts.length > 0;
  const allStepHosts: RuntimeHost[] = [...targetHosts, ...rpcHelperHosts];

  const resolvedModel: ResolvedModel = {
    id: modelCfg.id,
    display_name: modelCfg.display_name,
    source: modelCfg.source,
    launch: modelCfg.launch,
    runtime_defaults: modelCfg.runtime_defaults,
    chat_template: modelCfg.chat_template,
  };

  const resolvedHosts: ResolvedHost[] = allStepHosts.map((h) => ({
    id: h.id,
    display_name: h.display_name,
    transport: h.transport,
    connection: h.connection,
  }));

  const resolvedBackend: ResolvedBackend | null = backendCfg
    ? {
        id: backendCfg.id,
        display_name: backendCfg.display_name,
        type: backendCfg.type,
        env: backendCfg.env,
        args: backendCfg.args,
      }
    : null;

  const planHostIds = resolvedHosts.map((h) => h.id);
  const targetBackendId = resolvedBackend?.id;

  // RPC-backed models always do a stop/start cycle on selection so helper hosts
  // get pre-cleared (frees memory on both target + RPC nodes).
  if (
    !request.forceRestart &&
    !isRpcBacked &&
    activeState &&
    activeState.healthy === true &&
    activeState.modelId === resolvedModel.id &&
    (activeState.backendId ?? undefined) === (targetBackendId ?? undefined) &&
    sameHostIds(activeState.hostIds, planHostIds)
  ) {
    const probeSteps: PlanStep[] = targetHosts.map((host) => {
      const vars = buildVars(resolvedModel, host, resolvedBackend, backendCfg);
      return {
        kind: 'probe_health' as const,
        host_id: host.id,
        command: interpolate(resolvedModel.launch.probe_cmd, vars),
        timeout_sec: resolvedModel.launch.probe_timeout_sec ?? 60,
        probe_interval_ms: resolvedModel.launch.probe_interval_ms ?? 1000,
        description: `Probe health for ${resolvedModel.id} on ${host.id}`,
      };
    });

    const reuseResult: PlanResult = {
      ok: true,
      reuse: true,
      model: resolvedModel,
      backend: resolvedBackend,
      hosts: resolvedHosts,
      steps: probeSteps,
    };
    return reuseResult;
  }

  const steps: PlanStep[] = [];

  // Preflight first: fail fast if the model file does not exist on target host(s)
  // before touching any currently-running runtime.
  for (const host of targetHosts) {
    steps.push({
      kind: 'verify_model_source',
      host_id: host.id,
      command: `test -f ${shellEscape(resolvedModel.source)}`,
      timeout_sec: 10,
      description: `Verify model source exists on ${host.id}`,
    });
  }

  const stopAdded = new Set<string>();

  const addStopStep = (hostId: string, description: string) => {
    if (stopAdded.has(hostId)) return;
    const hostCfg = config.hosts.find((h) => h.id === hostId);
    if (!hostCfg?.model_control?.stop_cmd) return;
    steps.push({
      kind: 'stop_model',
      host_id: hostId,
      command: hostCfg.model_control.stop_cmd,
      timeout_sec: 30,
      description,
    });
    stopAdded.add(hostId);
  };

  if (activeState?.hostIds?.length) {
    for (const hostId of activeState.hostIds) {
      addStopStep(hostId, `Stop active model on ${hostId}`);
    }
  }

  // For RPC-backed models, proactively clear llama-server on BOTH affected hosts
  // (target host + RPC helper hosts) to free memory before start.
  if (rpcHelperHosts.length > 0) {
    for (const host of targetHosts) {
      addStopStep(host.id, `Pre-clear llama-server on target host ${host.id}`);
    }
    for (const host of rpcHelperHosts) {
      addStopStep(host.id, `Pre-clear llama-server on RPC helper host ${host.id}`);
    }
  }

  const backendChanged = (activeState?.backendId ?? undefined) !== (targetBackendId ?? undefined);
  if (backendCfg) {
    if (backendChanged && backendCfg.apply_cmd) {
      for (const host of targetHosts) {
        const vars = buildVars(resolvedModel, host, resolvedBackend, backendCfg);
        steps.push({
          kind: 'apply_backend',
          host_id: host.id,
          command: interpolate(backendCfg.apply_cmd, vars),
          timeout_sec: 30,
          rollback_cmd: backendCfg.rollback_cmd,
          description: `Apply backend ${backendCfg.id} on ${host.id}`,
        });
      }
    }

    const shouldVerifyBackend = !!backendCfg.verify_cmd;
    if (shouldVerifyBackend) {
      for (const host of targetHosts) {
        const vars = buildVars(resolvedModel, host, resolvedBackend, backendCfg);
        steps.push({
          kind: 'verify_backend',
          host_id: host.id,
          command: interpolate(String(backendCfg.verify_cmd), vars),
          timeout_sec: 15,
          description: `Verify backend ${backendCfg.id} on ${host.id}`,
        });
      }
    }
  }

  for (const host of targetHosts) {
    const vars = buildVars(resolvedModel, host, resolvedBackend, backendCfg);
    steps.push({
      kind: 'start_model',
      host_id: host.id,
      command: interpolate(resolvedModel.launch.start_cmd, vars),
      timeout_sec: 30,
      description: `Start model ${resolvedModel.id} on ${host.id}`,
    });
    steps.push({
      kind: 'probe_health',
      host_id: host.id,
      command: interpolate(resolvedModel.launch.probe_cmd, vars),
      timeout_sec: resolvedModel.launch.probe_timeout_sec ?? 60,
      probe_interval_ms: resolvedModel.launch.probe_interval_ms ?? 1000,
      description: `Probe health for ${resolvedModel.id} on ${host.id}`,
    });
  }

  const result: PlanResult = {
    ok: true,
    reuse: false,
    model: resolvedModel,
    backend: resolvedBackend,
    hosts: resolvedHosts,
    steps,
  };

  return result;
}
