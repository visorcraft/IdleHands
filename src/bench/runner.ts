#!/usr/bin/env node
// NOTE: These utilities are intentionally duplicated from src/ to keep the
// benchmark harness self-contained and free of production import dependencies.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSession } from '../agent.js';
import { loadConfig } from '../config.js';

import type { BenchCase, BenchResult } from './types.js';

function asError(e: unknown, fallback = 'error'): Error {
  if (e instanceof Error) return e;
  if (e === undefined) return new Error(fallback);
  return new Error(typeof e === 'string' ? e : String(e));
}

function nowMs() {
  return performance.now();
}

async function mkTempDir(prefix = 'idlehands-bench-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runShell(command: string, cwd: string, timeoutSec: number) {
  return await new Promise<{ rc: number; out: string; err: string }>((resolve, reject) => {
    const shell = process.env.IDLEHANDS_SHELL || 'bash';
    const child = spawn(shell, ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const t = setTimeout(() => child.kill('SIGKILL'), Math.max(1, timeoutSec) * 1000);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({
        rc: code ?? 0,
        out: Buffer.concat(out).toString('utf8'),
        err: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

async function main() {
  if (process.env.IDLEHANDS_BENCH_DEBUG === '1') {
    const { installBenchDebugHooks } = await import('./debug_hooks.js');
    installBenchDebugHooks();
  }
  const casePath = process.argv[2];
  if (!casePath) {
    console.error('Usage: runner <case.json>');
    process.exit(2);
  }

  const raw = await fs.readFile(casePath, 'utf8');
  const c = JSON.parse(raw) as BenchCase;

  const endpoint = process.env.IDLEHANDS_ENDPOINT || 'http://localhost:8080/v1';
  // Default to 10 reps so idlehands/openclaw comparisons have matching sample sizes.
  const reps = c.repetitions ?? 10;
  const maxTokens = c.max_tokens ?? 512;

  const results: BenchResult[] = [];

  // Workspace is per-run unless reuse_session is set.
  const reuse = !!c.reuse_session;
  let fixedWorkDir: string | null = null;
  let session: any = null;
  let config: any = null;
  let initMs = 0;

  const setupWorkspace = async () => {
    if (c.workspace.kind === 'fixed') return c.workspace.dir;
    return await mkTempDir(c.workspace.prefix ?? `idlehands-${c.name}-`);
  };

  if (reuse) {
    fixedWorkDir = await setupWorkspace();
    if (c.setup?.length) {
      for (const cmd of c.setup) {
        const r = await runShell(cmd, fixedWorkDir, 30);
        if (r.rc !== 0) throw new Error(`setup failed rc=${r.rc}: ${cmd}\n${r.err}`);
      }
    }

    const loaded = await loadConfig({
      configPath: path.join(os.tmpdir(), 'idlehands-bench-config-does-not-exist.json'),
      cli: {
        endpoint,
        dir: fixedWorkDir,
        model: c.model ?? process.env.IDLEHANDS_MODEL ?? '',
        max_tokens: maxTokens,
        no_confirm: true,
        dry_run: false,
        verbose: false,
      } as any,
    });
    config = loaded.config;

    const initStart = nowMs();
    session = await createSession({ config });
    initMs = nowMs() - initStart;
  }

  // Pre-load config once for non-reuse mode (avoid redundant loadConfig per iteration)
  let cachedConfig: any = null;
  if (!reuse) {
    const loaded = await loadConfig({
      configPath: path.join(os.tmpdir(), 'idlehands-bench-config-does-not-exist.json'),
      cli: {
        endpoint,
        dir: process.cwd(), // placeholder, overridden per-iter
        model: c.model ?? process.env.IDLEHANDS_MODEL ?? '',
        max_tokens: maxTokens,
        no_confirm: true,
        dry_run: false,
        verbose: false,
      } as any,
    });
    cachedConfig = loaded.config;
  }

  const iterTimeoutSec = Number.isFinite(Number(process.env.IDLEHANDS_BENCH_ITER_TIMEOUT_SEC))
    ? Number(process.env.IDLEHANDS_BENCH_ITER_TIMEOUT_SEC)
    : 500;

  const retryToSuccess = process.env.IDLEHANDS_BENCH_RETRY_TO_SUCCESS === '1';
  const maxRetry = Number(process.env.IDLEHANDS_BENCH_RETRY_MAX ?? '5');
  const retryCounts = new Map<number, number>();

  for (let i = 0; i < reps; i++) {
    let workDir = fixedWorkDir;

    try {
      console.error(
        `[bench] case=${c.name} engine=idlehands iter=${i + 1}/${reps} reuse_session=${reuse}`
      );
      if (reuse && i > 0) {
        session.reset();
      }
      if (!reuse) {
        workDir = await setupWorkspace();
        if (c.setup?.length) {
          for (const cmd of c.setup) {
            const r = await runShell(cmd, workDir!, 30);
            if (r.rc !== 0) throw new Error(`setup failed rc=${r.rc}: ${cmd}\n${r.err}`);
          }
        }

        config = { ...cachedConfig, dir: workDir };

        const initStart = nowMs();
        session = await createSession({ config });
        initMs = nowMs() - initStart;
      }

      const askStart = nowMs();
      let ttfr: number | null = null;
      let ttft: number | null = null;

      const aborter = new AbortController();
      const iterTimer = setTimeout(() => aborter.abort(), Math.max(1, iterTimeoutSec) * 1000);

      const res = await session
        .ask(c.instruction, {
          signal: aborter.signal,
          onFirstDelta: () => {
            if (ttfr == null) ttfr = nowMs() - askStart;
          },
          onToken: () => {
            if (ttft == null) ttft = nowMs() - askStart;
          },
        })
        .catch(async (e: any) => {
          // If the server is restarting/loading, wait for readiness and retry once.
          const message = e?.message ?? (typeof e === 'string' ? e : String(e ?? ''));
          const retryable =
            /fetch failed|Connection timeout|Cannot reach|model loading|returned 503/i.test(
              message
            );
          if (retryable) {
            try {
              const { OpenAIClient } = await import('../client.js');
              const cl = new OpenAIClient(config.endpoint, config.api_key, false);
              console.error(
                `[bench] transient server error (${message}); waiting for /v1/models ...`
              );
              await cl.waitForReady({ timeoutMs: 120_000, pollMs: 2000 });
              console.error(`[bench] server ready; retrying ask once`);
              return await session.ask(c.instruction, {
                signal: aborter.signal,
                onFirstDelta: () => {
                  if (ttfr == null) ttfr = nowMs() - askStart;
                },
                onToken: () => {
                  if (ttft == null) ttft = nowMs() - askStart;
                },
              });
            } catch {
              // fall through to rethrow original error
            }
          }
          throw asError(e, 'unknown error: threw undefined (bug)');
        })
        .finally(() => clearTimeout(iterTimer));

      const ttc = nowMs() - askStart;
      const out = (res.text ?? '').trim();

      let ok = true;
      let reason = 'ok';

      if (c.success) {
        if (c.success.type === 'equals') {
          ok = out === c.success.value;
          if (!ok)
            reason = `expected ${JSON.stringify(c.success.value)}, got ${JSON.stringify(out)}`;
        } else if (c.success.type === 'exec') {
          const ex = await runShell(c.success.command, workDir!, 60);
          const wantRc = c.success.exitCode ?? 0;
          ok = ex.rc === wantRc;
          reason = ok ? 'ok' : `success check rc=${ex.rc} want=${wantRc}`;
          if (ok && c.success.stdoutEquals !== undefined) {
            ok = ex.out.trimEnd() === c.success.stdoutEquals;
            if (!ok) reason = `success stdout mismatch`;
          }
          if (ok && c.success.stdoutIncludes) {
            ok = ex.out.includes(c.success.stdoutIncludes);
            if (!ok) reason = `success stdout missing substring`;
          }
        }
      }

      const row: BenchResult & {
        endpoint?: string;
        model?: string;
        git?: string;
      } = {
        case: c.name,
        engine: 'idlehands',
        iter: i + 1,
        ok,
        reason,
        init_ms: initMs, // real init time (same value for reuse mode, per-iter for non-reuse)
        ttfr_ms: ttfr,
        ttft_ms: ttft,
        ttc_ms: ttc,
        exitCode: 0,
        turns: res.turns,
        toolCalls: res.toolCalls,
        endpoint: process.env.IDLEHANDS_ENDPOINT,
        model: process.env.IDLEHANDS_MODEL,
        git: process.env.IDLEHANDS_GIT_SHA,
      };

      // Emit per-iteration result to stderr so callers can stream progress.
      const ttcS = row.ttc_ms ? (row.ttc_ms / 1000).toFixed(2) : '0.00';
      const ttfrS = row.ttfr_ms != null ? (row.ttfr_ms / 1000).toFixed(2) : 'null';
      console.error(
        `[bench] result case=${c.name} engine=idlehands iter=${row.iter}/${reps} ok=${row.ok} ttc_s=${ttcS} ttfr_s=${ttfrS} reason=${row.ok ? 'ok' : row.reason}`
      );

      results.push(row);
    } catch (e: any) {
      let reason = e?.message ?? (typeof e === 'string' ? e : undefined);
      if (!reason || reason === 'undefined') {
        if (e === undefined) {
          reason = 'unknown error: threw undefined (bug)';
        } else {
          try {
            reason = `unknown error: ${JSON.stringify(e)}`;
          } catch {
            reason = `unknown error: ${String(e)}`;
          }
        }
      }

      // Mode B: retry transient failures until we get N successful completions.
      // This keeps benchmark data useful even when the server/network has brief hiccups.
      if (retryToSuccess) {
        const retryable =
          /fetch failed|Connection timeout|Cannot reach|model loading|returned 503/i.test(reason);
        if (retryable) {
          const tries = (retryCounts.get(i) ?? 0) + 1;
          retryCounts.set(i, tries);
          if (tries <= maxRetry) {
            console.error(
              `[bench] retrying iter ${i + 1}/${reps} after retryable error (${tries}/${maxRetry}): ${reason}`
            );
            i -= 1;
            continue;
          }
        }
      }

      const row: BenchResult & {
        endpoint?: string;
        model?: string;
        git?: string;
      } = {
        case: c.name,
        engine: 'idlehands',
        iter: i + 1,
        ok: false,
        reason,
        init_ms: 0,
        ttfr_ms: null,
        ttft_ms: null,
        ttc_ms: 0,
        exitCode: null,
        endpoint: process.env.IDLEHANDS_ENDPOINT,
        model: process.env.IDLEHANDS_MODEL,
        git: process.env.IDLEHANDS_GIT_SHA,
      };

      console.error(
        `[bench] result case=${c.name} engine=idlehands iter=${row.iter}/${reps} ok=false reason=${row.reason}`
      );
      results.push(row);
    } finally {
      if (!reuse && c.workspace.kind === 'temp') {
        await fs.rm(workDir!, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  if (reuse && c.workspace.kind === 'temp' && fixedWorkDir) {
    await fs.rm(fixedWorkDir, { recursive: true, force: true }).catch(() => {});
  }

  // Stamp git sha into results (best-effort). Allows later comparison across changes.
  if (!process.env.IDLEHANDS_GIT_SHA) {
    try {
      const { execSync } = await import('node:child_process');
      process.env.IDLEHANDS_GIT_SHA = execSync('git rev-parse --short HEAD', {
        encoding: 'utf8',
      }).trim();
    } catch {}
  }

  // Stamp git sha into results retroactively
  if (process.env.IDLEHANDS_GIT_SHA) {
    for (const r of results) (r as any).git ??= process.env.IDLEHANDS_GIT_SHA;
  }

  const outPath = path.join(process.cwd(), 'bench', 'results', `${c.name}.${Date.now()}.jsonl`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`Wrote: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
