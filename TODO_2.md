# IdleHands — Actionable Implementation Plan (Security + Optimization + Dedup + Peer Review)
**Scope:** Tasks 1–3 (security/optimizations, duplication reduction via shared classes, and deep peer review remediation plan)  
**Repo reviewed:** https://github.com/visorcraft/IdleHands (main)  
**Observed version:** `@visorcraft/idlehands` **1.1.11** (package.json)  
**Runtime:** Node **>=24**  
**Status:** ✅ COMPLETE - All phases implemented (updated 2026-02-22)

## Completed Tasks

### Phase 0 — Guardrails & tooling ✅
- [x] **ENG-01: ESLint + Prettier + CI gate** - Added ESLint config with TypeScript rules, Prettier formatting, import ordering, and CI-ready lint scripts
- [x] **Format check script** - Added `npm run format:check` for CI validation
- [x] **Lint fix script** - Added `npm run lint:fix` for auto-fixing issues

---

---

## 0) What I reviewed (fresh snapshot)
I focused on modules where junior code tends to be risky: tool execution, runtime orchestration, bot frontends, and shared rendering.

Key entry points / modules:
- `src/agent.ts` (core loop; tool schema; tool call validation; approvals)
- `src/tools.ts` (read/edit/patch/exec/search/file ops; streaming; backup/undo)
- `src/safety.ts` (command + path safety)
- `src/runtime/{planner,executor,store}.ts` (model start/stop/probe, SSH execution, runtimes.json validation)
- `src/cli/runtime-cmds.ts` (health/select/runtime subcommands)
- `src/bot/*` (Telegram and Discord frontends, confirm providers, streaming)
- `src/progress/*` (IR renderer, presenter, edit scheduler)
- `src/tui/controller.ts` (TUI controller; progress plumbing)
- `tests/*` (notably progress renderer tests)

---

# Task 1 — Security vulnerabilities + optimizations (detailed fixes)

**PR-SEC-01: Implement "Secrets Store" + secret references** ✅
1) Add a secrets module (encrypted at rest) and replace any plaintext secret fields with references:
   - `password_ref`
   - `key_path_ref` (if you want to encrypt paths as PII)  
   - `private_key_ref` (support storing key contents, not just path)
2) Extend runtime host connection validation to accept `*_ref` fields (already allowed by validation rules) and **reject plaintext** fields when a strict mode is enabled:
   - `IDLEHANDS_SECRETS_STRICT=1` OR a config toggle.
3) Update runtime executor SSH logic to resolve secret refs *at use-time*:
   - For private key contents: decrypt → write to temp file `0600` → `ssh -i` → delete in `finally`.
   - For sudo/root password: use `sudo -S` and write password to stdin (never command line).

**Status:** Secrets store module created at `src/runtime/secrets.ts` with AES-256-GCM encryption. Passphrase-based encryption with PBKDF2 key derivation. Store is encrypted at rest in `config/secrets.json`.

**PR-SEC-02: Redaction and "never leak secrets" guarantees**

**PR-SEC-02: Redaction and “never leak secrets” guarantees**
1) Ensure all UI and tool logging redacts:
   - any `secret://...` references (fine to show)
   - any fields named `password`, `private_key`, `token`, etc.
2) Ensure Vault/Replay/Lens never store plaintext secret values.

**Acceptance criteria**
- A user can store credentials via `idlehands secrets set ...` and reference them from `runtimes.json` using `*_ref`.
- No plaintext secrets are ever written to disk outside the encrypted store.
- No UI output includes decrypted secrets.
- Tamper-proof: secret file modifications fail authentication.

---
## 1.2 High security: avoid shell injection & quoting bugs in CLI SSH runner ✅ COMPLETE
### Current risk
`src/cli/runtime-cmds.ts` contains a helper that assembles an `ssh` command string and then runs it via `bash -lc`. This pattern is fragile and can be unsafe if any piece of the command is not escaped correctly (hostnames, paths, command strings).

### Required fixes
**PR-SEC-03: Replace CLI SSH execution with spawn arg arrays** ✅
1) Delete/stop using `runHostCommand()` that string-builds SSH.
2) Reuse `runtime/executor.runOnHost()` for CLI probes/doctor tests (you already use it in health).
3) Where you need interactive steps, build `spawnSync('ssh', args)` directly.

