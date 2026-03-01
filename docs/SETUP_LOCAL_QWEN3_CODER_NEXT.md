# IdleHands Local Setup Guide (Qwen3-Coder-Next + llama-server)

> Security note: this guide intentionally uses placeholders for sensitive values.  
> Do **not** commit real API tokens, chat IDs, SSH keys, or private endpoints.

---

## 1) Architecture Overview

This project has two major parts:

1. **IdleHands/OpenClaw fork** (agent + bot orchestration)
   - Repo path (example): `/mnt/user/downloads/idlehands`
2. **llama-server backend** (local model inference)
   - Host example: Bee (`192.168.x.x`)
   - Model example: Qwen3-Coder-Next-UD-Q6_K_XL split GGUF

Typical flow:

- Telegram/Discord command triggers IdleHands agent
- Agent sends OpenAI-compatible requests to local llama-server (`/v1/chat/completions`)
- Model emits tool calls
- IdleHands executes tools (`read_file`, `edit_file`, `exec`, etc.)
- Agent loops until task complete

---

## 2) Repository + Branch Setup

```bash
cd /mnt/user/downloads/idlehands
git checkout idlehands
git pull
npm ci
npm run build
```

Optional sanity checks:

```bash
node --version
npm --version
npm test -- --help
```

---

## 3) Runtime Requirements

- Linux host with enough RAM/VRAM for model size
- Node.js 20+ (project currently running on newer Node in your environment)
- `rg` (ripgrep) installed (important for `search_files` reliability)
- `git`, `bash`, `python3` (useful for tooling/scripts)

Install ripgrep if missing:

```bash
which rg || sudo apt-get install -y ripgrep
```

---

## 4) Build llama.cpp (visorcraft fork)

Use visorcraft fork (contains hybrid-cache related fixes relevant to these models).

```bash
cd /home/<user>
git clone https://github.com/visorcraft/llama.cpp
cd llama.cpp
git fetch origin
git checkout master
git reset --hard origin/master
```

### Vulkan build (example)

```bash
cmake -S . -B build-vulkan-host \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_VULKAN=ON \
  -DGGML_NATIVE=ON

cmake --build build-vulkan-host -j$(nproc)
./build-vulkan-host/bin/llama-server --version
```

If you use ROCm/HIP instead, use your HIP build directory and matching flags.

---

## 5) Chat Template (`qwen3.jinja`)

For this setup, use:

- `--jinja`
- `--chat-template-file /home/<user>/.idlehands/templates/qwen3.jinja`

In your testing, `qwen3.jinja` was the key change that significantly improved tool-call behavior.

> If you see the filename written as “.ninja”, that is almost certainly a typo.  
> Correct extension here is `.jinja`.

---

## 6) Model Files

Example model paths used in this project:

- Q4: `/home/<user>/models/Qwen3-Coder-Next-Q4_K_M.gguf`
- Q6 split: `/home/<user>/models/Qwen3-Coder-Next-UD-Q6_K_XL/Qwen3-Coder-Next-UD-Q6_K_XL-00001-of-00003.gguf`

For split GGUF, point `-m` to the first shard (`00001-of-...`).

---

## 7) llama-server Launch Command (reference profile)

```bash
/home/<user>/llama.cpp/build-vulkan-host/bin/llama-server \
  -m /home/<user>/models/Qwen3-Coder-Next-UD-Q6_K_XL/Qwen3-Coder-Next-UD-Q6_K_XL-00001-of-00003.gguf \
  --port 8082 \
  --host 0.0.0.0 \
  --chat-template-file /home/<user>/.idlehands/templates/qwen3.jinja \
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
  --slots \
  --temp 0.8 \
  --top-k 40 \
  --top-p 0.95 \
  --min-p 0.05 \
  --repeat-penalty 1.0 \
  --frequency-penalty 0.0 \
  --presence-penalty 0.0 \
  --typical 1.0 \
  --repeat-last-n 64
```

### Flag notes

- `-np 4` + `--slots`: 4 parallel slots
- `-c 800000`: total context budget across slots
- `--ctx-checkpoints 0` + `--cache-reuse 64`: profile used in successful comparisons
- `-ctk/-ctv q4_0`: KV cache quantization for memory/perf
- `-dio`: direct I/O mode
- `-fa on`: flash attention

Health check:

```bash
curl -s http://127.0.0.1:8082/health
```

Expected: `{"status":"ok"}`

---

