# Benchmarking (Halo + Idle Hands)

This repo's benchmarks run against a shared model server (Halo llama-server). For consistent numbers:

- **Do not run multiple cases concurrently** (contention ruins results)
- Prefer sequential `10x` runs for parity with OpenClaw

## Halo llama-server

Recommended server command:

```bash
~/llama.cpp/build/bin/llama-server \
  -m ~/models/Qwen3-Coder-Next-Q4_K_M.gguf \
  -ngl 99 -c 262144 -fa on --jinja \
  --host 0.0.0.0 --port 8080
```

## Benchmark-only watchdog (recommended)

`llama-server` can crash intermittently under tool-calling workloads (known llama.cpp grammar issue: `Unexpected empty grammar stack ... =list`).

For **benchmark runs only**, we use a lightweight watchdog on Halo that:
- ensures **exactly one** watchdog is running
- restarts llama-server if it dies or `/v1/models` stops responding
- is **NOT** intended to run 24/7

Install location on Halo:
- `~/bench/llama_watchdog.sh`
- `~/bench/watchdog_start.sh`
- `~/bench/watchdog_stop.sh`

Usage (on Halo):

```bash
# Start watchdog (idempotent: will not spawn a second copy)
~/bench/watchdog_start.sh

# Check
cat ~/bench/llama_watchdog_8080.pid
tail -n 50 ~/bench/llama_watchdog_8080.out

# Stop watchdog when benchmarks are done
~/bench/watchdog_stop.sh
```

### Files used

- Watchdog PID: `~/bench/llama_watchdog_8080.pid`
- Watchdog stdout/stderr: `~/bench/llama_watchdog_8080.out`
- llama-server PID: `~/llama-server-8080.pid`
- llama-server log: `~/llama-server-8080.log`

## Idle Hands-only run (example)

```bash
cd ~/projects/visorcraft/idlehands
npm run build

export IDLEHANDS_ENDPOINT='http://localhost:8080/v1'
export IDLEHANDS_NO_TRIFECTA=1
export IDLEHANDS_CONN_TIMEOUT_MS=30000
export IDLEHANDS_READ_TIMEOUT_MS=60000
export IDLEHANDS_RESPONSE_TIMEOUT_MS=180000
export IDLEHANDS_BENCH_ITER_TIMEOUT_SEC=500

node dist/bench/runner.js bench/cases/js_bugfix_small_compare.json
node dist/bench/runner.js bench/cases/js_multifile_fix_compare.json
```
