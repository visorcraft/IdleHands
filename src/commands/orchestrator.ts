import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";
import { CONFIG_DIR } from "../utils.js";

export type OrchestratorHost = {
  id: string;
  enabled: boolean;
  transport: "local" | "ssh";
  connection?: {
    host?: string;
    port?: number;
    user?: string;
    keyPath?: string;
  };
  stopCmd?: string;
};

export type OrchestratorBackend = {
  id: string;
  enabled: boolean;
  applyCmd?: string;
  verifyCmd?: string;
  args?: string[];
};

export type OrchestratorModel = {
  id: string;
  enabled: boolean;
  source: string;
  hostPolicy: string[] | "any";
  backendPolicy: string[] | "any";
  startCmd: string;
  probeCmd: string;
  probeTimeoutSec?: number;
};

export type OrchestratorConfig = {
  schemaVersion: 1;
  hosts: OrchestratorHost[];
  backends: OrchestratorBackend[];
  models: OrchestratorModel[];
};

export type OrchestratorPlanStep = {
  kind: "stop" | "apply_backend" | "verify_backend" | "start_model" | "probe";
  hostId: string;
  command: string;
};

const ORCH_CONFIG_PATH = path.join(CONFIG_DIR, "orchestrator.runtimes.json");
const ORCH_STATE_PATH = path.join(CONFIG_DIR, "orchestrator.active.json");
const ORCH_LOCK_PATH = path.join(CONFIG_DIR, "orchestrator.lock");

async function ensureStateDir() {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
}

function q(v: string): string {
  return `'${String(v).replaceAll("'", `'\\''`)}'`;
}

function interpolate(template: string, vars: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

async function runCommand(
  cmd: string,
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      child.kill("SIGTERM");
      resolve({ code: 124, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim() });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${String(err)}`.trim() });
    });
  });
}

async function runOnHost(
  host: OrchestratorHost,
  command: string,
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (host.transport === "local") {
    return await runCommand(command, timeoutMs);
  }
  const targetHost = host.connection?.host;
  if (!targetHost) {
    return { code: 1, stdout: "", stderr: `host ${host.id} missing connection.host` };
  }
  const user = host.connection?.user ? `${host.connection.user}@` : "";
  const port = host.connection?.port ? ["-p", String(host.connection.port)] : [];
  const key = host.connection?.keyPath ? ["-i", host.connection.keyPath] : [];
  const ssh = [
    "ssh",
    ...port,
    ...key,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=no",
    `${user}${targetHost}`,
    "bash",
    "-lc",
    q(command),
  ].join(" ");
  return await runCommand(ssh, timeoutMs);
}

export async function orchestratorInit(runtime: RuntimeEnv) {
  await ensureStateDir();
  try {
    await fs.stat(ORCH_CONFIG_PATH);
    runtime.log(`orchestrator config already exists: ${ORCH_CONFIG_PATH}`);
    return;
  } catch {
    // create
  }

  const example: OrchestratorConfig = {
    schemaVersion: 1,
    hosts: [
      {
        id: "local",
        enabled: true,
        transport: "local",
        stopCmd: "pkill -f llama-server || true",
      },
    ],
    backends: [
      {
        id: "vulkan",
        enabled: true,
        verifyCmd: "vulkaninfo --summary >/dev/null 2>&1 || true",
        args: ["-ngl", "99"],
      },
    ],
    models: [
      {
        id: "qwen3-coder-next",
        enabled: true,
        source: "/path/to/model.gguf",
        hostPolicy: ["local"],
        backendPolicy: ["vulkan"],
        startCmd:
          "nohup llama-server -m {source} --port 8082 --host 0.0.0.0 --jinja --chat-template-file /home/<user>/.idlehands/templates/qwen3.jinja {backend_args} > /tmp/llama-server.log 2>&1 &",
        probeCmd: 'curl -fsS http://127.0.0.1:8082/health | grep -q \'"status":"ok"\'',
        probeTimeoutSec: 60,
      },
    ],
  };

  await fs.writeFile(ORCH_CONFIG_PATH, `${JSON.stringify(example, null, 2)}\n`, "utf8");
  runtime.log(`wrote ${ORCH_CONFIG_PATH}`);
}

