# CLI Reference

From `idlehands --help`.

## Commands

| Command | Description |
|---|---|
| `setup` | Interactive first-run configuration wizard |
| `bot <telegram|discord>` | Start chat bot frontend |
| `hosts` / `backends` / `models` | Runtime orchestration management |
| `select --model <id>` | Switch active runtime model |
| `health` | Probe enabled hosts and models |
| `init` | Generate `.idlehands.md` project context |
| `upgrade` | Self-update from GitHub or npm |
| `rollback` | Restore previous version |
| `service [action]` | Manage bot background service |

## Flags

- `--endpoint URL`, `--model NAME`, `--dir PATH`
- `--max-tokens N`, `--context-window N`, `--i-know-what-im-doing`
- `--temperature F`, `--top-p F`
- `--timeout N`, `--max-iterations N`
- `--sys`, `--sys-eager`
- `--no-confirm` / `--yolo`, `--plan`, `--step`, `--lockdown`
- `--harness ID`
- `--context-file PATH`, `--no-context`, `--context-max-tokens N`
- `--compact-at F`
- `--fresh`, `--session NAME`, `--continue`, `--resume [NAME]`
- `--prompt, -p TEXT`
- `--output-format text|json|stream-json`
- `--fail-on-error`, `--diff-only`, `--one-shot`
- `--replay PATH`
- `--no-trifecta`, `--no-replay`, `--no-vault`, `--no-lens`, `--vault-mode active|passive|off`
- `--theme NAME`, `--vim`, `--no-tui`, `--color auto|always|never`
- `--dry-run`, `--quiet`, `--verbose`
- `--config PATH`, `--offline`, `--no-update-check`
- `--show-server-metrics`, `--no-server-metrics`
- `--slow-tg-tps-threshold N`, `--auto-detect-model-change`
- `--mcp PATH`, `--mcp-tool-budget N`, `--mcp-call-timeout-sec N`
- `--help, -h`, `--version, -v`

::: tip
For exhaustive examples, pair this page with [Commands](/reference/commands) and [Configuration](/reference/config).
:::
