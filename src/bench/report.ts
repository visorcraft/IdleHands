#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

type Row = {
  case: string;
  engine: string;
  iter: number;
  ok: boolean;
  reason: string;
  init_ms?: number;
  ttft_ms: number | null;
  ttc_ms: number;
  exitCode: number | null;
};

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function median(sorted: number[]) {
  return percentile(sorted, 0.5);
}

async function main() {
  const resultsDir = path.join(process.cwd(), 'bench', 'results');
  const ents = await fs.readdir(resultsDir, { withFileTypes: true }).catch(() => []);
  const files = ents.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => path.join(resultsDir, e.name));

  const rows: Row[] = [];
  for (const f of files) {
    const raw = await fs.readFile(f, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // ignore
      }
    }
  }

  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.case}::${r.engine}`;
    const arr = byKey.get(key) ?? [];
    arr.push(r);
    byKey.set(key, arr);
  }

  const lines: string[] = [];
  lines.push('# Idle Hands — Bench Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  for (const [key, arr] of [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [caseName, engine] = key.split('::');
    const oks = arr.filter((r) => r.ok);
    const failCount = arr.length - oks.length;

    const ttc = oks.map((r) => r.ttc_ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    const ttfr = oks
      .map((r: any) => r.ttfr_ms)
      .filter((n: any): n is number => typeof n === 'number' && Number.isFinite(n))
      .sort((a: number, b: number) => a - b);

    const ttft = oks
      .map((r) => r.ttft_ms)
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      .sort((a, b) => a - b);

    lines.push(`## ${caseName} (${engine})`);
    lines.push('');
    lines.push(`Runs: ${arr.length}, ok: ${oks.length}, fail: ${failCount}`);
    lines.push('');
    const init = oks
      .map((r) => (typeof r.init_ms === 'number' ? r.init_ms : NaN))
      // In reuse_session mode we record init_ms=0 for iter>1; ignore those.
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);

    if (init.length) {
      lines.push(`- INIT median: ${median(init).toFixed(1)} ms (session init: model pick + warmup)`);
      lines.push(`- INIT p95:    ${percentile(init, 0.95).toFixed(1)} ms`);
    }

    if (ttc.length) {
      lines.push(`- TTC median:  ${median(ttc).toFixed(1)} ms (ask: completion wall time)`);
      lines.push(`- TTC p95:     ${percentile(ttc, 0.95).toFixed(1)} ms`);
    }
    if (ttfr.length) {
      lines.push(`- TTFR median: ${median(ttfr).toFixed(1)} ms (ask: time-to-first-delta)`);
      lines.push(`- TTFR p95:    ${percentile(ttfr, 0.95).toFixed(1)} ms`);
    }

    if (ttft.length) {
      lines.push(`- TTFT median: ${median(ttft).toFixed(1)} ms (ask: time-to-first-content-token)`);
      lines.push(`- TTFT p95:    ${percentile(ttft, 0.95).toFixed(1)} ms`);
    }
    if (!oks.length) {
      lines.push('- No successful runs to compute latency statistics.');
    }

    // Flag warmup: iter=1 is typically slower (cold KV cache, model warmup)
    const warmup = oks.find((r: any) => r.iter === 1);
    const steady = oks.filter((r: any) => r.iter !== 1);
    if (warmup && steady.length >= 2) {
      const steadyTtc = steady.map((r) => r.ttc_ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
      if (steadyTtc.length) {
        const warmupPct = warmup.ttc_ms > 0 ? ((warmup.ttc_ms / median(steadyTtc) - 1) * 100).toFixed(0) : '?';
        lines.push(`- Warmup: iter=1 TTC ${warmup.ttc_ms.toFixed(1)} ms (+${warmupPct}% vs steady median ${median(steadyTtc).toFixed(1)} ms)`);
      }
    }

    const fails = arr.filter((r) => !r.ok).slice(0, 5);
    if (fails.length) {
      lines.push('');
      lines.push('Top failures:');
      for (const f of fails) lines.push(`- iter ${f.iter}: ${f.reason}`);
    }
    lines.push('');
  }

  const outPath = path.join(process.cwd(), 'bench', 'REPORT.md');
  await fs.writeFile(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
