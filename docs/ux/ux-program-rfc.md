# IdleHands UX Improvement Program — RFC

## 1. Scope

Build a unified, deterministic, and observable UX layer for IdleHands that works consistently across Telegram and Discord. This is a **clean-slate implementation** — existing partial implementations are ignored.

### Goals

- **Latency UX breakthrough**: Simple prompts run on fast model, complex workloads use heavy model with explainable routing.
- **Zero dead-air**: Progress updates every ≤5s, acknowledgment ≤1.5s, heartbeat every ≤10s during long ops.
- **Reliability first**: Stale run auto-recovery ≤120s, cancellation ≤2s, infra failures never trigger LLM retry loops.
- **Cost control**: Explicit per-attempt token budgets with remediation guidance, preflight diagnostics.
- **Session continuity**: Sticky/ephemeral modes, no context loss during active workflows.

### Non-Goals

- UI redesign beyond inline buttons/actions.
- Changing the core agent architecture or inference engine.
- Supporting additional messaging platforms beyond Telegram/Discord (Phase 7 may expand scope).
- Breaking existing commands (`/status`, `/health`, `/anton`, `/select`, `/cancel`).

### Glossary

| Term | Definition |
|------|------------|
| Fast lane | Lightweight model (e.g., Nemotron) for simple/short prompts |
| Heavy lane | High-capability model (e.g., Opus) for complex/long prompts |
| Routing policy | Deterministic decision function selecting fast/heavy/auto |
| UX event | Platform-agnostic message type (ACK, PROGRESS, WARNING, ERROR, RESULT, ACTIONS) |
| Stale run | In-flight operation with no heartbeat for >120s |
| Preflight | Runtime readiness checks before LLM attempt |
| Session persistence | `default` (timeout), `sticky` (manual reset), `ephemeral` (isolated) |

---

## 2. Hard UX SLAs

| SLA | Target | Measurement |
|-----|--------|-------------|
| First acknowledgment | ≤1.5s | From command receipt to first ACK message |
| First progress update | ≤5s | From command receipt to first PROGRESS message |
| Silent period max | ≤10s | No more than 10s without any progress message |
| User-visible error | Always | Must include recovery guidance |
| Cancellation start | ≤2s | From `/cancel` to abort signal delivery |
| Stale-run recovery | ≤120s | Heartbeat timeout triggers auto-recovery |

---

## 3. Reliability SLAs

| SLA | Requirement |
|-----|-------------|
| Runtime selection | MUST mean "ready for inference", not only "process started" |
| `/anton stop` | MUST begin cancellation within 2s |
| Stale run lock recovery | MUST occur within 120s heartbeat timeout |

---

## 4. Token/Latency Guardrail Policy

| Parameter | Default | Notes |
|-----------|---------|-------|
| Per-attempt prompt token max | 128k | Configurable per route |
| User-visible warning threshold | 80% of budget | Include remediation guidance |
| Retry attempts on token overflow | 0 | Immediate error with guidance |

---

## 5. Backward Compatibility Contract

Existing commands **must not break**:

| Command | Required behavior |
|---------|-------------------|
| `/status` | Show session/runtime status |
| `/health` | Health check endpoint |
| `/anton` | Anton workflow trigger |
| `/select` | Runtime selection |
| `/cancel` | Abort current operation |

**Additive new behavior only**:
- `/health discover <range>` — port scanning (new)
- `/mode fast\|heavy\|auto\|status` — routing (new)
- `/anton doctor` — preflight diagnostics (new)
- `/session status` — session info (new)

---

## 6. Feature Flag System

### Schema

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

### Storage & Runtime

- Persisted in config (`openclaw.json` or equivalent)
- Support runtime updates without restart (reload config)
- Rollout stages:
  - **Canary**: `allowed_users`/`allowed_chats` only
  - **Partial**: `rollout_percentage` (random per session)
  - **Full**: `enabled=true`, no restrictions

### Default Flags

| Flag | Default | Notes |
|------|---------|-------|
| `ux_v2_enabled` | `false` | Main UX layer switch |
| `auto_route_enabled` | `false` | Fast/Heavy auto-routing |
| `chat_actions_enabled` | `false` | Inline buttons/actions |
| `anton_preflight_enabled` | `false` | Preflight diagnostics |

---

## 7. Implementation Phases

See `../TASKS.md` for full phase breakdown. Execution order is **strict**:

1. **Phase 0** — Scope lock, architecture, non-functional requirements (this RFC)
2. **Phase 1** — Shared UX core (events, renderer, actions, state, throttle)
3. **Phase 2** — Fast/Heavy/Auto routing (policy, commands, telemetry)
4. **Phase 3** — Deterministic progress UX + interactive controls
5. **Phase 4** — Runtime readiness + health UX
6. **Phase 5** — Anton reliability & cost control UX
7. **Phase 6** — Session continuity & conversational UX
8. **Phase 7** — Release engineering, migration, rollout safety

---

## 8. Rollout Strategy

- Feature flags default to **off** for risky UX changes
- Stage rollouts: Canary → Partial → Full
- Rollback runbook per phase in `docs/runbooks/ux-rollback.md`
- Post-release validation checklist for both platforms

---

**Status**: Draft — Ready for review  
**Next step**: Phase 0 completion → Merge RFC → Phase 1 implementation