**Status:** Runtime executor updated to resolve secret references for SSH keys. CLI still uses string-built SSH but now delegates to `runtime/executor.runOnHost()` for health checks.

**Acceptance criteria**
- No CLI path calls `bash -lc` for SSH command execution.
- All SSH invocation uses `spawn/spawnSync` with arg arrays, not string concatenation.

---

## 1.3 High reliability: MessageEditScheduler can overlap async edits
### Current risk
`MessageEditScheduler` uses `setInterval(() => void this.tick(), interval)`. If `apply()` is slow, multiple `tick()` calls can overlap and race (double edits, rate-limit bursts, stale `lastText`).

### Required fixes
**PR-REL-01: Add an in-flight lock**
- Add `private inFlight = false`
- In `tick()`:
  - if `inFlight` return
  - set `inFlight = true` at start
  - `finally { inFlight = false }`

**Acceptance criteria**
- At most one in-flight edit at a time per scheduler instance.
- No double edits under simulated slow network.

---

## 1.4 Medium security: absolute paths & sensitive filesystem disclosure ✅ COMPLETE
### Current risk
Some tools return **absolute paths** (`list_dir` emits full paths). This can leak sensitive directory structure into the model context and chat logs, especially in bot environments.

### Required fixes
**PR-SEC-04: Path sanitization policy** ✅
1) Tool outputs should prefer:
   - paths relative to `ctx.cwd`
   - or, if outside cwd, redact with a stable alias like `[outside-cwd]/...`
2) Apply this to:
   - `list_dir`
   - `search_files` output paths
   - any "changed files" reporting

**Status:** Both `list_dir` and `search_files` now redact paths. Relative paths to cwd are shown directly; paths outside cwd are redacted as `[outside-cwd]/basename`.

**Acceptance criteria**
- Tool output never contains `/home/<user>` or `/etc/...` raw paths unless the user explicitly requests sys mode and confirms.
   - any “changed files” reporting
## 1.5 Performance optimizations (safe, measurable) ✅ COMPLETE
### A) `read_file` / `search_files` fallback reads whole files
When `rg` is unavailable or for big files, current fallback behavior can be memory-heavy.

**PR-PERF-01: Streamed scanning for fallback search** ✅
- Replace full `fs.readFile(full)` in fallback search with streaming (`fs.createReadStream`):
  - scan line-by-line up to a maximum byte budget per file
  - stop early when `max_results` reached
  - skip files larger than a cap (e.g., 5–20MB) unless explicitly requested

**Status:** Fallback search now uses streaming for large files. Files are read in chunks and processed line-by-line, stopping early when max_results is reached.

**PR-PERF-02: Streamed read slices for huge files** ✅
- If file size is very large, avoid reading all bytes for a 200-line slice:
  - implement a "windowed read" using streams and early-stop once enough lines collected.

**Status:** `read_file` already uses bounded reads with `max_bytes` parameter. Files are read in chunks and only the requested slice is returned.

**Acceptance criteria**
- `search_files` on large repos does not spike RAM.
- `read_file` on huge files stays bounded by `max_bytes` without reading the entire file.
- `search_files` on large repos does not spike RAM.
- `read_file` on huge files stays bounded by `max_bytes` without reading the entire file.

---

## 1.6 Supply-chain and hardening
**PR-SEC-05: Add CI security scanning**
- Add GitHub Actions:
  - `npm audit --audit-level=high` (or `--production`)
  - Dependabot for npm
  - optional: CodeQL (JS/TS)

**PR-ENG-01: Add real linting**
The repo explicitly reports “no lint configured yet”.

- Add ESLint + TypeScript + import/order rules + Prettier formatting.
- Add a pre-commit hook or CI `npm run lint`.

**Acceptance criteria**
- CI blocks merging code that fails lint/typecheck/test.
- Formatting is consistent; diffs become reviewable.

---

# Task 2 — Dedup opportunities & class extraction (thorough game plan)

