# IdleHands Codebase Review

**Reviewed by:** Cerby 🐺  
**Branch:** `feature/multi-agent-routing`  
**Date:** 2026-02-19

---

## Executive Summary

IdleHands is a **local-first coding agent CLI** for OpenAI-compatible endpoints. It's a mature, well-architected TypeScript project (~96 source files, ~15k+ LOC) with:

- **TUI-first UX** with streaming output, slash commands, and interactive approvals
- **Runtime orchestration** for managing local/remote model stacks (hosts, backends, models)
- **Trifecta subsystem** (Vault + Replay + Lens) for persistent memory, checkpointing, and structural code compression
- **Bot frontends** (Telegram + Discord) with full session management
- **Multi-agent routing** (new feature) for Discord with tiered model escalation
- **Anton** autonomous task runner for batch task execution

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        ENTRY POINTS                              │
├─────────────────────────────────────────────────────────────────┤
│  src/index.ts          CLI entry, REPL, subcommand routing      │
│  src/tui/controller.ts Full-screen TUI mode                     │
│  src/bot/discord.ts    Discord bot frontend                     │
│  src/bot/telegram.ts   Telegram bot frontend                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         CORE AGENT                               │
├─────────────────────────────────────────────────────────────────┤
│  src/agent.ts          Main agent loop, tool dispatch, sessions │
│  src/client.ts         OpenAI-compatible API client             │
│  src/harnesses.ts      Model-specific behavior profiles         │
│  src/tools.ts          File, exec, search tool implementations  │
│  src/safety.ts         Command/path safety checks               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      TRIFECTA SUBSYSTEM                          │
├─────────────────────────────────────────────────────────────────┤
│  src/vault.ts          SQLite-backed persistent memory          │
│  src/replay.ts         File checkpoints + undo/rewind           │
│  src/lens.ts           Tree-sitter structural code projection   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    RUNTIME ORCHESTRATION                         │
├─────────────────────────────────────────────────────────────────┤
│  src/runtime/store.ts  Hosts, backends, models config           │
│  src/runtime/planner.ts Runtime selection logic                 │
│  src/runtime/executor.ts Model lifecycle (start/stop/health)    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SUPPORTING SYSTEMS                          │
├─────────────────────────────────────────────────────────────────┤
│  src/anton/            Autonomous task runner subsystem         │
│  src/mcp.ts            Model Context Protocol integration       │
│  src/lsp.ts            Language Server Protocol integration     │
│  src/confirm/          Confirmation providers (terminal/auto)   │
│  src/cli/              CLI commands, input handling, status     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Subsystems

### 1. Agent Core (`src/agent.ts`)

The heart of the system. A ~3400 line module that handles:

- **Session creation** with config merging, harness selection, vision detection
- **Agent loop** with tool calls, confirmation flow, streaming, and context management
- **Tool dispatch** with safety checks, retry logic, and result summarization
- **Sub-agent spawning** via `spawn_task` for parallel isolated tasks
- **Plan mode** for accumulating steps before execution
- **Context compaction** when approaching token limits

**Key types:**
- `AgentSession` - the main session interface
- `AgentHooks` - callbacks for streaming, tool events, turn stats
- `TurnPerformance` - metrics per agent turn

**Notable patterns:**
- XML tool call parsing fallback for models that emit `<tool_call>` in content
- Harness-driven behavior (thinking tokens, quirks, retry limits)
- Project-scoped vault entries to prevent cross-project leaks

### 2. Trifecta Subsystem

#### Vault (`src/vault.ts`)
SQLite-backed persistent memory with FTS5 search:
- Notes: User-created key-value entries
- Tool archives: Auto-saved high-signal tool results
- Project scoping: Entries tagged by project dir, prioritized in search

#### Replay (`src/replay.ts`)
File checkpoint system:
- Creates before/after snapshots on each file mutation
- Supports rewind/undo to any checkpoint
- FIFO rotation (default 200 checkpoints)

#### Lens (`src/lens.ts`)
Structural code projection using tree-sitter:
- Extracts function/class/method signatures
- Compresses large files to skeleton form
- Language support: TS, JS, Python, Rust, Go, C/C++, Java, Ruby, PHP, Kotlin
- Fallback regex extraction when tree-sitter unavailable

### 3. Bot Frontends

#### Discord (`src/bot/discord.ts`)

