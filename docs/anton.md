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

- **L0**: agent reports successful completion
- **L1**: build/test/lint commands pass
- **L2** (optional): AI review approves diff quality

## Safety posture

- single-run lock to prevent concurrent Anton conflicts
- clean-tree check by default
- bounded rollback strategy on failure
- explicit time/token/task ceilings

## Troubleshooting

**Run appears stuck / already active**
- check lock state under `~/.local/state/idlehands/`

**Tasks not detected**
- confirm `- [ ]` checkbox syntax
- ensure lines are not inside fenced code blocks

**Verification keeps failing**
- run build/test/lint manually
- use `--dry-run` to inspect execution plan
- use `--verbose` for richer run output
