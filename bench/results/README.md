# Benchmark Results

Latest run: **2026-02-15** — Qwen3-Coder-Next 80B-A3B Q4_K_M on Halo (Strix Halo, 128GB)

## What the acronyms mean

- **TTC** (Time to Complete) — How long from "go" to "done." The full wall-clock time for the agent to read the task, think, write code, and pass the test. This is the number that matters most.
- **TTFR** (Time to First Response) — How long before the agent says *anything*. A fast TTFR means the model started generating quickly. A slow one means it's still chewing through the prompt (prompt eval). Think of it like: you ask someone a question — TTFR is how long they stare blankly before opening their mouth.
- **Stdev** (Standard Deviation) — How consistent the times are. Low = predictable. High = sometimes fast, sometimes slow, who knows.
- **Pass rate** — Did the agent actually fix the bug? 10/10 = nailed it every time.

## Results: Idle Hands vs OpenClaw

Both engines use the same local model on the same machine. The only difference is the agent framework.

### js_bugfix_small (single-file bug fix, 10 reps)

| Metric | Idle Hands | OpenClaw |
|--------|-----------|----------|
| Pass rate | **10/10** | 9/10 |
| TTC median | **14.2s** | 21.5s |
| TTC mean | **14.9s** | 38.5s |
| TTC min / max | 13.1 / 18.5s | 18.9 / 87.2s |
| TTC stdev | **2.0s** | 27.1s |
| TTFR median | **0.7s** | 8.5s |

**Idle Hands is 1.5x faster** (median TTC)

### js_multifile_fix (multi-file bug fix, 10 reps)

| Metric | Idle Hands | OpenClaw |
|--------|-----------|----------|
| Pass rate | **10/10** | 10/10 |
| TTC median | **18.6s** | 22.2s |
| TTC mean | **19.2s** | 22.4s |
| TTC min / max | 17.5 / 24.3s | 21.4 / 24.1s |
| TTC stdev | 1.9s | **0.9s** |
| TTFR median | **1.6s** | 8.4s |

**Idle Hands is 1.2x faster** (median TTC)

## Why Idle Hands is faster

1. **Lean prompt** — Idle Hands sends a minimal system prompt. OpenClaw loads SOUL.md, USER.md, TOOLS.md, workspace context, tool schemas, and more. That's thousands of extra tokens the model has to chew through before it can think about your actual task.
2. **Direct API** — Idle Hands talks straight to llama-server. OpenClaw routes through its agent framework, adding overhead per tool call.
3. **KV cache friendly** — Idle Hands keeps stable prompt prefixes so the model can reuse cached computation. OpenClaw's dynamic context disrupts this.

## Raw data

Result files are JSONL — one JSON object per iteration:

```
bench/results/js_bugfix_small_compare.compare.*.jsonl
bench/results/js_multifile_fix_compare.compare.*.jsonl
```

## Reproducing

See `AGENTS.md` for the full benchmark template (env vars, server config, run commands).