async function readConfig(): Promise<OrchestratorConfig> {
  const raw = await fs.readFile(ORCH_CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as OrchestratorConfig;
  if (parsed.schemaVersion !== 1) {
    throw new Error("orchestrator schemaVersion must be 1");
  }
  if (
    !Array.isArray(parsed.hosts) ||
    !Array.isArray(parsed.backends) ||
    !Array.isArray(parsed.models)
  ) {
    throw new Error("orchestrator config requires hosts/backends/models arrays");
  }
  return parsed;
}

export async function orchestratorStatus(runtime: RuntimeEnv) {
  await ensureStateDir();
  try {
    const raw = await fs.readFile(ORCH_STATE_PATH, "utf8");
    runtime.log(raw.trim());
  } catch {
    runtime.log("No active orchestrator state.");
  }
}

function resolveHost(config: OrchestratorConfig, model: OrchestratorModel, hostOverride?: string) {
  if (hostOverride) {
    const h = config.hosts.find((x) => x.enabled && x.id === hostOverride);
    if (!h) {
      throw new Error(`host not found/enabled: ${hostOverride}`);
    }
    return h;
  }
  if (model.hostPolicy === "any") {
    const h = config.hosts.find((x) => x.enabled);
    if (!h) {
      throw new Error("no enabled hosts");
    }
    return h;
  }
  for (const id of model.hostPolicy) {
    const h = config.hosts.find((x) => x.enabled && x.id === id);
    if (h) {
      return h;
    }
  }
  throw new Error(`no eligible host for model ${model.id}`);
}

function resolveBackend(
  config: OrchestratorConfig,
  model: OrchestratorModel,
  backendOverride?: string,
): OrchestratorBackend | null {
  if (backendOverride) {
    const b = config.backends.find((x) => x.enabled && x.id === backendOverride);
    if (!b) {
      throw new Error(`backend not found/enabled: ${backendOverride}`);
    }
    return b;
  }
  if (model.backendPolicy === "any") {
    return null;
  }
  for (const id of model.backendPolicy) {
    const b = config.backends.find((x) => x.enabled && x.id === id);
    if (b) {
      return b;
    }
  }
  throw new Error(`no eligible backend for model ${model.id}`);
}

export async function orchestratorPlan(args: {
  modelId: string;
  host?: string;
  backend?: string;
}): Promise<{
  host: OrchestratorHost;
  model: OrchestratorModel;
  backend: OrchestratorBackend | null;
  steps: OrchestratorPlanStep[];
}> {
  const config = await readConfig();
  const model = config.models.find((x) => x.enabled && x.id === args.modelId);
  if (!model) {
    throw new Error(`model not found/enabled: ${args.modelId}`);
  }
  const host = resolveHost(config, model, args.host);
  const backend = resolveBackend(config, model, args.backend);

  const vars = {
    source: q(model.source),
    host: host.connection?.host ?? host.id,
    backend_args: (backend?.args ?? []).map((x) => q(x)).join(" "),
    model_id: model.id,
    host_id: host.id,
    backend_id: backend?.id ?? "",
  };

  const steps: OrchestratorPlanStep[] = [];
  if (host.stopCmd?.trim()) {
    steps.push({ kind: "stop", hostId: host.id, command: interpolate(host.stopCmd, vars) });
  }
  if (backend?.applyCmd?.trim()) {
    steps.push({
      kind: "apply_backend",
      hostId: host.id,
      command: interpolate(backend.applyCmd, vars),
    });
  }
  if (backend?.verifyCmd?.trim()) {
    steps.push({
      kind: "verify_backend",
      hostId: host.id,
      command: interpolate(backend.verifyCmd, vars),
    });
  }
  steps.push({ kind: "start_model", hostId: host.id, command: interpolate(model.startCmd, vars) });
  steps.push({ kind: "probe", hostId: host.id, command: interpolate(model.probeCmd, vars) });

  return { host, model, backend, steps };
}

async function acquireLock(force = false) {
  await ensureStateDir();
  try {
    await fs.writeFile(
      ORCH_LOCK_PATH,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { encoding: "utf8", flag: "wx" },
    );
    return;
  } catch {
    if (!force) {
      throw new Error(`orchestrator lock is held: ${ORCH_LOCK_PATH}`);
    }
    await fs.rm(ORCH_LOCK_PATH, { force: true });
    await fs.writeFile(
      ORCH_LOCK_PATH,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), force: true }),
      { encoding: "utf8", flag: "wx" },
    );
  }
}

async function releaseLock() {
  await fs.rm(ORCH_LOCK_PATH, { force: true });
}

export async function orchestratorApply(args: {
  modelId: string;
  host?: string;
  backend?: string;
  force?: boolean;
  dryRun?: boolean;
  runtime: RuntimeEnv;
}) {
  const { host, model, backend, steps } = await orchestratorPlan(args);
  if (args.dryRun) {
    args.runtime.log(
      JSON.stringify(
        { model: model.id, host: host.id, backend: backend?.id ?? null, steps },
        null,
        2,
      ),
    );
    return;
  }

  await acquireLock(Boolean(args.force));
  try {
    for (const step of steps) {
      const timeout =
        step.kind === "probe" ? Math.max(5_000, (model.probeTimeoutSec ?? 60) * 1000) : 120_000;
      args.runtime.log(`→ [${step.kind}] ${step.command}`);
      const res = await runOnHost(host, step.command, timeout);
      if (res.code !== 0) {
        throw new Error(`[${step.kind}] failed (exit ${res.code})\n${res.stderr || res.stdout}`);
      }
    }

    await fs.writeFile(
      ORCH_STATE_PATH,
      `${JSON.stringify(
        {
          modelId: model.id,
          hostId: host.id,
          backendId: backend?.id ?? null,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    args.runtime.log(`orchestrator apply complete: ${model.id} on ${host.id}`);
  } finally {
    await releaseLock();
  }
}
