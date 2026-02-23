# Sub-Agents & Task Delegation — Architecture Notes

This document explains how Idle Hands handles sub-agent delegation (`spawn_task`) in production.

## Purpose

Sub-agents let the primary agent offload focused work into an isolated context without dragging the full parent conversation into every step.

That gives you:

- cleaner context per delegated task
- better reliability for long parent sessions
- bounded delegation behavior (no recursive runaway spawning)

## Current behavior

### Delegation model

- Parent agent can call `spawn_task` for focused sub-work.
- Sub-agent runs with:
  - isolated message history
  - same working directory
  - same safety model/approval boundaries (with parent-capped permissions)
- Sub-agent cannot recursively spawn additional sub-agents.

### Queueing and execution

- Delegated tasks are executed through a controlled queue.
- On single-model/single-GPU setups this is intentionally sequential.
- Parent receives status updates (queued/running/completed/failed) and a structured summary.

### Output contract

Sub-agent results are returned to the parent as tool output containing:

- task summary
- status
- duration
- turns and tool call counts
- changed files
- capped result text

This keeps parent context usable while preserving traceability.

## Safety and control

- Sub-agent approval mode is capped by the parent session’s approval mode.
- `sub_agents.enabled=false` removes `spawn_task` from tool availability.
- If the user explicitly forbids delegation in a request, `spawn_task` is blocked.
- Delegation is not allowed as a workaround for blocked safety/confirmation restrictions.

## Configuration

```json
{
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
}
```

Session-level control:

- CLI: `--no-sub-agents`
- In-session: `/subagents on|off`

## Practical use cases

- test generation from a parent refactor
- focused code review on a diff
- targeted file-by-file remediation
- scoped research summaries in large repos

## Future direction (explicitly optional)

Potential enhancements:

- alternate endpoint routing per delegated task
- richer progress UI for nested workflows
- tighter policy controls by task type

These are optional evolutions; current production behavior is stable and supported.
