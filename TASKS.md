# TASKS.md — Cleaned Backlog (IdleHands UX)

_Last cleaned: 2026-02-25_

This file is now the **practical backlog**, not the original RFC implementation script.

## ✅ Completed (removed from active backlog)

- Shared UX core modules landed (`src/bot/ux/*`) with tests.
- Routing policy + per-turn routing wired (`query classifier` + heuristic + fallback).
- `/routing_mode auto|fast|heavy|status` implemented across TUI/Telegram/Discord.
- Runtime-native routing integrated with `runtimes.json` (single source of truth).
- `/models` UX overhaul shipped for Telegram + Discord:
  - pagination,
  - numbered buttons,
  - active-model marker,
  - query filtering (`/models <query>`).
- Redundant `/rtmodels` alias removed (now `/models` only).

---

## 🎯 Active backlog (high-value, still relevant)

## 1) Progress lifecycle consistency
- [x] Standardize stage names emitted across long operations (`queued`, `planning`, `runtime_preflight`, `executing`, `verifying`, `complete`).
- [x] Ensure both Discord and Telegram surface the same stage transitions from shared UX events.
- [x] Add/refresh tests for stage ordering and heartbeat behavior.

## 2) Shared action dispatch hardening
- [ ] Consolidate interactive action handling into one shared dispatch path (platform adapters only).
- [ ] Ensure `retry_fast`, `retry_heavy`, and `cancel` are fully parity-tested in both bots.

## 3) Runtime health UX clarity
- [ ] Improve bot `/health` output to clearly separate:
  - configured targets,
  - discovered/running services,
  - readiness state (`down` / `loading` / `ready`).
- [ ] Add integration tests that validate rendering from `health --json` only.

## 4) Anton reliability follow-up
- [ ] Add/finish `/anton doctor` preflight diagnostics UX.
- [ ] Tighten stale-run recovery + attach/resume ergonomics.
- [ ] Add targeted tests for stale-run cleanup and failure classification paths.

---

## Guardrails (keep)

- Keep `runtimes.json` as the runtime/model source of truth.
- Avoid platform-specific UX logic duplication when shared modules can handle it.
- New user-facing behavior should include tests for both Telegram and Discord flows.
