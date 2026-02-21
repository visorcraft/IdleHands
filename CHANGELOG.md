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
  - default `limit=200` (max `240`)
  - default `max_bytes=20000`
  - supports `format=plain|numbered|sparse`
- Tool schemas were compacted to reduce per-request prompt overhead.
- Oversized project context now defaults to summary injection with retrieval hints, instead of immediate hard failure.

### Internal

- Tool outputs are now proactively digested in live history while full output is archived to Vault (when available), reducing context growth during long runs.
