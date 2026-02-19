# Anton Autonomous Runner

Anton executes a markdown task list autonomously, verifies results, and commits successful task changes.

```bash
idlehands
/anton TASKS.md
```

## Commands

- `/anton <file>` — start run
- `/anton status` — current progress
- `/anton stop` — stop run
- `/anton last` — last run results

## Behavior highlights

- Fresh agent context per task (avoids context pollution)
- Tiered verification cascade:
  1. Agent reports completion
  2. Build/test/lint checks
  3. Optional AI review
- Auto-commit per successful task
- Atomic rollback on failure
- Resume-friendly skipping of already-checked tasks

See also: existing project deep-dive doc at `docs/anton.md`.
