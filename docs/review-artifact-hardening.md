# Review Artifact Hardening

This checklist + test matrix is for preventing compaction-induced re-read loops ("death spiral") after large code reviews.

## Goal

When a user asks to **print/show the full review**, the agent should retrieve a durable stored artifact and return it directly, without re-reading files or re-running analysis.

## Implementation Checklist

### 1) Retrieval routing (hard guard)
- [ ] Retrieval intent (`print/show/repeat full review`) bypasses model/tool loop.
- [ ] If artifact missing, return deterministic miss message.
- [ ] Never auto-fallback to fresh analysis unless user explicitly asks.
- [ ] Add an explicit command path (`/review print`) to avoid NLP misses.

### 2) Artifact integrity + schema
- [ ] Persist artifact only on successful final answer (not timeout/partial).
- [ ] Store metadata:
  - `id`, `createdAt`, `model`
  - `projectId`, `projectDir`
  - `reviewType`, `targetRef`
  - `gitHead`, `gitDirty`, `branch`
  - `prompt`, `content`
- [ ] Validate schema before serving.
- [ ] Optional checksum/hash to detect corruption.

### 3) Scope isolation
- [ ] Key artifacts by `{project, branch, reviewType, targetRef}`.
- [ ] Keep immutable per-id records + latest pointer.
- [ ] Block cross-project serving unless explicitly requested.

### 4) Staleness policy
- [ ] Compare artifact metadata vs current repo state on retrieval.
- [ ] Distinguish stale causes (commit drift, branch drift, dirty-tree drift).
- [ ] Configurable policy:
  - `warn` (default)
  - `block`
  - `force` with explicit confirmation

### 5) Large-output safety
- [ ] Support chunking/pagination for very large review artifacts.
- [ ] Retrieval path must not invoke analysis if output transport retries/fails.
- [ ] Treat artifact as inert output text (never as executable instructions).

### 6) Retention and compaction boundaries
- [ ] Artifact storage class is excluded from trace compaction.
- [ ] Trace compaction cannot delete latest artifact pointer rows.
- [ ] Eviction policy preserves artifact rows longer than transient traces.

### 7) Concurrency + idempotency
- [ ] Atomic latest-pointer updates (transaction/CAS semantics).
- [ ] Defined behavior for concurrent review writes.
- [ ] Idempotency key for retrieval sends to avoid duplicate full-output replies.

### 8) Observability
- [ ] Metrics: `review_artifact_hit/miss/stale/blocked`.
- [ ] Metric: retrieval-intent requests that still trigger tools (target = zero).
- [ ] Alert on repeated read→compact signatures per request.

---

## Test Matrix

### A) Unit
1. Intent classifier: generate vs retrieve paths.
2. Artifact parser/schema validation.
3. Key generation/scope partitioning.
4. Staleness evaluator by commit/branch/dirty state.
5. Retrieval miss contract (no analysis fallback).

### B) Integration
6. Generate → retrieve replay with zero extra LLM turns.
7. Forced compaction pressure still allows retrieval.
8. Huge artifact retrieval paginates safely.
9. Stale warning path includes clear reason.
10. Stale block path requires explicit override.

### C) Durability + concurrency
11. Concurrent writers keep consistent latest pointer.
12. Crash between artifact write and pointer update recovers safely.
13. Eviction does not remove protected artifact rows.
14. Corrupted artifact row fails gracefully (no loop fallback).

### D) Regression guards (death spiral-specific)
15. Retrieval intent executes zero tool calls.
16. No read→compact→re-read loop under retrieval intent.
17. Retry/idempotency does not duplicate long replay output.

---

## Suggested Pass Criteria

- Retrieval-intent calls show **0 tool calls** in telemetry.
- Compaction events do not affect ability to replay latest review.
- All stale modes (`warn`, `block`, `force`) behave deterministically.
- Concurrent write/retrieve paths are deterministic and race-safe.
