Below is a token‑efficiency review of **Idle Hands** (visorcraft/IdleHands) with concrete, implementable changes. I focused on reducing **input tokens per model call** (not just “making the model cheaper”), while preserving the ability to recover full fidelity via tools/Vault.

## What Idle Hands already does well for token control

* **Trifecta is explicitly designed to fight context bloat**: Vault (durable memory), Replay (safe rollback), Lens (structural projections). The docs even call out Lens as “structural projections to reduce context bloat,” and Vault as a place to archive compacted history/tool output. ([Visorcraft][1])
* You already have **context-window enforcement**. `enforceContextBudget()` estimates tokens and starts dropping older tool-call “groups” and then older messages when above a threshold (~85% of budget). ([GitHub][2])
* When compaction happens, you **archive dropped tool outputs into Vault**, and if Lens is enabled you **summarize tool outputs** before archiving. ([GitHub][2])
* Tool outputs are **bounded/truncated** in several places (e.g., exec output max bytes, stacktrace collapsing, repeat dedupe). ([GitHub][3])

That’s a strong baseline. The next gains come from changing what *ever enters* the rolling prompt history in the first place.

---

## The biggest token multipliers in the current design

### 1) `read_file` can still explode tokens in the live prompt

The tool schema makes `limit` optional (`['path']` is required), which means the model can request a full file read unless it remembers to set `limit/search/context`. ([GitHub][2])

Lens compression is currently applied in the **archive-to-Vault path** when history is dropped, not necessarily before the raw tool output has lived in the active context for multiple turns. ([GitHub][2])

### 2) `edit_file` duplicates large text blocks in tool-call arguments

Your `edit_file` tool takes `old_text` and `new_text` (and fails if `old_text` isn’t found). ([GitHub][2])
This is robust, but token-expensive because:

* the model must include `old_text` (copied from `read_file` output) **again** in the tool call, and
* that tool call is itself part of the conversation record (and therefore future prompt tokens).

### 3) Tool schemas themselves are treated as token budget

Idle Hands even estimates tool-schema tokens separately (`estimateToolSchemaTokens`) and subtracts them from the budget. ([GitHub][2])
So every byte in your tool descriptions/parameter descriptions matters for input tokens on servers that count tool schemas in prompt tokens.

### 4) Project context can legally be huge (up to 8192 tokens by default)

`loadProjectContext()` will include a project context file up to `context_max_tokens` (default 8192) and only warns above ~2048. ([GitHub][4])
That’s *one-time added*, but it becomes “forever resent” in every subsequent request unless you implement prefix-caching/session state, or you summarize it.

### 5) Compaction is reactive (waits until ~85% full)

You only start dropping tool groups/messages when you’re near the limit. ([GitHub][2])
If your goal is “reduce tokens sent each prompt,” you want **proactive** “keep the prompt small always,” not just “avoid overflow.”

---

## High-impact changes you can implement without changing model providers

### A) Make `read_file` token-safe by default (this is the #1 win)

**Goal:** “Never allow giant file blobs to enter the live prompt unless explicitly escalated.”

Implement one of these patterns:

#### A1) Default `limit` in the tool implementation (not the schema)

If `limit == null`, treat it as e.g. **200 lines** or **6–8 KB**, and include:

* total line count
* returned range (start/end)
* a hint: “use `search` + `context` to jump”

This preserves behavior with zero schema changes, and prevents the “oops I read 2,000 lines” failure mode.

You already encourage “Use search/context to jump,” but making it *enforced* is what drives token savings. ([GitHub][2])

#### A2) Add a `mode` parameter: `snippet | lens | full`

* `snippet` (default): limited lines, minimal formatting
* `lens`: return Lens skeleton projection + a small neighborhood around the match
* `full`: old behavior, but require explicit confirmation when above a threshold (you already have approval modes)

Lens already has a summarizer that can produce a structural projection when content is large. ([GitHub][5])

#### A3) “Handle + fetch” design (best long-term)

Change `read_file` to return:

* `handle` (stable ID: includes file hash + range)
* small preview
* optional Lens skeleton
  and store the full body out-of-band (Vault entry or local cache keyed by handle).

