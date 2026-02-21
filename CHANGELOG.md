# Changelog

All notable changes to Idle Hands are documented in this file.

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
