# Runtime Config Reference (`runtimes.json`)

Idle Hands runtime orchestration is configured in:

- `~/.config/idlehands/runtimes.json`

This file defines three resource types in one place:

- **hosts**: where runtimes can run (local or SSH)
- **backends**: runtime backend selection (vulkan/cuda/rocm/etc.)
- **models**: model launch + health probe behavior

A single file is used so host/backend/model cross-references can be validated atomically.

## File schema (v1)

```json
{
  "schema_version": 1,
  "hosts": [],
  "backends": [],
  "models": []
}
```

- `schema_version` must be `1`.
- Unknown **top-level** keys are allowed with warning (forward compatibility).
- Unknown keys inside `hosts[]`, `backends[]`, `models[]` are validation errors.

---

## `hosts[]`

Each entry matches `RuntimeHost`.

| Field | Type | Required | Notes |
|---|---|---:|---|
| `id` | string | yes | Host ID slug, unique in `hosts[]` |
| `display_name` | string | yes | Human-readable label |
| `enabled` | boolean | yes | Disabled hosts are ignored by planner |
| `transport` | `"local" \| "ssh"` | yes | How commands are executed |
| `connection` | object | yes | Connection parameters |
| `capabilities` | object | yes | Informational + backend support |
| `health` | object | yes | Host health check command |
| `model_control` | object | yes | Stop/cleanup commands |

### `connection`

| Field | Type | Required | Notes |
|---|---|---:|---|
| `host` | string | no | SSH hostname/IP |
| `port` | number | no | SSH port |
| `user` | string | no | SSH user |
| `key_path` | string | no | SSH key path (secret) |
| `password` | string | no | SSH password (secret) |

### `capabilities`

| Field | Type | Required | Notes |
|---|---|---:|---|
| `gpu` | string[] | yes | GPU labels |
| `vram_gb` | number | no | Informational |
| `backends` | string[] | yes | Backend IDs this host can run |

### `health`

| Field | Type | Required | Notes |
|---|---|---:|---|
| `check_cmd` | string | yes | Shell command; template vars allowed |
| `timeout_sec` | number | no | Default behavior: 5 sec |

### `model_control`

| Field | Type | Required | Notes |
|---|---|---:|---|
| `stop_cmd` | string | yes | Command used before switching |
| `cleanup_cmd` | string \| null | no | Optional cleanup |

---

## `backends[]`

Each entry matches `RuntimeBackend`.

| Field | Type | Required | Notes |
|---|---|---:|---|
| `id` | string | yes | Backend ID slug, unique in `backends[]` |
| `display_name` | string | yes | Human-readable label |
| `enabled` | boolean | yes | Disabled backends are ignored |
| `type` | `"vulkan" \| "rocm" \| "cuda" \| "metal" \| "cpu" \| "custom"` | yes | Backend type |
| `host_filters` | `"any" \| string[]` | yes | Restrict to specific host IDs |
| `apply_cmd` | string \| null | no | Optional backend switch command |
| `verify_cmd` | string \| null | no | Optional backend verification command |
| `verify_always` | boolean | no | If true, `verify_cmd` runs even when backend ID did not change |
| `rollback_cmd` | string \| null | no | Optional rollback command |
| `env` | `Record<string,string>` | no | Env vars to inject |
| `args` | string[] | no | Extra launch args |

---

## `models[]`

Each entry matches `RuntimeModel`.

| Field | Type | Required | Notes |
|---|---|---:|---|
| `id` | string | yes | Model ID slug |
| `display_name` | string | yes | Human-readable label |
| `enabled` | boolean | yes | Disabled models are not selectable |
| `source` | string | yes | Model path or URL |
| `host_policy` | `"any" \| string[]` | yes | Allowed host IDs |
| `backend_policy` | `"any" \| string[]` | yes | Allowed backend IDs |
| `launch` | object | yes | Start + probe commands |
| `runtime_defaults` | object | no | Optional runtime defaults |
| `split_policy` | any \| null | no | Reserved for future split orchestration |

### `launch`

| Field | Type | Required | Notes |
|---|---|---:|---|
| `start_cmd` | string | yes | Runtime start command |
| `probe_cmd` | string | yes | Health probe command |
| `probe_timeout_sec` | number | no | Default behavior: 30 sec |
| `probe_interval_ms` | number | no | Default behavior: 500 ms |

