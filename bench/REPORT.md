# Idle Hands — Bench Report

Generated: 2026-02-15T19:23:18.585Z

## edit_replace_compare (idlehands)

Runs: 20, ok: 20, fail: 0

- INIT median: 236.4 ms (session init: model pick + warmup)
- INIT p95:    334.6 ms
- TTC median:  8030.3 ms (ask: completion wall time)
- TTC p95:     11430.7 ms
- TTFR median: 2030.1 ms (ask: time-to-first-delta)
- TTFR p95:    2941.3 ms
- TTFT median: 2030.3 ms (ask: time-to-first-content-token)
- TTFT p95:    2941.4 ms

## edit_replace_compare (openclaw)

Runs: 5, ok: 5, fail: 0

- TTC median:  10331.8 ms (ask: completion wall time)
- TTC p95:     29852.0 ms
- TTFR median: 10244.9 ms (ask: time-to-first-delta)
- TTFR p95:    29758.7 ms
- TTFT median: 10244.9 ms (ask: time-to-first-content-token)
- TTFT p95:    29758.7 ms

## idlehands_realrepo_smoke_compare (idlehands)

Runs: 9, ok: 9, fail: 0

- INIT median: 230.8 ms (session init: model pick + warmup)
- INIT p95:    365.5 ms
- TTC median:  12679.3 ms (ask: completion wall time)
- TTC p95:     19526.3 ms
- TTFR median: 1567.3 ms (ask: time-to-first-delta)
- TTFR p95:    8074.8 ms
- TTFT median: 1567.4 ms (ask: time-to-first-content-token)
- TTFT p95:    8075.4 ms

## idlehands_realrepo_smoke_compare (openclaw)

Runs: 6, ok: 6, fail: 0

- TTC median:  15562.0 ms (ask: completion wall time)
- TTC p95:     18619.7 ms
- TTFR median: 15441.6 ms (ask: time-to-first-delta)
- TTFR p95:    18504.6 ms
- TTFT median: 15441.6 ms (ask: time-to-first-content-token)
- TTFT p95:    18504.6 ms

## insert_prepend_compare (idlehands)

Runs: 20, ok: 20, fail: 0

- INIT median: 244.5 ms (session init: model pick + warmup)
- INIT p95:    369.9 ms
- TTC median:  11430.3 ms (ask: completion wall time)
- TTC p95:     16992.8 ms
- TTFR median: 2119.5 ms (ask: time-to-first-delta)
- TTFR p95:    4132.2 ms
- TTFT median: 2119.6 ms (ask: time-to-first-content-token)
- TTFT p95:    4132.6 ms

## insert_prepend_compare (openclaw)

Runs: 5, ok: 5, fail: 0

- TTC median:  9148.4 ms (ask: completion wall time)
- TTC p95:     13814.3 ms
- TTFR median: 9045.3 ms (ask: time-to-first-delta)
- TTFR p95:    13675.5 ms
- TTFT median: 9045.3 ms (ask: time-to-first-content-token)
- TTFT p95:    13675.5 ms

## js_bugfix_small_compare (idlehands)

Runs: 74, ok: 34, fail: 40

- INIT median: 233.9 ms (session init: model pick + warmup)
- INIT p95:    369.4 ms
- TTC median:  29826.5 ms (ask: completion wall time)
- TTC p95:     61552.6 ms
- TTFR median: 1549.9 ms (ask: time-to-first-delta)
- TTFR p95:    8311.1 ms
- TTFT median: 1549.9 ms (ask: time-to-first-content-token)
- TTFT p95:    8311.2 ms

Top failures:
- iter 2: Connection timeout (10000ms) to http://localhost:8080/v1/chat/completions
- iter 1: Connection timeout (10000ms) to http://localhost:8080/v1/chat/completions
- iter 2: Connection timeout (10000ms) to http://localhost:8080/v1/chat/completions
- iter 3: Connection timeout (10000ms) to http://localhost:8080/v1/chat/completions
- iter 4: Connection timeout (10000ms) to http://localhost:8080/v1/chat/completions

## js_bugfix_small_compare (openclaw)

Runs: 28, ok: 9, fail: 19

- TTC median:  21378.1 ms (ask: completion wall time)
- TTC p95:     51842.2 ms
- TTFR median: 8626.2 ms (ask: time-to-first-delta)
- TTFR p95:    28785.8 ms
- TTFT median: 8626.2 ms (ask: time-to-first-content-token)
- TTFT p95:    28785.8 ms

