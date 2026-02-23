# Fullscreen TUI

Idle Hands starts in fullscreen TUI mode by default when a real TTY is available.

```bash
idlehands
```

Force classic CLI mode:

```bash
idlehands --no-tui
```

## What the TUI gives you

- deterministic layout with live status
- streaming assistant output
- slash commands and command discovery
- tool activity timeline (`start/end/error`, summary, duration)
- approval prompts and turn cancellation
- shell shortcuts (`!cmd`, `!!cmd`)
- session persistence to `~/.local/state/idlehands/`

## Terminal compatibility checks

On startup, Idle Hands checks:

- alt-screen support
- color support
- Unicode capability
- minimum size (10x40)
- environment constraints (tmux/screen/SSH)

If unsupported, it automatically falls back to classic CLI.

::: warning Non-TTY behavior
Piped/CI environments use classic CLI mode automatically.
:::

## Productivity tips

- Use `/status`, `/watchdog`, `/server`, `/perf` to keep runtime health visible.
- Use `/steps` (or `Ctrl+G`) to open the step navigator and jump across transcript history quickly.
- Use `/settings` (or `Ctrl+O`) for quick in-TUI adjustments (theme, approval mode, watchdog knobs).
- Use `/hooks [status|errors|slow|plugins]` to inspect hook plugins, event counts, and recent hook issues in an overlay.
- Use `/approval` to switch safety posture without restarting.
- Use `/compact` in long sessions to keep context efficient.
- Use `/new` when changing tasks/projects to avoid context bleed.

## Watchdog tuning

TUI uses the same top-level watchdog settings as bots:

```json
{
  "watchdog_timeout_ms": 180000,
  "watchdog_max_compactions": 4,
  "watchdog_idle_grace_timeouts": 2,
  "debug_abort_reason": true
}
```

If `debug_abort_reason` is true, watchdog/manual abort alerts include raw abort details (`[debug] ...`) instead of only `Cancelled.`.

## Keyboard basics

- `Ctrl+C` cancel active turn
- `Ctrl+D` exit
- `Ctrl+G` open step navigator (jump to any prior step)
- `Ctrl+O` open quick settings
- `Shift+Tab` cycle approval modes (TTY)