## 8) IdleHands Gateway Setup

Run gateway locally (replace token with your own secret from env, not hardcoded):

```bash
export IDLEHANDS_GATEWAY_TOKEN="<REDACTED_SECRET_TOKEN>"
nohup idlehands gateway run \
  --port 1013 \
  --token "$IDLEHANDS_GATEWAY_TOKEN" \
  --bind loopback \
  --force \
  > /tmp/idlehands-gateway.log 2>&1 &
```

Health check:

```bash
idlehands gateway health --port 1013 --token "$IDLEHANDS_GATEWAY_TOKEN"
```

---

## 9) IdleHands Runtime/Model Configuration

Use OpenAI-compatible runtime pointing to local llama-server:

- Base URL example: `http://<llama-host>:8082/v1`
- API mode: OpenAI chat-completions compatible
- Model name must match what your runtime expects (example: `qwen3-coder-next`)

High-value behavior settings observed in your environment:

- `thinkingDefault: "off"`
- `toolResultTruncation: "off"`
- Keep tool schemas compact (stub mode for non-core tools)
- Core tools with full schema:
  - `read_file`
  - `search_files`
  - `edit_file`
  - `write_file`
  - `exec`

Session behavior:

- Use explicit `--session-id` for isolated fresh runs
- Keep lock timeout defaults sane (`timeoutMs > staleMs`)

---

## 10) Agent Invocation Pattern

```bash
IDLEHANDS_GATEWAY_URL=ws://127.0.0.1:1013 \
IDLEHANDS_GATEWAY_TOKEN="$IDLEHANDS_GATEWAY_TOKEN" \
idlehands agent \
  --agent task1 \
  --session-id "run-$(date +%s)" \
  --to "+1XXXXXXXXXX" \
  --timeout 1800 \
  --no-confirm \
  --json \
  --message "<task prompt>"
```

Notes:

- `--no-confirm` is required for autonomous edits
- Use fresh session IDs for reproducibility
- Prefer narrow prompts with explicit allowed files

---

## 11) Suggested Validation Procedure

Run this sequence for each config change:

1. Reset repo state
   ```bash
   git reset --hard HEAD && git clean -fd
   ```
2. Ensure no stale IdleHands agent processes
3. Confirm gateway health
4. Confirm llama-server health
5. Launch one fresh `--session-id` run for a fixed benchmark task
6. Capture metrics:
   - first edit turn
   - total reads vs edits
   - tests executed and pass/fail
   - runtime duration/token usage

Success criteria (recommended):

- First meaningful edit within <= 15 tool calls
- No repeated read-loop of same slices beyond guard threshold
- Task-scoped tests pass
- No unrelated-file drift

---

## 12) Troubleshooting

### A) Model reads forever, no edits

- Verify `qwen3.jinja` is actually loaded
- Ensure `--no-confirm` is present in agent run
- Keep non-core tools stubbed to reduce schema overload
- Confirm session is fresh (`--session-id` isolation)

### B) `search_files` behaves poorly

- Ensure `rg` installed and in PATH
- Keep fallback/auto-fix logic enabled in file discovery tool

### C) `edit_file` failures from model arg mistakes

- Keep alias/auto-fix layers for common key mismatches (`old_text/new_text` etc.)
- Strengthen guardrails in system prompt for exact tool argument requirements

### D) Hanging test subprocesses

- Agent may spawn long `npm test` chains; prefer targeted test commands in prompt
- Kill stray test trees before next benchmark

---

## 13) Security + Secrets Hygiene Checklist

- Never commit:
  - gateway tokens
  - bot tokens
  - SSH private keys
  - personal phone/chat IDs
- Keep secrets in env vars or local untracked files
- Redact logs before sharing publicly
- Use placeholders in docs and examples

---

## 14) Minimal “Known Good” Snapshot (Template)

Record your current stable profile in a local, private ops note:

- llama.cpp commit: `<commit>`
- build type: `Vulkan` or `HIP/ROCm`
- model path: `<path>`
- template file: `qwen3.jinja`
- launch flags: `<exact>`
- gateway port: `<port>`
- runtime endpoint: `<url>`
- benchmark task results: `<metrics>`

This makes regressions easy to detect and bisect.

---

If you want, I can also generate a second doc with:

- exact sample `config.json` / `runtimes.json` skeletons (sanitized), and
- a one-command bootstrap script that checks prerequisites + health + process cleanup before each benchmark run.
