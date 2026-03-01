---
summary: "Uninstall IdleHands completely (CLI, service, state, workspace)"
read_when:
  - You want to remove IdleHands from a machine
  - The gateway service is still running after uninstall
title: "Uninstall"
---

# Uninstall

Two paths:

- **Easy path** if `idlehands` is still installed.
- **Manual service removal** if the CLI is gone but the service is still running.

## Easy path (CLI still installed)

Recommended: use the built-in uninstaller:

```bash
idlehands uninstall
```

Non-interactive (automation / npx):

```bash
idlehands uninstall --all --yes --non-interactive
npx -y idlehands uninstall --all --yes --non-interactive
```

Manual steps (same result):

1. Stop the gateway service:

```bash
idlehands gateway stop
```

2. Uninstall the gateway service (launchd/systemd/schtasks):

```bash
idlehands gateway uninstall
```

3. Delete state + config:

```bash
rm -rf "${IDLEHANDS_STATE_DIR:-$HOME/.idlehands}"
```

If you set `IDLEHANDS_CONFIG_PATH` to a custom location outside the state dir, delete that file too.

4. Delete your workspace (optional, removes agent files):

```bash
rm -rf ~/.idlehands/workspace
```

5. Remove the CLI install (pick the one you used):

```bash
npm rm -g idlehands
pnpm remove -g idlehands
bun remove -g idlehands
```

6. If you installed the macOS app:

```bash
rm -rf /Applications/IdleHands.app
```

Notes:

- If you used profiles (`--profile` / `IDLEHANDS_PROFILE`), repeat step 3 for each state dir (defaults are `~/.idlehands-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Manual service removal (CLI not installed)

Use this if the gateway service keeps running but `idlehands` is missing.

### macOS (launchd)

Default label is `ai.idlehands.gateway` (or `ai.idlehands.<profile>`; legacy `com.idlehands.*` may still exist):

```bash
launchctl bootout gui/$UID/ai.idlehands.gateway
rm -f ~/Library/LaunchAgents/ai.idlehands.gateway.plist
```

If you used a profile, replace the label and plist name with `ai.idlehands.<profile>`. Remove any legacy `com.idlehands.*` plists if present.

### Linux (systemd user unit)

Default unit name is `idlehands-gateway.service` (or `idlehands-gateway-<profile>.service`):

```bash
systemctl --user disable --now idlehands-gateway.service
rm -f ~/.config/systemd/user/idlehands-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `IdleHands Gateway` (or `IdleHands Gateway (<profile>)`).
The task script lives under your state dir.

```powershell
schtasks /Delete /F /TN "IdleHands Gateway"
Remove-Item -Force "$env:USERPROFILE\.idlehands\gateway.cmd"
```

If you used a profile, delete the matching task name and `~\.idlehands-<profile>\gateway.cmd`.

## Normal install vs source checkout

### Normal install (install.sh / npm / pnpm / bun)

If you used `https://idlehands.ai/install.sh` or `install.ps1`, the CLI was installed with `npm install -g idlehands@latest`.
Remove it with `npm rm -g idlehands` (or `pnpm remove -g` / `bun remove -g` if you installed that way).

### Source checkout (git clone)

If you run from a repo checkout (`git clone` + `idlehands ...` / `bun run idlehands ...`):

1. Uninstall the gateway service **before** deleting the repo (use the easy path above or manual service removal).
2. Delete the repo directory.
3. Remove state + workspace as shown above.
