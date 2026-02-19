# Command Reference

Idle Hands includes 53 primary slash commands, plus aliases/templates/custom commands.

## Session

- `/help`, `/about`, `/status`, `/history`, `/clear`
- `/compact [topic|hard|dry]`
- `/save <path>`, `/load <path>`, `/sessions`
- `/conv branch <name>`, `/conv branches`, `/conv checkout <name>`, `/conv merge <name>`
- `/quit`, `/exit`

## Model / server / diagnostics

- `/model`, `/model list`, `/model <name>`, `/model <endpoint> <name>`
- `/server`, `/perf`, `/stats`, `/cost`
- `/offline [on|off|status]`
- `/capture on [path]`, `/capture off`, `/capture last [path]`

## Editing / mode / approvals

- `/edit [seed]`, `/mode [code|sys]`
- `/system`, `/system tokens`, `/system edit`, `/system reset`
- `/approval [plan|default|auto-edit|yolo]`
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

## Integrations

- `/lsp [status]`
- `/mcp`, `/mcp desc`, `/mcp restart <name>`, `/mcp enable <tool>`, `/mcp disable <tool>`
- `/commands`
- `/hosts`, `/backends`, `/models`, `/runtime`, `/select <model-id>`, `/health`

## Anton

- `/anton <file>`
- `/anton status`
- `/anton stop`
- `/anton last`

## Prompt shortcuts and shell helpers

Built-in templates: `/fix`, `/review`, `/test`, `/explain`, `/refactor`

Shell helpers:
- `!` enters direct shell mode
- `!<cmd>` runs a shell command
- `!!<cmd>` runs and injects output into context
- `/exit-shell` exits direct shell mode
