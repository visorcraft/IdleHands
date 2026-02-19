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

- Use `/status`, `/server`, `/perf` to keep runtime health visible.
- Use `/approval` to switch safety posture without restarting.
- Use `/compact` in long sessions to keep context efficient.
- Use `/new` when changing tasks/projects to avoid context bleed.

## Keyboard basics

- `Ctrl+C` cancel active turn
- `Ctrl+D` exit
- `Shift+Tab` cycle approval modes (TTY)
