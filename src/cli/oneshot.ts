/**
 * One-shot mode: non-interactive single-instruction execution.
 *
 * Supports text, JSON, and stream-JSON output formats,
 * --diff-only mode, and --fail-on-error behavior.
 */

import { spawnSync } from 'node:child_process';

import { createSession } from '../agent.js';
import type { AgentHooks } from '../agent.js';
import { banner, err as errFmt } from '../term.js';
import type { makeStyler } from '../term.js';
import { projectDir } from '../utils.js';

import { friendlyError, normalizeOutputFormat, type OneShotOutputEvent } from './args.js';
import { expandAtFileRefs, expandPromptImages } from './input.js';

export interface OneShotOpts {
  instruction: string;
  config: any;
  S: ReturnType<typeof makeStyler>;
}

/**
 * Runs a single instruction against the agent and exits the process.
 */
export async function runOneShot(opts: OneShotOpts): Promise<never> {
  const { instruction, config, S } = opts;
  const outputFormat = normalizeOutputFormat(config.output_format);
  const oneShotStarted = Date.now();

  const jsonEvents: OneShotOutputEvent[] = [];
  const toolEventsById = new Map<string, Extract<OneShotOutputEvent, { type: 'tool_call' }>>();
  let partialAssistant = '';

  const emitEvent = (ev: OneShotOutputEvent) => {
    if (outputFormat === 'stream-json') {
      process.stdout.write(JSON.stringify(ev) + '\n');
      return;
    }
    if (outputFormat === 'json') {
      jsonEvents.push(ev);
    }
  };

  const flushJsonArray = () => {
    if (outputFormat === 'json') {
      process.stdout.write(JSON.stringify(jsonEvents, null, 2) + '\n');
    }
  };

  const writeWarning = (msg: string) => {
    if (outputFormat === 'text') {
      console.log(S.dim(msg));
    } else {
      process.stderr.write(`${msg}\n`);
    }
  };

  const oneShotCwd = projectDir(config);
  const diffOnly = !!config.diff_only;
  const shouldFailOnError = config.fail_on_error !== false;
  let diffOnlyEnabled = false;

  const runGit = (command: string, timeoutMs = 10_000) =>
    spawnSync('bash', ['-lc', command], {
      cwd: oneShotCwd,
      encoding: 'utf8',
      timeout: timeoutMs,
    });

  const captureUnifiedDiff = () => {
    const run = runGit('git diff --no-color');
    if (run.status !== 0) return '';
    return String(run.stdout || '').trimEnd();
  };

  const cleanupDiffOnly = () => {
    const run = runGit('git reset --hard -q && git clean -fd -q', 20_000);
    return run.status === 0;
  };

  if (diffOnly) {
    const inside = runGit('git rev-parse --is-inside-work-tree');
    if (
      inside.status !== 0 ||
      !String(inside.stdout || '')
        .trim()
        .startsWith('true')
    ) {
      console.error('--diff-only requires running inside a git repository.');
      process.exit(2);
    }

    const dirty = runGit('git status --porcelain');
    if (dirty.status !== 0) {
      console.error('--diff-only preflight failed: unable to read git status.');
      process.exit(2);
    }
    if (String(dirty.stdout || '').trim()) {
      console.error('--diff-only requires a clean working tree (found uncommitted changes).');
      process.exit(2);
    }

    diffOnlyEnabled = true;
  }

  // §11: Ctrl+C during one-shot aborts everything, exit code 130.
  let oneShotSession: any = null;
  const oneShotSigint = () => {
    try {
      oneShotSession?.cancel();
    } catch {}
    process.exit(130);
  };
  process.on('SIGINT', oneShotSigint);

  let session: any = null;

  try {
    session = await createSession({ config });
    oneShotSession = session;

    emitEvent({
      type: 'system',
      model: session.model,
      harness: session.harness,
      context_window: session.contextWindow,
    });

    let spinner: any = null;
    let oneShotHooks: AgentHooks;

    if (outputFormat === 'text') {
      const { CliSpinner } = await import('../spinner.js');
      spinner = new CliSpinner({ styler: S, verbose: config.verbose });
      spinner.start();

      const uiMode = config.verbose ? 'verbose' : config.quiet ? 'quiet' : 'normal';
      oneShotHooks =
        uiMode === 'verbose'
          ? {
              onToolCall: (e) => spinner.onToolCall(e),
              onToolResult: (e) => spinner.onToolResult(e),
            }
          : uiMode === 'quiet'
            ? {
                onToken: (t) => {
                  spinner.onFirstDelta();
                  partialAssistant += t;
                  process.stdout.write(t);
                },
                onFirstDelta: () => spinner.onFirstDelta(),
              }
            : {
                onToken: (t) => {
                  spinner.onFirstDelta();
                  partialAssistant += t;
                  process.stdout.write(t);
                },
                onFirstDelta: () => spinner.onFirstDelta(),
                onToolCall: (e) => spinner.onToolCall(e),
                onToolResult: (e) => spinner.onToolResult(e),
              };
    } else {
      oneShotHooks = {
        onToken: (t) => {
          partialAssistant += t;
          if (outputFormat === 'stream-json') {
            emitEvent({ type: 'assistant_delta', content: t });
          }
        },
        onToolCall: (e) => {
          const ev: Extract<OneShotOutputEvent, { type: 'tool_call' }> = {
            type: 'tool_call',
            name: e.name,
            args: e.args,
          };
          toolEventsById.set(e.id, ev);
          emitEvent(ev);
        },
        onToolResult: (e) => {
          const existing = toolEventsById.get(e.id);
          if (existing) {
            existing.result = e.result ?? e.summary;
            existing.success = e.success;
            existing.summary = e.summary;
            if (outputFormat === 'stream-json') {
              emitEvent({ ...existing });
            }
          } else {
            emitEvent({
              type: 'tool_call',
              name: e.name,
              args: {},
              result: e.result ?? e.summary,
              success: e.success,
              summary: e.summary,
            });
          }
        },
      };
    }

    const expandedRes = await expandAtFileRefs(
      instruction,
      projectDir(config),
      config.context_max_tokens ?? 8192
    );
    for (const w of expandedRes.warnings) writeWarning(w);

    const imageExpanded = await expandPromptImages(
      expandedRes.text,
      projectDir(config),
      session.supportsVision
    );
    for (const w of imageExpanded.warnings) writeWarning(w);

    const res = await session.ask(imageExpanded.content, oneShotHooks);

    const diffText = diffOnlyEnabled ? captureUnifiedDiff() : '';
    if (diffOnlyEnabled) {
      if (outputFormat === 'text') {
        if (diffText) console.log(diffText);
        else console.log(S.dim('[diff-only] no changes'));
      } else {
        emitEvent({ type: 'diff', content: diffText });
      }
    }

    const cleaned = diffOnlyEnabled ? cleanupDiffOnly() : true;

    if (outputFormat === 'text') {
      spinner?.stop();
      if (!config.verbose) process.stdout.write('\n');
      if (!diffOnlyEnabled && config.verbose) {
        const { renderMarkdown } = await import('../markdown.js');
        console.log(renderMarkdown(res.text, { color: S.enabled, verbose: true }));
      }
      if (!diffOnlyEnabled) {
        console.log(S.dim(banner('DONE', S)));
      }
      if (!cleaned) {
        console.error(errFmt('diff-only cleanup failed: unable to restore clean tree', S));
        process.exit(1);
      }
    } else {
      emitEvent({ type: 'assistant', content: res.text, thinking: '' });
      emitEvent({
        type: 'result',
        ok: cleaned,
        turns: res.turns,
        tool_calls: res.toolCalls,
        duration_ms: Date.now() - oneShotStarted,
        error: cleaned ? undefined : 'diff-only cleanup failed: unable to restore clean tree',
      });
      flushJsonArray();
    }

    process.exit(cleaned ? 0 : 1);
  } catch (e: any) {
    const errMsg = friendlyError(e);
    const durationMs = Date.now() - oneShotStarted;

    const diffText = diffOnlyEnabled ? captureUnifiedDiff() : '';
    if (diffOnlyEnabled) {
      if (outputFormat === 'text') {
        if (diffText) console.log(diffText);
      } else {
        emitEvent({ type: 'diff', content: diffText });
      }
    }

    const cleaned = diffOnlyEnabled ? cleanupDiffOnly() : true;

    if (outputFormat === 'text') {
      process.stdout.write('\n');
      console.error(errFmt(errMsg, S));
      if (!cleaned) {
        console.error(errFmt('diff-only cleanup failed: unable to restore clean tree', S));
      }
    } else {
      if (partialAssistant.trim()) {
        emitEvent({ type: 'assistant', content: partialAssistant.trim(), thinking: '' });
      }
      emitEvent({
        type: 'result',
        ok: false,
        duration_ms: durationMs,
        error: !cleaned
          ? `${errMsg}; diff-only cleanup failed: unable to restore clean tree`
          : errMsg,
        partial: !!partialAssistant.trim(),
      });
      flushJsonArray();
    }

    process.exit(shouldFailOnError || !cleaned ? 1 : 0);
  }
}
