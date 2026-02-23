# Anton Autonomous Runner

Anton executes a markdown checklist autonomously, verifies results, and commits successful task changes.

```bash
idlehands
/anton worklist.md
```

## Commands

- `/anton <file>` — start run
- `/anton status` — current progress
- `/anton stop` — stop run
- `/anton last` — last run results

## Behavior highlights

- Fresh agent context per task attempt (reduces context pollution)
- Tiered verification cascade:
  1. Agent reports completion
  2. Build/test/lint checks
  3. Optional AI review
- Auto-commit per successful task
- Rollback on failed attempts
- Resume-friendly skipping of already-checked items

See also: [Anton deep dive](/anton)