Full-featured Discord integration with:
- **Multi-agent routing** (new): Route users/channels/guilds to different agent personas
- **Model escalation**: Automatic or keyword-triggered escalation to larger models
- **Tiered escalation**: Multiple escalation tiers with per-tier endpoints
- **Auto-deescalation**: Returns to base model after each request
- **Slash commands**: /help, /new, /status, /agent, /escalate, /deescalate
- **Session management**: Per-user sessions with timeout cleanup
- **Anton integration**: /anton commands for autonomous task running

**Escalation flow:**
1. Check keyword triggers before calling model
2. If model responds with `[ESCALATE: reason]`, switch to next model
3. Re-run the same request on the escalated model
4. Auto-deescalate back to base after completion

#### Telegram (`src/bot/telegram.ts`)
Similar session management, confirmation via inline keyboards, streaming edits.

### 4. TUI System (`src/tui/`)

Full-screen terminal UI using raw stdin/stdout manipulation:
- **State management**: Immutable state with reducer pattern (`state.ts`)
- **Rendering**: Custom terminal drawing (`render.ts`, `screen.ts`)
- **Keymap**: Vi-style keybindings (`keymap.ts`)
- **Branch picker**: Browse/checkout conversation branches
- **Confirmation**: In-TUI approval dialogs (`confirm.ts`)

### 5. Anton (`src/anton/`)

Autonomous task runner for batch operations:
- **Parser**: Reads task files (markdown checklists)
- **Controller**: Main orchestration loop
- **Verifier**: Runs build/test/lint verification
- **Lock**: Prevents concurrent Anton runs
- **Session**: Isolated sessions per task

### 6. Runtime Orchestration (`src/runtime/`)

Manages local model servers and backends:
- **Hosts**: Local/SSH machines with GPU capabilities
- **Backends**: llama-server, vLLM, etc. with start/stop commands
- **Models**: GGUF/safetensors with backend affinity

### 7. Harnesses (`src/harnesses.ts`)

Model-specific behavior profiles:
- **Thinking format**: XML `<think>` tags vs none
- **Tool call reliability**: Whether model uses tool_calls array correctly
- **Quirks**: Loop detection, param omission, markdown in args
- **Defaults**: Temperature, max_tokens, vault mode

Built-in harnesses: qwen3-coder, qwen3-moe, qwen, nemotron, mistral, gpt-oss, llama, generic

---

## Recent Feature: Multi-Agent Routing (Branch: feature/multi-agent-routing)

### Commits Analysis

```
4decacf feat: Discord slash commands + per-tier endpoint support for escalation
ee9c09a feat(discord): allow higher-tier escalation + auto-deescalate
4547993 fix(discord): re-acquire turn after keyword escalation
e709933 feat(discord): add tiered keyword escalation
46544e2 fix(discord): update turnId after escalation session recreation
a17a9f9 feat(discord): add keyword-based auto-escalation
2c5579d feat(discord): add auto-escalation support
2f771a3 feat(discord): add model escalation support
8dcbf31 feat(discord): add multi-agent routing support
```

### New Types (`src/types.ts`)

```typescript
// Keyword tier for tiered escalation
type KeywordTier = {
  keywords?: string[];
  keyword_presets?: Array<'coding' | 'planning' | 'complex'>;
  endpoint?: string;  // Per-tier endpoint override
};

// Model escalation config
type ModelEscalation = {
  models: string[];           // Ordered list to escalate through
  auto?: boolean;             // Enable auto-escalation (default: true)
  max_escalations?: number;   // Prevent infinite loops (default: 1)
  tiers?: KeywordTier[];      // Tiered keyword triggers
};

// Agent persona for routing
type AgentPersona = {
  id: string;
  display_name?: string;
  model?: string;
  endpoint?: string;
  system_prompt?: string;
  escalation?: ModelEscalation;
  // ... other overrides
};

// Routing rules
type AgentRouting = {
  default?: string;
  users?: Record<string, string>;
  channels?: Record<string, string>;
  guilds?: Record<string, string>;
};
```

### Config Example

```json
{
  "bot": {
    "discord": {
      "agents": {
        "fast": {
          "id": "fast",
          "display_name": "Fast Bot",
          "model": "qwen3-coder-7b",
          "escalation": {
            "models": ["qwen3-coder-32b", "claude-3-opus"],
            "tiers": [
              { "keyword_presets": ["coding"] },
              { "keyword_presets": ["complex", "planning"], "endpoint": "https://api.anthropic.com/v1" }
            ]
          }
        }
      },
      "routing": {
        "default": "fast",
        "users": { "123456": "premium" }
      }
    }
  }
}
```

