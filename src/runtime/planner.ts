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
      ? `--chat-template ${shellEscape(model.chat_template)}`
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

  const resolvedModel: ResolvedModel = {
    id: modelCfg.id,
    display_name: modelCfg.display_name,
    source: modelCfg.source,
    launch: modelCfg.launch,
    runtime_defaults: modelCfg.runtime_defaults,
    chat_template: modelCfg.chat_template,
  };

  const resolvedHosts: ResolvedHost[] = targetHosts.map((h) => ({
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

  const targetHostIds = resolvedHosts.map((h) => h.id);
  const targetBackendId = resolvedBackend?.id;

  if (
    !request.forceRestart &&
    activeState &&
    activeState.healthy === true &&
    activeState.modelId === resolvedModel.id &&
    (activeState.backendId ?? undefined) === (targetBackendId ?? undefined) &&
    sameHostIds(activeState.hostIds, targetHostIds)
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

  if (activeState?.hostIds?.length) {
    for (const hostId of activeState.hostIds) {
      const hostCfg = config.hosts.find((h) => h.id === hostId);
      if (!hostCfg?.model_control?.stop_cmd) continue;
      steps.push({
        kind: 'stop_model',
        host_id: hostId,
        command: hostCfg.model_control.stop_cmd,
        timeout_sec: 30,
        description: `Stop active model on ${hostId}`,
      });
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
