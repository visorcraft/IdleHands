# Changelog

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
