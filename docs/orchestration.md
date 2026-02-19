# Runtime Orchestration Architecture

This document describes Phase E runtime orchestration architecture for Idle Hands.

## High-level flow

```text
User
  ↓
CLI / REPL / Telegram Bot
  ↓
Planner (pure)
  ↓
Executor (effectful)
  ↓
Target Host(s) (local / ssh)
```

- **Planner** computes what should happen.
- **Executor** performs it safely and records outcomes.

---

## Module layout

Core runtime modules:

- `src/runtime/types.ts`
  - Contracts for config, planning, and execution
- `src/runtime/store.ts`
  - Load/save/bootstrap/validate/redact for `runtimes.json`
- `src/runtime/planner.ts`
  - Deterministic plan generation (no I/O)
- `src/runtime/executor.ts`
  - Process execution, locking, health probing, rollback paths

Design boundaries:

- `store.ts` owns config file I/O.
- `planner.ts` does **not** spawn commands or read files.
- `executor.ts` is the only orchestration layer with side effects.

---

## Planner design

Planner inputs are runtime config + request + active runtime state.

Typical request fields:

- `modelId`
- `backendOverride?`
- `hostOverride?`
- `mode: 'live' | 'dry-run'`

Planner behavior:

1. Resolve model and ensure it is enabled.
2. Resolve backend/host using override → policy → first enabled match precedence.
3. Validate policy constraints and cross-references.
4. Build ordered `steps` (`stop_model`, `apply_backend`, `verify_backend`, `start_model`, `probe_health`).
5. Detect reuse opportunities.

### Determinism requirements

Planner is a pure function:

- no filesystem reads/writes
- no process spawning
- no network access
- same inputs ⇒ same output

This makes dry-run output stable and testable.

---

## Reuse detection

Planner can return `reuse: true` when active runtime already matches:

- same `modelId`
- same backend (if applicable)
- same host set
- active state currently healthy

When reuse is true, executor can skip full stop/start orchestration and perform a cheap re-probe.

---

## Executor sequence

Executor applies a plan in strict order:

1. **Lock**: acquire runtime lock (`~/.local/state/idlehands/runtime.lock`)
2. **Stop**: run current host `model_control.stop_cmd`
3. **Backend**: run `apply_cmd` (if needed)
4. **Verify backend**: run `verify_cmd` (if provided)
5. **Start model**: run `launch.start_cmd`
6. **Probe**: run `launch.probe_cmd` until healthy or timeout
7. **Save active state**
8. **Unlock**

If a step fails, executor records structured step outcomes and attempts rollback when defined.

---

## Lock mechanism

Runtime orchestration uses a PID-based lock file.

Conceptually stored metadata includes:

- owner PID
- start timestamp
- active model identifier

Behavior:

- If lock exists and PID is alive → lock is held by another process.
- If lock exists and PID is dead → lock is stale and can be reclaimed.
- Conflict strategies are surfaced by command UX (wait, force takeover, cancel).

This prevents overlapping stop/start actions across CLI/bot sessions.

---

## Integration points

## CLI subcommands

Runtime orchestration entry points from TASKS §7:

```bash
idlehands hosts ...
idlehands backends ...
idlehands models ...
idlehands select --model <id>
idlehands select status
```

Useful operational commands:

- `idlehands hosts validate`
- `idlehands hosts test <id>`
- `idlehands hosts doctor`
- `idlehands select --model <id> --dry-run --json`

## Session commands

Runtime commands (available in interactive sessions, Telegram, and Discord):

- `/hosts`
- `/backends`
- `/select <model>`
- `/runtime`

## Telegram bot commands

Planned bot integration calls the same planner/executor contracts:

- `/hosts`
- `/backends`
- `/runtime`
- `/switch <model>`

The bot should avoid duplicate orchestration logic and only adapt interaction UX (status updates, lock conflict prompts).

---

## Operational model

- **Single source of truth**: `runtimes.json`
- **Single planning path**: planner
- **Single execution path**: executor
- **Multiple front-ends**: CLI, REPL, bot

This keeps behavior consistent no matter how runtime switching is triggered.
