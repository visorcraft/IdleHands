# IdleHands UX Improvement Program — RFC

**Version:** 1.0  
**Date:** 2024  
**Status:** Draft — Phase 0 (Scope Lock)  
**Authors:** IdleHands Core Team

---

## Table of Contents

1. [Overview](#overview)
2. [Scope](#scope)
3. [Goals](#goals)
4. [Non-Goals](#non-goals)
5. [Glossary](#glossary)
6. [Hard UX SLAs](#hard-ux-slas)
7. [Reliability SLAs](#reliability-slas)
8. [Token/Latency Guardrail Policy](#tokenlatency-guardrail-policy)
9. [Backward Compatibility Contract](#backward-compatibility-contract)
10. [Feature Flag Strategy](#feature-flag-strategy)

---

## Overview

This RFC defines the scope, goals, non-goals, and non-functional requirements for the IdleHands UX Improvement Program targeting Discord and Telegram bot frontends.

The program addresses critical latency, reliability, and user experience gaps identified in production usage, with a focus on predictable response times, clear error recovery paths, and robust runtime orchestration.

---

## Scope

### In Scope

- **Bot frontend UX overhaul** (Discord + Telegram)
- **Latency SLAs** for first acknowledgment and progress updates
- **Reliability guarantees** for runtime selection, cancellation, and stale-run recovery
- **Token/latency guardrails** to prevent expensive operations without warning
- **Feature flag system** for gradual rollout and canary testing
- **Backward compatibility** for existing commands (`/status`, `/health`, `/anton`, `/select`, `/cancel`)

### Out of Scope

- Changes to the TUI (Fullscreen CLI) experience
- Changes to the CLI (headless) experience
- Changes to the core agent inference logic
- Changes to the Trifecta subsystem (vault, replay, lens)
- Changes to the `idlehands setup` wizard
- Changes to the `idlehands select` runtime selection flow (CLI)

---

## Goals

### Primary Goals

1. **Predictable Latency**
   - First acknowledgment message ≤ 1.5s from user input
   - First meaningful progress update ≤ 5s from user input
   - No silent failures for >10s during in-flight operations

2. **Reliable Runtime Orchestration**
   - Runtime selection success means "ready for inference", not just "process started"
   - `/anton stop` begins cancellation within 2s
   - Stale run lock auto-recovery occurs at ≤120s heartbeat timeout

3. **Clear Error Recovery**
   - All user-visible error messages include recovery guidance
   - Distinguish between user-actionable errors and system failures
   - Provide explicit next steps for common failure modes

4. **Safe Operation**
   - Token/latency guardrails prevent expensive operations without warning
   - Per-attempt prompt token max default: 128k
   - User-visible warning threshold for expensive operations

### Secondary Goals

1. **Gradual Rollout**
   - Feature flag system supports canary → partial → full rollout stages
   - Per-user and per-chat canary targeting
   - Runtime feature flag updates without restart

2. **Backward Compatibility**
   - Existing commands continue to work without modification
   - New behavior is additive only
   - No breaking changes to existing command signatures

---

## Non-Goals

### Explicitly Excluded

1. **TUI/CLI Changes**
   - The TUI (Fullscreen mode) and CLI (headless mode) are out of scope
   - These frontends may receive separate UX improvement programs

2. **Core Agent Logic**
   - Inference model selection, prompt engineering, and tool calling logic are out of scope
   - This program focuses on orchestration and user-facing latency/reliability

3. **Infrastructure Changes**
   - No changes to deployment architecture (Docker, systemd, etc.)
   - No changes to the underlying OpenAI-compatible endpoint protocol

4. **Authentication/Authorization**
   - User authentication and authorization are out of scope
   - Bot-specific access control (e.g., allowed users/chats) is handled via feature flags

5. **Analytics/Telemetry**
   - User behavior analytics and telemetry collection are out of scope
   - This program focuses on functional UX improvements, not monitoring

---

## Glossary

### Fast Lane

A routing mode that prioritizes speed over resource efficiency. Fast lane routes requests to pre-warmed runtimes with minimal startup latency, at the cost of higher resource utilization.

**Characteristics:**
- Pre-warmed runtimes (always-on or near-always-on)
- Minimal startup latency (< 500ms)
- Higher baseline resource cost
- Suitable for interactive, latency-sensitive workflows

### Heavy Lane

A routing mode that prioritizes resource efficiency over speed. Heavy lane routes requests to on-demand runtimes that may require startup time, optimized for cost and resource conservation.

**Characteristics:**
- On-demand runtime startup (may require 5–30s)
- Lower baseline resource cost
- Higher latency for first request
- Suitable for batch, non-interactive workflows

### Preflight

A diagnostic check performed before routing a request to a runtime. Preflight validates runtime readiness, resource availability, and configuration consistency to prevent silent failures.

**Components:**
- Runtime process health check
- Endpoint liveness probe
- Resource availability verification (memory, disk, GPU)
- Configuration consistency check

### Readiness

A runtime state indicating that the runtime is fully prepared to accept and process requests. Readiness is more strict than "process started" — it requires successful endpoint probing and health checks.

**Readiness Criteria:**
- Runtime process is running
- Endpoint is responding to HTTP requests
- Health check endpoint returns 200 OK
- Required resources (memory, GPU) are available
- No pending configuration errors

### Retries

A retry policy that defines how many times to attempt an operation before failing. Retries are configured per-operation with exponential backoff to prevent cascade failures.

**Retry Configuration:**
- Maximum retry count (configurable, default: 3)
- Initial backoff delay (default: 100ms)
- Backoff multiplier (default: 2.0)
- Maximum backoff delay (default: 5s)

### Stale-Run

A run ( Anton task or agent session) that has exceeded its heartbeat timeout without updating its status. Stale runs are automatically recovered by the watchdog to prevent resource leaks and inconsistent state.

**Stale-Run Detection:**
- Heartbeat timeout (default: 120s)
- Last heartbeat timestamp stored in lock file
- Stale run detection runs on every heartbeat check
- Automatic recovery includes lock cleanup and process termination

---

## Hard UX SLAs

### Acknowledgment Latency

| Metric | Target | Measurement | Failure Mode |
|--------|--------|-------------|--------------|
| First acknowledgment message | ≤ 1.5s | From user input to first bot response | User perceives "no response" |
| First meaningful progress update | ≤ 5s | From user input to first substantive update | User thinks request failed |

**Measurement Notes:**
- Clock starts at user message receipt (Discord/Telegram webhook)
- Clock ends at first message sent to user (including "thinking..." placeholder)
- Network latency to Discord/Telegram API is excluded from measurement

### Error Message Requirements

All user-visible error messages **MUST** include:

1. **Clear error type** (user error, runtime error, system error)
2. **Recovery guidance** (what the user can do next)
3. **Next steps** (specific actions to resolve)

**Example:**
```markdown
❌ Runtime failed to start (user error)

The selected runtime `llama-cpp` failed to start because the model file was not found.

**Recovery:**
1. Verify the model path in `config.json`
2. Run `idlehands select` to choose a different runtime
3. Check logs with `idlehands logs`
```

### Silent Failure Policy

**No silent failures for >10s during in-flight operations.**

**Requirements:**
- If an operation takes >10s, a progress update MUST be sent
- Progress updates may be minimal (e.g., "Still working...") but MUST be sent
- Silent failures (no message for >10s) are a violation of this SLA

---

## Reliability SLAs

### Runtime Selection

**SLA:** Runtime selection success MUST mean "ready for inference", not only "process started".

**Verification:**
- Runtime process is running
- Endpoint responds to HTTP requests
- Health check endpoint returns 200 OK
- Required resources (memory, GPU) are available

**Failure Mode:**
- If runtime starts but is not ready for inference, the selection MUST fail
- Error message MUST include recovery guidance (restart, check logs, verify config)

### Cancellation Latency

**SLA:** `/anton stop` MUST begin cancellation within 2s.

**Measurement Notes:**
- Clock starts at `/anton stop` command receipt
- Clock ends at cancellation signal sent to Anton process
- Includes network latency to Anton controller

**Failure Mode:**
- If cancellation does not begin within 2s, a warning MUST be sent to the user
- User MUST be able to force cancel with `/anton stop --force`

### Stale-Run Recovery

**SLA:** Stale run lock auto-recovery MUST occur at ≤120s heartbeat timeout.

**Recovery Process:**
1. Detect stale run (last heartbeat > 120s ago)
2. Terminate associated process (if still running)
3. Clean up lock file and state
4. Log recovery action for debugging

**Failure Mode:**
- If recovery fails, a warning MUST be sent to the user
- User MUST be able to manually recover with `/anton doctor --fix-stale`

---

## Token/Latency Guardrail Policy

### Per-Attempt Prompt Token Max

**Default:** 128k tokens per attempt

**Configuration:**
```json
{
  "guardrails": {
    "max_prompt_tokens_per_attempt": 128000
  }
}
```

**Behavior:**
- If prompt exceeds max tokens, the request is rejected with a clear error
- Error message MUST include guidance on how to reduce prompt size
- User MAY configure higher limit with explicit confirmation

### Expensive Operation Warning Threshold

**Definition:** An operation is "expensive" if it exceeds a user-configurable token or latency threshold.

**Default Thresholds:**
- Token threshold: 64k tokens (50% of max)
- Latency threshold: 30s estimated runtime

**Warning Behavior:**
- If operation exceeds threshold, a warning message is sent to the user
- User MUST explicitly confirm to proceed (Y/N prompt)
- Warning message MUST include estimated cost and duration

**Example Warning:**
```markdown
⚠️ Expensive operation detected

This operation is estimated to use 75k tokens and take ~45s.

**Estimated cost:** ~$0.75 (based on current model pricing)

Do you want to proceed? (Y/n)
```

---

## Backward Compatibility Contract

### Existing Commands (Must Not Break)

| Command | Purpose | Compatibility Requirement |
|---------|---------|---------------------------|
| `/status` | Show session/runtime status | No breaking changes to output format |
| `/health` | Health check endpoint | New subcommands only (`/health discover`) |
| `/anton` | Anton workflow trigger | No changes to existing flags/args |
| `/select` | Runtime selection | No changes to existing flow |
| `/cancel` | Abort current operation | No changes to existing behavior |

### New Behavior (Must Be Additive)

| Command | New Behavior | Compatibility Requirement |
|---------|--------------|---------------------------|
| `/health discover` | Port scanning for available runtimes | New subcommand only |
| `/mode fast\|heavy\|auto` | Routing mode selection | New subcommand only |
| `/anton doctor` | Preflight diagnostics | New subcommand only |
| `/anton stop --force` | Force cancellation | New flag only |

### Output Format Compatibility

- Existing command output formats MUST NOT change
- New fields MAY be added to JSON output (backward compatible)
- New subcommands MUST NOT affect existing command behavior

---

## Feature Flag Strategy

### Feature Flag Structure

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

### Storage

- Feature flags persisted in `config.json`
- Support runtime updates without restart
- Validation schema for flag structure

### Rollout Stages

| Stage | Configuration | Use Case |
|-------|---------------|----------|
| Canary | `allowed_users` / `allowed_chats` only | Internal testing, trusted users |
| Partial | `rollout_percentage` (e.g., 10%) | Beta testing, limited release |
| Full | `enabled=true`, no restrictions | General availability |

### Flag Lifecycle

1. **Draft:** Flag defined in code, disabled by default
2. **Canary:** Enabled for specific users/chats only
3. **Partial:** Enabled for percentage of users
4. **Full:** Enabled for all users
5. **Deprecated:** Flag removed from code (cleanup)

---

## Implementation Checklist

### Phase 0 (RFC — This Document)

- [x] Scope, goals, non-goals, and glossary defined
- [x] Hard UX SLAs defined
- [x] Reliability SLAs defined
- [x] Token/latency guardrail policy defined
- [x] Backward compatibility contract defined
- [x] Feature flag strategy defined

### Phase 1 (Implementation)

- [ ] Feature flag system implementation
- [ ] Fast/Heavy lane routing logic
- [ ] Preflight diagnostic checks
- [ ] Readiness verification for runtime selection
- [ ] Retry policy with exponential backoff
- [ ] Stale-run detection and recovery
- [ ] Error message template system
- [ ] Expensive operation warning threshold

### Phase 2 (Testing)

- [ ] Latency SLA testing (acknowledgment ≤1.5s, progress ≤5s)
- [ ] Reliability SLA testing (runtime readiness, cancel latency, stale recovery)
- [ ] Feature flag rollout testing (canary → partial → full)
- [ ] Backward compatibility testing (existing commands)

### Phase 3 (Rollout)

- [ ] Feature flag enabled for canary users
- [ ] Monitor SLA compliance and error rates
- [ ] Gradual rollout to partial users
- [ ] Full rollout to all users

---

## References

- [IdleHands Architecture](../guide/getting-started.md)
- [Runtime Orchestration](../orchestration.md)
- [Anton Task Runner](../anton.md)
- [Trifecta Subsystem](../guide/trifecta.md)

---

**RFC Status:** Draft — Ready for Review  
**Next Step:** Phase 1 Implementation (after Phase 0 RFC approval)