#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${ROOT}/.perf"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/agent-perf-$(date +%Y%m%d-%H%M%S).log"

echo "[perf-agent] running tests with IDLEHANDS_PERF_TRACE=1"
IDLEHANDS_PERF_TRACE=1 node --test --test-concurrency=1 tests/agent.test.ts 2>&1 | tee "$LOG_FILE" >/dev/null

echo "[perf-agent] trace log: $LOG_FILE"

grep '^\[perf\]' "$LOG_FILE" > "${LOG_FILE}.perf" || true
COUNT=$(wc -l < "${LOG_FILE}.perf" | tr -d ' ')
echo "[perf-agent] perf rows: $COUNT"

python3 - "$LOG_FILE" <<'PY'
import re, statistics, sys, pathlib
log = pathlib.Path(sys.argv[1])
rows=[]
for line in log.read_text().splitlines():
    if not line.startswith('[perf]'): continue
    d={}
    for k in ['turns','toolCalls','wallMs','modelMs','compactMs','compactions']:
        m=re.search(rf'{k}=(\d+)', line)
        d[k]=int(m.group(1)) if m else 0
    rows.append(d)

if not rows:
    print('[perf-agent] no perf rows found')
    sys.exit(0)

wall=[r['wallMs'] for r in rows]
model=[r['modelMs'] for r in rows]
compact=[r['compactMs'] for r in rows]
tool=[r['toolCalls'] for r in rows]

wall_sorted=sorted(wall)
p95_idx=max(0, int(len(wall_sorted)*0.95)-1)

print('[perf-agent] summary')
print(f"  asks: {len(rows)}")
print(f"  avg wallMs: {sum(wall)/len(wall):.2f}")
print(f"  p95 wallMs: {wall_sorted[p95_idx]}")
print(f"  avg modelMs: {sum(model)/len(model):.2f}")
print(f"  avg compactMs: {sum(compact)/len(compact):.2f}")
print(f"  avg toolCalls: {sum(tool)/len(tool):.2f}")

heavy=[r for r in rows if r['toolCalls']>=5]
if heavy:
    hw=[r['wallMs'] for r in heavy]
    print(f"  heavy asks (toolCalls>=5): {len(heavy)}")
    print(f"  heavy avg wallMs: {sum(hw)/len(hw):.2f}")
    print(f"  heavy max wallMs: {max(hw)}")
PY
