# Runtime Orchestration

Runtime orchestration manages multiple hosts, compute backends, and models from one CLI.
Configuration is stored in `~/.config/idlehands/runtimes.json`.

## Resource model

| Resource | What it is | Example |
|---|---|---|
| **Host** | Machine that runs models (local or SSH) | Workstation or remote GPU server |
| **Backend** | Compute backend on a host | Vulkan, CUDA, ROCm, CPU |
| **Model** | Model source + launch/probe commands | GGUF model entry |

## Setup flow

```bash
idlehands hosts add
idlehands backends add
idlehands models add
idlehands select --model <model-id>
idlehands health
```

The setup wizard (`idlehands setup`) provides this flow interactively.

## Template variables

Backend and model commands can use:
- `{backend_env}`
- `{backend_args}`
- `{source}`
- `{port}`
- `{host}`

## Endpoint resolution priority

After `idlehands select --model <id>`, Idle Hands launches and probes the model, then derives the endpoint from host + model port and stores it as active runtime state.

| Priority | Source |
|---|---|
| 1 | `--endpoint` CLI flag |
| 2 | Active runtime endpoint |
| 3 | `config.json` endpoint |

## Health checks

```bash
idlehands health
```

Probes all enabled hosts/models and reports status inline.

## Management commands

```bash
idlehands hosts
idlehands hosts show <id>
idlehands hosts test <id>
idlehands hosts doctor
idlehands hosts validate

idlehands backends
idlehands models

idlehands select --model <id>
idlehands select status
idlehands select --model <id> --dry-run
```