### `runtime_defaults`

| Field | Type | Required | Notes |
|---|---|---:|---|
| `port` | number | no | Launch/probe helper |
| `context_window` | number | no | Informational/default setting |
| `max_tokens` | number | no | Informational/default setting |

---

## Field rules

## ID format and uniqueness

All IDs (`host.id`, `backend.id`, `model.id`) must:

- match regex: `^[a-z0-9][a-z0-9-]*$`
- be at most 64 chars
- be unique within their section

## Cross-reference validation

- `backends[].host_filters[]` must reference existing `hosts[].id`
- `models[].host_policy[]` must reference existing `hosts[].id`
- `models[].backend_policy[]` must reference existing `backends[].id`

`"any"` means unrestricted for that policy/filter.

## Template variable rules

Command fields (`*_cmd`) support `{var}` interpolation and reject unknown variables.

Allowed variables (v1):

| Variable | Typical source |
|---|---|
| `{source}` | `model.source` |
| `{port}` | `model.runtime_defaults.port` |
| `{host}` | resolved host address |
| `{backend_args}` | backend args joined into one string |
| `{backend_env}` | backend env formatted for shell usage |
| `{model_id}` | `model.id` |
| `{host_id}` | `host.id` |
| `{backend_id}` | `backend.id` |

Interpolation uses shell escaping (`shellEscape`) for inserted values.

---

## Examples

## 1) Single local host with Vulkan backend

```json
{
  "schema_version": 1,
  "hosts": [
    {
      "id": "local-main",
      "display_name": "Local Workstation",
      "enabled": true,
      "transport": "local",
      "connection": {},
      "capabilities": {
        "gpu": ["rtx-4090"],
        "vram_gb": 24,
        "backends": ["vulkan"]
      },
      "health": {
        "check_cmd": "nvidia-smi > /dev/null 2>&1 && echo ok",
        "timeout_sec": 5
      },
      "model_control": {
        "stop_cmd": "pkill -f llama-server || true",
        "cleanup_cmd": null
      }
    }
  ],
  "backends": [
    {
      "id": "vulkan",
      "display_name": "Vulkan",
      "enabled": true,
      "type": "vulkan",
      "host_filters": "any",
      "verify_cmd": "vulkaninfo --summary > /dev/null 2>&1",
      "env": {"GGML_VK_DEVICE": "0"},
      "args": ["-ngl", "99"]
    }
  ],
  "models": [
    {
      "id": "qwen3-coder-q4",
      "display_name": "Qwen3 Coder Q4",
      "enabled": true,
      "source": "/models/Qwen3-Coder-Next-Q4_K_M.gguf",
      "host_policy": "any",
      "backend_policy": ["vulkan"],
      "launch": {
        "start_cmd": "llama-server --model {source} --host 0.0.0.0 --port {port} {backend_args}",
        "probe_cmd": "curl -sf http://127.0.0.1:{port}/health",
        "probe_timeout_sec": 30,
        "probe_interval_ms": 500
      },
      "runtime_defaults": {
        "port": 8080,
        "context_window": 131072,
        "max_tokens": 8192
      },
      "split_policy": null
    }
  ]
}
```

## 2) Two hosts (local + SSH server) with model switching