Then add:

* `read_handle(handle, offset, limit)` or `open_handle(handle, query, context)`.

This keeps the prompt small while still allowing exact retrieval on demand.

---

### B) Replace `edit_file(old_text,new_text)` as the default editing primitive

`edit_file` is robust, but it’s one of the worst token multipliers. ([GitHub][2])

Add **one new tool** and route the agent to prefer it:

#### B1) `apply_patch` (unified diff)

Tool signature: `{ patch: string }` (and maybe `{ cwd?: string }`).

* Model returns a small diff (usually much smaller than old/new blobs).
* Your tool applies it with a real patch engine.
* Replay already gives you rollback safety around mutating tools. ([Visorcraft][1])

This alone can cut “edit-phase” prompt tokens dramatically.

#### B2) `edit_range` / `replace_ranges`

Tool signature: `{ path, start_line, end_line, replacement }`.

This is extremely token efficient: no `old_text`, minimal context. The model just needs line numbers (which it already gets from `read_file` output). ([GitHub][2])

You can keep `edit_file` as a fallback when range edits fail.

---

### C) Proactively compress what you store in the *conversation*, not just what you archive

Right now, a lot of compression happens when compaction kicks in (drop → archive to Vault with Lens summarization). ([GitHub][2])
To reduce tokens *every prompt*, change the retention policy:

#### C1) “Tool output digest” policy

After each tool result:

1. Store **full raw output** to Vault (or disk) keyed by `tool_call_id`.
2. Replace the tool message content stored in `messages[]` with a **small digest**:

   * for `read_file`: path + range + Lens skeleton + 20–60 relevant lines
   * for `exec`: rc + extracted errors + last N lines + pointer to full log
   * for `search_files`: count + top matches + pointer to full results

Lens summarization is already a thing; you’re just moving it “upstream” from archival-only to “what lives in the prompt.” ([GitHub][5])

#### C2) Store less assistant verbosity in history

You already strip some “thinking” content. ([GitHub][2])
Take it further: keep the full assistant text for the user display, but write a much shorter version into `messages[]` for future prompts:

* “Decision + next action + constraints”
* not full narrative

This is often a *huge* token win over time, especially with chatty models.

---

### D) Shrink tool schemas (since you budget them as tokens)

`buildToolsSchema()` includes multi-line descriptions and per-parameter descriptions (e.g., `exec.command/cwd/timeout` have detailed descriptions). ([GitHub][2])
If your provider counts these in prompt tokens (many do), this is “always-on overhead.”

Concrete steps:

#### D1) Minify descriptions aggressively

* Move detailed guidance into a *single* compact “Tool usage rules” block in the system prompt (or session meta).
* In schemas: keep description to ~3–8 words per tool and omit per-parameter descriptions unless they materially improve call accuracy.

#### D2) Tool gating by phase (“capability sets”)

Instead of always sending every tool:

* Early turns: only `read_file/search_files/list_dir/exec` (read-only)
* Editing turns: add mutators (`apply_patch/write_file/insert_file`)
* Vault tools: only when trifecta enabled and mode needs it

This reduces schema tokens and also reduces model tool confusion.

You already do some conditional exposure (e.g., vault tools only when activeVaultTools). ([GitHub][2])
Extend that idea further.

---

### E) Summarize project context by default, keep raw on demand

`loadProjectContext()` will include the entire context file up to ~8192 tokens. ([GitHub][4])

If your goal is “reduce tokens sent each prompt,” the right pattern is:

* Include a **summary block** (e.g., 400–1200 tokens) in the live prompt
* Store the full context file text in Vault (or allow `read_file` to access it) when needed

Since project context tends to be stable, this yields consistent savings without losing information—because the raw is still retrievable.

---

## Novel, more aggressive approaches that are still implementable

### 1) “Always small prompt” via rolling state + retrieval

Instead of letting conversation history grow and then dropping chunks at 85%:

* Maintain a single **running “state object”** in the prompt:

  * current goal
  * decisions made
  * open TODOs
  * important file paths/symbols
  * last known test status
* Everything else goes to Vault and is retrieved by query.

