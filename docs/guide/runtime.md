# Runtime Orchestration

Runtime orchestration lets you manage hosts, compute backends, and model entries from one CLI.

State is stored in:

```bash
~/.config/idlehands/runtimes.json
```

## Resource model

| Resource | Meaning | Example |
|---|---|---|
| **Host** | Machine that runs inference | Local workstation, remote GPU server |
| **Backend** | Compute/runtime layer on a host | CUDA, ROCm, Vulkan, CPU, custom |
| **Model** | Model source + launch/probe behavior | GGUF model profile |

## Typical setup flow

```bash
idlehands hosts add
idlehands backends add
idlehands models add
idlehands select --model <model-id>
idlehands health
```

Prefer interactive setup? Use:

```bash
idlehands setup
```

## Template variables

Launch/probe commands can use:

- `{backend_env}`
- `{backend_args}`
- `{source}`
- `{port}`
- `{host}`

## Endpoint resolution order

When running a session, endpoint source priority is:

1. `--endpoint` CLI flag
2. active runtime endpoint (`idlehands select ...`)
3. `config.json` endpoint

## Health checks

```bash
idlehands health
idlehands health --scan-ports 8000-8100
idlehands health --scan-ports 8080,8081,9000
```

`idlehands health` probes enabled hosts/models and now also reports a **Loaded (discovered)** section:

- probes `http://127.0.0.1:<port>/v1/models` (with `/health` fallback)
- classifies `ready` (200), `loading` (503), `down` (connection/timeout), or `unknown`
- highlights model IDs discovered on ports that are not in configured model entries

`--scan-ports` overrides the default discovery range (`8080..8090` plus configured model ports).

## Core management commands

```bash
idlehands hosts
idlehands hosts show <id>
idlehands hosts test <id>
idlehands hosts doctor
idlehands hosts validate

idlehands backends
idlehands models

idlehands select --model <id>
idlehands select --model <id> --restart
idlehands select --model <id> --force
idlehands select status
idlehands select --model <id> --dry-run
```

## Practical guidance

- Keep at least one known-good fallback model profile.
- Use explicit probe commands so startup failures are obvious.
- Validate hosts/backends before adding many models.
- For shared environments, keep runtime IDs stable and human-readable.

## Select reuse + restart behavior

`idlehands select` now does a live safety check before declaring runtime reuse:

- reuse plans include explicit probe steps (never empty execution)
- stale active state is auto-corrected: if reuse probe fails, select retries with forced restart
- `--restart` explicitly forces stop/start behavior
- `--force` also forces restart planning (in addition to lock/confirmation behavior)

For backend-managed services, `verify_cmd` runs whenever a backend is selected, so daemon dependencies are validated even when backend ID did not change.

## Probe timeout behavior (size-aware defaults)

idlehands select uses the model launch probe command for readiness checks.

If a model does not set explicit probe values, Idle Hands derives defaults from estimated model size so large models, including RPC split models, get longer startup windows automatically.

For sharded GGUF files, Idle Hands sums all shards in the set before choosing defaults.

| Model size (GiB) | probe timeout | probe interval |
|---:|---:|---:|
| <= 10 | 120s | 1000ms |
| <= 40 | 300s | 1200ms |
| <= 80 | 900s | 2000ms |
| <= 140 | 3600s | 5000ms |
| > 140 | 5400s | 5000ms |

To override a specific model, set launch.probe_timeout_sec and/or launch.probe_interval_ms in runtimes.json.
Explicit per-model values always take precedence.