Top failures:
- iter 1: success check rc=1 want=0
- iter 2: success check rc=1 want=0
- iter 3: success check rc=1 want=0
- iter 4: success check rc=1 want=0
- iter 5: success check rc=1 want=0

## js_multifile_fix_compare (idlehands)

Runs: 58, ok: 29, fail: 29

- INIT median: 195.1 ms (session init: model pick + warmup)
- INIT p95:    347.7 ms
- TTC median:  31744.4 ms (ask: completion wall time)
- TTC p95:     122353.5 ms
- TTFR median: 4156.5 ms (ask: time-to-first-delta)
- TTFR p95:    8264.1 ms
- TTFT median: 4460.9 ms (ask: time-to-first-content-token)
- TTFT p95:    8264.1 ms

Top failures:
- iter 2: success check rc=1 want=0
- iter 1: Cannot reach http://localhost:8080/v1. Is llama-server running? (fetch failed)
- iter 2: Cannot reach http://localhost:8080/v1. Is llama-server running? (fetch failed)
- iter 3: Cannot reach http://localhost:8080/v1. Is llama-server running? (fetch failed)
- iter 4: Cannot reach http://localhost:8080/v1. Is llama-server running? (fetch failed)

## js_multifile_fix_compare (openclaw)

Runs: 23, ok: 8, fail: 15

- TTC median:  32007.6 ms (ask: completion wall time)
- TTC p95:     69573.4 ms
- TTFR median: 9409.3 ms (ask: time-to-first-delta)
- TTFR p95:    51964.7 ms
- TTFT median: 9409.3 ms (ask: time-to-first-content-token)
- TTFT p95:    51964.7 ms

Top failures:
- iter 1: success check rc=1 want=0
- iter 2: success check rc=1 want=0
- iter 3: success check rc=1 want=0
- iter 4: success check rc=1 want=0
- iter 5: success check rc=1 want=0

## noisy_build_compare (idlehands)

Runs: 23, ok: 23, fail: 0

- INIT median: 247.8 ms (session init: model pick + warmup)
- INIT p95:    345.6 ms
- TTC median:  4764.6 ms (ask: completion wall time)
- TTC p95:     6646.1 ms
- TTFR median: 2601.4 ms (ask: time-to-first-delta)
- TTFR p95:    5173.2 ms
- TTFT median: 4722.6 ms (ask: time-to-first-content-token)
- TTFT p95:    6620.5 ms

## noisy_build_compare (openclaw)

Runs: 8, ok: 2, fail: 6

- TTC median:  40220.1 ms (ask: completion wall time)
- TTC p95:     41189.2 ms
- TTFR median: 40124.0 ms (ask: time-to-first-delta)
- TTFR p95:    41109.7 ms
- TTFT median: 40124.0 ms (ask: time-to-first-content-token)
- TTFT p95:    41109.7 ms

Top failures:
- iter 2: success check rc=1 want=0
- iter 3: success check rc=1 want=0
- iter 2: success check rc=1 want=0
- iter 3: success check rc=1 want=0
- iter 4: success check rc=1 want=0

## portal_realrepo_build_compare (idlehands)

Runs: 18, ok: 13, fail: 5

- INIT median: 350.1 ms (session init: model pick + warmup)
- INIT p95:    430.8 ms
- TTC median:  11134.5 ms (ask: completion wall time)
- TTC p95:     19404.3 ms
- TTFR median: 1545.9 ms (ask: time-to-first-delta)
- TTFR p95:    10555.8 ms
- TTFT median: 9174.1 ms (ask: time-to-first-content-token)
- TTFT p95:    15120.7 ms

Top failures:
- iter 1: Cannot reach http://localhost:8080/v1. Is llama-server running? (fetch failed)
- iter 2: Cannot reach http://localhost:8080/v1. Is llama-server running? (fetch failed)
- iter 3: Cannot reach http://localhost:8080/v1. Is llama-server running? (fetch failed)
- iter 4: Cannot reach http://localhost:8080/v1. Is llama-server running? (fetch failed)
- iter 5: Cannot reach http://localhost:8080/v1. Is llama-server running? (fetch failed)

## portal_realrepo_build_compare (openclaw)

Runs: 8, ok: 8, fail: 0

- TTC median:  26309.1 ms (ask: completion wall time)
- TTC p95:     52034.0 ms
- TTFR median: 26218.6 ms (ask: time-to-first-delta)
- TTFR p95:    51929.9 ms
- TTFT median: 26218.6 ms (ask: time-to-first-content-token)
- TTFT p95:    51929.9 ms

