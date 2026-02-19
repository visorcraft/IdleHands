# Trifecta — Vault + Lens + Replay

Status: **DONE** — all Trifecta phases complete.

## Phase 5a — Replay (checkpoints + rewind) — no deps
- [x] `src/replay.ts` — ReplayStore class (~150 lines)
- [x] Wire into tools.ts: checkpoint on write_file/edit_file/insert_file (capture previous content + sha256)
- [x] Wire into agent.ts: pass ReplayStore to ToolContext, expose on AgentSession
- [x] REPL commands: `/checkpoints`, `/rewind <id>`, `/diff <id>`

## Phase 5b — Vault (native SQLite + FTS5)
- [x] `src/vault.ts` — native SQLite (`node:sqlite`) with FTS5 at `~/.local/state/idlehands/vault.db`
- [x] Active mode: add `vault_search` + `vault_note` tool schemas when harness says active
- [x] Passive mode: auto-inject relevant vault entries after context compaction
- [x] Eviction pipeline: archive tool results to vault BEFORE dropping from history
- [x] REPL commands: `/vault <query>`, `/notes`, `/note <key> <value>`
- [x] DB path: `~/.local/state/idlehands/vault.db`, auto-save, corruption recovery

## Phase 5c — Lens (tree-sitter skeleton extraction)
- [x] `src/lens.ts` — tree-sitter loader + skeleton extractor + fallback chain (~250 lines)
- [x] Enhance `read_file`: return skeleton on full-file reads, raw on offset/search reads
- [x] Fallback compressors: JSON keys, YAML top-level, Markdown headings

## Phase 5d — Synergy
- [x] Lens→Vault: compress to skeleton before archiving
- [x] Replay→Vault: archive failed branches as searchable notes
- [x] Lens→Replay: structural diff summaries in checkpoint notes

## Phase 5e — Config + harness integration
- [x] `trifecta` config block in types.ts
- [x] CLI flags: `--no-vault`, `--no-lens`, `--no-replay`, `--no-trifecta`, `--vault-mode=active|passive|off`
- [x] Harness profiles: vault mode per model family
- [x] System prompt append for active vault mode only
- [x] Startup health logging

## Phase 5f — Degradation
- [x] Each subsystem wrapped in try/catch
- [x] Vault corruption: rename corrupt DB, recreate
- [x] Lens parse failure: null → raw fallback
- [x] Replay reversal: sha mismatch handling
