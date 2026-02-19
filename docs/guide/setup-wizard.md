# Setup Wizard

Run the setup wizard:

```bash
idlehands setup
```

::: tip First-run shortcut
Running `idlehands` with no config file launches setup automatically.
:::

The wizard is a fullscreen TUI with five steps.

## Step 1 of 5 — Runtime

Configure:
- **Hosts**: machines that run inference (local or SSH)
- **Backends**: compute layers (Vulkan, CUDA, ROCm, CPU) with env vars and args
- **Models**: model source + launch/probe commands

Template variables used in runtime commands:
- `{source}`
- `{port}`
- `{backend_env}`
- `{backend_args}`
- `{host}`

After saving, setup launches the model and probes for health.

## Step 2 of 5 — Working directory

Choose where Idle Hands reads/writes files by default (overridable with `--dir` or `/dir`).

## Step 3 of 5 — Approval mode

Available modes:
- `plan`
- `default`
- `auto-edit`
- `yolo`

## Step 4 of 5 — Theme

Built-in themes:
- `default`
- `dark`
- `light`
- `minimal`
- `hacker`

## Step 5 of 5 — Bot setup

Set up:
- Telegram bot
- Discord bot
- Or skip bots

Configured bots can be edited later. The wizard can also install a **systemd user service** to run bot frontends in the background.

After confirmation, setup writes `~/.config/idlehands/config.json` and can launch a session.

## Re-running setup

Run setup any time to modify existing values:

```bash
idlehands setup
```

Existing entries are pre-populated, and manually added keys are preserved.
