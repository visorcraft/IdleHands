# Anton — Autonomous Task Runner

Anton is Idle Hands’ autonomous checklist runner.

You provide a markdown worklist, Anton executes items, verifies outcomes, and records progress safely.

## Quick start

```bash
# create a worklist
cat > worklist.md << 'EOF'
# Release Worklist

- [ ] Add input validation to src/api.ts
- [ ] Write unit tests for validation
- [ ] Update README with new API docs
EOF

# run Anton
idlehands
> /anton worklist.md
```

## What Anton does

- parses unchecked checklist items
- executes tasks with fresh agent context per attempt
- verifies with a multi-layer cascade
- marks items complete only after verification passes
- retries/rolls back according to policy

## Execution model

1. Acquire lock
2. Parse worklist
3. Detect verification commands
4. Validate repo state
5. Run task loop (execute → verify → mark/retry/skip)
6. Release lock and emit summary

## Key guarantees

- **Controller-owned completion state**: task checkboxes are controller-managed, not model-managed.
- **Fresh context per attempt**: reduces cross-task contamination.
- **Stable task identity**: tasks are tracked by deterministic keys, not line numbers.
- **Atomic file updates**: task-file writes are done safely.

## Worklist format

Standard markdown checkboxes:

```markdown
# Setup

- [ ] Initialize project structure
- [ ] Configure TypeScript
  - [ ] tsconfig.json
  - [ ] Build script

# Implementation

- [x] Already completed task
- [ ] Write the parser
- [ ] Write tests
```

Rules:

- `- [ ]` pending, `- [x]` completed
- headings organize sections
- nested items are supported
- fenced code blocks are ignored during parse

## Commands

- `/anton <file>` — start run
- `/anton run <file>` — explicit start alias
- `/anton status` — progress
- `/anton stop` — stop after current task
- `/anton last` — show last run summary

## High-value flags

- `--max-retries <n>`
- `--max-iterations <n>`
- `--task-timeout <sec>`
- `--total-timeout <sec>`
- `--max-tokens <n>`
- `--verify-ai`
- `--decompose`
- `--max-decompose-depth <n>`
- `--max-total-tasks <n>`
- `--skip-on-fail`
- `--approval <mode>`
- `--verbose`
- `--dry-run`

## Verification cascade

- **L0**: agent reports successful completion via `<anton-result>status: done</anton-result>`
- **L1**: build/test/lint commands pass (auto-detected or overridden)
- **L2** (optional): AI review approves diff quality

When L1 commands fail, Anton captures the **full stdout and stderr** from the failing commands (up to 4 KB). This output is stored in the attempt's verification result and used for:
- Rich error reporting in progress messages (Telegram/Discord/CLI)
- Contextual retry prompts (see Smart Retry below)

## Smart retry system

When a task fails verification or the agent reports `status: failed`, Anton retries intelligently:

### Fix-it retry context

Instead of blindly re-attempting the task, Anton sends a new session the **full failure details** including:
- Which verification stage failed (build, test, lint, AI review)
- The complete command output (stdout + stderr) from failing commands
- Explicit instructions to **fix the specific errors** rather than rewriting from scratch

Example retry prompt context:
```
Previous attempt #1 result: failed
Verification: Command failures: lint: ...
- Lint command failed

=== Full error output from failed commands ===
=== lint ===
stdout:
src/bot/ux/events.ts:5:1 - error: Missing semicolon
src/bot/ux/events.ts:12:3 - error: Unexpected whitespace
=== End of error output ===

IMPORTANT: Fix the errors shown above. The code from your previous attempt
is still in place — do NOT rewrite it from scratch.
```

### Identical failure dedup guard

If the exact same failure summary occurs **5 consecutive times** (configurable via `max_identical_failures`), Anton stops retrying that task and skips it. This prevents wasting tokens on issues the agent cannot resolve.

### Blocked tasks are never retried

When the agent reports `status: blocked`, Anton immediately skips the task rather than burning retries. A blocked task indicates a structural impediment (missing dependency, impossible requirement) that no retry can fix.

### Retry flow summary

```
Task attempt fails
  ├── status: blocked → skip immediately (no retry)
  ├── prompt-budget-exceeded → skip immediately (prompt too large)
  ├── same failure N times → skip (max_identical_failures, default 5)
  ├── max retries reached → skip (max_retries, default 3)
  └── otherwise → retry with full error context
```

## Safety posture

- single-run lock to prevent concurrent Anton conflicts
- clean-tree check by default
- bounded rollback strategy on failure
- explicit time/token/task ceilings

## High-value flags

- `--max-retries <n>` — max retries per task (default: 3)
- `--max-iterations <n>` — max total iterations across all tasks
- `--task-timeout <sec>` — timeout per task attempt
- `--total-timeout <sec>` — total time budget
- `--max-tokens <n>` — total token budget
- `--verify-ai` — enable L2 AI code review verification
- `--decompose` — allow agent to break large tasks into subtasks
- `--max-decompose-depth <n>` — max nesting depth for decomposition
- `--max-total-tasks <n>` — prevent decomposition explosion
- `--skip-on-fail` — skip failed tasks and continue (vs abort)
- `--approval <mode>` — approval mode for agent sessions
- `--verbose` — stream agent tokens to stderr
- `--dry-run` — parse and print plan only

## Configuration

### Config file (`idlehands.yaml`)

```yaml
anton:
  max_retries: 3
  max_iterations: 200
  task_timeout_sec: 600
  total_timeout_sec: 7200
  verify_ai: true
  decompose: true
  max_decompose_depth: 2
  max_total_tasks: 500
  skip_on_fail: false
  skip_on_blocked: true
  rollback_on_fail: false
  max_identical_failures: 5
  approval_mode: yolo
  auto_commit: true
```

### Environment variables

| Variable | Description |
|---|---|
| `IDLEHANDS_ANTON_MAX_RETRIES` | Max retries per task |
| `IDLEHANDS_ANTON_MAX_ITERATIONS` | Max total iterations |
| `IDLEHANDS_ANTON_TASK_TIMEOUT_SEC` | Timeout per task attempt |
| `IDLEHANDS_ANTON_TOTAL_TIMEOUT_SEC` | Total time budget |
| `IDLEHANDS_ANTON_MAX_TOTAL_TOKENS` | Total token budget |
| `IDLEHANDS_ANTON_VERIFY_AI` | Enable AI verification |

## Troubleshooting

**Run appears stuck / already active**
- check lock state under `~/.local/state/idlehands/`

**Tasks not detected**
- confirm `- [ ]` checkbox syntax
- ensure lines are not inside fenced code blocks

**Verification keeps failing**
- run build/test/lint manually
- check the full command output in the error message for specific file/line errors
- use `--dry-run` to inspect execution plan
- use `--verbose` for richer run output

**Same failure repeating endlessly**
- Anton automatically stops after 5 consecutive identical failures (configurable)
- If the agent cannot fix a specific lint/test error, consider adding a config override for the failing command

**Agent keeps rewriting code from scratch on retry**
- Anton now sends the full error output with explicit "fix only the specific issues" instructions
- The agent's code changes persist between retries — it should read and fix, not recreate

