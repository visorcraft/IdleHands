# Features Deep Dive

## Trifecta: Vault + Replay + Lens

Trifecta is the integrated subsystem that gives Idle Hands durable memory,
checkpoint-based recovery, and context shaping.

- **Vault**: persistent memory and notes (`/vault`, `/note`, `/notes`), plus automatic turn action summaries
- **Replay**: checkpoints and rewind/diff/undo (`/checkpoints`, `/rewind`, `/diff`, `/undo`)
- **Lens**: structural analysis/projection for compact context handling

Runtime controls:

- `--no-trifecta`
- `--no-vault`
- `--no-lens`
- `--no-replay`
- `--vault-mode active|passive|off`

See full behavior and setup: [Guide → Trifecta](/guide/trifecta)

## Themes

Built-in themes:
- `default`, `dark`, `light`, `minimal`, `hacker`

Custom themes:
- `~/.config/idlehands/themes/<name>.json`

## MCP integration

Configure in config or pass ad-hoc with `--mcp <file>`.

Commands:
- `/mcp`, `/mcp desc`, `/mcp restart <name>`, `/mcp enable <tool>`, `/mcp disable <tool>`

## LSP integration

- Configure servers in `lsp.servers`
- Use `/lsp` for status
- Supports proactive diagnostics

## Token-efficient editing + reads

Recent defaults focus on reducing context blowups in long coding sessions:

- `read_file` now defaults to bounded output (`limit=200` when omitted) and supports `format=plain|numbered|sparse`.
- `read_file` supports bounded byte output via `max_bytes` (default `20000`; validated range `256..262144`).
- New mutation tools:
  - `apply_patch` for unified diff application across files, with touched-file validation and `git apply --check`/`patch --dry-run` safety checks.
  - `edit_range` for line-range replacement in one file (including clean deletions with empty replacement).
- Live history stores compact tool-output digests while full raw output is archived in Vault (when enabled).

## Automatic turn summaries

When the agent completes a turn that involved tool calls, a structured action summary is automatically persisted to the Vault. Each summary captures:

- The user's request (truncated to 120 characters)
- Every tool action in the turn (using human-readable descriptions like `run: npm test`, `edit src/app.ts lines 10-20`)
- The assistant's final response (truncated to 200 characters)

This gives the model durable self-knowledge — it can use `vault_search` to recall what it did in previous turns, even after context compaction has dropped the original messages. Particularly useful for local models with smaller context windows where earlier conversation turns are lost.

Summaries are stored as `system`-kind vault entries keyed by ask ID and managed via `upsertNote`, so repeated asks update rather than duplicate.

## Shared progress rendering

Idle Hands uses a platform-agnostic progress message renderer across all UIs:

- **IR-based rendering**: `ProgressMessageRenderer` produces an intermediate representation (IR) that serializers convert to platform-specific formats.
- **Telegram HTML**: `renderTelegramHtml()` — compact HTML with tool summaries and live tails.
- **Discord Markdown**: `renderDiscordMarkdown()` — Discord-compatible markdown with code blocks.
- **TUI text**: `renderTuiLines()` — plain text lines for terminal status display.

All three frontends (TUI, Telegram, Discord) share the same rendering logic, ensuring consistent progress updates across platforms.

## Capture + replay

::: code-group
```bash [Capture in session]
/capture on captures/myrun.jsonl
/capture off
```

```bash [Replay from CLI]
idlehands --endpoint http://127.0.0.1:8080/v1 --replay captures/myrun.jsonl
```
:::

## Vim mode

- Start with `--vim`
- Toggle with `/vim`
- Includes normal/insert editing behavior in prompt input

## Custom commands and templates

Custom markdown commands:
- Global: `~/.config/idlehands/commands/*.md`
- Project: `.idlehands/commands/*.md`

Reload/list with `/commands`.

Built-in templates:
- `/fix`, `/review`, `/test`, `/explain`, `/refactor`
