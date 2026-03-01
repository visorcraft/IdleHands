---
summary: "CLI reference for `idlehands agents` (list/add/delete/bindings/bind/unbind/set identity)"
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
title: "agents"
---

# `idlehands agents`

Manage isolated agents (workspaces + auth + routing).

Related:

- Multi-agent routing: [Multi-Agent Routing](/concepts/multi-agent)
- Agent workspace: [Agent workspace](/concepts/agent-workspace)

## Examples

```bash
idlehands agents list
idlehands agents add work --workspace ~/.idlehands/workspace-work
idlehands agents bindings
idlehands agents bind --agent work --bind telegram:ops
idlehands agents unbind --agent work --bind telegram:ops
idlehands agents set-identity --workspace ~/.idlehands/workspace --from-identity
idlehands agents set-identity --agent main --avatar avatars/idlehands.png
idlehands agents delete work
```

## Routing bindings

Use routing bindings to pin inbound channel traffic to a specific agent.

List bindings:

```bash
idlehands agents bindings
idlehands agents bindings --agent work
idlehands agents bindings --json
```

Add bindings:

```bash
idlehands agents bind --agent work --bind telegram:ops --bind discord:guild-a
```

If you omit `accountId` (`--bind <channel>`), IdleHands resolves it from channel defaults and plugin setup hooks when available.

### Binding scope behavior

- A binding without `accountId` matches the channel default account only.
- `accountId: "*"` is the channel-wide fallback (all accounts) and is less specific than an explicit account binding.
- If the same agent already has a matching channel binding without `accountId`, and you later bind with an explicit or resolved `accountId`, IdleHands upgrades that existing binding in place instead of adding a duplicate.

Example:

```bash
# initial channel-only binding
idlehands agents bind --agent work --bind telegram

# later upgrade to account-scoped binding
idlehands agents bind --agent work --bind telegram:ops
```

After the upgrade, routing for that binding is scoped to `telegram:ops`. If you also want default-account routing, add it explicitly (for example `--bind telegram:default`).

Remove bindings:

```bash
idlehands agents unbind --agent work --bind telegram:ops
idlehands agents unbind --agent work --all
```

## Identity files

Each agent workspace can include an `IDENTITY.md` at the workspace root:

- Example path: `~/.idlehands/workspace/IDENTITY.md`
- `set-identity --from-identity` reads from the workspace root (or an explicit `--identity-file`)

Avatar paths resolve relative to the workspace root.

## Set identity

`set-identity` writes fields into `agents.list[].identity`:

- `name`
- `theme`
- `emoji`
- `avatar` (workspace-relative path, http(s) URL, or data URI)

Load from `IDENTITY.md`:

```bash
idlehands agents set-identity --workspace ~/.idlehands/workspace --from-identity
```

Override fields explicitly:

```bash
idlehands agents set-identity --agent main --name "IdleHands" --emoji "🖐️" --avatar avatars/idlehands.png
```

Config sample:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "IdleHands",
          theme: "space hand",
          emoji: "🖐️",
          avatar: "avatars/idlehands.png",
        },
      },
    ],
  },
}
```
