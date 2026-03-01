---
summary: "CLI reference for `idlehands config` (get/set/unset config values)"
read_when:
  - You want to read or edit config non-interactively
title: "config"
---

# `idlehands config`

Config helpers: get/set/unset values by path. Run without a subcommand to open
the configure wizard (same as `idlehands configure`).

## Examples

```bash
idlehands config get browser.executablePath
idlehands config set browser.executablePath "/usr/bin/google-chrome"
idlehands config set agents.defaults.heartbeat.every "2h"
idlehands config set agents.list[0].tools.exec.node "node-id-or-name"
idlehands config unset tools.web.search.apiKey
```

## Paths

Paths use dot or bracket notation:

```bash
idlehands config get agents.defaults.workspace
idlehands config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
idlehands config get agents.list
idlehands config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--strict-json` to require JSON5 parsing. `--json` remains supported as a legacy alias.

```bash
idlehands config set agents.defaults.heartbeat.every "0m"
idlehands config set gateway.port 19001 --strict-json
idlehands config set channels.whatsapp.groups '["*"]' --strict-json
```

Restart the gateway after edits.
