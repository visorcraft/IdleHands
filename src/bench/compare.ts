#!/usr/bin/env node
// NOTE: These utilities are intentionally duplicated from src/ to keep the
// benchmark harness self-contained and free of production import dependencies.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSession } from '../agent.js';
import { loadConfig } from '../config.js';

import { runOpenclaw } from './openclaw.js';
import type { BenchCase, BenchEngine, BenchResult } from './types.js';

function nowMs() {
  return performance.now();
}

async function mkTempDir(prefix = 'idlehands-bench-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runShell(command: string, cwd: string, timeoutSec: number) {
  return await new Promise<{ rc: number; out: string; err: string }>((resolve, reject) => {
    const shell = process.env.IDLEHANDS_SHELL || 'bash';
    const child = spawn(shell, ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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

function randSessionId() {
  return crypto.randomBytes(8).toString('hex');
}

async function setupWorkspace(c: BenchCase): Promise<string> {
  if (c.workspace.kind === 'fixed') return c.workspace.dir;
  return await mkTempDir(c.workspace.prefix ?? `idlehands-${c.name}-`);
}

async function applySetup(c: BenchCase, workDir: string) {
  if (!c.setup?.length) return;
  for (const cmd of c.setup) {
    const r = await runShell(cmd, workDir, 30);
    if (r.rc !== 0) throw new Error(`setup failed rc=${r.rc}: ${cmd}\n${r.err}`);
  }
}

async function checkSuccess(c: BenchCase, workDir: string, agentOutput: string) {
  if (!c.success) return { ok: true, reason: 'ok' };

  if (c.success.type === 'equals') {
    const out = agentOutput.trim();
    const ok = out === c.success.value;
    return {
      ok,
      reason: ok ? 'ok' : `expected ${JSON.stringify(c.success.value)}, got ${JSON.stringify(out)}`,
    };
  }

  if (c.success.type === 'exec') {
    const ex = await runShell(c.success.command, workDir, 60);
    const wantRc = c.success.exitCode ?? 0;
    let ok = ex.rc === wantRc;
    let reason = ok ? 'ok' : `success check rc=${ex.rc} want=${wantRc}`;
    if (ok && c.success.stdoutEquals !== undefined) {
      ok = ex.out.trimEnd() === c.success.stdoutEquals;
      if (!ok) reason = `success stdout mismatch`;
    }
    if (ok && c.success.stdoutIncludes) {
      ok = ex.out.includes(c.success.stdoutIncludes);
      if (!ok) reason = `success stdout missing substring`;
    }
    return { ok, reason };
  }

  return { ok: false, reason: 'unknown success type' };
}

async function runIdlehandsOnce(opts: {
  workDir: string;
  instruction: string;
  endpoint: string;
  maxTokens: number;
  model?: string;
  cachedConfig?: any;
}): Promise<{
  initMs: number;
  ttfrMs: number | null;
  ttftMs: number | null;
  ttcMs: number;
  exitCode: number;
  out: string;
  turns: number;
  toolCalls: number;
}> {
  const config = opts.cachedConfig
    ? { ...opts.cachedConfig, dir: opts.workDir }
    : (
        await loadConfig({
          configPath: path.join(os.tmpdir(), 'idlehands-bench-config-does-not-exist.json'),
          cli: {
            endpoint: opts.endpoint,
            dir: opts.workDir,
            model: opts.model ?? '',
            max_tokens: opts.maxTokens,
            no_confirm: true,
            dry_run: false,
            verbose: false,
          } as any,
        })
      ).config;

  const initStart = nowMs();
  const session = await createSession({ config });
  const initMs = nowMs() - initStart;

  const askStart = nowMs();
  let ttfr: number | null = null;
  let ttft: number | null = null;

  const res = await session.ask(opts.instruction, {
    onFirstDelta: () => {
      if (ttfr == null) ttfr = nowMs() - askStart;
    },
    onToken: () => {
      if (ttft == null) ttft = nowMs() - askStart;
    },
  });

  const ttc = nowMs() - askStart;
  return {
    initMs,
    ttfrMs: ttfr,
    ttftMs: ttft,
    ttcMs: ttc,
    exitCode: 0,
    out: res.text ?? '',
    turns: res.turns,
    toolCalls: res.toolCalls,
  };
}

async function runEngineOnce(
  engine: BenchEngine,
  c: BenchCase,
  workDir: string,
  endpoint: string,
  maxTokens: number,
  cachedConfig?: any
) {
  if (engine === 'idlehands') {
    return await runIdlehandsOnce({
      workDir,
      instruction: c.instruction,
      endpoint,
      maxTokens,
      model: c.model,
      cachedConfig,
    });
  }

  // openclaw (embedded local mode to keep it apples-to-apples)
  const t0 = nowMs();
  const r = await runOpenclaw({
    workDir,
    instruction: c.instruction,
    timeoutSec: 180,
    sessionId: `bench_${c.name}_${randSessionId()}`,
    // Use embedded mode to avoid gateway pairing requirements.
    // We still pin the model/provider via OPENCLAW_CONFIG_PATH.
    local: true,
    profile: 'idlehands-bench',
  });
  const initMs = 0;
  const ttc = nowMs() - t0;

  // openclaw emits JSON; extract first "text" field.
  let out = '';
  try {
    const { extractFirstText } = await import('./json_extract.js');
    const parsed = JSON.parse(r.stdout || r.stderr || '{}');
    out = (extractFirstText(parsed) ?? '').trim();
  } catch {
    out = (r.stdout || r.stderr || '').trim();
  }

  return {
    initMs,
    ttfrMs: r.ttfrMs,
    ttftMs: null,
    ttcMs: ttc,
    exitCode: r.exitCode,
    out,
    turns: 0,
    toolCalls: 0,
  };
}

async function main() {
  const casePath = process.argv[2];
  if (!casePath) {
    console.error('Usage: compare <case.json>');
    process.exit(2);
  }

  const raw = await fs.readFile(casePath, 'utf8');
  const c = JSON.parse(raw) as BenchCase;

  const endpoint = process.env.IDLEHANDS_ENDPOINT || 'http://localhost:8080/v1';
  const reps = c.repetitions ?? 5;
  const maxTokens = c.max_tokens ?? 512;

  const engines: BenchEngine[] =
    c.engine === 'openclaw'
      ? ['openclaw']
      : c.engine === 'both'
        ? ['idlehands', 'openclaw']
        : ['idlehands'];

  const results: BenchResult[] = [];

  // Pre-load config once for idlehands runs (avoids redundant loadConfig + /v1/models per iteration)
  let idlehandsCachedConfig: any = null;
  if (engines.includes('idlehands')) {
    const { config } = await loadConfig({
      configPath: path.join(os.tmpdir(), 'idlehands-bench-config-does-not-exist.json'),
      cli: {
        endpoint,
        dir: process.cwd(),
        model: c.model ?? '',
        max_tokens: maxTokens,
        no_confirm: true,
        dry_run: false,
        verbose: false,
      } as any,
    });
    idlehandsCachedConfig = config;
  }

  for (const engine of engines) {
    for (let i = 0; i < reps; i++) {
      const workDir = await setupWorkspace(c);
      try {
        console.error(
          `[bench] case=${c.name} engine=${engine} iter=${i + 1}/${reps} workdir=${workDir}`
        );
        await applySetup(c, workDir);

        const r = await runEngineOnce(
          engine,
          c,
          workDir,
          endpoint,
          maxTokens,
          engine === 'idlehands' ? idlehandsCachedConfig : undefined
        );
        const check = await checkSuccess(c, workDir, r.out);

        const ok = check.ok && r.exitCode === 0;
        const reason = check.ok
          ? r.exitCode === 0
            ? 'ok'
            : `exitCode=${r.exitCode}`
          : check.reason;
        const ttcS = r.ttcMs != null ? (r.ttcMs / 1000).toFixed(2) : '?';
        const ttfrS = r.ttfrMs != null ? (r.ttfrMs / 1000).toFixed(2) : '?';
        console.error(
          `[bench] result case=${c.name} engine=${engine} iter=${i + 1}/${reps} ok=${ok} ttc_s=${ttcS} ttfr_s=${ttfrS} reason=${ok ? 'ok' : reason}`
        );

        results.push({
          case: c.name,
          engine,
          iter: i + 1,
          ok,
          reason,
          init_ms: r.initMs,
          ttfr_ms: r.ttfrMs,
          ttft_ms: r.ttftMs,
          ttc_ms: r.ttcMs,
          exitCode: r.exitCode,
          turns: r.turns,
          toolCalls: r.toolCalls,
        });
      } catch (e: any) {
        const reason = e?.message ?? String(e);
        console.error(
          `[bench] result case=${c.name} engine=${engine} iter=${i + 1}/${reps} ok=false ttc_s=0 ttfr_s=? reason=${reason}`
        );

        results.push({
          case: c.name,
          engine,
          iter: i + 1,
          ok: false,
          reason,
          init_ms: 0,
          ttfr_ms: null,
          ttft_ms: null,
          ttc_ms: 0,
          exitCode: null,
        });
      } finally {
        if (c.workspace.kind === 'temp') {
          await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  }

  const outPath = path.join(
    process.cwd(),
    'bench',
    'results',
    `${c.name}.compare.${Date.now()}.jsonl`
  );
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`Wrote: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
