# Sub-Agents & Task Delegation — Detailed Design (extracted from PLAN.md v3, Phase 16)

> This document preserves the full detailed sub-agent design that was collapsed in PLAN.md for readability.
> The summary lives in PLAN.md Phase 18. This file has the implementation details.

## Why this matters for local models

On Halo, we have one GPU running one model. We can't run two models simultaneously. But we CAN:
- Use the same model with a stripped-down prompt for simple tasks (fewer tokens = faster)
- Queue sub-tasks that run sequentially but with isolated context (no prompt pollution)
- In the future, route sub-tasks to a different endpoint (e.g., a smaller model on a second machine, or a cloud API for specific tasks)

## 16a) Sub-agent spawning

- [ ] `spawn_task` tool: available to the main agent for delegating work
  - Params: `task` (string — the instruction), `context_files` (optional — list of files to include), `model` (optional — override model for this sub-agent), `max_iterations` (optional — cap for sub-agent, default 50)
  - Returns: the sub-agent's final response text + summary of changes made
- [ ] Sub-agent runs in isolation: separate message history, separate tool context, same working directory
- [ ] Sub-agent inherits: endpoint, harness, safety tiers, approval mode — but NOT the parent's conversation history
- [ ] Sub-agent has access to: all standard tools (read_file, edit_file, exec, etc.) but NOT `spawn_task` (no recursive spawning)
- [ ] Sub-agent output is summarized and returned to the parent as a tool result
- [ ] File changes made by sub-agents are visible to the parent (same filesystem)
- [ ] Replay checkpoints from sub-agent are merged into parent's Replay store

## 16b) Use cases

- [ ] **Test generation**: main agent says "I've refactored auth.ts" → spawns sub-agent: "Write unit tests for src/auth.ts"
- [ ] **Code review**: main agent spawns a sub-agent with a different system prompt: "Review this diff for bugs and security issues"
- [ ] **Batch operations**: "Fix the same deprecation warning across all 12 files" → sub-agent per file (sequential, not parallel — one GPU)
- [ ] **Research**: "What does the `processQueue` function do?" → sub-agent reads and summarizes, parent continues with other work
- [ ] **Title/commit message generation**: spawn with low max_tokens for a quick one-liner

## 16c) Sub-agent configuration

- [ ] Config for sub-agent defaults:
  ```json
  {
    "sub_agents": {
      "max_iterations": 50,
      "max_tokens": 16384,
      "system_prompt": "You are a focused coding assistant. Complete the task efficiently with minimal tool calls.",
      "inherit_context_file": true,
      "inherit_vault": true
    }
  }
  ```
- [ ] Sub-agent system prompt is deliberately minimal — even leaner than the main agent's
- [ ] Sub-agent inherits project context file (`.idlehands.md`) by default but NOT the parent's conversation
- [ ] Sub-agent can access Vault (for cross-session memory) but writes to a separate namespace: `kind: "sub_agent_result"`

## 16d) Sub-agent lifecycle & display

- [ ] While sub-agent runs: parent shows progress: `⠋ Sub-agent: "Write tests for auth.ts" (turn 3/10, 12.4s)...`
- [ ] Sub-agent tool calls shown in dimmed/collapsed format (user can see what it's doing without noise)
- [ ] On completion: summary returned to parent:
  ```
  [sub-agent] Completed: "Write tests for auth.ts"
    Duration: 34.2s (6 turns, 8 tool calls)
    Files modified: tests/auth.test.ts (+82 lines, new file)
    Result: Created 5 test cases covering login, logout, token refresh, invalid credentials, and session expiry.
  ```
- [ ] On failure (max iterations or error): return error summary to parent, parent decides how to proceed
- [ ] `/tasks` command: show history of sub-agent tasks in current session with status and duration

## 16e) Multi-endpoint routing (future)

- [ ] `"sub_agents.endpoint": "http://other-machine:8080/v1"` — route sub-agent tasks to a different LLM server
- [ ] Use case: main agent runs on Qwen3-Coder (best quality), sub-agents run on a faster/smaller model for simple tasks
- [ ] Use case: main agent is local, sub-agent routes to a cloud API for tasks that need a stronger model (e.g., complex refactoring)
- [ ] Endpoint per task: `spawn_task(task="...", endpoint="http://cloud:8080/v1")` for one-off routing

## 16f) Token discipline

- [ ] Sub-agent prompt is ~100 tokens (vs main agent's ~200). Task instruction + context files are the bulk.
- [ ] Sub-agent tool schemas are identical to main agent's (same tools, same token cost)
- [ ] Sub-agent does NOT inherit parent's message history — this is the key savings. A 10-turn parent session at 30k tokens would crush a sub-agent's context. Instead, the sub-agent starts fresh with just the task.
- [ ] Sub-agent results returned to parent are capped at 2000 tokens. If the sub-agent wrote a novel, summarize it.
- [ ] Total sub-agent token budget: configurable, default 65536 (half of main agent's context)

## Implementation notes

**Priority order:** 16a → 16d → 16b → 16c → 16f → 16e

Core spawning (16a) and display (16d) first — get the basic delegation working. Use cases (16b) are documentation + prompt tuning. Config (16c) and token discipline (16f) are polish. Multi-endpoint (16e) is future work.

**Dependencies:** None — sub-agents reuse the existing `createSession` + `agent.ask()` infrastructure. The main agent calls `spawn_task`, which internally creates a new `AgentSession` with a stripped-down config, runs `ask()`, and returns the result.

**Risk:** Sub-agents on a single GPU are sequential, not parallel. The main agent blocks while the sub-agent runs. This is fine for delegation ("go do this while I wait") but doesn't enable true parallelism. True parallelism requires multiple endpoints (16e).
