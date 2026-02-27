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

## 2) Shared action dispatch hardening (one-shot sized)
- [ ] **2.1 Wire Telegram callbacks through shared dispatcher**
  - **Target files/modules:** `src/bot/telegram.ts`, `src/bot/ux/action-dispatcher.ts`.
  - **Required behavior changes:** Telegram interactive paths for `retry_fast`, `retry_heavy`, and `cancel` must call shared dispatcher entrypoints (no Telegram-only business logic branches).
  - **Exact tests to pass/add:** update/add Telegram action dispatch test in `tests/telegram*.test.ts` (or existing bot test file) covering all 3 actions.
  - **Done when:** Telegram action handlers for all 3 actions route through shared dispatcher and Telegram action test is green.

- [ ] **2.2 Wire Discord callbacks through shared dispatcher**
  - **Target files/modules:** `src/bot/discord.ts`, `src/bot/ux/action-dispatcher.ts`.
  - **Required behavior changes:** Discord interactive paths for `retry_fast`, `retry_heavy`, and `cancel` must call shared dispatcher entrypoints (no Discord-only business logic branches).
  - **Exact tests to pass/add:** update/add Discord action dispatch test in `tests/discord*.test.ts` (or existing bot test file) covering all 3 actions.
  - **Done when:** Discord action handlers for all 3 actions route through shared dispatcher and Discord action test is green.

- [ ] **2.3 Add explicit cross-platform parity assertions for retry/cancel trio**
  - **Target files/modules:** `tests/telegram*.test.ts`, `tests/discord*.test.ts`, optionally shared helper in `tests/*bot*.test.ts`.
  - **Required behavior changes:** assert equivalent semantics for `retry_fast`, `retry_heavy`, `cancel` (same intent/outcome class, equivalent errors/acks) between Telegram and Discord.
  - **Exact tests to pass/add:** parity-focused tests for each action in both platform suites.
  - **Done when:** parity tests for all 3 actions pass in both suites.

## 3) Runtime health UX clarity (one-shot sized)
- [ ] **3.1 Add shared health section formatter for configured/discovered/readiness**
  - **Target files/modules:** shared health formatting helper (or `src/cli/runtime-cmds.ts` if helper already lives there), plus one bot renderer file.
  - **Required behavior changes:** formatter must produce 3 explicit sections: configured targets, discovered/running services, readiness (`down|loading|ready`).
  - **Exact tests to pass/add:** formatter unit test(s) in `tests/*health*.test.ts` with fixture input/output.
  - **Done when:** formatter test passes and emitted structure has all 3 sections.

- [ ] **3.2 Apply shared health formatter to Telegram renderer**
  - **Target files/modules:** `src/bot/telegram-commands.ts` + shared formatter module.
  - **Required behavior changes:** Telegram `/health` rendering must consume structured health JSON and render only via shared formatter.
  - **Exact tests to pass/add:** Telegram health rendering test using canned `health --json` fixture in `tests/*health*.test.ts`.
  - **Done when:** Telegram test passes with no ad-hoc probing assumptions.

- [ ] **3.3 Apply shared health formatter to Discord renderer**
  - **Target files/modules:** `src/bot/discord-commands.ts` + shared formatter module.
  - **Required behavior changes:** Discord `/health` rendering must consume structured health JSON and render only via shared formatter.
  - **Exact tests to pass/add:** Discord health rendering test using canned `health --json` fixture in `tests/*health*.test.ts`.
  - **Done when:** Discord test passes with no live probing dependencies.

## 4) Anton reliability follow-up (one-shot sized)
- [ ] **4.1 Implement `/anton doctor` core diagnostic report builder**
  - **Target files/modules:** `src/anton/runtime-ready.ts`, `src/anton/controller.ts`.
  - **Required behavior changes:** produce actionable doctor report fields for runtime reachability, lock state, task-file validity, and model readiness.
  - **Exact tests to pass/add:** doctor report builder tests in `tests/anton-controller.test.ts` (or nearest doctor-focused suite).
  - **Done when:** doctor report test covers pass/fail variants and passes.

- [ ] **4.2 Expose `/anton doctor` in Telegram command surface**
  - **Target files/modules:** `src/bot/telegram-commands.ts`.
  - **Required behavior changes:** command invokes doctor builder and returns actionable pass/fail guidance text.
  - **Exact tests to pass/add:** Telegram command logic test in `tests/anton-command-logic.test.ts`.
  - **Done when:** Telegram doctor command test passes.

- [ ] **4.3 Expose `/anton doctor` in Discord command surface**
  - **Target files/modules:** `src/bot/discord-commands.ts`.
  - **Required behavior changes:** command invokes doctor builder and returns actionable pass/fail guidance text.
  - **Exact tests to pass/add:** Discord command logic test in `tests/anton-command-logic.test.ts` or Discord command suite.
  - **Done when:** Discord doctor command test passes.

- [ ] **4.4 Harden stale-lock cleanup classification**
  - **Target files/modules:** `src/anton/lock.ts`, `src/anton/controller.ts`.
  - **Required behavior changes:** stale lock classification must deterministically identify recoverable vs fatal lock states and choose cleanup path accordingly.
  - **Exact tests to pass/add:** stale lock tests in `tests/anton-lock.test.ts` + controller recovery path in `tests/anton-controller.test.ts`.
  - **Done when:** stale lock classification and cleanup tests pass.

- [ ] **4.5 Stabilize attach/resume behavior for stale/active runs**
  - **Target files/modules:** `src/anton/controller.ts` and attach/resume command wiring.
  - **Required behavior changes:** attach/resume must provide deterministic behavior/messages for active run, stale run, and no-run states.
  - **Exact tests to pass/add:** attach/resume flow tests in `tests/anton-controller.test.ts`.
  - **Done when:** attach/resume tests pass for all 3 states.

- [ ] **4.6 Tighten failure-category mapping in Anton verify/controller path**
  - **Target files/modules:** `src/anton/controller.ts`, `src/anton/verifier.ts`.
  - **Required behavior changes:** map infra timeout/tool-loop/prompt-budget/verification failures to stable categories with deterministic reporting and cleanup triggers.
  - **Exact tests to pass/add:** failure-path tests in `tests/anton-controller.test.ts` and `tests/anton-verifier.test.ts`.
  - **Done when:** category mapping tests pass and each category yields expected cleanup/reporting behavior.

---

## Guardrails (keep)

- Keep `runtimes.json` as the runtime/model source of truth.
- Avoid platform-specific UX logic duplication when shared modules can handle it.
- New user-facing behavior should include tests for both Telegram and Discord flows.
