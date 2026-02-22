/**
 * Factory for the ReplContext object — wires up all method implementations.
 *
 * Extracted from index.ts to keep the main REPL loop focused on flow control.
 * Every method that was defined inline on `ctx` now lives here.
 */

import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import type readline from 'node:readline/promises';

import { runProjectIndex, projectIndexKeys, parseIndexMeta, indexSummaryLine } from '../indexer.js';
import type { makeStyler } from '../term.js';
import { projectDir } from '../utils.js';

import { runAgentTurnWithSpinner } from './agent-turn.js';
import { friendlyError } from './args.js';
import { getGitShortStat, parseChangedFileCount } from './init.js';
import type { ReplContext } from './repl-context.js';
import {
  lastSessionPath,
  namedSessionPath,
  projectSessionPath,
  saveSessionFile,
} from './session-state.js';
import {
  queryServerHealth,
  formatStatusLine,
  StatusBar,
  formatTps,
  formatKv,
  type PerfTurnSample,
} from './status.js';
import { summarizeWatchChange } from './watch.js';

/** Dependencies injected from main() — avoids closing over the entire scope. */
export interface ReplContextDeps {
  session: any;
  config: any;
  rl: readline.Interface;
  S: ReturnType<typeof makeStyler>;
  version: string;
  vimState: any;
  customCommands: Map<string, any>;
  enabled: boolean;
  confirm: (prompt: string) => Promise<boolean>;
  sessionName: string;
  resumeFile: string;
  warnFmt: (msg: string, s: any) => string;
  errFmt: (msg: string, s: any) => string;
}

/**
 * Build a fully wired ReplContext from the given dependencies.
 *
 * All mutable state lives on the returned ctx object.
 * Methods reference `ctx` (the returned object) for self-mutation
 * and `deps` for injected collaborators.
 */
