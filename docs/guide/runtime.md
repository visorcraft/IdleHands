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
```

This probes enabled resources and reports runtime readiness.

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
idlehands select status
idlehands select --model <id> --dry-run
```

## Practical guidance

- Keep at least one known-good fallback model profile.
- Use explicit probe commands so startup failures are obvious.
- Validate hosts/backends before adding many models.
- For shared environments, keep runtime IDs stable and human-readable.
