# Fullscreen TUI

Idle Hands launches in fullscreen TUI mode by default when a TTY is detected.
Use `--no-tui` to force classic CLI mode.

```bash
idlehands
idlehands --no-tui
```

## Capabilities

- Fullscreen render loop with deterministic layout
- Streaming assistant output
- Slash command registry support
- Shell commands (`!cmd`) and shell-output injection (`!!cmd`)
- Tool approval prompts with remembered decisions
- Tool lifecycle timeline (`start/end/error`, summary, duration)
- Runtime status panel (model/host/backend/health)
- Cancel turn with `Ctrl+C`, quit with `Ctrl+D`
- Resize-safe redraw via `SIGWINCH`
- Input and transcript navigation (history, cursor movement, multiline compose, page scrolling)
- Session save on exit/crash to `~/.local/state/idlehands/`

## Terminal compatibility

On startup, the TUI probes:
- Alt screen support
- Color support (256-color / truecolor)
- Unicode environment
- Minimum terminal size (10 rows × 40 columns)
- tmux/screen/SSH environment details

If unsupported (like a `dumb` terminal or too-small window), Idle Hands falls back to classic CLI automatically.

::: warning Non-TTY behavior
Pipe/CI environments default to classic CLI mode.
:::

## Notes

- TUI and CLI share the same core session/agent/runtime paths.
- `--no-tui` remains an explicit escape hatch.
