# LSP Integration — Architecture Notes

This document describes the Language Server Protocol (LSP) integration in Idle Hands.

## Why LSP exists here

LSP adds semantic code intelligence on top of standard file tools.

Compared to grep-only workflows, LSP reduces wasted turns by providing direct answers for:

- diagnostics
- symbol lookup
- definitions/references
- hover/type info

## Current behavior

### Server management

Idle Hands can connect to configured language servers and use them during agent sessions.

- supports multiple language servers
- tracks server availability
- degrades gracefully if a server is unavailable

### LSP tools exposed to the agent

When LSP is active, semantic tools are available for targeted analysis:

- diagnostics
- symbols
- definition
- references
- hover

### Proactive diagnostics

After file mutations, diagnostics can be surfaced proactively so breakages are visible immediately rather than discovered late in a manual build step.

## Configuration

Example:

```json
{
  "lsp": {
    "enabled": true,
    "servers": [
      { "language": "typescript", "command": "typescript-language-server", "args": ["--stdio"] },
      { "language": "go", "command": "gopls" }
    ],
    "auto_detect": true,
    "proactive_diagnostics": true,
    "diagnostic_severity_threshold": 1
  }
}
```

## Operational principles

- LSP is additive, not mandatory.
- If unavailable, the agent still operates with file/shell tools.
- Tool schemas are only expanded when applicable to keep context overhead reasonable.
- Diagnostic output is bounded to avoid context flooding.

## Trifecta interaction

LSP complements Trifecta:

- **Lens** provides structural projections.
- **LSP** provides semantic/type-aware intelligence.
- **Vault/Replay** preserve useful diagnostic context and recovery history.

Using both gives the best quality in large codebases.

## Future direction (optional)

Potential enhancements include richer rename/refactor workflows and deeper per-language optimizations.

These are roadmap candidates, not prerequisites for current production usage.