```json
{
  "schema_version": 1,
  "hosts": [
    {
      "id": "workstation",
      "display_name": "Local Workstation",
      "enabled": true,
      "transport": "local",
      "connection": {},
      "capabilities": {"gpu": ["rtx-4090"], "backends": ["vulkan", "cuda"]},
      "health": {"check_cmd": "echo ok"},
      "model_control": {"stop_cmd": "pkill -f llama-server || true"}
    },
    {
      "id": "lab-ssh",
      "display_name": "Lab Server",
      "enabled": true,
      "transport": "ssh",
      "connection": {
        "host": "10.0.0.10",
        "port": 22,
        "user": "exampleuser",
        "key_path": "~/.ssh/id_example_key"
      },
      "capabilities": {"gpu": ["mi300"], "backends": ["rocm"]},
      "health": {"check_cmd": "rocminfo > /dev/null 2>&1"},
      "model_control": {"stop_cmd": "pkill -f llama-server || true"}
    }
  ],
  "backends": [
    {
      "id": "vulkan",
      "display_name": "Vulkan",
      "enabled": true,
      "type": "vulkan",
      "host_filters": ["workstation"]
    },
    {
      "id": "rocm",
      "display_name": "ROCm",
      "enabled": true,
      "type": "rocm",
      "host_filters": ["lab-ssh"]
    }
  ],
  "models": [
    {
      "id": "qwen-local",
      "display_name": "Qwen Local",
      "enabled": true,
      "source": "/models/qwen-local.gguf",
      "host_policy": ["workstation"],
      "backend_policy": ["vulkan"],
      "launch": {
        "start_cmd": "llama-server --model {source} --port {port}",
        "probe_cmd": "curl -sf http://127.0.0.1:{port}/health"
      },
      "runtime_defaults": {"port": 8080}
    },
    {
      "id": "qwen-remote",
      "display_name": "Qwen Remote",
      "enabled": true,
      "source": "/srv/models/qwen-remote.gguf",
      "host_policy": ["lab-ssh"],
      "backend_policy": ["rocm"],
      "launch": {
        "start_cmd": "llama-server --model {source} --port {port}",
        "probe_cmd": "curl -sf http://127.0.0.1:{port}/health"
      },
      "runtime_defaults": {"port": 8080}
    }
  ]
}
```

## 3) Multiple models with different host/backend policies

```json
{
  "schema_version": 1,
  "hosts": [
    {"id": "ws", "display_name": "Workstation", "enabled": true, "transport": "local", "connection": {}, "capabilities": {"gpu": ["rtx-4090"], "backends": ["vulkan", "cuda"]}, "health": {"check_cmd": "echo ok"}, "model_control": {"stop_cmd": "pkill -f llama-server || true"}},
    {"id": "cpu-node", "display_name": "CPU Node", "enabled": true, "transport": "ssh", "connection": {"host": "10.0.0.12", "user": "exampleuser", "key_path": "~/.ssh/id_example_key"}, "capabilities": {"gpu": [], "backends": ["cpu"]}, "health": {"check_cmd": "echo ok"}, "model_control": {"stop_cmd": "pkill -f llama-server || true"}}
  ],
  "backends": [
    {"id": "cuda", "display_name": "CUDA", "enabled": true, "type": "cuda", "host_filters": ["ws"]},
    {"id": "cpu", "display_name": "CPU", "enabled": true, "type": "cpu", "host_filters": ["cpu-node"]}
  ],
  "models": [
    {"id": "coder-fast", "display_name": "Coder Fast", "enabled": true, "source": "/models/coder-fast.gguf", "host_policy": ["ws"], "backend_policy": ["cuda"], "launch": {"start_cmd": "llama-server --model {source}", "probe_cmd": "curl -sf http://127.0.0.1:8080/health"}},
    {"id": "reasoning-large", "display_name": "Reasoning Large", "enabled": true, "source": "/models/reasoning-large.gguf", "host_policy": "any", "backend_policy": "any", "launch": {"start_cmd": "llama-server --model {source}", "probe_cmd": "curl -sf http://127.0.0.1:8080/health"}},
    {"id": "fallback-cpu", "display_name": "Fallback CPU", "enabled": true, "source": "/models/fallback-cpu.gguf", "host_policy": ["cpu-node"], "backend_policy": ["cpu"], "launch": {"start_cmd": "llama-server --model {source}", "probe_cmd": "curl -sf http://127.0.0.1:8080/health"}}
  ]
}
```

---

## Secret handling (v1)

In v1, secrets are inline in `runtimes.json`:

- `hosts[].connection.password`
- `hosts[].connection.key_path`

Recommendations:

1. Restrict file permissions:
   ```bash
   chmod 600 ~/.config/idlehands/runtimes.json
   ```
2. Keep runtime config out of shared screenshots/logs.
3. Prefer SSH key auth over passwords.

`saveRuntimes()` writes the file with mode `0600`, and redacted output paths should hide secret fields when displayed.

---

## Related commands

From the runtime CLI set:

```bash
idlehands hosts validate
idlehands hosts doctor
idlehands select --model <id>
idlehands select --model <id> --dry-run --json
idlehands select status
```

See also: [orchestration.md](./orchestration.md) and [troubleshooting.md](./troubleshooting.md).