export function buildReplContext(deps: ReplContextDeps): ReplContext {
  const {
    session,
    config,
    rl,
    S,
    version,
    vimState,
    customCommands,
    enabled,
    confirm,
    sessionName,
    resumeFile,
    warnFmt,
    errFmt,
  } = deps;

  const statusBar = new StatusBar(S);
  const perfSamples: PerfTurnSample[] = [];
  const sessionStartedMs = Date.now();

  const ctx: ReplContext = {
    session,
    config,
    rl,
    S,
    version,
    shellMode: false,
    activeShellProc: null,
    statusBarEnabled: false,
    statusBar,
    lastStatusLine: formatStatusLine(session, config, S),
    lastAutoCommitOfferStat: '',
    sessionStartedMs,
    changesBaselineMs: sessionStartedMs,
    lastRunnableInput: '',
    perfSamples,
    healthUnsupported: false,
    lastHealthWarning: '',
    lastHealthSnapshot: null,
    lastHealthSnapshotAt: 0,
    pendingTemplate: null,
    customCommands,
    vimState,
    enabled,

    watchPaths: [],
    watchMaxIterationsPerTrigger: 3,
    watchActive: false,
    watchWatchers: [],
    watchDebounceTimer: null,
    watchPendingChanges: new Set<string>(),
    watchRunInFlight: false,
    watchRunQueued: false,

    indexRunning: false,
    indexStartedAt: 0,
    indexProgress: { scanned: 0, indexed: 0, skipped: 0 },
    indexLastResult: null,
    indexLastError: '',

    antonActive: false,
    antonAbortSignal: null,
    antonLastResult: null,
    antonProgress: null,

    confirm,

    // ── Lifecycle ──────────────────────────────────────────────────

    async shutdown(code: number) {
      if (code === 0 || code === 143) {
        await ctx.saveCurrentSession().catch(() => {});
      }
      ctx.stopWatchMode(false);
      try {
        session.cancel();
      } catch {}
      try {
        await session.close();
      } catch {}
      try {
        rl.close();
      } catch {}
      process.exit(code);
    },

    // ── Server health ─────────────────────────────────────────────

    async readServerHealth(force = false) {
      if (ctx.healthUnsupported) return null;
      const now = Date.now();
      if (!force && ctx.lastHealthSnapshot && now - ctx.lastHealthSnapshotAt < 2000) {
        return ctx.lastHealthSnapshot;
      }
      const snap = await queryServerHealth(config.endpoint, 1500);
      ctx.lastHealthSnapshot = snap;
      ctx.lastHealthSnapshotAt = now;
      if (snap.unsupported) {
        ctx.healthUnsupported = true;
        return null;
      }
      if (!snap.ok) {
        if (snap.error !== ctx.lastHealthWarning) {
          ctx.lastHealthWarning = snap.error || '';
          console.log(warnFmt(`[server] ${snap.error || 'health check failed'}`, S));
        }
        return snap;
      }
      ctx.lastHealthWarning = '';
      return snap;
    },

    // ── Metrics ───────────────────────────────────────────────────

    async maybePrintTurnMetrics(stats) {
      const sample: PerfTurnSample = {
        ts: Date.now(),
        turn: stats.turn,
        ttftMs: stats.ttftMs,
        ttcMs: stats.ttcMs,
        promptTokens: stats.promptTokensTurn ?? 0,
        completionTokens: stats.completionTokensTurn ?? 0,
        ppTps: stats.ppTps,
        tgTps: stats.tgTps,
      };
      perfSamples.push(sample);
      if (config.show_server_metrics === false) return;
      const health = await ctx.readServerHealth();
      const kv = health ? formatKv(health.kvUsed, health.kvTotal) : undefined;
      const pp = stats.ppTps ?? health?.ppTps;
      const tg = stats.tgTps ?? health?.tgTps;
      const bits = [
        typeof pp === 'number' && Number.isFinite(pp) ? `pp: ${formatTps(pp)}` : undefined,
        typeof tg === 'number' && Number.isFinite(tg) ? `tg: ${formatTps(tg)}` : undefined,
        kv ? `KV: ${kv}` : undefined,
      ].filter(Boolean);
      if (bits.length) console.log(S.dim(`[server] ${bits.join(' | ')}`));
      const slowThreshold = config.slow_tg_tps_threshold ?? 10;
      if (typeof tg === 'number' && Number.isFinite(tg) && tg < slowThreshold) {
        console.log(
          warnFmt(`[perf] Generation slowed to ${tg.toFixed(1)} t/s - context may be too large`, S)
        );
      }
    },

    // ── Git auto-commit ───────────────────────────────────────────

    async maybeOfferAutoCommit(taskHint: string) {
      const cwd = projectDir(config);
      const short = getGitShortStat(cwd);
      if (!short || short === ctx.lastAutoCommitOfferStat) return;
      const changedFiles = parseChangedFileCount(short);
      if (changedFiles < 2) return;
      const ans = (await rl.question(`Commit these changes? [Y/n/edit message] (${short}) `))
        .trim()
        .toLowerCase();
      if (ans === 'n' || ans === 'no') {
        ctx.lastAutoCommitOfferStat = short;
        return;
      }
      let msg = `chore(agent): ${taskHint.replace(/\s+/g, ' ').slice(0, 64) || 'apply multi-file changes'}`;
      if (ans === 'e' || ans === 'edit' || ans === 'message') {
        const custom = (await rl.question('Commit message: ')).trim();
        if (custom) msg = custom;
      }
      const run = spawnSync('git', ['add', '-A'], { cwd, encoding: 'utf8', timeout: 5000 });
      if (run.status !== 0) {
        console.log(
          (String(run.stdout || '') + String(run.stderr || '')).trim() || 'git add failed'
        );
        return;
      }
      const commit = spawnSync('git', ['commit', '-m', msg], {
        cwd,
        encoding: 'utf8',
        timeout: 5000,
      });
      const out = (String(commit.stdout || '') + String(commit.stderr || '')).trim();
      if (commit.status === 0) {
        console.log(out || `Committed: ${msg}`);
        ctx.lastAutoCommitOfferStat = '';
      } else {
        console.log(out || 'git commit failed');
        ctx.lastAutoCommitOfferStat = short;
      }
    },

    // ── Session persistence ───────────────────────────────────────

    async saveCurrentSession() {
      const payload = {
        savedAt: new Date().toISOString(),
        model: session.model,
        harness: session.harness,
        contextWindow: session.contextWindow,
        messages: session.messages,
        sessionName: sessionName || undefined,
      };
      const targets = new Set<string>([
        resumeFile,
        lastSessionPath(),
        projectSessionPath(projectDir(config)),
      ]);
      if (sessionName) targets.add(namedSessionPath(sessionName));
      for (const target of targets) await saveSessionFile(target, payload);
    },

    // ── Watch mode ────────────────────────────────────────────────

    stopWatchMode(announce = true) {
      if (ctx.watchDebounceTimer) {
        clearTimeout(ctx.watchDebounceTimer);
        ctx.watchDebounceTimer = null;
      }
      for (const w of ctx.watchWatchers) {
        try {
          w.close();
        } catch {}
      }
      ctx.watchWatchers = [];
      ctx.watchPendingChanges = new Set<string>();
      ctx.watchRunQueued = false;
      ctx.watchActive = false;
      ctx.watchPaths = [];
      if (announce) console.log(S.dim('[watch] stopped.'));
    },

    async startWatchMode(paths: string[], maxIterationsPerTrigger: number) {
      const cwd = projectDir(config);
      const resolved = paths.map((p) => path.resolve(cwd, p));
      const missing = resolved.filter((p) => !fsSync.existsSync(p));
      if (missing.length) throw new Error(`Watch path not found: ${missing[0]}`);
      ctx.stopWatchMode(false);
      ctx.watchMaxIterationsPerTrigger = Math.max(1, maxIterationsPerTrigger || 3);
      ctx.watchPaths = resolved;
      for (const absPath of resolved) {
        const st = fsSync.statSync(absPath);
        const baseDir = st.isDirectory() ? absPath : path.dirname(absPath);
        const watcher = fsSync.watch(absPath, { persistent: true }, (_eventType, filename) => {
          const name = filename ? String(filename) : path.basename(absPath);
          const changedAbs = filename ? path.resolve(baseDir, name) : absPath;
          const rel = path.relative(cwd, changedAbs).replace(/\\/g, '/');
          ctx.watchPendingChanges.add(rel || name);
          if (ctx.watchDebounceTimer) clearTimeout(ctx.watchDebounceTimer);
          ctx.watchDebounceTimer = setTimeout(() => {
            const summary = summarizeWatchChange(ctx.watchPendingChanges);
            ctx.watchPendingChanges = new Set<string>();
            void ctx.runWatchPrompt(summary);
          }, 500);
        });
        watcher.on('error', (e) =>
          console.error(warnFmt(`[watch] ${absPath}: ${String((e as any)?.message ?? e)}`, S))
        );
        ctx.watchWatchers.push(watcher);
      }
      ctx.watchActive = true;
    },

    async runWatchPrompt(changeSummary: string) {
      if (!ctx.watchActive) return;
      if (typeof ctx.lastRunnableInput === 'string' && !ctx.lastRunnableInput.trim()) return;
      if (Array.isArray(ctx.lastRunnableInput) && ctx.lastRunnableInput.length === 0) return;
      if (ctx.watchRunInFlight) {
        ctx.watchRunQueued = true;
        return;
      }
      ctx.watchRunInFlight = true;
      const priorMaxIterations = config.max_iterations;
      config.max_iterations = Math.max(
        1,
        Math.min(config.max_iterations, ctx.watchMaxIterationsPerTrigger)
      );
      try {
        console.log(S.dim(`[watch] ${changeSummary} → re-running...`));
        const res = await runAgentTurnWithSpinner(ctx, ctx.lastRunnableInput);
        await ctx.maybeOfferAutoCommit('[watch] auto-rerun');
        if (config.verbose) {
          const { renderMarkdown } = await import('../markdown.js');
          console.log(renderMarkdown(res.text, { color: S.enabled, verbose: true }));
        }
        ctx.lastStatusLine = formatStatusLine(session, config, S);
        console.log(ctx.lastStatusLine);
        if (ctx.statusBarEnabled) statusBar.render(ctx.lastStatusLine);
      } catch (e: any) {
        process.stdout.write('\n');
        console.error(errFmt(friendlyError(e), S));
      } finally {
        config.max_iterations = priorMaxIterations;
        ctx.watchRunInFlight = false;
        if (ctx.watchRunQueued) {
          ctx.watchRunQueued = false;
          const queuedSummary = summarizeWatchChange(ctx.watchPendingChanges);
          ctx.watchPendingChanges = new Set<string>();
          void ctx.runWatchPrompt(queuedSummary);
        }
      }
    },

    // ── Project indexing ──────────────────────────────────────────

    async startIndexInBackground() {
      if (!session.vault || !session.lens) {
        console.log(
          'Indexing requires Vault + Lens enabled. Remove --no-vault/--no-lens/--no-trifecta.'
        );
        return;
      }
      if (ctx.indexRunning) {
        const elapsed = Math.max(0, Math.floor((Date.now() - ctx.indexStartedAt) / 1000));
        console.log(
          `Index already running (${elapsed}s): scanned=${ctx.indexProgress.scanned}, indexed=${ctx.indexProgress.indexed}, skipped=${ctx.indexProgress.skipped}`
        );
        return;
      }
      ctx.indexRunning = true;
      ctx.indexStartedAt = Date.now();
      ctx.indexProgress = { scanned: 0, indexed: 0, skipped: 0 };
      ctx.indexLastError = '';
      const cwd = projectDir(config);
      console.log(`[index] started in background for ${cwd}`);
      void runProjectIndex({
        projectDir: cwd,
        vault: session.vault,
        lens: session.lens,
        onProgress: (p) => {
          ctx.indexProgress = {
            scanned: p.scanned,
            indexed: p.indexed,
            skipped: p.skipped,
            current: p.current,
          };
        },
      })
        .then((result) => {
          ctx.indexLastResult = result;
          ctx.indexRunning = false;
          const elapsed = Math.max(0, Math.floor((Date.now() - ctx.indexStartedAt) / 1000));
          console.log(
            S.dim(
              `[index] done in ${elapsed}s — scanned ${result.filesScanned}, indexed ${result.filesIndexed}, skipped ${result.filesSkipped}, removed ${result.filesRemoved}`
            )
          );
          if (result.warnings.length)
            for (const w of result.warnings) console.log(warnFmt(`[index] ${w}`, S));
          console.log(S.dim(indexSummaryLine(result.meta)));
        })
        .catch((e: any) => {
          ctx.indexRunning = false;
          ctx.indexLastError = String(e?.message ?? e);
          console.error(errFmt(`INDEX: ${ctx.indexLastError}`, S));
        });
    },

    async printIndexStats() {
      if (!session.vault) {
        console.log('No index metadata found for this project. Run /index to build one.');
        return;
      }
      const keys = projectIndexKeys(projectDir(config));
      const row = await session.vault.getLatestByKey(keys.metaKey, 'system');
      if (!row?.value) {
        console.log('No index metadata found for this project. Run /index to build one.');
        return;
      }
      const meta = parseIndexMeta(row.value);
      if (!meta) {
        console.log('No index metadata found for this project. Run /index to build one.');
        return;
      }
      const ageMs = Date.now() - Date.parse(meta.indexedAt || '');
      const ageMin = Number.isFinite(ageMs) ? Math.max(0, Math.floor(ageMs / 60_000)) : 0;
      const ageStr =
        ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
      const langs = Object.entries(meta.languages || {})
        .sort((a: any, b: any) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
      console.log('Index stats:');
      console.log(`  Project id: ${meta.projectId}`);
      console.log(`  Indexed at: ${meta.indexedAt} (${ageStr})`);
      console.log(`  File count: ${meta.fileCount}`);
      console.log(`  Skeleton tokens: ${meta.totalSkeletonTokens.toLocaleString()}`);
      console.log(`  Top languages: ${langs || 'none'}`);
      if (ctx.indexRunning) {
        const elapsed = Math.max(0, Math.floor((Date.now() - ctx.indexStartedAt) / 1000));
        console.log(
          `  Background job: running (${elapsed}s) scanned=${ctx.indexProgress.scanned} indexed=${ctx.indexProgress.indexed} skipped=${ctx.indexProgress.skipped}`
        );
        if (ctx.indexProgress.current) console.log(`  Current file: ${ctx.indexProgress.current}`);
      }
    },

    async clearIndex() {
      if (!session.vault) {
        console.log('Vault is disabled. /index requires Vault + Lens enabled.');
        return;
      }
      const keys = projectIndexKeys(projectDir(config));
      const removedFiles = await session.vault.deleteByKeyPrefix(keys.filePrefix);
      const removedMeta = await session.vault.deleteByKey(keys.metaKey);
      const removedSummary = await session.vault.deleteByKey(keys.summaryKey);
      console.log(
        `Index cleared: removed ${removedFiles} file entr${removedFiles === 1 ? 'y' : 'ies'} (+${removedMeta + removedSummary} metadata entries).`
      );
    },
  };

  return ctx;
}
