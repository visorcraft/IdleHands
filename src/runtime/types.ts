// Host transport types
export type HostTransport = 'local' | 'ssh';

export interface HostConnection {
  host?: string;
  port?: number;
  user?: string;
  key_path?: string;
  password?: string;
}

export interface HostCapabilities {
  gpu: string[];
  vram_gb?: number;
  backends: string[];
}

export interface HostHealth {
  check_cmd: string;
  timeout_sec?: number; // default 5
}

export interface HostModelControl {
  stop_cmd: string;
  cleanup_cmd?: string | null;
}

export interface RuntimeHost {
  id: string; // [a-z0-9][a-z0-9-]*, max 64 chars
  display_name: string;
  enabled: boolean;
  transport: HostTransport;
  connection: HostConnection;
  capabilities: HostCapabilities;
  health: HostHealth;
  model_control: HostModelControl;
}

// Backend types
export type BackendType = 'vulkan' | 'rocm' | 'cuda' | 'metal' | 'cpu' | 'custom';

export interface RuntimeBackend {
  id: string;
  display_name: string;
  enabled: boolean;
  type: BackendType;
  host_filters: 'any' | string[]; // host IDs
  apply_cmd?: string | null;
  verify_cmd?: string | null;
  /** Run verify step even when backend did not change. */
  verify_always?: boolean;
  rollback_cmd?: string | null;
  env?: Record<string, string>;
  args?: string[];
}

// Model types
export interface ModelLaunch {
  start_cmd: string;
  probe_cmd: string;
  probe_timeout_sec?: number; // default 60
  probe_interval_ms?: number; // default 1000
}

export interface ModelRuntimeDefaults {
  port?: number;
  context_window?: number;
  max_tokens?: number;
}

export interface RuntimeModel {
  id: string;
  display_name: string;
  enabled: boolean;
  source: string; // path or URL
  host_policy: 'any' | string[];
  backend_policy: 'any' | string[];
  launch: ModelLaunch;
  runtime_defaults?: ModelRuntimeDefaults;
  /** Jinja chat template path or built-in name (e.g. "chatml", path to .jinja file). Passed as --chat-template to llama-server. */
  chat_template?: string;
  split_policy?: any | null; // Phase D only
}

// Top-level config
export interface RuntimesConfig {
  schema_version: number; // must be 1
  hosts: RuntimeHost[];
  backends: RuntimeBackend[];
  models: RuntimeModel[];
}

// Planner types (needed by Phase B but defined here for completeness)
export interface PlanRequest {
  modelId: string;
  backendOverride?: string;
  hostOverride?: string;
  forceSplit?: boolean;
  mode: 'live' | 'dry-run';
  /** Force planner to produce a restart plan even if active runtime appears healthy/matching. */
  forceRestart?: boolean;
}

export interface ResolvedHost {
  id: string;
  display_name: string;
  transport: HostTransport;
  connection: HostConnection;
}

export interface ResolvedBackend {
  id: string;
  display_name: string;
  type: BackendType;
  env?: Record<string, string>;
  args?: string[];
}

export interface ResolvedModel {
  id: string;
  display_name: string;
  source: string;
  launch: ModelLaunch;
  runtime_defaults?: ModelRuntimeDefaults;
  chat_template?: string;
}

export type PlanStepKind =
  | 'stop_model'
  | 'apply_backend'
  | 'verify_backend'
  | 'start_model'
  | 'probe_health';

export interface PlanStep {
  kind: PlanStepKind;
  host_id: string;
  command: string;
  timeout_sec: number;
  probe_interval_ms?: number;
  rollback_cmd?: string | null;
  description: string;
}

export interface PlanResult {
  ok: true;
  reuse: boolean;
  model: ResolvedModel;
  backend: ResolvedBackend | null;
  hosts: ResolvedHost[];
  steps: PlanStep[];
}

export interface PlanError {
  ok: false;
  reason: string;
  code: string;
}

export type PlanOutput = PlanResult | PlanError;

// Executor types
export interface StepOutcome {
  step: PlanStep;
  status: 'ok' | 'error' | 'skipped';
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  duration_ms?: number;
}

export interface ExecuteOpts {
  onStep?: (step: PlanStep, status: 'start' | 'done' | 'error', detail?: string) => void;
  signal?: AbortSignal;
  confirm?: (prompt: string) => Promise<boolean>;
  force?: boolean;
}

export interface ExecuteResult {
  ok: boolean;
  reused: boolean;
  steps: StepOutcome[];
  error?: string;
}

// Active state tracking
export interface ActiveRuntime {
  modelId: string;
  backendId?: string;
  hostIds: string[];
  healthy: boolean;
  startedAt: string; // ISO
  pid?: number;
  endpoint?: string; // derived from host + model port at select time
}