You already have Vault search and injection behavior when compactions occur. ([GitHub][2])
Make retrieval the default, not the emergency mechanism.

### 2) Store large exec outputs as artifacts/log files, not tokens

Even with truncation, exec output can still be noisy. ([GitHub][3])
Write full output to:

* `.idlehands/logs/<tool_call_id>.log`
  Return only:
* rc
* extracted error blocks
* pointer to log file (and a “search log” tool)

This keeps the prompt clean while preserving full fidelity.

### 3) Symbol-aware context tools (LSP/Tree-sitter powered)

Instead of `read_file` + manual scanning:

* `read_symbol(path, symbol)` → returns only that symbol body + immediate dependencies
* `find_references(symbol)` → returns call sites list
* `outline(path)` → returns Lens-like skeleton for the file

This is exactly aligned with “reduce tokens without losing valuable information,” because most tasks don’t need full files—just the relevant slice.

Idle Hands already depends on tree-sitter libs and has Lens infrastructure. ([GitHub][6])

---

## If you control the inference backend: the “real” compression path

If you truly want to reduce **tokens resent every call**, the biggest lever isn’t gzip—it’s **stateful sessions/prefix caching**.

### A) Stateful session IDs (don’t resend history at all)

Build an OpenAI-compatible proxy that supports:

* `session_id`
* `append_messages: [...]`

The proxy reconstructs full prompt server-side. Idle Hands only sends deltas.

This reduces:

* network payload size
* server-side re-tokenization overhead
* repeated prompt processing

### B) KV/prefix caching aware prompting

Even without session IDs, many self-hosted servers can reuse KV caches when the prefix is identical. Your code already inspects health snapshots including kv-cache metrics when available. ([GitHub][2])
You can exploit this by ensuring:

* system prompt + tool schemas are extremely stable
* session meta is stable and early
* only append deltas each turn

It may not reduce *token count*, but it materially improves throughput/latency and can reduce billed cost on platforms that price cached tokens differently.

### C) Tokenizer-level “macro tokens” (only for self-hosted models)

If you run your own models, you can add special tokens for repeated boilerplate:

* headings like `[git status -s]`
* tool JSON keys
* common instruction blocks

This can shrink tokenization length for the fixed scaffolding of Idle Hands. It’s not possible on closed tokenizers, but is viable for custom/fine-tuned deployments.

---

## A practical priority order (highest ROI first)

1. **Default-limit `read_file`** + introduce `mode` / handle-based reads (prevents the worst blowups). ([GitHub][2])
2. Add **`apply_patch` or `edit_range`** and make it the default edit path (removes old/new duplication). ([GitHub][2])
3. Implement **tool output digests** in live history (Lens-style summaries live in prompt; raw stored in Vault/log). ([GitHub][2])
4. **Shrink tool schemas + tool gating** (since you budget schema tokens explicitly). ([GitHub][2])
5. Summarize **project context** by default; keep full context retrievable. ([GitHub][4])
6. (Optional) Backend statefulness / caching for the “no resend” win.

---

## One concrete design that tends to work extremely well

If you want a single “north star” architecture:

* **Prompt always contains:**

  * system prompt
  * a small “session state” block (500–1500 tokens)
  * last 1–2 user/assistant turns (raw)
  * last N tool digests (not raw outputs)

* **Everything else lives in Vault/logs** and is accessible via retrieval tools.

That achieves your stated goal: **reduce tokens sent per prompt without losing information**, because nothing is deleted—only moved out-of-band and re-injectable.

# Below are exact schema diff proposals for:
* `read_file` modes + default limits,
* `apply_patch`,
* and a `tool_digest_policy` configuration section (so users can tune “prompt size vs tool calls”).

## Tool schemas live in `buildToolsSchema()` in `src/agent.ts` (that’s the list you send every request). ([GitHub][2])
Below are **drop-in schema diffs** that (a) force bounded file reads, (b) expose your existing `max_entries/max_results` caps to the model, and (c) add token-efficient edit primitives (`apply_patch`, `edit_range`) so you don’t have to echo giant `old_text/new_text` blocks. Your current `read_file` always prefixes line numbers and can return up to ~100KB if `limit` is omitted, so requiring a `limit` and offering a `format` knob is a big lever. ([GitHub][3])

