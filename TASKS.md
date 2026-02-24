# IdleHands UX Improvement Program (Discord + Telegram)

## Clarifications & Execution Notes

### Clean Slate Implementation

This roadmap is treated as a **clean slate implementation**. Do not assume any prior work has been completed. All tasks should be implemented fresh according to the phases defined below, regardless of any existing partial implementations.

---

### Strict RFC-First Approach

**Phase 0 is blocking**. The full RFC must be completed before any implementation work begins:

1. `docs/ux/ux-program-rfc.md` with complete:
   - Scope, goals, non-goals, glossary
   - Hard UX SLAs (acknowledgment ≤1.5s, progress ≤5s, etc.)
   - Reliability SLAs (runtime readiness, cancel latency, stale-run recovery)
   - Token/latency guardrail policy
   - Backward compatibility contract
   - Full feature flag strategy (see below)

**No parallel implementation**. Start Phase 1 only after Phase 0 RFC is merged.

---

### Full Feature Flag System

Implement a **complete feature flag system** in Phase 0, not simple boolean toggles:

```typescript
interface FeatureFlags {
  ux_v2_enabled: FeatureFlag;
  auto_route_enabled: FeatureFlag;
  chat_actions_enabled: FeatureFlag;
  anton_preflight_enabled: FeatureFlag;
}

interface FeatureFlag {
  enabled: boolean;
  rollout_percentage?: number;  // 0-100 for gradual rollout
  allowed_users?: string[];     // user IDs for canary testing
  allowed_chats?: string[];     // chat IDs for canary testing
  created_at: string;
  updated_at: string;
}
```

**Storage**: Feature flags should be persisted in config and support runtime updates without restart.

**Rollout stages**:
- Canary (allowed_users/allowed_chats only)
- Partial (rollout_percentage)
- Full (enabled=true, no restrictions)

---

### Backward Compatibility Contract

Existing commands that **must not break**:
- `/status` — show session/runtime status
- `/health` — health check endpoint
- `/anton` — Anton workflow trigger
- `/select` — runtime selection
- `/cancel` — abort current operation

New behavior must be additive:
- `/health discover` for port scanning (new)
- `/mode fast|heavy|auto` for routing (new)
- `/anton doctor` for preflight diagnostics (new)

---

### Session Persistence Modes

Phase 6 mentions `default|sticky|ephemeral` modes:

- **default**: Session timeout after inactivity (current behavior)
- **sticky**: Session persists until explicit `/reset`
- **ephemeral**: No persistence, each message is isolated

Implementation uses existing `session_timeout_min` config with new enum:
```typescript
session_persistence?: 'default' | 'sticky' | 'ephemeral';
```

---

## Phase 0 — Scope Lock, Architecture, and Non-Functional Requirements

✅ Create `docs/ux/ux-program-rfc.md` defining scope, goals, non-goals, and glossary (Fast lane, Heavy lane, preflight, readiness, retries, stale-run).
✅ Define hard UX SLAs in RFC:
  - ✅ First acknowledgment message <= 1.5s.
  - ✅ First meaningful progress update <= 5s.
  - ✅ User-visible error messages always include recovery guidance.
  - ✅ No silent failures for >10s during in-flight operations.
✅ Define reliability SLAs in RFC:
  - ✅ Runtime selection success MUST mean "ready for inference", not only "process started".
  - ✅ `/anton stop` MUST begin cancellation within 2s.
  - ✅ Stale run lock auto-recovery MUST occur at <=120s heartbeat timeout.
✅ Define token/latency guardrail policy in RFC:
  - ✅ Per-attempt prompt token max default: 128k.
  - ✅ User-visible warning threshold for expensive operations.
✅ Define backward compatibility contract for existing commands (`/status`, `/health`, `/anton`, `/select`).
✅ Define full feature-flag system in RFC (see Clarifications section for schema).

## Phase 1 — Shared UX Core (No Duplication, Maximum Reuse)

