# Changelog

All notable changes to Idle Hands are documented in this file.

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

- `read_file` now uses safe bounded defaults when arguments are omitted:
  - default `limit=200`
  - default `max_bytes=20000` (validated range `256..262144`)
  - supports `format=plain|numbered|sparse`
- `apply_patch` now validates touched files against declared `files[]` and runs dry-run checks before apply (`git apply --check` or `patch --dry-run`).
- `edit_range` now preserves file EOL style and supports clean line-range deletions with empty replacement.
- Tool schemas were compacted to reduce per-request prompt overhead.
- Oversized project context now defaults to summary injection with retrieval hints, instead of immediate hard failure.

### Internal

- Tool outputs are now proactively digested in live history while full output is archived to Vault (when available), reducing context growth during long runs.
