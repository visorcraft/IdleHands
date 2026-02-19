# Configuration Reference

Main config path:

```bash
~/.config/idlehands/config.json
```

Generate/update config interactively:

```bash
idlehands setup
```

## Key defaults (high level)

- `endpoint`: API base URL (runtime endpoint can override)
- `model`: model ID (empty = auto/select first)
- `dir`: working directory
- `max_tokens`, `temperature`, `top_p`
- `timeout`, `max_iterations`
- `approval_mode`: `plan/default/auto-edit/yolo`
- `mode`: `code` or `sys`
- `context_window`, `context_max_tokens`
- `theme`, `vim_mode`, `harness`
- `offline`, `auto_update_check`
- `mcp_tool_budget`, `mcp_call_timeout_sec`

## Structured sections

### `trifecta`

```json
"trifecta": {
  "enabled": true,
  "vault": { "enabled": true, "mode": "active" },
  "lens": { "enabled": true },
  "replay": { "enabled": true }
}
```

### `lsp`

```json
"lsp": {
  "enabled": false,
  "servers": [],
  "auto_detect": true,
  "proactive_diagnostics": true,
  "diagnostic_severity_threshold": 1
}
```

### `sub_agents`

```json
"sub_agents": {
  "enabled": true,
  "max_iterations": 50,
  "max_tokens": 16384,
  "timeout_sec": 600,
  "result_token_cap": 4000,
  "system_prompt": "You are a focused coding sub-agent. Execute only the delegated task.",
  "inherit_context_file": true,
  "inherit_vault": true
}
```

When `enabled` is `false`, the `spawn_task` tool is removed from the agent's tool
list entirely. The model works in single-agent mode.

**CLI:** `--no-sub-agents`
**Env:** `IDLEHANDS_NO_SUB_AGENTS=1`
**Setup wizard:** Step 5 — Sub-Agents

### `mcp`

```json
"mcp": {
  "servers": []
}
```

### `bot`

`bot.telegram` supports token, allowlists, directory restrictions, queue/session limits, approval defaults, and group controls.

`bot.discord` supports token, allowlists, directory restrictions, queue/session limits, approval defaults, and guild controls (`guild_id`, `allow_guilds`).
