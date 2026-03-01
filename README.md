# 🤚 Idle Hands

> *"The devil finds work for idle hands."*

**Idle Hands** is an autonomous AI coding agent built for running **local LLMs**. It connects your self-hosted model to your codebase and lets it loose — reading files, writing code, running tests, executing commands — all without touching the cloud.

Named after the 1999 cult classic where Anton's possessed hand develops a mind of its own, Idle Hands gives your local model a hand that **acts autonomously on your codebase**. You define the work. The hand does the rest.

---

## ✋ What Makes Idle Hands Different

**Your model. Your hardware. Your rules.**

Idle Hands is purpose-built for local inference. No API keys to OpenAI. No token metering. No data leaving your network. Just your GPU, your model, and a codebase that needs work done.

- **Local-first**: Designed around `llama-server`, `ollama`, `lmstudio`, and any OpenAI-compatible local endpoint
- **Agent autonomy**: The model reads your code, edits files, runs tests, and iterates — hands-free
- **Multi-surface**: Control it from **Telegram**, **Discord**, **CLI**, **TUI**, or any supported chat platform
- **Self-upgrading**: `/upgrade` checks GitHub for the latest release, installs it, and restarts — from any chat surface

---

## 🔪 /anton — The Possessed Hand

This is the flagship feature. Inspired by the movie, `/anton` is what happens when you chop the hand off and let it go.

### How It Works

You write a task document — a simple markdown checklist:

```markdown
# TASKS.md

## Phase 1: Core refactor
- [ ] Extract shared dispatcher from telegram callback handler
- [ ] Wire retry_fast, retry_heavy, cancel through shared dispatcher
- [ ] Add unit tests for all 3 dispatch actions

## Phase 2: Bot commands
- [ ] Add /upgrade command to all bot surfaces
- [ ] Add /dir command to view and set workspace
- [x] Set up CI pipeline (already done)
```

Then invoke it:

```
/anton TASKS.md
```

**The Idle Hands Orchestrator takes over:**

1. Parses the task document and finds the **first incomplete task** (`- [ ]`)
2. Spawns a **fresh, isolated agent session** for that single task
3. The agent reads your codebase, makes targeted edits, runs tests
4. On success: marks the task `- [x]` in the document and moves to the next
5. On failure: skips the task, logs the error, continues to the next
6. **Each task gets its own clean agent** — no context bleed, no accumulated confusion
7. When no incomplete tasks remain, the orchestrator completes and returns **final run stats**

The task document is the **single source of truth**. You can check it mid-run to see exactly where things stand. Every `[x]` was earned by a real agent execution with real test results.

### Live Progress

Anton pushes real-time updates to whatever surface you invoked it from:

```
🤚 Anton activated
📄 Task file: TASKS.md
📋 5 tasks pending

🔪 Task 1/5: Extract shared dispatcher from telegram callback handler
🤖 Agent spawned (session: anton-impl-1740829200000-1)
✅ Task 1/5 complete: Extract shared dispatcher

🔪 Task 2/5: Wire retry_fast, retry_heavy, cancel through shared dispatcher
🤖 Agent spawned (session: anton-impl-1740829260000-2)
❌ Task 2/5 failed: Wire retry_fast...
└ Agent timed out after 1200s

🏁 Anton finished
✅ Completed: 4/5
⏭️ Skipped: 1
⏱️ Duration: 42m 15s
```

### Two Execution Modes

Anton supports two modes, configurable per-deployment:

#### Direct Mode (default)

Single agent per task. Fast, simple, good for straightforward changes:

```
Task → Agent → Done
```

#### Preflight Mode

Two-phase pipeline inspired by how senior engineers work — **plan first, then execute**:

```
Task → Discovery Agent (writes spec) → Review Agent (refines spec) → Implementation Agent (follows spec) → Done
```