## portal_realrepo_build (idlehands)

Runs: 3, ok: 2, fail: 1

- INIT median: 223.2 ms (session init: model pick + warmup)
- INIT p95:    241.8 ms
- TTC median:  16060.7 ms (ask: completion wall time)
- TTC p95:     18959.9 ms
- TTFR median: 4764.6 ms (ask: time-to-first-delta)
- TTFR p95:    7626.6 ms
- TTFT median: 15984.7 ms (ask: time-to-first-content-token)
- TTFT p95:    18839.8 ms

Top failures:
- iter 1: Connection timeout (10000ms) to http://localhost:8080/v1/chat/completions

## search_files_compare (idlehands)

Runs: 25, ok: 15, fail: 10

- INIT median: 275.1 ms (session init: model pick + warmup)
- INIT p95:    928.4 ms
- TTC median:  16112.1 ms (ask: completion wall time)
- TTC p95:     32737.1 ms
- TTFR median: 1746.8 ms (ask: time-to-first-delta)
- TTFR p95:    10487.3 ms
- TTFT median: 15796.1 ms (ask: time-to-first-content-token)
- TTFT p95:    32202.7 ms

Top failures:
- iter 2: expected "/home/user/projects/visorcraft/idlehands/src/tools.ts", got "The `edit_file` tool is implemented in `/home/user/projects/visorcraft/idlehands/src/tools.ts`."
- iter 4: expected "/home/user/projects/visorcraft/idlehands/src/tools.ts", got "The `edit_file` tool is implemented in `/home/user/projects/visorcraft/idlehands/src/tools.ts`."
- iter 5: expected "/home/user/projects/visorcraft/idlehands/src/tools.ts", got "The `edit_file` tool is implemented in `/home/user/projects/visorcraft/idlehands/src/tools.ts` at line 503."
- iter 2: expected "/home/user/projects/visorcraft/idlehands/src/tools.ts", got "`/home/user/projects/visorcraft/idlehands/src/tools.ts`"
- iter 4: expected "/home/user/projects/visorcraft/idlehands/src/tools.ts", got "`/home/user/projects/visorcraft/idlehands/src/tools.ts`"

## search_files_compare (openclaw)

Runs: 10, ok: 5, fail: 5

- TTC median:  14640.4 ms (ask: completion wall time)
- TTC p95:     28519.9 ms
- TTFR median: 14139.0 ms (ask: time-to-first-delta)
- TTFR p95:    28435.0 ms
- TTFT median: 14139.0 ms (ask: time-to-first-content-token)
- TTFT p95:    28435.0 ms

Top failures:
- iter 1: expected "/home/user/projects/visorcraft/idlehands/src/tools.ts", got "Connection error."
- iter 2: expected "/home/user/projects/visorcraft/idlehands/src/tools.ts", got "Connection error."
- iter 3: expected "/home/user/projects/visorcraft/idlehands/src/tools.ts", got "Connection error."
- iter 4: expected "/home/user/projects/visorcraft/idlehands/src/tools.ts", got "Connection error."
- iter 5: expected "/home/user/projects/visorcraft/idlehands/src/tools.ts", got "Connection error."

## smoke_ok_compare (idlehands)

Runs: 27, ok: 14, fail: 13

- INIT median: 282.7 ms (session init: model pick + warmup)
- INIT p95:    370.9 ms
- TTC median:  2386.9 ms (ask: completion wall time)
- TTC p95:     17089.4 ms
- TTFR median: 2346.0 ms (ask: time-to-first-delta)
- TTFR p95:    17003.1 ms
- TTFT median: 2346.1 ms (ask: time-to-first-content-token)
- TTFT p95:    17003.5 ms

Top failures:
- iter 1: Connection timeout (10000ms) to http://localhost:8080/v1/chat/completions
- iter 2: Connection timeout (10000ms) to http://localhost:8080/v1/chat/completions
- iter 3: Connection timeout (10000ms) to http://localhost:8080/v1/chat/completions
- iter 1: Connection timeout (10000ms) to http://localhost:8080/v1/chat/completions
- iter 2: Connection timeout (10000ms) to http://localhost:8080/v1/chat/completions

## smoke_ok_compare (openclaw)

Runs: 5, ok: 0, fail: 5

- No successful runs to compute latency statistics.

Top failures:
- iter 1: expected "OK", got "Connection error."
- iter 2: expected "OK", got "Connection error."
- iter 3: expected "OK", got "Connection error."
- iter 4: expected "OK", got "Connection error."
- iter 5: expected "OK", got "Connection error."