---

## Code Patterns & Conventions

### TypeScript Style
- ES modules with `.js` extensions in imports
- Strict null checks enabled
- Heavy use of async/await
- Type imports separated from value imports

### Error Handling
- Custom error classes with `retryable` flags
- Graceful degradation (e.g., vault falls back on SQLite failures)
- `IDLEHANDS_QUIET_WARNINGS` env var to suppress non-critical warnings

### State Management
- TUI uses immutable state with reducer pattern
- Bot sessions use mutable `ManagedSession` objects with state machine (`idle`/`running`/`canceling`/`resetting`)

### Testing
- Node.js built-in test runner (`node --test`)
- Tests in `tests/` directory
- TUI tests in `tests/tui/`

---

## Potential Issues & Tech Debt

### 1. Large Monolithic Files
- `agent.ts` at ~3400 lines is doing a lot
- Consider splitting: tool dispatch, sub-agent management, context compaction

### 2. Discord Bot Complexity
- `discord.ts` at ~1650 lines with escalation logic embedded
- Could extract escalation state machine to separate module

### 3. Session Recreation Pattern
After escalation, the Discord bot recreates the entire session:
```typescript
await recreateSession(managed, cfg);
// Re-acquire turn after recreation - must update turnId!
const newTurn = beginTurn(managed);
```
This works but loses conversation history. Consider session cloning instead.

### 4. Hardcoded Keyword Presets
Keyword presets are hardcoded in `discord.ts`:
```typescript
const KEYWORD_PRESETS: Record<string, string[]> = {
  coding: ['build', 'implement', 'create', ...],
  planning: ['plan', 'design', 'roadmap', ...],
  complex: ['full', 'complete', 'comprehensive', ...],
};
```
Could be moved to config or user-definable.

### 5. No Telegram Multi-Agent
Multi-agent routing is Discord-only. Telegram bot uses single agent.

### 6. Rate Limiting
`RateLimiter` class exists but is per-client instance. No global rate limiting across sessions.

### 7. Memory Cleanup
Some resources (tree-sitter Language objects, SQLite connections) have cleanup methods but disposal isn't always explicit.

---

## Recommendations

### Short-term
1. Add tests for multi-agent routing logic
2. Extract escalation state machine to `src/bot/escalation.ts`
3. Add config validation for `tiers` array length vs `models` array length
4. Document the escalation feature in docs/guide/bots.md

### Medium-term
1. Refactor `agent.ts` into smaller modules
2. Add Telegram multi-agent support
3. Move keyword presets to config
4. Add session cloning for escalation (preserve history)

### Long-term
1. Consider WebSocket support for real-time model server monitoring
2. Add per-user rate limiting for bot frontends
3. Explore conversation branching in Discord (like TUI branches)

---

## File Reference

| Path | Purpose | Lines |
|------|---------|-------|
| `src/agent.ts` | Core agent loop | ~3400 |
| `src/bot/discord.ts` | Discord frontend | ~1650 |
| `src/bot/telegram.ts` | Telegram frontend | ~800 |
| `src/tui/controller.ts` | TUI orchestration | ~370 |
| `src/vault.ts` | Persistent memory | ~500 |
| `src/replay.ts` | File checkpoints | ~150 |
| `src/lens.ts` | Code projection | ~450 |
| `src/tools.ts` | Tool implementations | ~1200 |
| `src/harnesses.ts` | Model profiles | ~250 |
| `src/client.ts` | API client | ~830 |
| `src/config.ts` | Config loading | ~540 |
| `src/types.ts` | Type definitions | ~400 |
| `src/index.ts` | CLI entry | ~600 |
| `src/anton/controller.ts` | Anton orchestrator | ~420 |
| `src/runtime/store.ts` | Runtime config | ~290 |

---

## Summary

IdleHands is a well-structured, feature-rich coding agent with excellent local-first design. The multi-agent routing feature is a solid addition that enables sophisticated Discord bot deployments with automatic model escalation. The codebase is clean TypeScript with good separation of concerns, though some files (agent.ts, discord.ts) would benefit from further modularization.

The Trifecta subsystem (Vault/Replay/Lens) is particularly well-designed for LLM workflows, providing persistent memory, undo capability, and intelligent code compression. The harness system elegantly handles model-specific quirks.

**Ready for continued development.** 🐺
