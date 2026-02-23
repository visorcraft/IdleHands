# Hooks & Plugins

Idle Hands includes a modular hook system so you can extend behavior without editing core files.

## What hooks exist

Current lifecycle hooks:

- `session_start`
- `model_changed`
- `ask_start`
- `turn_start`
- `tool_call`
- `tool_result`
- `turn_end`
- `ask_end`
- `ask_error`

All hook handlers receive:

- event payload
- context `{ sessionId, cwd, model, harness, endpoint }`

## Configure hooks

```json
{
  "hooks": {
    "enabled": true,
    "strict": false,
    "warn_ms": 250,
    "allow_capabilities": [
      "observe",
      "read_prompts",
      "read_responses",
      "read_tool_args",
      "read_tool_results"
    ],
    "plugin_paths": [
      "./dist/hooks/plugins/example-console.js",
      "./plugins/my-hook.js"
    ]
  }
}
```

### Environment variables

- `IDLEHANDS_HOOKS_ENABLED`
- `IDLEHANDS_HOOKS_STRICT`
- `IDLEHANDS_HOOK_PLUGIN_PATHS` (comma-separated)
- `IDLEHANDS_HOOK_WARN_MS`
- `IDLEHANDS_HOOK_ALLOW_CAPABILITIES` (comma-separated)

## Plugin format

A plugin can export one of:

- `default` plugin object
- `plugin` plugin object
- `createPlugin()` returning a plugin object

Example:

```js
/** @type {import('../dist/hooks/index.js').HookPlugin} */
const plugin = {
  name: 'my-plugin',
  hooks: {
    ask_start: ({ askId, instruction }, ctx) => {
      console.error(`[my-plugin] ask_start ${askId} ${ctx.model}: ${instruction}`)
    },
    tool_result: ({ result }) => {
      if (!result.success) {
        console.error(`[my-plugin] tool failed: ${result.name} => ${result.summary}`)
      }
    }
  }
}

export default plugin
```

## Capability sandbox

Plugin capabilities are default-deny.

- Global allowlist is controlled by `hooks.allow_capabilities`.
- Each plugin can request capabilities via `plugin.capabilities`.
- Granted capabilities = intersection of requested + allowed.
- Missing capabilities are redacted in payloads (instead of exposing raw data).

Capabilities:
- `observe`
- `read_prompts`
- `read_responses`
- `read_tool_args`
- `read_tool_results`

## Safety model

- Non-strict mode (`strict: false`) isolates plugin failures and logs warnings.
- Strict mode (`strict: true`) treats plugin failure as fatal for that operation.
- Slow hook handlers emit warnings when runtime exceeds `warn_ms`.
- TUI/CLI hook inspector: `/hooks [status|errors|slow|plugins]`.

## Scaffolding a new plugin

From the CLI/TUI session:

```bash
/plugin init my-plugin
```

Optional:

```bash
/plugin init my-plugin ./plugins --force
```

This creates a starter plugin with `index.ts` + `README.md`.

## Inspector

Use:

```bash
/hooks
/hooks plugins
/hooks errors
/hooks slow
```

In TUI, `/hooks ...` opens an inspector overlay so you can browse plugin status/errors quickly.

## Recommended usage

- Keep hooks fast and side-effect-light.
- Use hooks for telemetry, policy checks, audit trails, and custom integrations.
- Avoid mutating shared state unless you explicitly control ordering.
