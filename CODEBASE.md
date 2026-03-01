# IdleHands Codebase Deep Dive

> This is a comprehensive guide to the IdleHands codebase, written for AI agents and developers who need to understand the architecture deeply.

## What is IdleHands?

IdleHands is a **personal AI assistant gateway** — a local-first control plane that connects AI models to messaging channels (WhatsApp, Telegram, Discord, Slack, Signal, iMessage, etc.) and provides tools for browser control, device automation, and multi-agent orchestration.

**Key insight:** The Gateway is the brain. Everything else (channels, tools, nodes, apps) connects to it via WebSocket.

## Repository Overview

- **~500k lines of TypeScript** (ESM, strict typing)
- **Runtime:** Node.js 22+
- **Package manager:** pnpm (Bun supported for dev)
- **License:** MIT

## Directory Structure

```
idlehands/
├── src/                    # Core source code (~50 subdirectories)
│   ├── gateway/           # WebSocket server, HTTP endpoints, control plane
│   ├── agents/            # Pi agent runtime, tools, sandbox, skills
│   ├── channels/          # Channel plugin system, routing, allowlists
│   ├── cli/               # CLI commands and program structure
│   ├── commands/          # Command implementations (agent, gateway, etc.)
│   ├── config/            # Configuration types, validation, migration
│   ├── plugins/           # Plugin loading, registry, hook runner
│   ├── plugin-sdk/        # Exported SDK for extension authors
│   ├── discord/           # Discord channel (built-in)
│   ├── telegram/          # Telegram channel (built-in)
│   ├── slack/             # Slack channel (built-in)
│   ├── signal/            # Signal channel (built-in)
│   ├── whatsapp/          # WhatsApp channel (built-in, Baileys)
│   ├── imessage/          # iMessage channel (legacy)
│   ├── web/               # WebChat and web inbound handling
│   ├── browser/           # Browser automation (Playwright CDP)
│   ├── canvas-host/       # A2UI canvas rendering
│   ├── cron/              # Scheduled jobs and wake events
│   ├── sessions/          # Session management and state
│   ├── routing/           # Message routing and session keys
│   ├── media/             # Media pipeline (images, audio, video)
│   ├── tts/               # Text-to-speech
│   ├── memory/            # Memory/RAG system
│   ├── process/           # Process execution (exec tool)
│   ├── pairing/           # Device pairing flow
│   ├── security/          # Security policies
│   ├── infra/             # Infrastructure utilities
│   ├── terminal/          # Terminal UI helpers
│   ├── tui/               # Terminal UI components
│   └── ...
├── extensions/            # Channel plugins (npm packages)
│   ├── discord/           # Discord extension (separate from built-in)
│   ├── telegram/          # Telegram extension
│   ├── msteams/           # Microsoft Teams
│   ├── matrix/            # Matrix
│   ├── bluebubbles/       # BlueBubbles (iMessage)
│   ├── mattermost/        # Mattermost
│   ├── twitch/            # Twitch
│   ├── voice-call/        # Voice calls
│   └── ... (40+ extensions)
├── skills/                # Agent skills (bundled)
│   ├── coding-agent/      # Run coding agents (Codex, Claude Code)
│   ├── discord/           # Discord-specific skill
│   ├── weather/           # Weather lookups
│   ├── healthcheck/       # System health
│   ├── tmux/              # tmux control
│   └── ... (50+ skills)
├── apps/                  # Native apps
│   ├── macos/             # macOS menu bar app (SwiftUI)
│   ├── ios/               # iOS node (SwiftUI)
│   └── android/           # Android node (Kotlin)
├── docs/                  # Documentation (Mintlify)
├── ui/                    # Web UI (Lit components)
├── packages/              # Internal packages
├── scripts/               # Build/dev/release scripts
└── test/                  # E2E tests
```

## Architecture

### The Gateway (Heart of IdleHands)

The Gateway is a **WebSocket + HTTP server** that acts as the control plane:

