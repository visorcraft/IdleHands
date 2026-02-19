# LSP Integration — Detailed Design (extracted from PLAN.md v3, Phase 15)

> This document preserves the full detailed LSP design that was collapsed in PLAN.md for readability.
> The summary lives in PLAN.md Phase 17. This file has the implementation details.

## Why this matters for local models

Local models are slower per round-trip than cloud models. Every wasted turn (reading the wrong file, editing the wrong function, guessing at an API signature) costs 15-30 seconds. LSP integration lets the model ask "what calls this function?" or "what type errors exist?" in one tool call instead of grep+read+grep chains that burn 3-5 turns.

With Trifecta's Lens already doing tree-sitter parsing, the LSP adds a layer of *semantic* understanding on top of Lens's *structural* understanding.

## 15a) LSP client infrastructure

- [ ] Generic LSP client that can launch and communicate with any language server via stdio
- [ ] Manage LSP server lifecycle: start on first use, keep alive during session, shutdown on exit
- [ ] Multiple concurrent LSP servers (one per language): e.g., `gopls` + `typescript-language-server` + `rust-analyzer` in a polyglot repo
- [ ] Initialization: send `initialize` with project root, wait for `initialized`, track server capabilities
- [ ] Document sync: track open/changed files via `textDocument/didOpen`, `textDocument/didChange`, `textDocument/didSave`
- [ ] Sync on agent file edits: when the agent edits a file via `edit_file`/`write_file`, notify the LSP so diagnostics update immediately
- [ ] Graceful degradation: if LSP crashes or doesn't support a feature, fall back silently (never block the agent loop)

## 15b) LSP configuration

- [ ] Config in `~/.config/idlehands/config.json`:
  ```json
  {
    "lsp": {
      "typescript": {
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "enabled": true
      },
      "go": {
        "command": "gopls",
        "enabled": true
      },
      "rust": {
        "command": "rust-analyzer",
        "enabled": true
      },
      "python": {
        "command": "pylsp",
        "enabled": true
      }
    }
  }
  ```
- [ ] Auto-detection: if no LSP config exists, detect installed language servers on `$PATH` and offer to enable them
- [ ] `/lsp` command: show connected language servers and their status
- [ ] `/lsp restart <name>` — restart a specific language server
- [ ] CLI: `--no-lsp` to disable all LSP integration for a session

## 15c) LSP-powered tools

Expose LSP capabilities as agent tools. The model calls these just like `read_file` or `exec`.

- [ ] `diagnostics` tool: get current errors/warnings for a file or the whole project
  - Params: `path` (optional — if omitted, return project-wide diagnostics)
  - Returns: list of `{file, line, severity, message, code}` — structured, not raw terminal output
  - This replaces the common pattern of `exec("npm run build")` → parse errors from stdout. Diagnostics are instant and structured.
- [ ] `symbols` tool: list all symbols (functions, classes, variables, exports) in a file
  - Params: `path`
  - Returns: list of `{name, kind, line, detail}` — like Lens skeletons but with type information
  - Synergy with Lens: `symbols` provides type-aware skeletons, Lens provides structural compression. Use whichever is available.
- [ ] `references` tool: find all references to a symbol
  - Params: `path`, `line`, `character`
  - Returns: list of `{file, line, context}` — every place a function/variable/class is used
  - This is the killer feature for refactoring: "find all callers of this function" in one tool call instead of grep+manual-filtering
- [ ] `definition` tool: go to definition of a symbol
  - Params: `path`, `line`, `character`
  - Returns: `{file, line, preview}` — where the symbol is defined
- [ ] `hover` tool: get type info / documentation for a symbol at a position
  - Params: `path`, `line`, `character`
  - Returns: type signature + doc string (if available)
- [ ] `rename_symbol` tool (stretch): LSP-powered rename across the entire project
  - Params: `path`, `line`, `character`, `new_name`
  - Returns: list of all files/lines changed
  - This is a single tool call that replaces what would be 10+ `edit_file` calls

## 15d) Proactive diagnostics

Don't wait for the model to ask — push diagnostics when they're relevant.

- [ ] After every `edit_file`/`write_file`: automatically check diagnostics for the modified file
- [ ] If new errors introduced: inject as a system note: `[lsp] 2 new errors in src/main.ts after edit (line 42: Type 'string' is not assignable to type 'number')`
- [ ] The model sees the error immediately and can fix it in the next turn — no wasted round-trip running `npm build`
- [ ] Configurable: `"lsp_proactive_diagnostics": true` (default: true)
- [ ] Severity threshold: only surface errors by default, `/lsp warnings` to include warnings

## 15e) Token discipline with LSP

LSP tools add to the tool schema. Keep it lean.

- [ ] Total LSP tool schema cost: ~250-400 tokens (5 tools × ~60 tokens each)
- [ ] Only register LSP tools when at least one LSP server is connected
- [ ] If no LSP configured: zero token overhead (tools not registered)
- [ ] LSP tool results are subject to same output truncation as other tools
- [ ] `references` can return hundreds of results — cap at 50 with `[+N more — use search_files for full list]`
- [ ] `diagnostics` can be noisy — cap at 20 per file, 50 project-wide

## 15f) Synergy with existing systems

- [ ] **Lens + LSP**: Lens provides fast structural skeletons (tree-sitter, no server needed). LSP provides semantic type info (requires running server). Use Lens as fast fallback when LSP is unavailable or slow.
- [ ] **Vault + LSP**: when archiving tool results during compaction, include diagnostic state (`"2 errors in main.ts"`) so the model can recall what was broken
- [ ] **Replay + LSP**: after a `/rewind`, re-check diagnostics on restored files — the model knows immediately if the rewind fixed or introduced errors
- [ ] **Proactive diagnostics + auto-compact**: diagnostic summaries are tiny (~50 tokens each), so they don't contribute meaningfully to context bloat

## Implementation notes

**Language server prerequisites:**
- TypeScript: `npm i -g typescript-language-server typescript`
- Go: `go install golang.org/x/tools/gopls@latest`
- Rust: comes with `rustup`
- Python: `pip install python-lsp-server`

**Dependencies:** `vscode-languageserver-protocol` (types only, ~50KB) or hand-roll the JSON-RPC protocol (~200 lines). No heavy dependencies.

**Priority order:** 15a → 15b → 15c (diagnostics + symbols first) → 15d → 15c (references, definition, hover) → 15e → 15f

Start with diagnostics — it's the highest-value, lowest-complexity LSP feature. "Show me errors" replaces `exec("npm build")` and saves 15-30 seconds per cycle. Symbols and references come next. Rename is stretch.