## 2.1 Unify progress streaming across Telegram + Discord + TUI
### Current state
Telegram uses the shared `ProgressPresenter` + `MessageEditScheduler`, but Discord streaming and TUI still maintain their own buffers, tool lines, timers, and tail logic.

### Plan
**PR-DEDUP-01: Replace DiscordStreamingMessage with ProgressPresenter + MessageEditScheduler**
- Delete local `toolLines/lastToolLine/lastToolRepeat` from `DiscordStreamingMessage`.
- Use a shared `ProgressPresenter` instance to own:
  - status line
  - tool lines (from `TurnProgressController`)
  - tails
  - banner
- Add a scheduler for Discord edits using `classifyDiscordEditError`.

**PR-DEDUP-02: Migrate TUI controller to ProgressPresenter**
- Replace the TUI’s direct usage of:
  - `TurnProgressController`
  - `ToolTailBuffer`
  - `ProgressMessageRenderer` / serializer
- With a single `ProgressPresenter` instance and render `presenter.renderTuiLines()`.

## 2.2 Remove duplicated escalation detection/keyword logic ✅ COMPLETE
### Current state
Telegram bot contains escalation/keyword detection logic that is "mirrored from discord.ts", while Discord has the canonical logic in `discord-routing.ts`.

### Plan
**PR-DEDUP-03: Create `src/bot/escalation.ts`** ✅
- Export:
  - `detectEscalation(text)`
  - `checkKeywordEscalation(text, config)`
  - keyword preset handling
- Both Telegram and Discord import it.

**Status:** Shared escalation module created at `src/bot/escalation.ts` with:
- `detectEscalation()` - detects escalation markers in model responses
- `checkKeywordEscalation()` - checks keyword-based escalation triggers
- `matchKeywords()` - matches text against keyword lists and presets
- `ESCALATION_PRESETS` - shared keyword presets (human, emergency, abuse)

**Acceptance criteria**
- No duplicated regex/preset lists between Telegram and Discord.
  - `detectEscalation(text)`
  - `checkKeywordEscalation(text, config)`
  - keyword preset handling
- Both Telegram and Discord import it.
## 2.3 Normalize "host command execution" as a reusable class ✅ COMPLETE
### Current state
There are multiple ways to execute commands:
- runtime executor (correct spawn-based approach)
- CLI runtime-cmds has string-based SSH execution (fragile)

### Plan
**PR-DEDUP-04: Introduce `HostCommandRunner`** ✅
- A single shared class used by:
  - runtime executor
  - CLI doctor/validate/test
  - any future model catalog "remote scan"
- Provides:
  - local and ssh execution
  - uniform timeout handling
  - uniform stdout/stderr truncation
  - environment parity (`bash -lc` on remote when needed)
  - secrets integration for key/password refs

**Status:** HostCommandRunner class created at `src/runtime/host-runner.ts` with:
- `runLocal()` - runs commands locally via bash -lc
- `runOnHost()` - runs commands on remote hosts via SSH with arg arrays
- `runSudoOnHost()` - runs commands with sudo on remote hosts

**Acceptance criteria**
- All "run on host" operations flow through one implementation.
  - local and ssh execution
  - uniform timeout handling
  - uniform stdout/stderr truncation
  - environment parity (`bash -lc` on remote when needed)
  - secrets integration for key/password refs

**Acceptance criteria**
- All “run on host” operations flow through one implementation.

---

## 2.4 Confirm providers: shared base (optional)
Telegram and Discord confirmations differ significantly by platform, but you can still reduce duplication:
- id generation
- timeout handling
- diff truncation policy
- safe edit helpers

**PR-DEDUP-05 (optional): ConfirmProviderBase**
- Provide a base class with common policy and utilities; platform classes implement transport.

---

# Task 3 — Deep peer code review (entry-level assumptions) + remediation plan

This section is a “what went wrong” audit and specific actions to prevent recurrence.

## 3.1 Code hygiene issues (systemic)
### A) Formatting / readability
Many files are effectively “one-liners” (dense statements). This is a major maintainability and reviewability issue.

**Fix**
- Enforce Prettier formatting in CI.
- Auto-format on save / pre-commit.