```
Channels (WhatsApp/Telegram/Discord/...)
              │
              ▼
┌─────────────────────────────────┐
│           Gateway               │
│    ws://127.0.0.1:18789         │
│                                 │
│  ┌─────────────────────────┐   │
│  │ Channel Manager         │   │  ← Manages channel connections
│  ├─────────────────────────┤   │
│  │ Session Manager         │   │  ← Tracks conversation state
│  ├─────────────────────────┤   │
│  │ Agent Runtime (Pi)      │   │  ← Executes AI agent logic
│  ├─────────────────────────┤   │
│  │ Tool Registry           │   │  ← Browser, exec, cron, etc.
│  ├─────────────────────────┤   │
│  │ Plugin Loader           │   │  ← Extension channels/tools
│  ├─────────────────────────┤   │
│  │ Node Registry           │   │  ← Device nodes (iOS/Android/Mac)
│  └─────────────────────────┘   │
└─────────────────────────────────┘
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
  CLI     macOS App   WebChat
```

**Key files:**

- `src/gateway/server.impl.ts` — Main server startup
- `src/gateway/server-methods.ts` — WebSocket RPC handlers
- `src/gateway/server-chat.ts` — Agent event handling
- `src/gateway/server-channels.ts` — Channel manager
- `src/gateway/server-cron.ts` — Cron service
- `src/gateway/server-plugins.ts` — Plugin loading

### Configuration System

Config lives at `~/.idlehands/idlehands.json` (JSON5 format).

**Key types:**

- `src/config/types.ts` — Exports all config type modules
- `src/config/types.idlehands.ts` — Root `IdleHandsConfig` type
- `src/config/types.gateway.ts` — Gateway-specific config
- `src/config/types.channels.ts` — Channel config
- `src/config/types.agents.ts` — Agent config
- `src/config/zod-schema.ts` — Zod validation schema

Config is validated with Zod and TypeBox schemas. Migration from legacy formats is handled in `src/config/legacy-migrate.ts`.

### Agent System

IdleHands uses **Pi** (by Mario Zechner) as the agent runtime:

```
User Message → Gateway → Pi Agent Runtime → Tool Execution → Response
```

**Key files:**

- `src/agents/agent-scope.ts` — Agent ID resolution
- `src/agents/pi-embedded-runner/` — Embedded Pi runtime
- `src/agents/tools/` — Tool definitions
- `src/agents/skills/` — Skill loading and management
- `src/agents/sandbox/` — Docker sandbox for untrusted execution

**Agent workspaces:**