**Phase 1: Discovery.** A planning agent reads your codebase and writes a detailed implementation spec to `.agents/tasks/`. It identifies what files need to change, what the approach should be, and how to verify the result. The discovery agent is **restricted from modifying source files** — it can only write the plan.

**Phase 1.5: Requirements Review** *(optional)*. A review agent reads the plan, tightens it, catches edge cases, and improves it in-place. Think of it as an automated code review of the spec before any code is written.

**Phase 2: Implementation.** A fresh agent receives the task *and* the spec file. It follows the plan to write code, run tests, and verify the result. Because it has a clear spec to follow, it's far less likely to drift or loop.

If discovery fails after retries, Anton automatically falls back to direct execution — the hand keeps moving.

#### Configuration

In your config file:

```json
{
  "anton": {
    "mode": "preflight",
    "requirementsReview": true,
    "taskTimeoutSec": 1200,
    "discoveryTimeoutSec": 600,
    "reviewTimeoutSec": 300,
    "preflightMaxRetries": 2,
    "planDir": ".agents/tasks"
  }
}
```

Or override per-run from CLI:

```bash
idlehands anton run TASKS.md --mode preflight
```

#### Preflight Progress in Chat

When running in preflight mode, you get granular updates for every phase:

```
🔪 Task 1/3: Refactor session manager
🔎 Discovery: analyzing codebase for task 1/3...
🤖 Agent spawned (session: anton-discovery-1740829200000-1-0)
📝 Plan written: task-1-1740829200000.md
🧪 Reviewing plan: task-1-1740829200000.md...
🤖 Agent spawned (session: anton-review-1740829215000-1)
✅ Plan reviewed and refined
🛠️ Implementation: following spec task-1-1740829200000.md
🤖 Agent spawned (session: anton-impl-1740829230000-1)
✅ Task 1/3 complete: Refactor session manager
```

### Why This Matters

Most AI coding tools give you a chat window and hope for the best. `/anton` gives you:

- **Structured autonomy** — the model works through a defined plan, not freestyle
- **Task isolation** — each task starts with a fresh context, preventing the drift and confusion that kills long agent sessions
- **Plan-then-execute** — preflight mode means the implementation agent has a clear spec to follow, dramatically reducing read-loops and aimless exploration
- **Persistent progress** — if the process stops, your task document shows exactly what's done and what's left
- **Graceful failure** — failed tasks are skipped, not fatal; the hand keeps moving
- **Observable execution** — live progress updates to your chat surface; `/anton status` for on-demand checks; `/anton stop` to halt gracefully

### Commands

| Command | Surface | Description |
|---------|---------|-------------|
| `/anton TASKS.md` | Telegram, Discord, TUI | Start the orchestrator on a task document |
| `/anton status` | All | Show current task progress |
| `/anton stop` | All | Stop after current task completes |
| `idlehands anton run TASKS.md` | CLI | Run from terminal |
| `idlehands anton run TASKS.md --mode preflight` | CLI | Run with discovery → implementation pipeline |
| `idlehands anton run TASKS.md --dry-run` | CLI | Preview tasks without executing |

---

## 🎛️ Runtime Orchestrator

For those running multiple models across multiple machines, the **Runtime Orchestrator** manages your inference infrastructure:

```bash
# Initialize runtime config
idlehands orchestrator init

# Plan a model switch (dry run)
idlehands orchestrator plan --model qwen3-coder-next --json

# Apply — stops current server, switches backend, starts model, probes health
idlehands orchestrator apply --model qwen3-coder-next

# Check what's running
idlehands orchestrator status
```

Supports:
- **Local and remote hosts** (SSH transport)
- **Backend switching** (Vulkan, ROCm, CPU)
- **Health probing** with configurable timeouts
- **Lock-based safety** — no concurrent applies
- **Deterministic plans** — preview every step before execution

---

## ⚡ Quick Start

### 1. Install

```bash
npm install -g @visorcraft/idlehands
```

### 2. Configure

