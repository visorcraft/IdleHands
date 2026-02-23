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
- `timeout`, `max_iterations`, `response_timeout`, `connection_timeout`
- `initial_connection_check`, `initial_connection_timeout`
- `approval_mode`: `plan/reject/default/auto-edit/yolo`
- `mode`: `code` or `sys`
- `context_window`, `context_max_tokens`
- `context_summarize`, `context_summary_max_tokens`
- `theme`, `vim_mode`, `harness`
- `offline`, `auto_update_check`
- `mcp_tool_budget`, `mcp_call_timeout_sec`
- `watchdog_timeout_ms`, `watchdog_max_compactions`, `watchdog_idle_grace_timeouts`
- `debug_abort_reason`
- `hooks.enabled`, `hooks.strict`, `hooks.warn_ms`, `hooks.allow_capabilities`, `hooks.plugin_paths`

## Project context behavior

Idle Hands can load project bootstrap context from `.idlehands.md`, `AGENTS.md`, or a configured context file.

```json
{
  "context_max_tokens": 8192,
  "context_summarize": true,
  "context_summary_max_tokens": 1024
}
```

- `context_max_tokens`: hard cap for context injection payload.
- `context_summarize` (default `true`): summarize oversized context files instead of hard-failing.
- `context_summary_max_tokens`: target budget for the summary payload.

When summarization is used, Idle Hands injects a compact summary plus a retrieval hint so the model can fetch exact sections with `read_file(path, limit, search, format, max_bytes)`.

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

### `hooks`

```json
"hooks": {
  "enabled": true,
  "strict": false,
  "warn_ms": 250,
  "allow_capabilities": ["observe"],
  "plugin_paths": [
    "./dist/hooks/plugins/example-console.js"
  ]
}
```

Use hooks to extend session/model/tool lifecycle behavior without modifying core files.
See [Guide → Hooks & Plugins](/guide/hooks) for payloads and plugin examples.

### `tool_loop_auto_continue`

```json
"tool_loop_auto_continue": {
  "enabled": true,
  "max_retries": 5
}
```

Controls automatic retry behavior when the agent hits a critical tool loop (AgentLoopBreak).

- `enabled` (default `true`): when `true`, tool-loop breaks trigger automatic retries instead of stopping.
- `max_retries` (default `5`, range `1..10`): maximum number of auto-continue attempts before surfacing the error normally.

Applies to all surfaces: TUI, Telegram bot, Discord bot, and Anton task runner.

**Env:** `IDLEHANDS_TOOL_LOOP_AUTO_CONTINUE_ENABLED`, `IDLEHANDS_TOOL_LOOP_AUTO_CONTINUE_MAX_RETRIES`

### `bot`

`bot.telegram` supports token, allowlists, directory restrictions, queue/session limits, approval defaults, group controls, and `reply_to_user_messages` (native Telegram reply threading toggle).

`bot.discord` supports token, allowlists, directory restrictions, queue/session limits, approval defaults, guild controls (`guild_id`, `allow_guilds`), and `reply_to_user_messages` (native Discord reply threading toggle).

Both frontends also support:
- `watchdog_timeout_ms`
- `watchdog_max_compactions`
- `watchdog_idle_grace_timeouts`
- `debug_abort_reason`

When bot-specific watchdog fields are omitted, top-level watchdog fields are used as defaults.
