# Idle Hands Bench

Bench harness for comparing Idle Hands vs OpenClaw on repeatable cases.

## Layout

- `bench/cases/*.json` — bench case definitions
- `bench/fixtures/*` — fixture workspaces copied into a temp dir per iteration
- `bench/results/*.jsonl` — raw results (one JSON per line)
- `bench/REPORT.md` — aggregated report (p50/p95, failures)

## Run

From repo root:

```bash
npm run build
node dist/bench/runner.js bench/cases/example.json
```

This writes a `.jsonl` file to `bench/results/`.

## Timeouts (recommended)

Local model servers can intermittently stall during warmup, reloads, or under contention.
The bench runner and client support env overrides to reduce false failures:

```bash
# model server
export IDLEHANDS_ENDPOINT='http://localhost:8080/v1'

# network/stream timeouts
export IDLEHANDS_CONN_TIMEOUT_MS=30000
export IDLEHANDS_READ_TIMEOUT_MS=60000
export IDLEHANDS_RESPONSE_TIMEOUT_MS=180000

# bench iteration safety valve
export IDLEHANDS_BENCH_ITER_TIMEOUT_SEC=500

# optional: disable Trifecta features for cleaner perf measurements
export IDLEHANDS_NO_TRIFECTA=1
```

## Report

Regenerate the aggregated report:

```bash
node dist/bench/report.js
# writes bench/REPORT.md
```

## Notes

- Cases control the model name via `model` in the case JSON (or `IDLEHANDS_MODEL`).
- Each iteration runs in its own temp workspace unless `reuse_session` is set.
