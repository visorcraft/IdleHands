# Anton — Autonomous Task Runner

## What is Anton?

Anton is Idle Hands' autonomous task runner. Give it a markdown task file and it works through each unchecked item — writing code, running verification, and committing results — without human intervention.

### Lineage

- **Ralph Wiggum** — earliest prototype, no verification, no guardrails.
- **Pickle Rick** — added tiered verification and retry logic.
- **Anton** — production version in Idle Hands. Controller-owned checkboxes, stable task keys, bounded rollback, and fresh agent context per attempt.

## Quick Start

```bash
# Create a task file
cat > TASKS.md << 'EOF'
# My Tasks

- [ ] Add input validation to src/api.ts
- [ ] Write unit tests for validation
- [ ] Update README with new API docs
EOF

# Run Anton
idlehands
> /anton TASKS.md
```

Anton parses the file, works through each unchecked task, verifies its work, commits if successful, and moves on.

## How It Works

```
┌──────────────────────────────────────────────┐
│                  /anton run                   │
│                                              │
│  1. Acquire lock                             │
│  2. Parse task file                          │
│  3. Detect verification commands             │
│  4. Clean-tree check                         │
│                                              │
│  ┌─── Main Loop ──────────────────────────┐  │
│  │  Pick next runnable task               │  │
│  │  ↓                                     │  │
│  │  Create fresh agent session            │  │
│  │  ↓                                     │  │
│  │  Build prompt with context             │  │
│  │  ↓                                     │  │
│  │  Agent executes task                   │  │
│  │  ↓                                     │  │
│  │  Verification cascade (L0→L1→L2)      │  │
│  │  ↓                                     │  │
│  │  Pass? → commit + mark checked         │  │
│  │  Fail? → rollback + retry or skip      │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  5. Release lock                             │
│  6. Print summary                            │
└──────────────────────────────────────────────┘
```

### Key design decisions

- **Controller owns checkboxes**: The agent never marks tasks as done. Only the controller marks a task checked after verification passes.
- **Fresh context per attempt**: Each task attempt gets a new agent session. No accumulated context pollution.
- **Stable task keys**: Tasks are identified by SHA-256 hash (phase path + depth + text + sibling ordinal), not line numbers. This survives file edits.
- **Atomic file writes**: All task file mutations use write-to-temp + `fs.rename()` to prevent corruption.

## Task File Format

Standard markdown with checkboxes:

```markdown
# Phase 1 — Setup

- [ ] Initialize project structure
- [ ] Configure TypeScript
  - [ ] tsconfig.json
  - [ ] Build script

# Phase 2 — Implementation

- [x] Already completed task (skipped)
- [ ] Write the parser
- [ ] Write tests
```

**Rules:**
- Headings (`#`, `##`, etc.) define phases/sections.
- `- [ ]` = pending task, `- [x]` = completed (skipped).
- Indented items are children. Children must complete before their parent.
- Tasks inside fenced code blocks are ignored.
- Continuation lines (indented non-checkbox text) are appended to the task above.

## CLI Reference

### Commands

| Command | Description |
|---|---|
| `/anton <file> [flags]` | Start autonomous task runner |
| `/anton run <file> [flags]` | Same as above |
| `/anton status` | Show current progress |
| `/anton stop` | Stop after current task |
| `/anton last` | Show last run results |
| `/anton help` | Show usage |

### Flags

| Flag | Default | Description |
|---|---|---|
| `--max-retries <n>` | 3 | Max retries per task |
| `--max-iterations <n>` | 200 | Max total loop iterations |
| `--task-timeout <sec>` | 600 | Per-task timeout |
| `--total-timeout <sec>` | 7200 | Total time budget |
| `--max-tokens <n>` | unlimited | Total token budget |
| `--auto-commit` | true | Git commit each success |
| `--allow-dirty` | false | Allow dirty working tree |
| `--verify-ai` | true | Enable L2 AI verification |
| `--decompose` | true | Allow task decomposition |
| `--max-decompose-depth <n>` | 2 | Max decomposition nesting |
| `--max-total-tasks <n>` | 500 | Prevent decomposition explosion |
| `--skip-on-fail` | true | Skip failed tasks vs. abort |
| `--build-command <cmd>` | auto-detect | Custom build command |
| `--test-command <cmd>` | auto-detect | Custom test command |
| `--lint-command <cmd>` | auto-detect | Custom lint command |
| `--approval <mode>` | yolo | Agent approval mode |
| `--verbose` | false | Stream agent tokens |
| `--dry-run` | false | Show plan without executing |