- Default: `~/.idlehands/workspace`
- Per-agent: `~/.idlehands/agents/<agentId>/workspace`
- Injected files: `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `USER.md`, `IDENTITY.md`

### Channel Plugin System

Channels are the messaging integrations. Some are built-in, others are extensions:

**Built-in channels:** Discord, Telegram, Slack, Signal, WhatsApp, iMessage, Web

**Extension channels:** Microsoft Teams, Matrix, BlueBubbles, Mattermost, Twitch, Zalo, etc.

**Plugin interface (`src/channels/plugins/types.plugin.ts`):**

```typescript
interface ChannelPlugin {
  id: ChannelId;
  meta: ChannelMeta;
  config?: ChannelConfigAdapter;
  setup?: ChannelSetupAdapter;
  auth?: ChannelAuthAdapter;
  messaging?: ChannelMessagingAdapter;
  outbound?: ChannelOutboundAdapter;
  // ... more adapters
}
```

**Key files:**

- `src/channels/plugins/index.ts` — Plugin registry
- `src/channels/plugins/types.ts` — Adapter interfaces
- `extensions/*/idlehands.plugin.json` — Plugin manifests

### Tools

Tools are actions the agent can take:

| Tool                         | Description                             |
| ---------------------------- | --------------------------------------- |
| `exec`                       | Run shell commands                      |
| `read`/`write`/`edit`        | File operations                         |
| `browser`                    | Browser automation via Playwright       |
| `canvas`                     | Render visual UI (A2UI)                 |
| `nodes`                      | Control device nodes (camera, location) |
| `cron`                       | Schedule jobs                           |
| `message`                    | Send messages to channels               |
| `web_search`/`web_fetch`     | Web research                            |
| `memory_search`/`memory_get` | RAG memory                              |
| `sessions_*`                 | Multi-agent orchestration               |
| `tts`                        | Text-to-speech                          |
| `image`                      | Image analysis                          |

**Key files:**

- `src/agents/tools/` — Tool implementations
- `src/process/` — Exec tool runtime
- `src/browser/` — Browser tool runtime

### Sessions

Sessions track conversation state:

- **Main session:** Direct chat with the user
- **Group sessions:** Per-group isolation
- **Isolated sessions:** Sub-agents and cron jobs

Session keys format: `<agentId>:<chatId>` or just `<chatId>` for default agent.

**Key files:**

- `src/sessions/` — Session state management
- `src/routing/session-key.ts` — Session key parsing
- `src/config/sessions.ts` — Session configuration

### Nodes

Nodes are paired devices that can execute device-local actions:

- **macOS node:** System commands, notifications, screen recording
- **iOS/Android nodes:** Camera, location, screen, notifications

Nodes connect to the Gateway via WebSocket and advertise capabilities.

**Key files:**

- `src/gateway/node-registry.ts` — Node registration
- `src/gateway/server-node-events.ts` — Node event handling
- `apps/macos/`, `apps/ios/`, `apps/android/` — Native apps

## Key Patterns

### Dependency Injection

Most subsystems use `createDefaultDeps()` for dependency injection:

```typescript
const deps = createDefaultDeps();
await someFunction({ ...deps, config });
```

### Logging

Use subsystem loggers:

```typescript
import { createSubsystemLogger } from "../logging/subsystem.js";
const log = createSubsystemLogger("my-subsystem");
log.info("message");
log.warn("warning");
log.error("error");
```

### TypeBox Schemas

Tool inputs use TypeBox for schema definition:

```typescript
import { Type } from "@sinclair/typebox";

const schema = Type.Object({
  message: Type.String(),
  optional: Type.Optional(Type.String()),
});
```

**Guardrail:** No `Type.Union` in tool schemas (breaks some validators).

### Testing

- Framework: Vitest
- Colocated tests: `*.test.ts` alongside source
- E2E tests: `*.e2e.test.ts` in `test/`
- Live tests: `IDLEHANDS_LIVE_TEST=1 pnpm test:live`

## Common Tasks

### Adding a new tool

1. Create tool definition in `src/agents/tools/`
2. Register in tool registry
3. Add to system prompt tool list

### Adding a new channel extension

1. Create extension in `extensions/<channel>/`
2. Implement `ChannelPlugin` interface
3. Add `idlehands.plugin.json` manifest
4. Export from `extensions/<channel>/index.ts`

### Adding a new skill

1. Create skill in `skills/<skill>/`
2. Add `SKILL.md` with instructions
3. Add supporting scripts/assets
4. Register in skill manifest if needed

## Configuration Reference

Minimal config:

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
}
```

Full reference: https://docs.idlehands.ai/gateway/configuration

## CLI Commands

```bash
idlehands onboard          # Setup wizard
idlehands gateway run      # Run gateway
idlehands agent            # Chat with agent
idlehands message send     # Send message
idlehands channels status  # Channel health
idlehands doctor           # Diagnose issues
idlehands config set       # Update config
idlehands skills list      # List skills
idlehands nodes list       # List paired nodes
```

## Security Model

- **Default:** Tools run on host for main session (full access)
- **Groups:** Can sandbox non-main sessions (`sandbox.mode: "non-main"`)
- **DM Policy:** `pairing` (require approval) or `open` (allow all)
- **Elevated:** Per-session toggle for sensitive operations

**Key files:**

- `SECURITY.md` — Security policy
- `src/security/` — Security utilities
- `src/gateway/auth.ts` — Authentication

## External Dependencies

Key dependencies:

- `@mariozechner/pi-*` — Pi agent runtime
- `grammy` — Telegram bot
- `@whiskeysockets/baileys` — WhatsApp
- `@buape/carbon` — Discord (fork)
- `@slack/bolt` — Slack
- `playwright-core` — Browser automation
- `sharp` — Image processing
- `undici` — HTTP client

## Quick Reference

| What            | Where                            |
| --------------- | -------------------------------- |
| Gateway server  | `src/gateway/server.impl.ts`     |
| Config types    | `src/config/types.ts`            |
| Channel plugins | `src/channels/plugins/`          |
| Agent runtime   | `src/agents/pi-embedded-runner/` |
| Tools           | `src/agents/tools/`              |
| Skills          | `skills/`                        |
| Extensions      | `extensions/`                    |
| CLI             | `src/cli/`                       |
| Native apps     | `apps/`                          |
| Docs            | `docs/`                          |
| Tests           | colocated `*.test.ts`            |

## Links

- **Docs:** https://docs.idlehands.ai
- **GitHub:** https://github.com/idlehands/idlehands
- **Discord:** https://discord.gg/clawd
- **ClawHub (skills):** https://clawhub.com