```bash
idlehands configure
```

Point it at your local model endpoint (e.g., `http://localhost:8082/v1`).

### 3. Set workspace

```bash
# From CLI
idlehands agents add --workspace /path/to/your/repo

# Or from any chat surface
/dir /path/to/your/repo
```

### 4. Start the bot

```bash
idlehands bot
```

### 5. Start coding

Send a message from Telegram, Discord, or the TUI:

```
Read the codebase and fix the failing tests in src/utils.ts
```

Or go autonomous with `/anton`:

```
/anton TASKS.md
```

---

## 🛠️ Local LLM Setup (Recommended)

Idle Hands works best with `llama-server` from the [visorcraft/llama.cpp](https://github.com/visorcraft/llama.cpp) fork, which includes fixes for hybrid Mamba-Transformer models.

### Recommended flags

```bash
llama-server \
  -m /path/to/model.gguf \
  --port 8082 \
  --host 0.0.0.0 \
  --chat-template-file /path/to/qwen3.jinja \
  --jinja \
  -ngl 99 \
  -fa on \
  -dio \
  --no-warmup \
  -ctk q4_0 \
  -ctv q4_0 \
  -np 4 \
  -c 800000 \
  -cb \
  --ctx-checkpoints 0 \
  --cache-reuse 64 \
  --slots
```

### Key notes

- **Template matters**: `qwen3.jinja` is critical for proper tool-call generation with Qwen3-Coder models
- **KV cache quantization** (`-ctk q4_0 -ctv q4_0`): Keeps VRAM usage manageable for large contexts
- **Flash attention** (`-fa on`): Required for performance
- **Direct I/O** (`-dio`): Recommended for the visorcraft fork

See [`docs/SETUP_LOCAL_QWEN3_CODER_NEXT.md`](docs/SETUP_LOCAL_QWEN3_CODER_NEXT.md) for the complete setup guide.

---

## 💬 Bot Commands (All Surfaces)

These work in **Telegram, Discord, TUI**, and every other connected chat surface:

| Command | Description |
|---------|-------------|
| `/anton <file>` | Start autonomous task execution |
| `/anton status` | Check orchestrator progress |
| `/anton stop` | Stop after current task |
| `/dir` | Show current workspace |
| `/dir /path` | Set workspace directory |
| `/upgrade` | Self-upgrade to latest version |
| `/status` | Show session info |
| `/model` | View/change active model |
| `/new` | Start fresh session |
| `/compact` | Compress context |
| `/stop` | Cancel current operation |

---

## 📂 Project Structure

```
src/
├── commands/
│   ├── anton.ts              # /anton orchestrator core (direct + preflight modes)
│   ├── orchestrator.ts       # Runtime orchestrator (host/backend/model)
│   └── ...
├── auto-reply/reply/
│   ├── commands-anton.ts     # /anton bot command handler + progress routing
│   ├── commands-dir.ts       # /dir command handler
│   ├── commands-upgrade.ts   # /upgrade command handler
│   └── commands-core.ts      # Universal command dispatch
├── bot/
│   └── upgrade-command.ts    # Self-upgrade engine
└── cli/program/
    └── register.orchestrator-anton.ts  # CLI registration
```

---

## 🔒 Security

- **No telemetry**. No analytics. No call-home behavior.
- **No cloud dependency**. Your model, your data, your network.
- Diagnostic events are local in-process only.
- Agent tool execution is sandboxed with configurable safety profiles.
- Anti-obfuscation detection blocks suspicious commands from the AI.

---

## 📜 Attribution

Idle Hands is a fork of [OpenClaw](https://github.com/openclaw/openclaw), licensed under the Apache 2.0 License. See [LICENSE](LICENSE) for details.

---

## 🎬

> *"I'm not possessed! My hand is!"*
> — Anton Tobias, *Idle Hands* (1999)

Your hand. Your model. Let it loose. 🤚
