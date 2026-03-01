---
summary: "CLI reference for `idlehands reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "reset"
---

# `idlehands reset`

Reset local config/state (keeps the CLI installed).

```bash
idlehands reset
idlehands reset --dry-run
idlehands reset --scope config+creds+sessions --yes --non-interactive
```