```diff
diff --git a/src/agent.ts b/src/agent.ts
--- a/src/agent.ts
+++ b/src/agent.ts
@@
-const FILE_MUTATION_TOOL_SET = new Set(['edit_file', 'write_file', 'insert_file']);
+// Include new mutation tools so approvals / mutation-aware logic triggers properly.
+const FILE_MUTATION_TOOL_SET = new Set(['edit_file', 'edit_range', 'apply_patch', 'write_file', 'insert_file']);

@@
-function buildToolsSchema(opts?: { activeVaultTools?: boolean; sysMode?: boolean; mcpTools?: ToolSchema[]; lspTools?: boolean; allowSpawnTask?: boolean; }): ToolSchema[] { const obj = (properties: Record, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required }); const schemas: ToolSchema[] = [ { type: 'function', function: { name: 'read_file', description: 'Read file contents with line numbers.
-Use search/context to jump to relevant code.', parameters: obj( { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' }, search: { type: 'string' }, context: { type: 'integer' }, }, ['path'] ) } }, { type: 'function', function: { name: 'read_files', description: 'Batch read multiple files.', parameters: obj( { requests: { type: 'array', items: obj( { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' }, search: { type: 'string' }, context: { type: 'integer' }, }, ['path'] ) } }, ['requests'] ) } }, { type: 'function', function: { name: 'write_file', description: 'Write a file (atomic).
-Creates parents. Makes a backup first.', parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) } }, { type: 'function', function: { name: 'edit_file', description: 'Search/replace exact text in a file.
-Fails if old_text not found.', parameters: obj( { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_text', 'new_text'] ) } }, { type: 'function', function: { name: 'insert_file', description: 'Insert text at a specific line (0=prepend, -1=append).', parameters: obj( { path: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' } }, ['path', 'line', 'text'] ) } }, { type: 'function', function: { name: 'list_dir', description: 'List directory contents (optional recursive, max depth 3).', parameters: obj( { path: { type: 'string' }, recursive: { type: 'boolean' }, }, ['path'] ) } }, { type: 'function', function: { name: 'search_files', description: 'Search for a regex pattern in files under a directory.', parameters: obj( { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' }, }, ['pattern', 'path'] ) } }, { type: 'function', function: { name: 'exec', description: 'Run a shell command (bash -c) with timeout; returns JSON rc/out/err.
-Each call is a new shell — cwd does not persist between calls.', parameters: obj( { command: { type: 'string', description: 'Shell command to run' }, cwd: { type: 'string', description: 'Working directory (default: project root). Use this instead of cd.' }, timeout: { type: 'integer', description: 'Timeout in seconds (default: 30, max: 120).
-Use 60-120 for npm install, builds, or test suites.' } }, ['command'] ) } } ];
+function buildToolsSchema(opts?: { activeVaultTools?: boolean; sysMode?: boolean; mcpTools?: ToolSchema[]; lspTools?: boolean; allowSpawnTask?: boolean; }): ToolSchema[] {
+  const obj = (properties: Record, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
+  const int = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
+
+  const schemas: ToolSchema[] = [
+    // ────────────────────────────────────────────────────────────────────────────
+    // Token-safe reads (require limit; allow plain output without per-line numbers)
+    // ────────────────────────────────────────────────────────────────────────────
+    {
+      type: 'function',
+      function: {
+        name: 'read_file',
+        description: 'Read a bounded slice of a file.',
+        parameters: obj(
+          {
+            path: { type: 'string' },
+            offset: int(1, 1_000_000),
+            limit: int(1, 240),              // keep small; raise only if needed
+            search: { type: 'string' },
+            context: int(0, 80),             // ±lines around first match
+            format: { type: 'string', enum: ['plain', 'numbered', 'sparse'] },
+            max_bytes: int(256, 20_000),      // hard cap tool output size
+          },
+          ['path', 'limit']
+        ),
+      },
+    },
+    {
+      type: 'function',
+      function: {
+        name: 'read_files',
+        description: 'Batch read bounded file slices.',
+        parameters: obj(
+          {
+            requests: {
+              type: 'array',
+              items: obj(
+                {
+                  path: { type: 'string' },
+                  offset: int(1, 1_000_000),
+                  limit: int(1, 240),
+                  search: { type: 'string' },
+                  context: int(0, 80),
+                  format: { type: 'string', enum: ['plain', 'numbered', 'sparse'] },
+                  max_bytes: int(256, 20_000),
+                },
+                ['path', 'limit']
+              ),
+            },
+          },
+          ['requests']
+        ),
+      },
+    },
+
+    // ────────────────────────────────────────────────────────────────────────────
+    // Writes/edits
+    // ────────────────────────────────────────────────────────────────────────────
+    {
+      type: 'function',
+      function: {
+        name: 'write_file',
+        description: 'Write file (atomic, backup).',
+        parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
+      },
+    },
+    {
+      type: 'function',
+      function: {
+        name: 'apply_patch',
+        description: 'Apply unified diff patch (multi-file).',
+        parameters: obj(
+          {
+            patch: { type: 'string' },
+            files: { type: 'array', items: { type: 'string' } }, // list touched paths (safety/approvals)
+            strip: int(0, 5),                                     // like `patch -pN`
+          },
+          ['patch', 'files']
+        ),
+      },
+    },
+    {
+      type: 'function',
+      function: {
+        name: 'edit_range',
+        description: 'Replace a line range in a file.',
+        parameters: obj(
+          {
+            path: { type: 'string' },
+            start_line: int(1, 1_000_000),
+            end_line: int(1, 1_000_000),
+            replacement: { type: 'string' },
+          },
+          ['path', 'start_line', 'end_line', 'replacement']
+        ),
+      },
+    },
+    {
+      type: 'function',
+      function: {
+        name: 'edit_file',
+        description: 'Legacy exact replace (requires old_text). Prefer apply_patch/edit_range.',
+        parameters: obj(
+          { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } },
+          ['path', 'old_text', 'new_text']
+        ),
+      },
+    },
+    {
+      type: 'function',
+      function: {
+        name: 'insert_file',
+        description: 'Insert text at line (0=prepend, -1=append).',
+        parameters: obj({ path: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' } }, ['path', 'line', 'text']),
+      },
+    },
+
+    // ────────────────────────────────────────────────────────────────────────────
+    // Bounded listings/search (expose existing caps already implemented in tools.ts)
+    // ────────────────────────────────────────────────────────────────────────────
+    {
+      type: 'function',
+      function: {
+        name: 'list_dir',
+        description: 'List directory entries.',
+        parameters: obj(
+          { path: { type: 'string' }, recursive: { type: 'boolean' }, max_entries: int(1, 500) },
+          ['path']
+        ),
+      },
+    },
+    {
+      type: 'function',
+      function: {
+        name: 'search_files',
+        description: 'Search regex in files.',
+        parameters: obj(
+          { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' }, max_results: int(1, 100) },
+          ['pattern', 'path']
+        ),
+      },
+    },
+
+    // ────────────────────────────────────────────────────────────────────────────
+    // Exec (minify schema: remove per-parameter descriptions)
+    // ────────────────────────────────────────────────────────────────────────────
+    {
+      type: 'function',
+      function: {
+        name: 'exec',
+        description: 'Run bash -c; returns JSON rc/out/err.',
+        parameters: obj({ command: { type: 'string' }, cwd: { type: 'string' }, timeout: int(1, 120) }, ['command']),
+      },
+    },
+  ];
@@
-  if (opts?.allowSpawnTask !== false) { schemas.push({ type: 'function', function: { name: 'spawn_task', description: 'Delegate a focused task to an isolated sub-agent session (no parent chat history).', parameters: obj( { task: { type: 'string', description: 'Instruction for the sub-agent' }, context_files: { type: 'array', description: 'Optional extra files to inject into sub-agent context', items: { type: 'string' }, }, model: { type: 'string', description: 'Optional model override for this task' }, endpoint: { type: 'string', description: 'Optional endpoint override for this task' }, max_iterations: { type: 'integer', description: 'Optional max turn cap for the sub-agent' }, max_tokens: { type: 'integer', description: 'Optional max completion tokens for the sub-agent' }, timeout_sec: { type: 'integer', description: 'Optional timeout for this sub-agent run (seconds)' }, system_prompt: { type: 'string', description: 'Optional sub-agent system prompt override for this task' }, approval_mode: { type: 'string', enum: ['plan', 'reject', 'default', 'auto-edit', 'yolo'] }, }, ['task'] ) } }); }
+  if (opts?.allowSpawnTask !== false) {
+    schemas.push({
+      type: 'function',
+      function: {
+        name: 'spawn_task',
+        description: 'Run a sub-agent task (no parent history).',
+        parameters: obj(
+          {
+            task: { type: 'string' },
+            context_files: { type: 'array', items: { type: 'string' } },
+            model: { type: 'string' },
+            endpoint: { type: 'string' },
+            max_iterations: { type: 'integer' },
+            max_tokens: { type: 'integer' },
+            timeout_sec: { type: 'integer' },
+            system_prompt: { type: 'string' },
+            approval_mode: { type: 'string', enum: ['plan', 'reject', 'default', 'auto-edit', 'yolo'] },
+          },
+          ['task']
+        ),
+      },
+    });
+  }
@@
-  if (opts?.activeVaultTools) { schemas.push( { type: 'function', function: { name: 'vault_search', description: 'Search vault entries (notes and previous tool outputs) to reuse prior high-signal findings.', parameters: obj( { query: { type: 'string' }, limit: { type: 'integer' } }, ['query'] ) } }, { type: 'function', function: { name: 'vault_note', description: 'Persist a concise, high-signal note into the Trifecta vault.', parameters: obj( { key: { type: 'string' }, value: { type: 'string' } }, ['key', 'value'] ) } } ); }
+  if (opts?.activeVaultTools) {
+    schemas.push(
+      { type: 'function', function: { name: 'vault_search', description: 'Search vault.', parameters: obj({ query: { type: 'string' }, limit: { type: 'integer' } }, ['query']) } },
+      { type: 'function', function: { name: 'vault_note', description: 'Write vault note.', parameters: obj({ key: { type: 'string' }, value: { type: 'string' } }, ['key', 'value']) } }
+    );
+  }
```