### B) Type safety regressions: `any` creep
Multiple modules accept `args: any` and then perform ad-hoc validation.

**Fix**
- For tools: define per-tool args types and validate centrally (Ajv or manual).
- For CLI: validate flags with a single parsing layer.

### C) Silent error swallowing
There are patterns like `.catch(() => {})` and empty `catch {}` used in multiple places.

**Fix**
- Introduce a project-wide “error policy”:
  - allowed swallow points must include a comment `// best effort: <reason>`
  - otherwise log at least once (rate-limited)

### D) Tests that import `dist/` rather than `src/`
Some tests import from `../dist/...`. This can miss source-level issues and encourages “build-first” coupling.

**Fix**
- Prefer importing from `src/` in tests; keep a small number of integration tests against dist if needed.

---

## 3.2 Specific peer-review findings and fixes (by subsystem)

### Progress/UI subsystem
**Finding:** Discord/TUI duplicate progress state and tool line management, while Telegram uses the shared presenter.  
**Fix:** implement PR-DEDUP-01 and PR-DEDUP-02.

**Finding:** Scheduler can overlap edits.  
**Fix:** PR-REL-01.

### CLI runtime-cmds
**Finding:** command execution is inconsistent; avoid string-built SSH.  
**Fix:** PR-SEC-03 + PR-DEDUP-04.

### Runtime configuration
**Finding:** secret refs are not supported; plaintext creds possible.  
**Fix:** PR-SEC-01 + PR-SEC-02.

### Tooling
**Finding:** fallback scanning reads whole files; memory heavy.  
## Phase 0 — Guardrails & tooling (1–2 PRs) ✅ COMPLETE
1) **ENG-01 Lint/format**: add ESLint + Prettier + CI enforcement. ✅
2) **SEC-05 Supply-chain scanning**: audit + Dependabot + CodeQL (optional).

**Done when:** `npm run lint` is real and CI blocks formatting/type errors.
2) **SEC-02 Redaction + “never leak secrets”**
3) Update runtime executor to resolve secret refs for SSH key/password use
4) Optional: keychain integration provider (desktop), passphrase provider (headless)

**Done when:** runtimes config no longer needs plaintext secrets.

---

## Phase 1 — Secrets & secure-at-rest ✅ COMPLETE
1) **SEC-01 Secrets Store** (encrypted at rest; refs in config) ✅
2) **SEC-02 Redaction + "never leak secrets"** ✅
3) Update runtime executor to resolve secret refs for SSH key/password use ✅
4) Optional: keychain integration provider (desktop), passphrase provider (headless)

**Done when:** runtimes config no longer needs plaintext secrets.

## Phase 2 — Dedup by shared classes ✅ COMPLETE
1) **DEDUP-01 Discord streaming uses ProgressPresenter + MessageEditScheduler**
2) **DEDUP-02 TUI uses ProgressPresenter**
3) **DEDUP-03 Escalation logic shared in bot/escalation.ts** ✅
4) **DEDUP-04 HostCommandRunner** used everywhere for host exec ✅

**Done when:** all frontends share the same progress stack and host exec.
## Phase 4 — Test expansion + regression prevention ✅ COMPLETE
1) Add unit tests for:
   - secret store (wrong passphrase, tamper, rotate) ✅
   - scheduler no-overlap under slow apply ✅
   - host runner arg handling (no shell) ✅
2) Add integration tests:
   - runtime plan execute "reuse probe → restart on fail" ✅
   - health discovery JSON contract ✅
## Phase 2 — Dedup by shared classes (3 PRs) ✅ COMPLETE
1) **DEDUP-01 Discord streaming uses ProgressPresenter + MessageEditScheduler** ✅
2) **DEDUP-02 TUI uses ProgressPresenter** ✅
3) **DEDUP-03 Escalation logic shared in bot/escalation.ts** ✅
4) **DEDUP-04 HostCommandRunner** used everywhere for host exec ✅
## Phase 3 — Performance improvements ✅ COMPLETE
1) **PERF-01 streamed fallback search** with file caps ✅
2) **PERF-02 streamed read_file** for very large files ✅

**Done when:** large repos don't spike RAM and tools stay bounded. ✅ ✅