# Setup Wizard

Run the setup wizard:

```bash
idlehands setup
```

::: tip First-run shortcut
If no config file exists, running `idlehands` starts setup automatically.
:::

The wizard is designed to get you from zero to a working session in a few minutes.

## Step 1 of 5 — Runtime

Define how Idle Hands reaches your model runtime:

- **Hosts**: where inference runs (local or SSH)
- **Backends**: compute layer + env/args (CUDA, ROCm, Vulkan, CPU, custom)
- **Models**: model source + launch/probe commands

Template variables available in launch/probe commands:

- `{source}`
- `{port}`
- `{backend_env}`
- `{backend_args}`
- `{host}`

After saving, setup can launch and health-check the selected runtime.

## Step 2 of 5 — Working directory

Choose the default directory Idle Hands can read/write.

You can override later with:

- CLI: `--dir`
- Session command: `/dir`

## Step 3 of 5 — Approval mode

Choose your default operation posture:

- `plan` — plan only, no mutations
- `reject` — non-interactive safe mode for mutating actions
- `default` — confirm before risky actions
- `auto-edit` — day-to-day coding flow with safeguards
- `yolo` — no confirmations

## Step 4 of 5 — Theme

Built-in themes:

- `default`
- `dark`
- `light`
- `minimal`
- `hacker`

## Step 5 of 5 — Bot setup (optional)

Configure Telegram and/or Discord, or skip.

The wizard can also install a **systemd user service** for bot mode.

At the end, setup writes `~/.config/idlehands/config.json` and can launch a session immediately.

## Re-running setup

You can safely run setup any time:

```bash
idlehands setup
```

Existing values are prefilled, and unknown/custom keys in config are preserved.