### Notes you’ll want to implement alongside the schema change (non-schema, but important)

* **`read_file` format/max_bytes**: today `read_file` always prefixes line numbers and has a hard 100KB truncation, so the new schema knobs need corresponding behavior in `tools.ts` to actually reduce tokens. ([GitHub][3])

  * `format: plain` should omit the `NNNNNN| ` prefix entirely (big token win).
  * `max_bytes` should override the current hard cap.
  * Because the schema makes `limit` required, the model can’t accidentally request “entire file” anymore.

* **`apply_patch` safety**: because `apply_patch` won’t have a single `args.path`, you should update your mutation safety checks to validate *each* path in `args.files` before applying the patch (protected path tiers, approvals, etc.). Your schema already includes `files` to make that easy.

[1]: https://visorcraft.github.io/IdleHands/guide/trifecta "https://visorcraft.github.io/IdleHands/guide/trifecta"
[2]: https://raw.githubusercontent.com/visorcraft/IdleHands/main/src/agent.ts "https://raw.githubusercontent.com/visorcraft/IdleHands/main/src/agent.ts"
[3]: https://raw.githubusercontent.com/visorcraft/IdleHands/main/src/tools.ts "https://raw.githubusercontent.com/visorcraft/IdleHands/main/src/tools.ts"
[4]: https://raw.githubusercontent.com/visorcraft/IdleHands/main/src/context.ts "https://raw.githubusercontent.com/visorcraft/IdleHands/main/src/context.ts"
[5]: https://raw.githubusercontent.com/visorcraft/IdleHands/main/src/lens.ts "https://raw.githubusercontent.com/visorcraft/IdleHands/main/src/lens.ts"
[6]: https://raw.githubusercontent.com/visorcraft/IdleHands/main/package.json "https://raw.githubusercontent.com/visorcraft/IdleHands/main/package.json"
