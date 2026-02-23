/**
 * Project commands: /init, /git, /branch, /changes, /watch, /index, /undo, /diff.
 */

import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { unifiedDiffFromBuffers } from '../../replay_cli.js';
import { colorizeUnifiedDiff, err as errFmt } from '../../term.js';
import { projectDir } from '../../utils.js';
import type { SlashCommand } from '../command-registry.js';
import { restTokens } from '../command-utils.js';
import {
  generateInitContext,
  formatInitSummary,
  getGitSnapshot,
  buildReplayChangeEntries,
  getGitNumstatMap,
  getGitPorcelainMap,
  formatChangePrefix,
} from '../init.js';
import { parseWatchArgs } from '../watch.js';
import { expandHome } from '../../bot/dir-guard.js';

export const projectCommands: SlashCommand[] = [
  {
    name: '/init',
    description: 'Generate .idlehands.md context',
    async execute(ctx) {
      try {
        const cwd = projectDir(ctx.config);
        const summary = await generateInitContext(cwd);
        const rendered = formatInitSummary(summary);
        const outPath = path.join(cwd, '.idlehands.md');
        console.log(rendered);
        if (fsSync.existsSync(outPath)) {
          const existing = await fs.readFile(outPath, 'utf8').catch(() => '');
          const diff = await unifiedDiffFromBuffers(Buffer.from(existing), Buffer.from(rendered));
          if (diff.trim()) console.log(colorizeUnifiedDiff(diff.trim(), ctx.S));
        }
        const ans = (
          await ctx.rl.question(
            `Generated .idlehands.md (~${summary.tokenEstimate} tokens). Write? [Y/n] `
          )
        )
          .trim()
          .toLowerCase();
        if (!ans || ans === 'y' || ans === 'yes') {
          await fs.writeFile(outPath, rendered, 'utf8');
          console.log(`Wrote ${outPath}`);
        } else {
          console.log('Cancelled.');
        }
      } catch (e: any) {
        console.error(errFmt(`INIT: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/git',
    description: 'Git status/diff',
    async execute(ctx, args) {
      try {
        const sub = args.toLowerCase();
        if (sub === 'diff') {
          const full = spawnSync('bash', ['-c', 'git diff'], {
            cwd: projectDir(ctx.config),
            encoding: 'utf8',
            timeout: 4000,
          });
          console.log(
            full.status === 0
              ? String(full.stdout || '').trim() || 'No git diff.'
              : 'No git diff (or not a git repository).'
          );
          return true;
        }
        const snap = getGitSnapshot(projectDir(ctx.config));
        if (!snap.status && !snap.diffStat) {
          console.log('No git changes (or not a git repository).');
        } else {
          if (snap.status) {
            console.log('[git status -s]');
            console.log(snap.status);
          }
          if (snap.diffStat) {
            console.log('\n[git diff --stat]');
            console.log(snap.diffStat);
          }
        }
      } catch (e: any) {
        console.error(errFmt(`GIT: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/git_status',
    description: 'Git status (alias for /git)',
    async execute(ctx, args) {
      // Delegate to /git command
      const gitCmd = projectCommands.find((c) => c.name === '/git');
      return gitCmd!.execute(ctx, args, '/git_status');
    },
  },
  {
    name: '/branch',
    description: 'Show/create git branch',
    async execute(ctx, args) {
      try {
        const cwd = projectDir(ctx.config);
        if (!args) {
          const current = spawnSync('bash', ['-c', 'git rev-parse --abbrev-ref HEAD'], {
            cwd,
            encoding: 'utf8',
            timeout: 1500,
          });
          console.log(
            current.status === 0
              ? `Current branch: ${String(current.stdout || '').trim()}`
              : 'Not a git repository.'
          );
          return true;
        }
        if (!/^[A-Za-z0-9._\/-]+$/.test(args)) {
          console.log('Invalid branch name. Allowed: letters, numbers, ., _, /, -');
          return true;
        }
        const mk = spawnSync('git', ['checkout', '-b', args], {
          cwd,
          encoding: 'utf8',
          timeout: 5000,
        });
        console.log(
          (String(mk.stdout || '') + String(mk.stderr || '')).trim() ||
            (mk.status === 0 ? `Created branch ${args}` : `Failed to create branch ${args}`)
        );
      } catch (e: any) {
        console.error(errFmt(`BRANCH: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/changes',
    description: 'Show session changes',
    async execute(ctx, args, _line) {
      const cwd = projectDir(ctx.config);
      if (args === 'reset') {
        ctx.changesBaselineMs = Date.now();
        console.log('[changes] baseline reset to current state.');
        return true;
      }
      const sinceMatch = /^--since\s+(\d+)$/i.exec(args);
      const sinceN = sinceMatch ? Number(sinceMatch[1]) : undefined;
      const full = args === '--full';
      const targetFile = !args.startsWith('--') && args !== '' ? args : '';

      if (targetFile) {
        const diff = spawnSync('bash', ['-c', `git diff -- ${JSON.stringify(targetFile)}`], {
          cwd,
          encoding: 'utf8',
          timeout: 4000,
        });
        console.log(
          diff.status === 0
            ? String(diff.stdout || '').trim() || `No diff for ${targetFile}`
            : `No diff for ${targetFile}`
        );
        return true;
      }

      const entries = await buildReplayChangeEntries(
        ctx.session.replay,
        sinceN ? undefined : ctx.changesBaselineMs,
        sinceN
      );
      const numstat = getGitNumstatMap(cwd);
      const porcelain = getGitPorcelainMap(cwd);

      if (!entries.length && numstat.size === 0 && porcelain.size === 0) {
        console.log('Session changes (0 files).');
        return true;
      }

      const byPath = new Map<string, { filePath: string; edits: number; opHint?: string }>();
      for (const e of entries) byPath.set(e.filePath, e);
      for (const p of numstat.keys()) if (!byPath.has(p)) byPath.set(p, { filePath: p, edits: 0 });
      for (const p of porcelain.keys())
        if (!byPath.has(p)) byPath.set(p, { filePath: p, edits: 0 });

      const list = [...byPath.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
      console.log(`Session changes (${list.length} files):`);
      for (const item of list) {
        const st = porcelain.get(item.filePath);
        const pref = formatChangePrefix(st);
        const ns = numstat.get(item.filePath) ?? { adds: 0, removes: 0 };
        const edits = item.edits > 0 ? `(${item.edits} edits)` : '';
        console.log(
          `  ${pref} ${item.filePath.padEnd(28, ' ')} +${ns.adds} -${ns.removes} ${edits}`.trimEnd()
        );
      }

      if (full) {
        const fullDiff = spawnSync('bash', ['-c', 'git diff'], {
          cwd,
          encoding: 'utf8',
          timeout: 7000,
        });
        const out = fullDiff.status === 0 ? String(fullDiff.stdout || '').trim() : '';
        if (out) console.log('\n' + out);
      }
      return true;
    },
  },
  {
    name: '/watch',
    description: 'Watch files and re-run',
    async execute(ctx, args) {
      if (!args || args === 'status') {
        if (!ctx.watchActive) {
          console.log('Watch mode: off');
        } else {
          const displayPaths = ctx.watchPaths
            .map((p) => path.relative(projectDir(ctx.config), p) || p)
            .join(', ');
          console.log(
            `Watch mode: on (${displayPaths}) | max iterations/trigger: ${ctx.watchMaxIterationsPerTrigger}`
          );
          console.log(ctx.S.dim('Press Ctrl+C to exit watch mode.'));
        }
        return true;
      }
      if (args === 'off' || args === 'stop') {
        if (!ctx.watchActive) console.log('Watch mode is already off.');
        else ctx.stopWatchMode(true);
        return true;
      }
      const hasRunnable =
        typeof ctx.lastRunnableInput === 'string'
          ? !!ctx.lastRunnableInput.trim()
          : (ctx.lastRunnableInput as any[]).length > 0;
      if (!hasRunnable) {
        console.log('Run a task first, then start /watch <path>.');
        return true;
      }
      try {
        const parsed = parseWatchArgs(args);
        if (!parsed.paths.length) {
          console.log('Usage: /watch <path...> [--max N]');
          return true;
        }
        await ctx.startWatchMode(parsed.paths, parsed.maxIterationsPerTrigger);
        const displayPaths = ctx.watchPaths
          .map((p) => path.relative(projectDir(ctx.config), p) || p)
          .join(', ');
        console.log(`[watch] monitoring: ${displayPaths}`);
        console.log(
          `[watch] on change: re-run last prompt (max iterations ${ctx.watchMaxIterationsPerTrigger}, debounce 500ms)`
        );
        console.log(ctx.S.dim('Press Ctrl+C to exit watch mode.'));
      } catch (e: any) {
        console.error(errFmt(`WATCH: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/index',
    description: 'Project index',
    async execute(ctx, _args, line) {
      const parts = restTokens(line);
      const action = (parts[0] || '').toLowerCase();
      if (!action || action === 'run') {
        await ctx.startIndexInBackground();
        return true;
      }
      if (action === 'status') {
        if (!ctx.indexRunning) {
          console.log('No background index job is currently running.');
        } else {
          const elapsed = Math.max(0, Math.floor((Date.now() - ctx.indexStartedAt) / 1000));
          console.log(
            `Index running (${elapsed}s): scanned=${ctx.indexProgress.scanned}, indexed=${ctx.indexProgress.indexed}, skipped=${ctx.indexProgress.skipped}`
          );
          if (ctx.indexProgress.current) console.log(`Current file: ${ctx.indexProgress.current}`);
        }
        return true;
      }
      if (action === 'stats') {
        await ctx.printIndexStats();
        return true;
      }
      if (action === 'clear') {
        await ctx.clearIndex();
        return true;
      }
      console.log('Usage: /index [run|status|stats|clear]');
      return true;
    },
  },
  {
    name: '/undo',
    description: 'Undo file edit',
    async execute(ctx, args) {
      const { undo_path } = await import('../../tools.js');
      try {
        const msg = await undo_path(
          {
            cwd: ctx.config.dir!,
            noConfirm: !!ctx.config.no_confirm,
            dryRun: !!ctx.config.dry_run,
            lastEditedPath: ctx.session.lastEditedPath,
            confirm: ctx.confirm,
          },
          args ? { path: args } : {}
        );
        console.log(String(msg));
      } catch (e: any) {
        console.error(errFmt(`UNDO: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/dir',
    description: 'Get/set working directory',
    async execute(ctx, args) {
      if (!args) {
        console.log(`Working directory: ${ctx.S.dim(ctx.config.dir || '(not set)')}`);
        return true;
      }
      const resolvedDir = path.resolve(expandHome(args));
      console.log(`Working directory set to: ${resolvedDir}`);
      // Note: The actual config update happens in the CLI, this is just for display
      return true;
    },
  },
  {
    name: '/pin',
    description: 'Pin current working directory',
    async execute(ctx) {
      console.log(`Working directory pinned: ${ctx.S.dim(ctx.config.dir || '(not set)')}`);
      return true;
    },
  },
  {
    name: '/unpin',
    description: 'Unpin current working directory',
    async execute(ctx) {
      console.log(`Working directory unpinned.`);
      // Clear the dir config to reset to default
      ctx.config.dir = undefined;
      return true;
    },
  },
];
