# Idle Hands

**Local-first coding agent CLI for OpenAI-compatible endpoints.**  
Fast in the terminal, practical in production, and built to run close to your code.

📚 Full docs: https://visorcraft.github.io/IdleHands/

---

## Why Idle Hands

Idle Hands is built for people who want an agent that can actually ship work, not just chat:

- **TUI-first UX** for real daily use (streaming output, slash commands, approvals)
- **Runtime orchestration** (hosts/backends/models) for local + remote model stacks
- **Size-aware runtime probes** so very large GGUF/RPC models get sane startup timeouts by default
- **Safety + approvals** with explicit modes (`plan`, `reject`, `default`, `auto-edit`, `yolo`)
- **Headless mode** for CI and scripts (`json`, `stream-json`, `--fail-on-error`, `--diff-only`)
- **Bot frontends** (Telegram + Discord) with service management
- **Trifecta subsystem** (Vault + Replay + Lens) for durable memory, reversibility, and context shaping

---

## What makes Idle Hands unique: Trifecta

Trifecta is the integrated core of Idle Hands:

- **Vault** → persistent memory + notes (`/vault`, `/note`, `/notes`)
- **Replay** → file checkpoints and rewind/diff (`/checkpoints`, `/rewind`, `/diff`, `/undo`)
- **Lens** → structural compression/indexing for better context usage

Runtime controls:

```bash
--no-trifecta
--no-vault
--no-lens
--no-replay
--vault-mode active|passive|off
```

Detailed docs: [Trifecta guide](https://visorcraft.github.io/IdleHands/guide/trifecta)

---

## Install

### npm (recommended)

```bash
npm i -g @visorcraft/idlehands@latest
idlehands --help
```

### Build from source

```bash
git clone https://github.com/visorcraft/idlehands.git
cd idlehands
npm i
npm run build
node dist/index.js --help
```

Requirements:

- Node.js **24+**
- Linux (recommended target environment)

---

## Quick start

```bash
idlehands setup
idlehands
```

One-shot mode:

```bash
idlehands -p "run npm test and fix failures"
```

Project-scoped session:

```bash
idlehands --dir ~/projects/myapp
```

Resume/fresh controls:

```bash
idlehands --continue
idlehands --resume
idlehands --resume my-session
idlehands --fresh
```

---

## Linux hardening (recommended)

If you run Idle Hands regularly on Linux, use a dedicated low-privilege account.

### 1) Create a restricted user

```bash
sudo useradd --system --create-home --home-dir /home/idlehands --shell /bin/bash idlehands
sudo passwd -l idlehands
```

### 2) Give it only the project dirs it needs

```bash
sudo mkdir -p /home/idlehands/work
sudo chown -R idlehands:idlehands /home/idlehands
```

### 3) Run Idle Hands as that user

```bash
sudo -u idlehands -H bash -lc 'idlehands setup'
sudo -u idlehands -H bash -lc 'idlehands --dir /home/idlehands/work'
```

This limits blast radius if the agent runs bad commands, and keeps your main user environment cleaner.

---

## Running bots as a service

Idle Hands can manage a user-level systemd service for bot frontends.

```bash
idlehands service install
idlehands service status
idlehands service start
idlehands service logs
```

To keep user services running after logout:

```bash
sudo loginctl enable-linger <user>
```

If you use a dedicated `idlehands` account, install/manage the service while logged in as that user.

---

## Approval modes at a glance

- `plan` → dry plan only, no mutations
- `reject` → non-interactive safe mode, rejects mutating operations
- `default` → asks before risky actions
- `auto-edit` → allows normal code-edit flow, still safety-aware
- `yolo` / `--no-confirm` → no confirmations (fastest, riskiest)

---

## Token-efficient file tooling

Recent tool updates reduce context bloat and make edits cheaper:

- `read_file`
  - bounded default when `limit` is omitted (`limit=200`)
  - supports `format=plain|numbered|sparse`
  - supports `max_bytes` (default `20000`, validated up to `262144`)
- `edit_range`
  - replace an inclusive line range in one file
  - preserves existing EOL style (`LF`/`CRLF`)
  - supports clean deletions by passing empty replacement text
- `apply_patch`
  - apply unified diffs across multiple files
  - validates touched files against declared `files[]`
  - dry-runs before apply (`git apply --check` with fallback to `patch --dry-run`)

---

## Shared progress rendering (v1.1.8+)

All three frontends (TUI, Telegram, Discord) now use a shared progress message renderer:

- **Platform-agnostic IR**: `ProgressMessageRenderer` produces an intermediate representation.
- **Consistent UX**: same banner → status → tools → tail → assistant flow everywhere.
- **Serializers**:
  - Telegram: compact HTML with `<pre>` code blocks
  - Discord: markdown with fenced code blocks
  - TUI: plain text lines for status bar

---

## Runtime probe defaults (size-aware)

When a model does not explicitly set probe timeout and probe interval, Idle Hands derives defaults from estimated model size on the target host.

Default tiers used by idlehands select:

| Model size (GiB) | probe timeout | probe interval |
|---:|---:|---:|
| <= 10 | 120s | 1000ms |
| <= 40 | 300s | 1200ms |
| <= 80 | 900s | 2000ms |
| <= 140 | 3600s | 5000ms |
| > 140 | 5400s | 5000ms |

Per-model override remains available in runtimes.json under models.launch.
Explicit per-model values always take precedence.

## Documentation map

- [Getting Started](https://visorcraft.github.io/IdleHands/guide/getting-started)
- [Trifecta Guide](https://visorcraft.github.io/IdleHands/guide/trifecta)
- [Runtime Orchestration](https://visorcraft.github.io/IdleHands/guide/runtime)
- [Bots + Service](https://visorcraft.github.io/IdleHands/guide/bots)
- [CLI Reference](https://visorcraft.github.io/IdleHands/reference/cli)
- [Config Reference](https://visorcraft.github.io/IdleHands/reference/config)
- [Safety Model](https://visorcraft.github.io/IdleHands/reference/safety)
- [Changelog](https://visorcraft.github.io/IdleHands/reference/changelog)