- [x] Create shared module `src/bot/ux/events.ts` with platform-agnostic event model (`ACK`, `PROGRESS`, `WARNING`, `ERROR`, `RESULT`, `ACTIONS`).
- [x] Create shared module `src/bot/ux/renderer.ts` to convert event model into canonical text blocks.
- [x] Create shared module `src/bot/ux/actions.ts` defining normalized action schema (`retry_fast`, `retry_heavy`, `cancel`, `show_diff`, `apply`, `anton_stop`).
- [x] Create shared module `src/bot/ux/state.ts` for per-session UX state (last event timestamp, active actions, stale detection).
- [x] Create shared module `src/bot/ux/progress-throttle.ts` for unified rate-limiting and heartbeat behavior.
- [ ] Refactor Telegram and Discord handlers to consume shared UX core instead of duplicating message composition logic.
- [ ] Add tests: `tests/bot-ux-events.test.ts`, `tests/bot-ux-renderer.test.ts`, `tests/bot-ux-throttle.test.ts`.
- [ ] Add lint/CI check preventing duplicate platform formatter logic for identical event types.

### Phase 1 Definition of Done

- [ ] Telegram and Discord emit identical semantic events for the same workflow stage.
- [ ] No duplicated status/progress formatting blocks across bot implementations.

## Phase 2 — Fast/Heavy/Auto Routing (Latency UX Breakthrough)

- [ ] Create shared routing module `src/routing/policy.ts` with deterministic decision function:
  - [ ] Inputs: prompt length, complexity heuristics, command type, requested mode, model health.
  - [ ] Outputs: `fast | heavy | auto-selected-fast | auto-selected-heavy`.
- [ ] Extend config schema in `src/types.ts`:
  - [ ] `routing.default_mode`.
  - [ ] `routing.fast_model`.
  - [ ] `routing.heavy_model`.
  - [ ] `routing.auto_escalation_rules`.
- [ ] Add bot commands:
  - [ ] `/mode fast`.
  - [ ] `/mode heavy`.
  - [ ] `/mode auto`.
  - [ ] `/mode status`.
- [ ] Add one-click retry actions from result/error blocks:
  - [ ] `Retry Fast`.
  - [ ] `Retry Heavy`.
- [ ] Ensure route decision is included in ACK/progress messages (e.g., "Running in Fast mode on <model>").
- [ ] Add tests: `tests/routing-policy.test.ts`, `tests/bot-routing-integration.test.ts`.
- [ ] Add telemetry counters: selected mode, escalations, fallback retries, p50/p95 latency by mode.

### Phase 2 Definition of Done

- [ ] Simple prompts do not default to heavy model unless explicitly requested.
- [ ] Route decisions are explainable and visible in logs and user ACK messages.

## Phase 3 — Deterministic Progress UX + Interactive Controls

- [ ] Implement standardized progress stages:
  - [ ] `queued`.
  - [ ] `planning`.
  - [ ] `runtime_preflight`.
  - [ ] `executing`.
  - [ ] `verifying`.
  - [ ] `complete`.
- [ ] Ensure every long-running operation emits stage transitions via shared UX event bus.
- [ ] Add Telegram inline buttons and Discord actions using shared action schema.
- [ ] Implement action handlers in one shared dispatch layer (`src/bot/ux/action-dispatch.ts`) with platform adapters only.
- [ ] Add timeout watchdog for silent periods >10s that emits heartbeat progress.
- [ ] Add elapsed time for long runs (`>20s`) and ETA when available.
- [ ] Add tests: `tests/bot-actions-dispatch.test.ts`, `tests/bot-progress-lifecycle.test.ts`.

### Phase 3 Definition of Done

- [ ] No dead-air experience during long operations.
- [ ] Users can cancel/retry without memorizing commands.

## Phase 4 — Runtime Readiness + Health UX (Configured vs Discovered)

- [ ] Finalize canonical readiness utility usage for all runtime-consuming flows (`/select`, Anton preflight, recovery paths).
- [ ] Ensure `/select --restart --wait-ready` is used by internal recovery orchestration where applicable.
- [ ] Stabilize `health --json` contract to include:
  - [ ] Host checks.
  - [ ] Configured model checks.
  - [ ] Discovered services by host/port with status/model IDs.
- [ ] Implement bot `/health` rendering with two sections:
  - [ ] Configured Targets.
  - [ ] Discovered Running Services.
