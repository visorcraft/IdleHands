---
summary: "Run IdleHands in a rootless Podman container"
read_when:
  - You want a containerized gateway with Podman instead of Docker
title: "Podman"
---

# Podman

Run the IdleHands gateway in a **rootless** Podman container. Uses the same image as Docker (build from the repo [Dockerfile](https://github.com/idlehands/idlehands/blob/main/Dockerfile)).

## Requirements

- Podman (rootless)
- Sudo for one-time setup (create user, build image)

## Quick start

**1. One-time setup** (from repo root; creates user, builds image, installs launch script):

```bash
./setup-podman.sh
```

This also creates a minimal `~idlehands/.idlehands/idlehands.json` (sets `gateway.mode="local"`) so the gateway can start without running the wizard.

By default the container is **not** installed as a systemd service, you start it manually (see below). For a production-style setup with auto-start and restarts, install it as a systemd Quadlet user service instead:

```bash
./setup-podman.sh --quadlet
```

(Or set `IDLEHANDS_PODMAN_QUADLET=1`; use `--container` to install only the container and launch script.)

**2. Start gateway** (manual, for quick smoke testing):

```bash
./scripts/run-idlehands-podman.sh launch
```

**3. Onboarding wizard** (e.g. to add channels or providers):

```bash
./scripts/run-idlehands-podman.sh launch setup
```

Then open `http://127.0.0.1:18789/` and use the token from `~idlehands/.idlehands/.env` (or the value printed by setup).

## Systemd (Quadlet, optional)

If you ran `./setup-podman.sh --quadlet` (or `IDLEHANDS_PODMAN_QUADLET=1`), a [Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) unit is installed so the gateway runs as a systemd user service for the idlehands user. The service is enabled and started at the end of setup.

- **Start:** `sudo systemctl --machine idlehands@ --user start idlehands.service`
- **Stop:** `sudo systemctl --machine idlehands@ --user stop idlehands.service`
- **Status:** `sudo systemctl --machine idlehands@ --user status idlehands.service`
- **Logs:** `sudo journalctl --machine idlehands@ --user -u idlehands.service -f`

The quadlet file lives at `~idlehands/.config/containers/systemd/idlehands.container`. To change ports or env, edit that file (or the `.env` it sources), then `sudo systemctl --machine idlehands@ --user daemon-reload` and restart the service. On boot, the service starts automatically if lingering is enabled for idlehands (setup does this when loginctl is available).

To add quadlet **after** an initial setup that did not use it, re-run: `./setup-podman.sh --quadlet`.

## The idlehands user (non-login)

`setup-podman.sh` creates a dedicated system user `idlehands`:

- **Shell:** `nologin` — no interactive login; reduces attack surface.
- **Home:** e.g. `/home/idlehands` — holds `~/.idlehands` (config, workspace) and the launch script `run-idlehands-podman.sh`.
- **Rootless Podman:** The user must have a **subuid** and **subgid** range. Many distros assign these automatically when the user is created. If setup prints a warning, add lines to `/etc/subuid` and `/etc/subgid`:

  ```text
  idlehands:100000:65536
  ```

  Then start the gateway as that user (e.g. from cron or systemd):

  ```bash
  sudo -u idlehands /home/idlehands/run-idlehands-podman.sh
  sudo -u idlehands /home/idlehands/run-idlehands-podman.sh setup
  ```

- **Config:** Only `idlehands` and root can access `/home/idlehands/.idlehands`. To edit config: use the Control UI once the gateway is running, or `sudo -u idlehands $EDITOR /home/idlehands/.idlehands/idlehands.json`.

## Environment and config

- **Token:** Stored in `~idlehands/.idlehands/.env` as `IDLEHANDS_GATEWAY_TOKEN`. `setup-podman.sh` and `run-idlehands-podman.sh` generate it if missing (uses `openssl`, `python3`, or `od`).
- **Optional:** In that `.env` you can set provider keys (e.g. `GROQ_API_KEY`, `OLLAMA_API_KEY`) and other IdleHands env vars.
- **Host ports:** By default the script maps `18789` (gateway) and `18790` (bridge). Override the **host** port mapping with `IDLEHANDS_PODMAN_GATEWAY_HOST_PORT` and `IDLEHANDS_PODMAN_BRIDGE_HOST_PORT` when launching.
- **Gateway bind:** By default, `run-idlehands-podman.sh` starts the gateway with `--bind loopback` for safe local access. To expose on LAN, set `IDLEHANDS_GATEWAY_BIND=lan` and configure `gateway.controlUi.allowedOrigins` (or explicitly enable host-header fallback) in `idlehands.json`.
- **Paths:** Host config and workspace default to `~idlehands/.idlehands` and `~idlehands/.idlehands/workspace`. Override the host paths used by the launch script with `IDLEHANDS_CONFIG_DIR` and `IDLEHANDS_WORKSPACE_DIR`.

## Useful commands

- **Logs:** With quadlet: `sudo journalctl --machine idlehands@ --user -u idlehands.service -f`. With script: `sudo -u idlehands podman logs -f idlehands`
- **Stop:** With quadlet: `sudo systemctl --machine idlehands@ --user stop idlehands.service`. With script: `sudo -u idlehands podman stop idlehands`
- **Start again:** With quadlet: `sudo systemctl --machine idlehands@ --user start idlehands.service`. With script: re-run the launch script or `podman start idlehands`
- **Remove container:** `sudo -u idlehands podman rm -f idlehands` — config and workspace on the host are kept

## Troubleshooting

- **Permission denied (EACCES) on config or auth-profiles:** The container defaults to `--userns=keep-id` and runs as the same uid/gid as the host user running the script. Ensure your host `IDLEHANDS_CONFIG_DIR` and `IDLEHANDS_WORKSPACE_DIR` are owned by that user.
- **Gateway start blocked (missing `gateway.mode=local`):** Ensure `~idlehands/.idlehands/idlehands.json` exists and sets `gateway.mode="local"`. `setup-podman.sh` creates this file if missing.
- **Rootless Podman fails for user idlehands:** Check `/etc/subuid` and `/etc/subgid` contain a line for `idlehands` (e.g. `idlehands:100000:65536`). Add it if missing and restart.
- **Container name in use:** The launch script uses `podman run --replace`, so the existing container is replaced when you start again. To clean up manually: `podman rm -f idlehands`.
- **Script not found when running as idlehands:** Ensure `setup-podman.sh` was run so that `run-idlehands-podman.sh` is copied to idlehands’s home (e.g. `/home/idlehands/run-idlehands-podman.sh`).
- **Quadlet service not found or fails to start:** Run `sudo systemctl --machine idlehands@ --user daemon-reload` after editing the `.container` file. Quadlet requires cgroups v2: `podman info --format '{{.Host.CgroupsVersion}}'` should show `2`.

## Optional: run as your own user

To run the gateway as your normal user (no dedicated idlehands user): build the image, create `~/.idlehands/.env` with `IDLEHANDS_GATEWAY_TOKEN`, and run the container with `--userns=keep-id` and mounts to your `~/.idlehands`. The launch script is designed for the idlehands-user flow; for a single-user setup you can instead run the `podman run` command from the script manually, pointing config and workspace to your home. Recommended for most users: use `setup-podman.sh` and run as the idlehands user so config and process are isolated.
