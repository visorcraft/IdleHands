# Command Reference

Idle Hands provides a broad slash-command surface for session control, runtime management, safety, and recovery.

## Session

- `/help`, `/about`, `/status`, `/history`, `/clear`
- `/compact [topic|hard|dry]`
- `/save <path>`, `/load <path>`, `/sessions`
- `/conv branch <name>`, `/conv branches`, `/conv checkout <name>`, `/conv merge <name>`
- `/new`, `/quit`, `/exit`

## Observability and diagnostics

- `/cost` — Show estimated token cost from current session usage
- `/metrics` — Show latency, throughput, cache, and route diagnostics
- `/server`, `/perf`, `/stats`

## Hooks

- `/hooks` — Inspect hook system status
- `/hooks status` — Hook snapshot + recent event counts
- `/hooks plugins` — Installed plugin grants/requests/denials
- `/hooks errors` — Recent hook errors
- `/hooks slow` — Recently slow handlers

## Model / server / project integration

- `/model`, `/model list`, `/model <name>`, `/model <endpoint> <name>`
- `/offline [on|off|status]`
- `/capture on [path]`, `/capture off`, `/capture last [path]`
- `/mcp_discover` — Discover MCP servers from project files
- `/mcp`, `/mcp desc`, `/mcp restart <name>`, `/mcp enable <tool>`, `/mcp disable <tool>`
- `/hosts`, `/backends`, `/models`, `/runtime`, `/select <model-id>`, `/health`

## Editing / mode / approvals

- `/edit [seed]`, `/mode [code|sys]`, `/routing_mode [auto|fast|heavy]`
- `/system`, `/system tokens`, `/system edit`, `/system reset`
- `/approval [plan|reject|default|auto-edit|yolo]`
- `/plan [on|off|toggle|show]`, `/step [on|off|toggle]`
- `/approve [N]`, `/reject`
- `/quiet`, `/normal`, `/verbose`
- `/theme [name|list]`, `/vim`, `/statusbar [on|off]`

## Project / git / watch

- `/init`, `/git`, `/git diff`
- `/branch`, `/branch <name>`
- `/changes [--full|--since N|reset|<file>]`
- `/watch status`, `/watch off`, `/watch <paths...> [--max N]`
- `/index`, `/index status`, `/index stats`, `/index clear`
- `/undo [path]`

## Trifecta / memory

- `/vault <query>`, `/notes`, `/note <key> <value>`
- `/checkpoints`, `/rewind <id>`, `/diff <id>`

## Anton

- `/anton <file>`
- `/anton status`
- `/anton stop`
- `/anton last`

## Prompt shortcuts + shell helpers

Built-in templates:

- `/fix`, `/review`, `/test`, `/explain`, `/refactor`

Shell helpers:

- `!` enter direct shell mode
- `!<cmd>` run shell command
- `!!<cmd>` run shell command and inject output
- `/exit-shell` leave direct shell mode