- [ ] Add optional `/health discover <range>` wrapper for `--scan-ports`.
- [ ] Add parsing-safe integration tests for bot health rendering from `health --json` only (never parse ANSI).
- [ ] Add failure-class display mapping:
  - [ ] `down` (connect fail).
  - [ ] `loading` (503).
  - [ ] `ready` (200 + model IDs).

### Phase 4 Definition of Done

- [ ] User can always answer both: "What is configured?" and "What is actually running?" from one command.

## Phase 5 — Anton Reliability & Cost Control UX

- [ ] Add explicit Anton preflight event sequence before attempt 1 (`runtime_preflight` stage).
- [ ] Add explicit failure classifier outcomes in progress stream:
  - [ ] `infra_down`.
  - [ ] `loading`.
  - [ ] `tooling_error`.
  - [ ] `patch_conflict`.
  - [ ] `context_budget_exceeded`.
- [ ] Ensure infra failures trigger infra recovery path first, not full LLM attempt loops.
- [ ] Implement run supervisor abstraction (`src/anton/supervisor.ts`) keyed by channel/session identity with:
  - [ ] `runId`.
  - [ ] `abortController`.
  - [ ] `startedAt`.
  - [ ] `lastHeartbeatAt`.
  - [ ] `promise` lifecycle.
- [ ] Ensure supervisor cleanup in `finally` always clears active run state.
- [ ] Ensure stale supervisor state auto-recovers after heartbeat TTL (120s).
- [ ] Add `/anton attach` to reconnect to active run updates.
- [ ] Add `/anton doctor` to run preflight diagnostics before starting.
- [ ] Add strict per-attempt prompt budget handling with explicit remediation guidance.
- [ ] Add tests:
  - [ ] `tests/anton-supervisor.test.ts`.
  - [ ] `tests/anton-preflight-recovery.test.ts`.
  - [ ] `tests/anton-stale-run-recovery.test.ts`.
  - [ ] `tests/anton-token-guardrail.test.ts`.

### Phase 5 Definition of Done

- [ ] "Anton already running forever" is no longer reproducible.
- [ ] Infra outages no longer burn massive token retries.

## Phase 6 — Session Continuity & Conversational UX

- [ ] Add configurable session persistence modes (`default`, `sticky`, `ephemeral`) for Telegram and Discord.
- [ ] Add `/session status` showing:
  - [ ] Session age.
  - [ ] Last activity.
  - [ ] In-flight status.
  - [ ] Expiration policy.
- [ ] Add optional "pin session" command for long-running collaboration threads.
- [ ] Ensure active Anton or in-flight generation blocks cleanup expiry.
- [ ] Add tests for cleanup behavior under each session mode.

### Phase 6 Definition of Done

- [ ] Users do not unexpectedly lose context during active workflows.

## Phase 7 — Release Engineering, Migration, and Rollout Safety

- [ ] Add migration notes for new config keys in `docs/CHANGELOG.md` and `docs/config.md`.
- [ ] Add feature flags default-off for risky UX changes; stage rollouts:
  - [ ] Canary.
  - [ ] Partial.
  - [ ] Full.
- [ ] Add rollback runbook per phase: `docs/runbooks/ux-rollback.md`.
- [ ] Add post-release validation checklist for both Discord and Telegram.
- [ ] Run synthetic E2E scenarios in CI for both platforms.

### Phase 7 Definition of Done

- [ ] Full rollout complete with no regression in command compatibility.

## Cross-Phase Engineering Standards (Mandatory)

- [ ] No platform-specific duplication of core UX logic (Telegram/Discord must use shared modules).
- [ ] All new behavior behind typed interfaces and unit-tested.
- [ ] Every user-visible error path includes remediation guidance.
- [ ] Every long-running flow emits progress and heartbeat.
- [ ] Every recovery path is idempotent and retry-safe.
- [ ] New JSON output contracts are versioned or backward compatible.
- [ ] CI fails on TypeScript errors, lint violations, and missing tests for modified critical modules.

## Execution Order (Strict)

✅ Complete Phase 0 before Phase 1.
- [ ] Complete Phase 1 before Phase 2.
- [ ] Complete Phase 2 before Phase 3.
- [ ] Complete Phase 3 before Phase 4.
- [ ] Complete Phase 4 before Phase 5.
- [ ] Complete Phase 5 before Phase 6.
- [ ] Complete Phase 6 before Phase 7.
