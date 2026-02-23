# Changelog

All notable changes to Idle Hands are documented in this file.

## [1.1.17] - 2026-02-22

### Fixed

- **Read loop threshold increased**: `read_file`, `read_files`, `list_dir` now allow up to 6 consecutive identical calls (up from 4) before hard break.
- **Stronger 4x warning**: At 4th consecutive call, model receives "DO NOT make another identical call for this file, it HAS NOT CHANGED. Move on to the NEXT step NOW."
- **Read cache reuse**: From 2nd call onward, cached output is reused to avoid context bloat while still allowing the model to continue.
- **Git operations cwd fix**: Git functions now call `git` directly via `spawnSync` instead of spawning `bash -c`, fixing cwd issues under Node test runner where login shell would reset working directory to process.cwd().

## [1.1.16] - 2026-02-22

### Fixed

- **Multi-repo candidate auto-allow**: When `requireDirPinForMutations` is true but cwd matches one of the repo candidates, mutations now proceed automatically instead of blocking.
- **Exec outside-cwd respects approval mode**: In `yolo` or `auto-edit` modes, commands targeting paths outside cwd are allowed with a warning instead of blocked. Plan/reject/default modes still block.
- **Pre-break read warnings**: At 3rd consecutive identical read_file/read_files/list_dir call, an explicit warning message is injected before the hard break at 4x.
- **Telegram code block auto-detection**: JSON objects/arrays (single-line or multi-line) are now automatically wrapped in code blocks even without markdown fences.
- **CI stabilization**: Relaxed brittle sub-agent failure-reason assertion to accept both max-iterations and loop-guard failure paths, preventing false CI failures.

### Added

- Expanded read-only exec command detection: `git blame`, `git remote`, `git config --get`, `file`, `which`, `type`, `uname`, `env`, `printenv`, `id`, `whoami`, `pwd`.

## [1.1.14] - 2026-02-21

### Fixed

- **Test fix**: Added `upsertNote` to test vault mocks to match new vault API.

## [1.1.13] - 2026-02-21

### Fixed

- **Vault: preserve user prompt before compaction** — Before compacting history, the last substantive user prompt is now stored in the vault with key `current_task`. This ensures the original task/instruction survives context loss when messages are dropped during compaction. Previously, after compaction the model would lose track of what it was supposed to be doing.

## [1.1.12] - 2026-02-21

### Added

- **Model catalog management system**:
  - `idlehands models scan` — scan directories for GGUF, HuggingFace, and safetensors models
  - `idlehands models list` — list cataloged models with filtering (`--filter vision=true`)
  - `idlehands models info <id>` — show detailed model metadata
  - `idlehands models where <id>` — show model file paths
  - `idlehands models verify <id>` — verify model files are readable
  - `idlehands models tags <id> add|remove <tag>` — manage model tags
  - `idlehands models discover` — discover running servers across hosts
  - Remote host scanning via `--host <id>` for SSH hosts
  - Deep metadata extraction: MoE params, vision/tools/audio capabilities, architecture details
  - Smart catalog caching with mtime validation

- **Encrypted secrets management**:
  - `idlehands secrets init` — initialize encrypted secrets store with passphrase
  - `idlehands secrets unlock` — unlock secrets store for current session
  - `idlehands secrets lock` — manually lock secrets store
  - `idlehands secrets set <id>` — store encrypted secret
  - `idlehands secrets get <id>` — retrieve secret value
  - `idlehands secrets delete <id>` — delete secret
  - `idlehands secrets list` — list stored secret IDs
  - `idlehands secrets rotate-passphrase` — change encryption passphrase
  - AES-256-GCM encryption with Argon2id/scrypt key derivation
  - Auto-locking TTL (10 minutes default)
  - Secret reference syntax: `secret://<id>` for SSH keys, passwords, tokens
  - Automatic redaction of secret values in exec output
  - Temp file materialization for SSH key references

## [1.1.10] - 2026-02-21

### Fixed

- Anton controller now stops in-flight runs promptly on `/cancel` and prevents stale session expiry.
- Session manager and bot commands updated to handle cancellation signals correctly.

## [1.1.9] - 2026-02-21

### Added

- Runtime health discovery output:
  - `idlehands health` now shows a **Loaded (discovered)** section per host.
  - Probes `/v1/models` with `/health` fallback.
  - Classifies discovered endpoints as `ready`, `loading` (503), `down`, or `unknown`.
  - Supports custom port selection with `--scan-ports` (`range`, `list`, or single port).

### Changed

- Runtime selection reliability:
  - reuse plans now include explicit probe step(s) instead of empty execution.
  - `idlehands select --force` and `idlehands select --restart` force restart planning.
  - failed reuse probe auto-falls back to forced restart.
  - backend `verify_cmd` now runs whenever a backend is selected.
- SSH runtime execution now uses `BatchMode`, `ConnectTimeout`, and remote `bash -lc` for deterministic behavior.
- `select` step rendering now includes trimmed failure details for faster diagnosis.

### Fixed

- Streaming usage telemetry now captures usage-only SSE chunks (`choices=[]`) so status/usage counters remain accurate.

## [1.1.8] - 2026-02-21

### Added

- Shared progress message rendering system:
  - `ProgressMessageRenderer` produces a platform-agnostic IR for progress updates.
  - `renderTelegramHtml()` serializes IR to Telegram HTML.
  - `renderDiscordMarkdown()` serializes IR to Discord markdown.
  - `renderTuiLines()` serializes IR to TUI plain text lines.
- All three frontends (TUI, Telegram, Discord) now share the same rendering logic.

### Changed

- Simplified progress renderer to use banner → status → tools → tail → assistant flow.
- Removed redundant renderer configuration options.

## [Unreleased]

### Added

- New built-in editing tools:
  - `apply_patch` — apply unified diff patches across one or more files.
  - `edit_range` — replace an inclusive line range in a file.
- New project-context config flags:
  - `context_summarize` (default: `true`) — summarize oversized context files instead of failing.
  - `context_summary_max_tokens` (default: `1024`) — target budget for summarized context.

### Changed

- `read_file`/`read_files`/`list_dir` tool guidance now explicitly tells models not to repeat identical back-to-back calls; runtime loop handling now blocks these duplicate consecutive calls on the second attempt (also guarding `list_dirs` alias).
- `read_file` now uses safe bounded defaults when arguments are omitted:
  - default `limit=200`
  - default `max_bytes=20000` (validated range `256..262144`)
  - supports `format=plain|numbered|sparse`
- `apply_patch` now validates touched files against declared `files[]` and runs dry-run checks before apply (`git apply --check` or `patch --dry-run`).
- `edit_range` now preserves file EOL style and supports clean line-range deletions with empty replacement.
- Tool schemas were compacted to reduce per-request prompt overhead.
- Oversized project context now defaults to summary injection with retrieval hints, instead of immediate hard failure.

### Fixed

- `edit_range` now rejects likely double-escaped replacements (literal `\\n` with no real newlines) and returns guidance to resend with real multiline text.
- `write_file` now refuses to overwrite existing non-empty files unless `overwrite=true` (or `force=true`) is explicitly provided.
- Agent auto-recovery now compacts and retries when `/chat/completions` returns 400/413 context-window overflow errors (e.g. `request (...) exceeds the available context size (...)`). After compaction, it re-anchors with the most recent user objective; when Vault is active it reminds the model to use `vault_search(...)`, and in passive mode it notes that relevant entries may be auto-injected.

### Internal

- Tool outputs are now proactively digested in live history while full output is archived to Vault (when available), reducing context growth during long runs.
