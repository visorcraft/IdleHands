#!/usr/bin/env node

import readline from 'node:readline/promises';
import * as rlBase from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import os from 'node:os';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { loadConfig, defaultConfigPath, applyRuntimeEndpoint } from './config.js';
import { runSetup, guidedRuntimeOnboarding } from './cli/setup.js';
import { projectDir } from './utils.js';
import { createSession } from './agent.js';
import type { UserContent, TurnEndEvent } from './types.js';
import { unifiedDiffFromBuffers } from './replay_cli.js';
import { makeStyler, resolveColorMode, colorizeUnifiedDiff, warn as warnFmt, err as errFmt } from './term.js';
import { resolveTheme } from './themes.js';
import { createVimState, handleVimKeypress } from './vim.js';
import { loadCustomCommands, expandArgs } from './commands.js';
import { performUpgrade, performRollback, dailyUpdateCheck, detectInstallSource, type InstallSource } from './upgrade.js';
import { setLockdown, setSafetyLogging, loadSafetyConfig } from './safety.js';
import { loadGitStartupSummary } from './git.js';

// ── Extracted CLI modules ────────────────────────────────────────────
import {
  parseArgs, asNum, asBool, friendlyError, loadMcpServerConfigFile,
  printHelp,
} from './cli/args.js';
import {
  readUserInput, readStdinIfPiped,
  reverseSearchHistory, isPathCompletionContext,
  expandAtFileRefs, expandPromptImages,
} from './cli/input.js';
import {
  lastSessionPath, namedSessionPath, projectSessionPath,
  loadPromptTemplates, loadHistory, appendHistoryLine, rotateHistoryIfNeeded,
} from './cli/session-state.js';
import { runDirectShellCommand } from './cli/shell.js';
import {
  replayCaptureFile,
  formatStatusLine,
  renderStartupBanner,
  formatCount, endpointLooksLocal,
} from './cli/status.js';
import {
  generateInitContext, formatInitSummary,
} from './cli/init.js';
import type { ReplContext } from './cli/repl-context.js';
import { buildReplContext } from './cli/build-repl-context.js';
import { runAgentTurnWithSpinner } from './cli/agent-turn.js';
import { printBotHelp, runBotSubcommand } from './cli/bot.js';
import { runHostsSubcommand, runBackendsSubcommand, runModelsSubcommand, runSelectSubcommand, runHealthSubcommand } from './cli/runtime-cmds.js';
import { runOneShot } from './cli/oneshot.js';
import { registerAll, findCommand, allCommandNames } from './cli/command-registry.js';
import { sessionCommands } from './cli/commands/session.js';
import { runtimeCommands } from './cli/commands/runtime.js';
import { modelCommands } from './cli/commands/model.js';
import { editingCommands } from './cli/commands/editing.js';
import { projectCommands } from './cli/commands/project.js';
import { trifectaCommands } from './cli/commands/trifecta.js';
import { toolCommands } from './cli/commands/tools.js';
import { antonCommands } from './cli/commands/anton.js';
import { runTui } from './cli/commands/tui.js';
async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { version } = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));

  if (args.version || args.v) {
    console.log(version);
    process.exit(0);
  }

  if (args._[0] === 'upgrade' || args.upgrade) {
    const configPath = typeof args.config === 'string' ? args.config : defaultConfigPath();
    let source: InstallSource = 'github';
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const cfg = JSON.parse(raw);
      if (cfg.install_source === 'npm' || cfg.install_source === 'github') {
        source = cfg.install_source;
      } else {
        source = detectInstallSource();
      }
    } catch {
      source = detectInstallSource();
    }
    await performUpgrade(version, source);
    process.exit(0);
  }

  if (args._[0] === 'rollback' || args.rollback) {
    await performRollback();
    process.exit(0);
  }

  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const configPath = typeof args.config === 'string' ? args.config : defaultConfigPath();

  if (args._[0] === 'setup') {
    const setupResult = await runSetup(configPath);
    if (setupResult !== 'run') process.exit(0);
    // 'run' → fall through to normal startup below
  }

  // First-run detection: no config file + no CLI endpoint = offer setup
  if (process.stdin.isTTY && process.stdout.isTTY) {
    let hasConfig = false;
    try { await fs.access(configPath); hasConfig = true; } catch {}
    const hasEndpointArg = typeof args.endpoint === 'string';
    const isSubcommand = args._[0] === 'bot' || args._[0] === 'hosts' || args._[0] === 'backends'
      || args._[0] === 'models' || args._[0] === 'select' || args._[0] === 'health'
      || args._[0] === 'upgrade' || args._[0] === 'rollback' || args._[0] === 'init'
      || args._[0] === 'service';
    if (!hasConfig && !hasEndpointArg && !isSubcommand) {
      console.log('\n  No config file found. Running interactive setup...');
      console.log('  (To skip, pass --endpoint <url>)\n');
      const setupResult = await runSetup(configPath);
      if (setupResult !== 'run') process.exit(0);
      // 'run' → fall through to normal startup below
    }
  }

  const cliCfg: any = {
    endpoint: typeof args.endpoint === 'string' ? args.endpoint : undefined,
    model: typeof args.model === 'string' ? args.model : undefined,
    dir: typeof args.dir === 'string' ? path.resolve(args.dir) : undefined,
    max_tokens: asNum(args['max-tokens'] ?? args.max_tokens),
    temperature: asNum(args.temperature),
    top_p: asNum(args['top-p'] ?? args.top_p),
    timeout: asNum(args.timeout),
    response_timeout: asNum(args['response-timeout'] ?? args.response_timeout),
    max_iterations: asNum(args['max-iterations'] ?? args.max_iterations),
    context_window: asNum(args['context-window'] ?? args.context_window),
    approval_mode: typeof args['approval-mode'] === 'string'
      ? args['approval-mode']
      : asBool(args['non-interactive'] ?? args.non_interactive) ? 'reject'
      : asBool(args.plan) ? 'plan' : undefined,
    verbose: asBool(args.verbose),
    quiet: asBool(args.quiet),
    dry_run: asBool(args['dry-run'] ?? args.dry_run),
    output_format: typeof args['output-format'] === 'string' ? args['output-format'] : undefined,
    fail_on_error: asBool(args['fail-on-error'] ?? args.fail_on_error),
    diff_only: asBool(args['diff-only'] ?? args.diff_only),
    no_confirm: asBool(args['no-confirm'] ?? args.no_confirm ?? args.yolo),
    mode: asBool(args.sys) ? 'sys' as const : undefined,
    sys_eager: asBool(args['sys-eager'] ?? args.sys_eager) || undefined,
    i_know_what_im_doing: asBool(args['i-know-what-im-doing'] ?? args.i_know_what_im_doing),
    theme: typeof args.theme === 'string' ? args.theme : undefined,
    vim_mode: asBool(args.vim ?? args['vim-mode'] ?? args.vim_mode),
    harness: typeof args.harness === 'string' ? args.harness : undefined,
    context_file: typeof args['context-file'] === 'string' ? args['context-file'] : undefined,
    no_context: asBool(args['no-context'] ?? args.no_context),
    context_max_tokens: asNum(args['context-max-tokens'] ?? args.context_max_tokens),
    compact_at: asNum(args['compact-at'] ?? args.compact_at),
    step_mode: asBool(args.step),
    auto_detect_model_change: asBool(args['auto-detect-model-change'] ?? args.auto_detect_model_change),
    show_server_metrics: asBool(args['show-server-metrics']) !== undefined
      ? asBool(args['show-server-metrics'])
      : (asBool(args['no-server-metrics']) === undefined ? undefined : !asBool(args['no-server-metrics'])),
    slow_tg_tps_threshold: asNum(args['slow-tg-tps-threshold'] ?? args.slow_tg_tps_threshold),
    mcp_tool_budget: asNum(args['mcp-tool-budget'] ?? args.mcp_tool_budget),
    mcp_call_timeout_sec: asNum(args['mcp-call-timeout-sec'] ?? args.mcp_call_timeout_sec),
    color: typeof args.color === 'string' ? args.color : undefined,
    auto_update_check: asBool(args['no-update-check']) === undefined ? undefined : !asBool(args['no-update-check']),
    offline: asBool(args.offline),
    sub_agents: {
      enabled: asBool(args['no-sub-agents']) === undefined ? undefined : !asBool(args['no-sub-agents']),
    },
    trifecta: {
      enabled: asBool(args['no-trifecta']) === undefined ? undefined : !asBool(args['no-trifecta']),
      vault: {
        enabled: asBool(args['no-vault']) === undefined ? undefined : !asBool(args['no-vault']),
        mode: (() => {
          const raw = typeof args['vault-mode'] === 'string' ? args['vault-mode'].toLowerCase() : undefined;
          if (!raw) return undefined;
          if (raw === 'active' || raw === 'passive' || raw === 'off') return raw;
          console.error(`Invalid --vault-mode: ${raw} (expected active|passive|off)`);
          return undefined;
        })()
      },
      lens: {
        enabled: asBool(args['no-lens']) === undefined ? undefined : !asBool(args['no-lens'])
      },
      replay: {
        enabled: asBool(args['no-replay']) === undefined ? undefined : !asBool(args['no-replay'])
      }
    }
  };

  const { config } = await loadConfig({ configPath, cli: cliCfg });

  // If a runtime is active, use its endpoint (unless --endpoint was passed explicitly)
  const cliEndpoint = typeof args.endpoint === 'string' ? args.endpoint : undefined;
  const runtimeOverrode = await applyRuntimeEndpoint(config, cliEndpoint);
  if (runtimeOverrode && config.verbose) {
    console.error(`[runtime] Using endpoint from active runtime: ${config.endpoint}`);
  }

  if (typeof args.mcp === 'string' && args.mcp.trim()) {
    const extraServers = await loadMcpServerConfigFile(args.mcp.trim());
    const existing = Array.isArray(config.mcp?.servers) ? config.mcp!.servers : [];
    config.mcp = config.mcp ?? { servers: [] };
    config.mcp.servers = [...existing, ...extraServers];
    console.log(`[mcp] loaded ${extraServers.length} ad-hoc server(s) from ${path.resolve(args.mcp.trim())}`);
  }

  if (typeof args.replay === 'string' && args.replay.trim()) {
    const replayPath = path.resolve(args.replay);
    await replayCaptureFile(replayPath, config);
    process.exit(0);
  }

  // --- Safety initialization (Phase 9) ---
  await loadSafetyConfig();
  if (asBool(args.lockdown)) {
    setLockdown(true);
  }
  if (config.verbose) {
    setSafetyLogging(true);
  }

  // --- Service subcommand ---
  if (args._[0] === 'service') {
    const { runServiceSubcommand } = await import('./cli/service.js');
    await runServiceSubcommand(args);
    return;
  }

  // --- Bot subcommand ---
  if (args._[0] === 'bot') {
    if (args.help) { printBotHelp(); return; }
    await runBotSubcommand({ botTarget: args._[1] || 'telegram', config, configPath, cliCfg, all: Boolean(args.all) });
    return;
  }
  // Runtime subcommands — catch Ctrl+C cleanly
  for (const [name, handler] of [
    ['hosts', runHostsSubcommand],
    ['backends', runBackendsSubcommand],
    ['models', runModelsSubcommand],
    ['select', runSelectSubcommand],
    ['health', runHealthSubcommand],
  ] as const) {
    if (args._[0] === name) {
      try { await (handler as any)(args, config); } catch (e: any) {
        if (e?.code === 'ABORT_ERR' || e?.name === 'AbortError') { process.stdout.write('\n'); }
        else throw e;
      }
      return;
    }
  }

  // TUI is the default for interactive TTY sessions.
  // --no-tui forces classic CLI. Non-TTY environments skip TUI automatically.
  const forceNoTui = asBool(args['no-tui'] ?? args.no_tui) === true;
  const hasTTY = !!(process.stdin.isTTY && process.stdout.isTTY);
  if (hasTTY && !forceNoTui) {
    const launched = await runTui(config, args);
    if (launched) return; // TUI ran successfully
    // Fall through to classic CLI if TUI validation failed
  }

  // Terminal styling + theme
  const colorMode = (cliCfg.color ?? 'auto') as any;
  const { enabled } = resolveColorMode(colorMode);
  const themeFns = await resolveTheme(config.theme ?? 'default');
  let S = makeStyler(enabled, themeFns);

  const positionalInstruction = args._.filter((a: string) =>
    a !== 'bot' && a !== 'setup' && a !== 'init'
  ).join(' ').trim();
  const promptFlag = typeof args.prompt === 'string'
    ? args.prompt
    : (typeof args.p === 'string' ? args.p : '');
  const pipedInput = await readStdinIfPiped();

  let instruction = (promptFlag || positionalInstruction || '').trim();
  if (!instruction && pipedInput) {
    instruction = pipedInput;
  } else if (instruction && pipedInput) {
    instruction = `${pipedInput}\n\n${instruction}`.trim();
  }

  const oneShotFlag = asBool(args['one-shot']);
  const isOneShot = Boolean(instruction) || Boolean(oneShotFlag) || Boolean(promptFlag);

  if (args._[0] === 'init' || asBool(args.init)) {
    const cwd = projectDir(config);
    const summary = await generateInitContext(cwd);
    const rendered = formatInitSummary(summary);
    const outPath = path.join(cwd, '.idlehands.md');

    console.log(rendered);

    let shouldWrite = false;
    if (process.stdin.isTTY) {
      if (fsSync.existsSync(outPath)) {
        const existing = await fs.readFile(outPath, 'utf8').catch(() => '');
        const diff = await unifiedDiffFromBuffers(Buffer.from(existing), Buffer.from(rendered));
        if (diff.trim()) {
          console.log(colorizeUnifiedDiff(diff.trim(), S));
        }
      }
      const rlInit = readline.createInterface({ input, output });
      const ans = (await rlInit.question(`Generated .idlehands.md (~${summary.tokenEstimate} tokens). Write? [Y/n] `)).trim().toLowerCase();
      rlInit.close();
      shouldWrite = !ans || ans === 'y' || ans === 'yes';
    } else {
      console.error('Refusing to write .idlehands.md non-interactively. Re-run with a TTY to confirm.');
      process.exit(2);
    }

    if (shouldWrite) {
      await fs.writeFile(outPath, rendered, 'utf8');
      console.log(`Wrote ${outPath}`);
      process.exit(0);
    }

    console.log('Cancelled.');
    process.exit(0);
  }

  if (isOneShot) {
    if (!instruction) {
      console.error('Usage: idlehands --one-shot "your instruction" (or -p/--prompt, or piped stdin)');
      process.exit(2);
    }
    await runOneShot({ instruction, config, S });
  }

  // REPL (persistent session for KV cache reuse)
  await rotateHistoryIfNeeded();
  const priorHistory = await loadHistory();
  let lastPersistedHistory = priorHistory[priorHistory.length - 1] ?? '';
  const promptTemplates = await loadPromptTemplates();

  // ── Register all slash commands ──
  registerAll([
    ...sessionCommands,
    ...runtimeCommands,
    ...modelCommands,
    ...editingCommands,
    ...projectCommands,
    ...trifectaCommands,
    ...toolCommands,
    ...antonCommands,
  ]);

  let customCommands = await loadCustomCommands(projectDir(config));

  const getSlashCommands = () => [
    ...allCommandNames(),
    ...Object.keys(promptTemplates),
    ...ctx.customCommands.keys(),
  ];

  const completer = (line: string): [string[], string] => {
    const trimmed = line.trim();

    if (trimmed.startsWith('/')) {
      const slashCommands = getSlashCommands();
      const hits = slashCommands.filter(c => c.startsWith(trimmed));
      return [hits.length ? hits : slashCommands, trimmed];
    }

    const m = /(.*\s)?([^\s]*)$/.exec(line);
    const token = m?.[2] ?? '';
    const isAtRef = token.startsWith('@');
    const tokenPath = isAtRef ? token.slice(1) : token;
    const allowBarePath = isPathCompletionContext(line);
    if (tokenPath && (isAtRef || allowBarePath || tokenPath.includes('/') || tokenPath.startsWith('.') || tokenPath.startsWith('~'))) {
      const base = tokenPath.startsWith('~')
        ? path.resolve(os.homedir(), tokenPath.slice(1))
        : path.resolve(projectDir(config), tokenPath || '.');
      const dir = tokenPath && tokenPath.includes('/') ? path.dirname(base) : path.resolve(projectDir(config));
      const prefix = tokenPath && tokenPath.includes('/') ? path.basename(base) : tokenPath;
      try {
        const entries = fsSync.readdirSync(dir, { withFileTypes: true }) as any[];
        const hits = entries
          .filter((e: any) => String(e.name).startsWith(prefix))
          .map((e: any) => {
            const rel = path.relative(projectDir(config), path.join(dir, e.name));
            const completed = rel + (e.isDirectory() ? '/' : '');
            return isAtRef ? `@${completed}` : completed;
          });
        return [hits, token];
      } catch {
        return [[], token];
      }
    }

    return [[], line];
  };

  const rl = readline.createInterface({ input, output, historySize: 10_000, completer });
  (rl as any).history = [...priorHistory].reverse();

  const vimState = createVimState();
  if (config.vim_mode) vimState.mode = 'normal';

  if (process.stdin.isTTY) {
    const approvalModes = ['plan', 'reject', 'default', 'auto-edit', 'yolo'] as const;
    rlBase.emitKeypressEvents(input, rl as any);
    input.on('keypress', (_ch: string | undefined, key: any) => {
      if (config.vim_mode) {
        const consumed = handleVimKeypress(vimState, rl, _ch, key);
        if (consumed) {
          const vimTag = vimState.mode === 'normal' ? S.dim('[N] ') : S.dim('[I] ');
          const runModeTag = config.mode === 'sys' ? S.dim('[sys] ') : '';
          const approvalTag = config.approval_mode !== 'auto-edit' ? S.dim(`[${config.approval_mode}] `) : '';
          rl.setPrompt(vimTag + runModeTag + approvalTag + S.bold(S.cyan('> ')));
          rl.prompt(true);
          return;
        }
      }

      if (key && key.name === 'tab' && key.shift) {
        const idx = approvalModes.indexOf(config.approval_mode as any);
        config.approval_mode = approvalModes[(idx + 1) % approvalModes.length];
        process.stderr.write(`\r\x1b[K${S.dim(`[approval: ${config.approval_mode}]`)}\n`);
        const runModeTag = config.mode === 'sys' ? S.dim('[sys] ') : '';
        const approvalTag = config.approval_mode !== 'auto-edit' ? S.dim(`[${config.approval_mode}] `) : '';
        rl.setPrompt(runModeTag + approvalTag + S.bold(S.cyan('> ')));
        rl.prompt(true);
        return;
      }

      if (key?.ctrl && key?.name === 'e') {
        const seed = String((rl as any).line ?? '').trim();
        rl.write(null, { ctrl: true, name: 'u' } as any);
        rl.write(`/edit ${seed}`);
        rl.write(null, { name: 'return' } as any);
        return;
      }

      if (key?.ctrl && key?.name === 'r') {
        void reverseSearchHistory(rl as any, S);
        return;
      }
    });
  }

  const confirm = async (prompt: string) => {
    const ans = (await rl.question(prompt)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  };

  const { TerminalConfirmProvider } = await import('./confirm/terminal.js');
  const { HeadlessConfirmProvider } = await import('./confirm/headless.js');
  const { AutoApproveProvider } = await import('./confirm/auto.js');

  const confirmProvider = config.approval_mode === 'yolo'
    ? new AutoApproveProvider()
    : config.approval_mode === 'reject'
      ? new HeadlessConfirmProvider('reject')
      : process.stdin.isTTY
        ? new TerminalConfirmProvider(rl)
        : new HeadlessConfirmProvider(config.approval_mode);

  let session;
  try {
    session = await createSession({ config, confirm, confirmProvider });
  } catch (e: any) {
    const msg = e?.message ?? '';
    if (msg.includes('No models found') && process.stdin.isTTY) {
      const ok = await guidedRuntimeOnboarding();
      if (ok) {
        // Runtime started — re-apply endpoint and retry
        await applyRuntimeEndpoint(config);
        session = await createSession({ config, confirm, confirmProvider });
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

  const sessionName = typeof args.session === 'string' && args.session.trim() ? args.session.trim() : '';
  const resumeArg = args.resume;
  const continueFlag = !!asBool(args['continue']);
  const resumeNamed = typeof resumeArg === 'string' && resumeArg.trim() ? resumeArg.trim() : '';

  const resumeFile = continueFlag
    ? projectSessionPath(projectDir(config))
    : (resumeNamed
      ? namedSessionPath(resumeNamed)
      : (sessionName ? namedSessionPath(sessionName) : lastSessionPath()));

  const shouldFresh = !!asBool(args.fresh);
  const shouldResume = continueFlag || !!asBool(resumeArg) || !!resumeNamed;

  if (!shouldFresh) {
    const resumeRaw = await fs.readFile(resumeFile, 'utf8').catch(() => '');
    if (resumeRaw.trim()) {
      try {
        const parsed = JSON.parse(resumeRaw);
        const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
        if (msgs.length >= 2) {
          let ok = shouldResume;
          if (!shouldResume && process.stdin.isTTY) {
            const modelLabel = parsed?.model ? `model: ${parsed.model}, ` : '';
            const turns = Math.max(0, msgs.filter((m: any) => m.role !== 'system').length);
            const savedAt = parsed?.savedAt ? new Date(parsed.savedAt).toLocaleString() : 'unknown time';
            const ans = (await rl.question(`Resume previous session? (${modelLabel}${turns} turns, saved ${savedAt}) [Y/n] `)).trim().toLowerCase();
            ok = !ans || ans === 'y' || ans === 'yes';
          }
          if (ok) {
            session.restore(msgs as any);
            if (parsed?.model) {
              try { session.setModel(String(parsed.model)); } catch {}
            }
            console.log(S.dim(`[resume] restored session from ${resumeFile}`));
          }
        }
      } catch {
        // ignore corrupt session file
      }
    }
  }

  // ── Build ReplContext ──
  const ctx = buildReplContext({
    session, config, rl, S, version,
    vimState, customCommands, enabled, confirm,
    sessionName, resumeFile,
    warnFmt, errFmt,
  });

  // ── Signal handlers ──
  let sigintCount = 0;
  process.on('SIGINT', () => {
    if (ctx.activeShellProc) {
      try { ctx.activeShellProc.kill('SIGKILL'); } catch {}
      process.stdout.write('\n');
      ctx.activeShellProc = null;
      return;
    }
    if (ctx.watchActive) {
      process.stdout.write('\n');
      ctx.stopWatchMode(true);
      return;
    }
    sigintCount++;
    if (sigintCount >= 2) { void ctx.shutdown(130); return; }
    session.cancel();
    setTimeout(() => { sigintCount = 0; }, 1500).unref();
  });
  process.on('SIGTERM', () => { void ctx.shutdown(143); });

  // ── Startup ──
  const startupGitSummary = await loadGitStartupSummary(projectDir(config)).catch(() => '');
  renderStartupBanner(session, config, S, {
    firstRun: priorHistory.length === 0,
    lockdown: !!asBool(args.lockdown),
    gitSummary: startupGitSummary || undefined,
  });

  if (config.show_server_metrics !== false) {
    const startupHealth = await ctx.readServerHealth(true);
    if (ctx.healthUnsupported) {
      console.log(S.dim('[server] /health unavailable on this endpoint; /server stats disabled.'));
    } else if (startupHealth?.ok) {
      const startupBits = [
        `status: ${startupHealth.statusText || 'ok'}`,
        startupHealth.model ? `model: ${startupHealth.model}` : undefined,
        startupHealth.contextSize ? `ctx: ${formatCount(startupHealth.contextSize)}` : undefined,
        startupHealth.slotCount !== undefined ? `slots: ${formatCount(startupHealth.slotCount)}` : undefined,
      ].filter(Boolean);
      if (startupBits.length) console.log(S.dim(`[server] ${startupBits.join(' | ')}`));
    }
  }

  try {
    const skipInternet = !!config.offline || endpointLooksLocal(config.endpoint);
    const shouldCheck = config.auto_update_check !== false && !skipInternet;
    if (shouldCheck) {
      const src: InstallSource = config.install_source || detectInstallSource();
      void dailyUpdateCheck(version, src, { timeoutMs: 3000, offline: !!config.offline })
        .then((updateInfo) => {
          if (updateInfo) console.log(S.yellow(`\n  Update available: ${updateInfo.current} → ${updateInfo.latest} (run: idlehands upgrade)\n`));
        }).catch(() => {});
    }
  } catch {}

  // ── REPL loop ──
  while (true) {
    let raw: string;
    const runModeTag = config.mode === 'sys' ? S.dim('[sys] ') : '';
    const approvalTag = config.approval_mode !== 'auto-edit' ? S.dim(`[${config.approval_mode}] `) : '';
    const prompt = ctx.shellMode
      ? S.bold(S.yellow('$ '))
      : runModeTag + approvalTag + S.bold(S.cyan('> '));
    try {
      if (ctx.statusBarEnabled) ctx.statusBar.render(ctx.lastStatusLine);
      raw = await readUserInput(rl, prompt);
    } catch { break; }
    let line = raw.trim();
    if (!line) continue;

    if (line !== lastPersistedHistory) {
      await appendHistoryLine(line);
      lastPersistedHistory = line;
    }

    // Shell mode toggle
    if (line === '!') {
      ctx.shellMode = !ctx.shellMode;
      console.log(ctx.shellMode ? S.dim('[shell] direct shell mode ON (use ! or /exit-shell to leave)') : S.dim('[shell] direct shell mode OFF'));
      continue;
    }
    if (line === '/exit-shell') {
      ctx.shellMode = false;
      console.log(S.dim('[shell] direct shell mode OFF'));
      continue;
    }

    // ── Anton guard ── warn on free-form prompts and shell while Anton is running
    if (ctx.antonActive && !line.startsWith('/anton')) {
      const isShell = (ctx.shellMode && !line.startsWith('/')) || /^!{1,2}\s*\S/.test(line);
      const isAgentTurn = !line.startsWith('/');
      if (isShell || isAgentTurn) {
        console.log('⚠️  Anton is running. File changes may conflict. Use /anton stop first, or proceed at your own risk.');
      }
    }

    // Direct shell execution
    const shouldRunShell = (ctx.shellMode && !line.startsWith('/')) || /^!{1,2}\s*\S/.test(line);
    if (shouldRunShell) {
      const injectOutput = !ctx.shellMode && line.startsWith('!!');
      const command = ctx.shellMode ? line : line.slice(injectOutput ? 2 : 1).trim();
      if (!command) { console.log('Usage: !<command> (or !!<command> to also inject output into context)'); continue; }
      const timeoutSec = config.mode === 'sys' ? 60 : 30;
      console.log(S.dim(`[shell] $ ${command}`));
      const result = await runDirectShellCommand({
        command, cwd: projectDir(config), timeoutSec,
        onStart: (proc) => { ctx.activeShellProc = proc; },
        onStop: () => { ctx.activeShellProc = null; },
      });
      if (result.timedOut) console.log(warnFmt(`[shell] killed after ${timeoutSec}s timeout`, S));
      if (!result.timedOut && result.rc !== 0) console.log(warnFmt(`[shell] exited with rc=${result.rc}`, S));
      if (injectOutput) {
        const merged = `${result.out}${result.err}`.slice(-4000);
        session.messages.push({ role: 'user', content: `[Shell output]\n$ ${command}\n${merged}` } as any);
        console.log(S.dim('[shell] output injected into conversation context.'));
      }
      continue;
    }

    // Slash command dispatch via registry
    const [slashHeadRaw, ...slashRest] = line.split(/\s+/);
    const slashHead = slashHeadRaw.toLowerCase();

    const registeredCmd = findCommand(line);
    if (registeredCmd) {
      const cmdArgs = line.replace(/^\S+\s*/, '').trim();
      try {
        const handled = await registeredCmd.execute(ctx, cmdArgs, line);
        S = ctx.S; // sync in case command changed styler (e.g. /theme)
        if (handled) continue;
      } catch (e: any) {
        console.error(errFmt(`${registeredCmd.name}: ${e?.message ?? String(e)}`, S));
        continue;
      }
    }

    // Template expansion (fall through to agent turn)
    if (line.startsWith('/') && Object.prototype.hasOwnProperty.call(promptTemplates, slashHead)) {
      const template = promptTemplates[slashHead];
      ctx.pendingTemplate = template;
      console.log(S.dim(`[template] queued from ${slashHead}. Your next prompt will be prefixed.`));
      continue;
    }

    // Custom command expansion (modifies line, falls through to agent turn)
    if (line.startsWith('/') && ctx.customCommands.has(slashHead)) {
      const cmd = ctx.customCommands.get(slashHead)!;
      const expanded = expandArgs(cmd.template, slashRest).trim();
      if (!expanded) { console.log(warnFmt(`[command] ${slashHead} expanded to empty prompt.`, S)); continue; }
      line = expanded;
      console.log(S.dim(`[command] ${slashHead} → prompt injected (${cmd.source})`));
    }

    // ── Agent turn ──
    try {
      const expandedRes = await expandAtFileRefs(line, projectDir(config), config.context_max_tokens ?? 8192);
      for (const w of expandedRes.warnings) console.log(S.dim(w));
      const promptText = ctx.pendingTemplate ? `${ctx.pendingTemplate}\n\n${expandedRes.text}` : expandedRes.text;
      ctx.pendingTemplate = null;
      const imageExpanded = await expandPromptImages(promptText, projectDir(config), session.supportsVision);
      for (const w of imageExpanded.warnings) console.log(S.dim(w));
      ctx.lastRunnableInput = imageExpanded.content;
      const res = await runAgentTurnWithSpinner(ctx, imageExpanded.content);
      await ctx.maybeOfferAutoCommit(line);
      if (config.verbose) {
        const { renderMarkdown } = await import('./markdown.js');
        console.log(renderMarkdown(res.text, { color: S.enabled, verbose: true }));
      }
      ctx.lastStatusLine = formatStatusLine(session, config, S);
      console.log(ctx.lastStatusLine);
      if (ctx.statusBarEnabled) ctx.statusBar.render(ctx.lastStatusLine);
    } catch (e: any) {
      process.stdout.write('\n');
      console.error(errFmt(friendlyError(e), S));
    }
  }

  ctx.stopWatchMode(false);
  rl.close();
}


main().catch((e) => {
  if (e?.code === 'ABORT_ERR' || e?.name === 'AbortError') {
    process.stdout.write('\n');
    process.exit(0);
  }
  const msg = e?.message ?? String(e);
  if (msg.includes('No models found')) {
    console.error(`\n  ${msg}`);
    console.error(`\n  To set up runtime orchestration, run: idlehands setup`);
    console.error(`  Or configure manually: idlehands hosts add → idlehands backends add → idlehands models add\n`);
  } else {
    console.error(msg);
  }
  process.exit(1);
});
