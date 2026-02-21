# CLI Reference

This page mirrors `idlehands --help` and highlights the most-used entry points.

## Core commands

| Command | Description |
|---|---|
| `setup` | Interactive configuration wizard |
| `bot <telegram\|discord>` | Start bot frontend |
| `hosts` / `backends` / `models` | Runtime orchestration management |
| `select --model <id>` | Activate a runtime model (supports `--restart` / `--force`) |
| `health` | Probe enabled hosts/models + discovered loaded runtimes (`--scan-ports`) |
| `init` | Generate `.idlehands.md` project context |
| `upgrade` | Self-update from configured install source |
| `rollback` | Restore previous version |
| `service [action]` | Manage bot background service |

## High-value flags

### Session targeting

- `--dir PATH`
- `--session NAME`
- `--resume [NAME]`
- `--continue`
- `--fresh`

### Execution behavior

- `--approval-mode plan|reject|default|auto-edit|yolo`
- `--no-confirm` (alias for yolo behavior)
- `--step`
- `--lockdown`

### Output + automation

- `--one-shot`
- `--prompt, -p TEXT`
- `--output-format text|json|stream-json`
- `--fail-on-error`
- `--diff-only`

### Runtime/model controls

- `--endpoint URL`
- `--model NAME`
- `--context-window N`
- `--max-tokens N`

### Trifecta controls

- `--no-trifecta`
- `--no-vault`
- `--no-lens`
- `--no-replay`
- `--vault-mode active|passive|off`

### Misc

- `--no-tui`
- `--offline`
- `--config PATH`
- `--help`, `--version`

## Minimal examples

```bash
# interactive
idlehands

# one-shot task
idlehands --one-shot -p "run tests and fix straightforward failures"

# specific project + safe approval mode
idlehands --dir ~/projects/app --approval-mode default

# CI-style JSON output
idlehands --one-shot --output-format json --fail-on-error -p "lint and summarize"

# force a runtime restart
idlehands select --model llama70b --restart

# discover loaded model servers on custom ports
idlehands health --scan-ports 8000-8100
```

::: tip
For full command behavior and slash-command details, pair this page with:
- [Commands](/reference/commands)
- [Configuration](/reference/config)
- [Safety](/reference/safety)
:::