## Verification Levels

Anton uses a three-level verification cascade:

### L0 — Agent Completion

The agent must report `status: done` in its structured result block. If the agent reports `blocked` or `decompose`, verification stops.

### L1 — Build / Test / Lint

If detected (or overridden), Anton runs:
1. Build command (e.g., `npm run build`)
2. Test command (e.g., `npm test`)
3. Lint command (e.g., `npm run lint`)

All must pass (exit code 0). Auto-detection checks `package.json`, `Cargo.toml`, `Makefile`, and Python config files.

### L2 — AI Code Review (optional)

When `--verify-ai` is enabled and there's a diff to review, Anton spawns a separate AI session to review the changes against the task description. The reviewer must explicitly approve; unknown or malformed output = FAIL.

## Task Decomposition

When a task is too large, the agent can respond with `status: decompose` and a list of subtasks. Anton inserts these as children of the original task and continues the loop.

- Controlled by `--decompose` (default: true)
- Max nesting: `--max-decompose-depth` (default: 2)
- Total task limit: `--max-total-tasks` (default: 500) prevents runaway decomposition

## Configuration

Add an `anton` block to `~/.config/idlehands/config.json`:

```json
{
  "anton": {
    "max_retries": 3,
    "max_iterations": 200,
    "task_timeout_sec": 600,
    "total_timeout_sec": 7200,
    "verify_ai": true,
    "decompose": true,
    "max_decompose_depth": 2,
    "max_total_tasks": 500,
    "skip_on_fail": true,
    "approval_mode": "yolo",
    "verbose": false,
    "auto_commit": true
  }
}
```

All values can be overridden per-run via flags. Environment variable overrides use the `IDLEHANDS_ANTON_` prefix (e.g., `IDLEHANDS_ANTON_MAX_RETRIES=5`).

## Safety

- **Cross-process lock**: Only one Anton run at a time (per state directory). Stale locks are auto-reclaimed.
- **Dirty tree check**: Refuses to start on a dirty working tree unless `--allow-dirty` is passed.
- **Bounded rollback**: Failed attempts restore tracked changes via `git checkout -- .`. Aggressive clean (`git clean -fd`) is opt-in.
- **Approval mode**: Defaults to `yolo` (auto-approve all agent actions). Use `auto-edit` or `plan` for more control.
- **Token budget**: Set `--max-tokens` to cap spending.
- **Time budget**: Set `--total-timeout` to cap wall-clock time.
- **Task limit**: `--max-total-tasks` prevents decomposition bombs.
- **REPL guard**: Warning shown when sending prompts or shell commands while Anton is active.
- **Abort**: `/anton stop` sets the abort flag; run halts after the current task finishes.

## Troubleshooting

**"Anton: Run already in progress"**
A previous run didn't clean up. The lock file is at `~/.local/state/idlehands/anton.lock`. Check if the PID is still alive; if not, delete the lock file.

**Tasks not being picked up**
- Ensure tasks use `- [ ]` format (space between brackets).
- Check that tasks aren't inside fenced code blocks.
- Children must be indented (2+ spaces or tab).

**Verification always failing**
- Check that your build/test commands work manually.
- Use `--dry-run` to see what commands Anton would run.
- Use `--verbose` to see agent output.

**Agent can't complete tasks**
- Try increasing `--task-timeout`.
- Check that the project has proper context (README, relevant source files).
- Consider breaking large tasks into smaller ones in your task file.
