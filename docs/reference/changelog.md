# Changelog

## 1.3.4 (2026-02-23)

### Tool loop auto-continue

- When the agent hits a critical tool loop, all surfaces (TUI, Telegram, Discord, Anton) now automatically retry instead of stopping.
- Each retry sends a user-visible notification with error details and attempt count (e.g. "retry 1 of 5").
- Configurable via `tool_loop_auto_continue.enabled` (default `true`) and `tool_loop_auto_continue.max_retries` (default `5`, range 1–10).
- Anton handles tool-loop retries internally without orchestrator involvement, reporting via `onToolLoop` callback.
- After exhausting all retries, the error surfaces normally.

### Vault: automatic turn action summaries

- After every tool-using turn, a structured action summary is now automatically persisted to the Vault.
- Each summary includes: the user's request, every tool action taken (human-readable), and the assistant's final response.
- Summaries are stored as `system`-kind vault entries keyed by ask ID, using `upsertNote` to avoid duplicates.
- Enables `vault_search` to recall prior actions even after context compaction — particularly valuable for local models with limited context windows.
- Best-effort only: summary persistence never blocks or delays ask completion.

## 1.1.17 (2026-02-22)

### Bug fixes

- **Read loop threshold increased**: `read_file`, `read_files`, `list_dir` now allow up to 6 consecutive identical calls before hard break (up from 4).
- **Stronger 4x warning**: "DO NOT make another identical call for this file, it HAS NOT CHANGED. Move on to the NEXT step NOW."
- **Read cache reuse**: Cached output reused from 2nd call onward to prevent context explosion.

## 1.1.16 (2026-02-22)

### Bug fixes

- **Multi-repo candidate auto-allow**: When multiple repo candidates are detected but cwd matches one of them, mutations now proceed automatically.
- **Exec outside-cwd respects approval mode**: `yolo` and `auto-edit` modes allow outside-cwd paths with warning; other modes still block.
- **Pre-break read warnings**: Explicit warning injected at 3rd consecutive identical read before hard break at 4x.
- **CI stabilization**: Sub-agent failure-reason assertion now accepts either max-iterations or loop-guard failure wording to avoid brittle CI failures.

### Improvements

- **Telegram code block detection**: Auto-wrap JSON (single-line or multi-line) in code blocks without requiring markdown fences.
- **Read-only exec detection expanded**: Added `git blame`, `git remote`, `git config --get`, `file`, `which`, `type`, `uname`, `env`, `printenv`, `id`, `whoami`, `pwd`.

## 1.1.14 (2026-02-21)

### Test fix

- Added `upsertNote` to test vault mocks to match new vault API.

## 1.1.13 (2026-02-21)

### Bug fix

- **Vault: preserve user prompt before compaction** — The last substantive user prompt is now stored in the vault before compaction occurs. This ensures the original task survives context loss when messages are dropped during compaction.

## 1.1.12 (2026-02-21)

### Model catalog

- New `idlehands models` commands for model discovery and metadata:
  - `scan` — scan directories for GGUF, HuggingFace, and safetensors models
  - `list` — list cataloged models with filtering
  - `info` — show detailed model metadata (params, MoE, capabilities)
  - `where` — show model file paths
  - `verify` — verify model files are readable
  - `tags` — manage model tags
  - `discover` — discover running model servers across hosts
- Deep metadata extraction:
  - MoE active parameter estimation
  - Vision/tools/audio capability detection
  - Architecture details (layers, hidden size, attention heads)
  - Context length and vocab size
- Remote host scanning via `--host <id>` for SSH hosts
- Smart catalog caching with mtime-based validation

### Encrypted secrets

- New `idlehands secrets` commands for encrypted-at-rest secret storage:
  - `init` — initialize encrypted store with passphrase
  - `unlock`/`lock` — manage session unlock state
  - `set`/`get`/`delete` — store and retrieve secrets
  - `list` — list stored secret IDs
  - `rotate-passphrase` — change encryption passphrase
- AES-256-GCM envelope encryption
- Argon2id or scrypt key derivation (auto-selects best available)
- Auto-locking TTL (10 minutes default)
- Secret reference syntax: `secret://<id>` for transparent resolution
- SSH key materialization: automatically converts `secret://` refs to temp files
- Automatic redaction of secret values in exec output

## 1.1.10 (2026-02-21)

### Bug fixes

- Anton controller now stops in-flight runs promptly on `/cancel`.
- Session expiry logic hardened to prevent stale sessions from lingering.

## 1.1.9 (2026-02-21)

### Runtime reliability + discovery

- `idlehands select` reuse plans now include explicit health probe steps.
- `idlehands select --force` and `idlehands select --restart` force restart planning.
- Reuse probe failures now auto-fallback to forced restart.
- Backend `verify_cmd` is run whenever a backend is selected.
- SSH plan execution now uses `BatchMode`, explicit connect timeout, and remote `bash -lc`.

### Health command

- Added **Loaded (discovered)** output section in `idlehands health`.
- Discovery probes `/v1/models` with `/health` fallback and classifies `ready/loading/down/unknown`.
- Added `--scan-ports` for custom discovery ports:
  - range (`8000-8100`)
  - list (`8080,8081,9000`)
  - single port (`8080`)

### Client fix

- Streaming usage counters now include usage-only SSE chunks (`choices=[]`), improving status/usage accuracy.

## 1.1.8 (2026-02-21)

### Progress rendering

- Added shared `ProgressMessageRenderer` that produces a platform-agnostic intermediate representation (IR).
- Added three IR serializers:
  - `renderTelegramHtml()` for Telegram HTML output
  - `renderDiscordMarkdown()` for Discord markdown output
  - `renderTuiLines()` for TUI plain text display
- All three frontends (TUI, Telegram, Discord) now use the same rendering logic for consistent progress updates.

### Internal

- Simplified progress message rendering with banner → status → tools → tail → assistant flow.
- Removed redundant renderer options (`toolLinesAsCode`, `showStatusAlways`, `showStatusWhenEmpty`).

## Unreleased

### New tools

- `apply_patch` — apply unified diff patches across multiple files.
- `edit_range` — replace a line range (`start_line..end_line`) in one file.

### Context + token behavior

- `read_file` now defaults to bounded output when `limit` is omitted.
  - default `limit=200`
  - default `max_bytes=20000` (validated range `256..262144`)
  - supports `format=plain|numbered|sparse`
- `apply_patch` now validates touched files against declared `files[]` and performs dry-run checks before apply (`git apply --check` or `patch --dry-run`).
- `edit_range` now preserves file EOL style and supports clean line-range deletions with empty replacement.
- Project context now summarizes oversized files by default (instead of failing), with retrieval guidance.

### New config flags

- `context_summarize` (default `true`)
- `context_summary_max_tokens` (default `1024`)

---

For full release history in Git, see the repository `CHANGELOG.md`.
