---
summary: "CLI reference for `idlehands daemon` (legacy alias for gateway service management)"
read_when:
  - You still use `idlehands daemon ...` in scripts
  - You need service lifecycle commands (install/start/stop/restart/status)
title: "daemon"
---

# `idlehands daemon`

Legacy alias for Gateway service management commands.

`idlehands daemon ...` maps to the same service control surface as `idlehands gateway ...` service commands.

## Usage

```bash
idlehands daemon status
idlehands daemon install
idlehands daemon start
idlehands daemon stop
idlehands daemon restart
idlehands daemon uninstall
```

## Subcommands

- `status`: show service install state and probe Gateway health
- `install`: install service (`launchd`/`systemd`/`schtasks`)
- `uninstall`: remove service
- `start`: start service
- `stop`: stop service
- `restart`: restart service

## Common options

- `status`: `--url`, `--token`, `--password`, `--timeout`, `--no-probe`, `--deep`, `--json`
- `install`: `--port`, `--runtime <node|bun>`, `--token`, `--force`, `--json`
- lifecycle (`uninstall|start|stop|restart`): `--json`

## Prefer

Use [`idlehands gateway`](/cli/gateway) for current docs and examples.
