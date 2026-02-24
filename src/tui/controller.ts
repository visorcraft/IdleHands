import { createSession, type AgentSession, type AgentHooks } from '../agent.js';
import { splitTokens } from '../cli/command-utils.js';
import { saveSessionFile, lastSessionPath, projectSessionPath } from '../cli/session-state.js';
import { chainAgentHooks } from '../progress/agent-hooks.js';
import { ProgressPresenter } from '../progress/progress-presenter.js';
import { formatToolCallSummary } from '../progress/tool-summary.js';
import type { IdlehandsConfig } from '../types.js';
import { projectDir } from '../utils.js';
import { formatWatchdogCancelMessage, resolveWatchdogSettings } from '../watchdog.js';

import { loadBranches, executeBranchSelect } from './branch-picker.js';
import {
  ensureCommandsRegistered,
  allCommandNames,
  runShellCommand,
  runSlashCommand,
} from './command-handler.js';
import { TuiConfirmProvider } from './confirm.js';
import { decodeRawInput, resolveAction } from './keymap.js';
import { calculateLayout } from './layout.js';
import { renderTui, setRenderTheme } from './render.js';
import { enterFullScreen, leaveFullScreen } from './screen.js';
import { createInitialTuiState, reduceTuiState } from './state.js';
import type { SettingsMenuItem, StepNavigatorItem, TranscriptItem } from './types.js';
import { isToolLoopBreak, formatAutoContinueNotice, AUTO_CONTINUE_PROMPT } from '../bot/auto-continue.js';

const THEME_OPTIONS = ['default', 'dark', 'light', 'minimal', 'hacker'] as const;
const APPROVAL_OPTIONS = ['plan', 'default', 'auto-edit', 'yolo'] as const;

export class TuiController {
  private state = createInitialTuiState();
  private session: AgentSession | null = null;
  private inFlight = false;
  private aborter: AbortController | null = null;
  private ctrlCAt = 0;
  private cleanupFn: (() => Promise<void>) | null = null;
  private confirmProvider: TuiConfirmProvider;
  private lastProgressAt = 0;
  private watchdogCompactAttempts = 0;
  /** Tab completion state: candidates and current cycle index. */
  private tabCandidates: string[] = [];
  private tabIndex = -1;
  private tabPrefix = '';

  constructor(private readonly config: IdlehandsConfig) {
    this.confirmProvider = new TuiConfirmProvider((ev) => this.dispatch(ev));
  }

  private dispatch(ev: Parameters<typeof reduceTuiState>[1]): void {
    this.state = reduceTuiState(this.state, ev);
    renderTui(this.state);
  }

  /** Reset tab completion state (called when input changes by non-tab means). */
  private resetTab(): void {
    this.tabCandidates = [];
    this.tabIndex = -1;
    this.tabPrefix = '';
  }

  /** Cycle through slash-command completions for the current input. */
  private handleTabComplete(): void {
    ensureCommandsRegistered();
    const buf = this.state.inputBuffer;

    // Only complete if input starts with / and has no spaces (completing the command name itself)
    if (!buf.startsWith('/') || buf.includes(' ')) return;

    const prefix = buf.toLowerCase();

    // If prefix changed, rebuild candidates
    if (prefix !== this.tabPrefix) {
      this.tabPrefix = prefix;
      this.tabIndex = -1;
      const names = allCommandNames();
      // Add TUI-specific commands that aren't in the registry
      const extra = [
        '/quit',
        '/exit',
        '/clear',
        '/cancel',
        '/help',
        '/branches',
        '/steps',
        '/settings',
        '/hooks',
      ];
      const all = [...new Set([...names, ...extra])];
      this.tabCandidates = all.filter((n) => n.toLowerCase().startsWith(prefix)).sort();
    }

    if (!this.tabCandidates.length) return;

    // Cycle forward
    this.tabIndex = (this.tabIndex + 1) % this.tabCandidates.length;
    const completion = this.tabCandidates[this.tabIndex]!;

    // Replace input with the completed command
    this.state = { ...this.state, inputBuffer: completion, inputCursor: completion.length };
    renderTui(this.state);
  }

  /** Open the branch picker overlay. */
  private async openBranchPicker(action: 'checkout' | 'merge' | 'browse'): Promise<void> {
    const data = await loadBranches(action);
    this.dispatch({ type: 'BRANCH_PICKER_OPEN', branches: data.branches, action: data.action });
  }

  /** Handle branch picker selection (Enter). */
  private async handleBranchSelect(): Promise<void> {
    const picker = this.state.branchPicker;
    if (!picker || !picker.branches.length) {
      this.dispatch({ type: 'BRANCH_PICKER_CLOSE' });
      return;
    }
    const selected = picker.branches[picker.selectedIndex];
    if (!selected) {
      this.dispatch({ type: 'BRANCH_PICKER_CLOSE' });
      return;
    }
    this.dispatch({ type: 'BRANCH_PICKER_CLOSE' });

    if (picker.action === 'browse') {
      this.pushSystemMessage(
        `Branch: ${selected.name} (${selected.messageCount} messages)\n${selected.preview || '(no preview)'}`
      );
      return;
    }

    if (!this.session) return;
    const result = await executeBranchSelect(this.session, selected.name, picker.action);
    if (result.message) {
      if (result.ok) this.pushSystemMessage(result.message);
      else
        this.dispatch({
          type: 'ALERT_PUSH',
          id: `br_${Date.now()}`,
          level: result.level ?? 'error',
          text: result.message,
        });
    }
  }

  private transcriptLineStarts(): number[] {
    const starts: number[] = [];
    let line = 0;
    for (const item of this.state.transcript) {
      starts.push(line);
      const chunks = String(item.text ?? '').split('\n');
      line += Math.max(1, chunks.length);
    }
    return starts;
  }

  private buildStepNavigatorItems(query?: string): StepNavigatorItem[] {
    const q = (query ?? '').trim().toLowerCase();
    const starts = this.transcriptLineStarts();
    const items: StepNavigatorItem[] = this.state.transcript.map((item, idx) => {
      const preview =
        String(item.text ?? '')
          .split(/\r?\n/)[0]
          ?.trim() ?? '';
      return {
        id: item.id,
        ts: item.ts,
        role: item.role,
        preview,
        lineStart: starts[idx] ?? 0,
      };
    });

    if (!q) return items;
    return items.filter((it) => `${it.role} ${it.preview}`.toLowerCase().includes(q));
  }

  private openStepNavigator(query = ''): void {
    const items = this.buildStepNavigatorItems(query);
    this.dispatch({ type: 'STEP_NAV_OPEN', items, query });
  }

  private stepNavigatorQueryAppend(text: string): void {
    const current = this.state.stepNavigator?.query ?? '';
    const next = `${current}${text}`;
    this.openStepNavigator(next);
  }

  private stepNavigatorQueryBackspace(): void {
    const current = this.state.stepNavigator?.query ?? '';
    const next = current.slice(0, -1);
    this.openStepNavigator(next);
  }

  private jumpToStepSelection(): void {
    const nav = this.state.stepNavigator;
    if (!nav?.items.length) {
      this.dispatch({ type: 'STEP_NAV_CLOSE' });
      return;
    }

    const selected = nav.items[nav.selectedIndex];
    if (!selected) {
      this.dispatch({ type: 'STEP_NAV_CLOSE' });
      return;
    }

    const layout = calculateLayout(process.stdout.rows ?? 30, process.stdout.columns ?? 120);
    const starts = this.transcriptLineStarts();
    const totalLines = starts.length
      ? (starts[starts.length - 1] ?? 0) +
        Math.max(
          1,
          String(this.state.transcript[this.state.transcript.length - 1]?.text ?? '').split('\n')
            .length
        )
      : 0;

    const desiredStart = Math.max(
      0,
      Math.min(selected.lineStart, Math.max(0, totalLines - layout.transcriptRows))
    );
    const scrollBack = Math.max(0, totalLines - (desiredStart + layout.transcriptRows));
    this.dispatch({ type: 'SCROLL_SET', panel: 'transcript', value: scrollBack });
    this.dispatch({ type: 'STEP_NAV_CLOSE' });
    this.dispatch({
      type: 'ALERT_PUSH',
      id: `step_${Date.now()}`,
      level: 'info',
      text: `Jumped to ${selected.role}: ${selected.preview || '(no preview)'}`,
    });
  }

  private buildSettingsItems(): SettingsMenuItem[] {
    const watchdog = resolveWatchdogSettings(undefined, this.config);
    return [
      {
        key: 'theme',
        label: 'Theme',
        value: this.config.theme || 'default',
        hint: 'Cycle TUI themes instantly.',
      },
      {
        key: 'approval',
        label: 'Approval mode',
        value: this.config.approval_mode || 'default',
        hint: 'Plan/default/auto-edit/yolo for next turns.',
      },
      {
        key: 'watchdog_timeout',
        label: 'Watchdog timeout',
        value: `${watchdog.timeoutMs} ms`,
        hint: 'Longer timeout helps with slower models.',
      },
      {
        key: 'watchdog_compactions',
        label: 'Max compactions',
        value: String(watchdog.maxCompactions),
        hint: 'Retries before watchdog cancellation.',
      },
      {
        key: 'watchdog_grace',
        label: 'Grace windows',
        value: String(watchdog.idleGraceTimeouts),
        hint: 'Extra idle windows before first compaction.',
      },
      {
        key: 'debug_abort',
        label: 'Debug abort reason',
        value: watchdog.debugAbortReason ? 'on' : 'off',
        hint: 'Show raw abort reason in cancellation messages.',
      },
    ];
  }

  private openSettingsMenu(): void {
    this.dispatch({ type: 'SETTINGS_OPEN', items: this.buildSettingsItems() });
  }

  private refreshSettingsMenu(selectedIndex?: number): void {
    if (!this.state.settingsMenu) return;
    this.dispatch({ type: 'SETTINGS_UPDATE', items: this.buildSettingsItems(), selectedIndex });
  }

  private adjustSelectedSetting(delta: number): void {
    const menu = this.state.settingsMenu;
    if (!menu?.items.length) return;
    const selected = menu.items[menu.selectedIndex];
    if (!selected) return;

    switch (selected.key) {
      case 'theme': {
        const current = (this.config.theme || 'default') as (typeof THEME_OPTIONS)[number];
        const idx = Math.max(0, THEME_OPTIONS.indexOf(current));
        const next =
          THEME_OPTIONS[
            (idx + (delta >= 0 ? 1 : -1) + THEME_OPTIONS.length) % THEME_OPTIONS.length
          ]!;
        this.config.theme = next;
        setRenderTheme(next);
        break;
      }
      case 'approval': {
        const current = (this.config.approval_mode ||
          'default') as (typeof APPROVAL_OPTIONS)[number];
        const idx = Math.max(0, APPROVAL_OPTIONS.indexOf(current));
        const next =
          APPROVAL_OPTIONS[
            (idx + (delta >= 0 ? 1 : -1) + APPROVAL_OPTIONS.length) % APPROVAL_OPTIONS.length
          ]!;
        this.config.approval_mode = next as any;
        break;
      }
      case 'watchdog_timeout': {
        const cur = this.config.watchdog_timeout_ms ?? 120_000;
        const step = cur >= 180_000 ? 60_000 : 30_000;
        this.config.watchdog_timeout_ms = Math.max(30_000, cur + (delta >= 0 ? step : -step));
        break;
      }
      case 'watchdog_compactions': {
        const cur = this.config.watchdog_max_compactions ?? 3;
        this.config.watchdog_max_compactions = Math.max(0, cur + (delta >= 0 ? 1 : -1));
        break;
      }
      case 'watchdog_grace': {
        const cur = this.config.watchdog_idle_grace_timeouts ?? 1;
        this.config.watchdog_idle_grace_timeouts = Math.max(0, cur + (delta >= 0 ? 1 : -1));
        break;
      }
      case 'debug_abort': {
        this.config.debug_abort_reason = !(this.config.debug_abort_reason === true);
        break;
      }
      default:
        return;
    }

    this.refreshSettingsMenu(menu.selectedIndex);
  }

  private buildHookInspectorLines(mode: 'status' | 'errors' | 'slow' | 'plugins'): string[] {
    const manager: any = this.session?.hookManager;
    if (!manager || typeof manager.getSnapshot !== 'function') {
      return ['Hooks are unavailable for this session.'];
    }

    const snap = manager.getSnapshot();
    const totalEvents = Object.values(snap.eventCounts || {}).reduce(
      (sum: number, n: any) => sum + Number(n || 0),
      0
    );

    if (mode === 'errors') {
      return snap.recentErrors?.length
        ? snap.recentErrors.map((x: string) => `• ${x}`)
        : ['No recent hook errors.'];
    }

    if (mode === 'slow') {
      return snap.recentSlowHandlers?.length
        ? snap.recentSlowHandlers.map((x: string) => `• ${x}`)
        : ['No recent slow hook handlers.'];
    }

    if (mode === 'plugins') {
      if (!snap.plugins?.length) return ['No hook plugins loaded.'];
      const lines: string[] = [];
      for (const p of snap.plugins) {
        lines.push(`• ${p.name} (${p.source})`);
        lines.push(`  granted: ${p.grantedCapabilities.join(', ') || 'none'}`);
        if (p.deniedCapabilities?.length)
          lines.push(`  denied: ${p.deniedCapabilities.join(', ')}`);
      }
      return lines;
    }

    return [
      `Enabled: ${snap.enabled ? 'yes' : 'no'}`,
      `Strict mode: ${snap.strict ? 'yes' : 'no'}`,
      `Allowed capabilities: ${(snap.allowedCapabilities || []).join(', ')}`,
      `Plugins: ${snap.plugins?.length ?? 0}`,
      `Handlers: ${snap.handlers?.length ?? 0}`,
      `Events observed: ${totalEvents}`,
      `Recent errors: ${snap.recentErrors?.length ?? 0}`,
      `Recent slow handlers: ${snap.recentSlowHandlers?.length ?? 0}`,
    ];
  }

  private openHooksInspector(mode: 'status' | 'errors' | 'slow' | 'plugins' = 'status'): void {
    this.dispatch({
      type: 'HOOKS_INSPECTOR_OPEN',
      mode,
      lines: this.buildHookInspectorLines(mode),
    });
  }

  /** Open the model picker overlay with all enabled models. */
  private async openModelPicker(query = ''): Promise<void> {
    try {
      const { loadRuntimes } = await import('../runtime/store.js');
      const config = await loadRuntimes();
      const models = config.models
        .filter((m) => m.enabled)
        .map((m) => ({
          id: m.id,
          displayName: m.display_name,
          source: m.source,
          enabled: m.enabled,
        }));

      if (!models.length) {
        this.dispatch({
          type: 'ALERT_PUSH',
          id: `mp_${Date.now()}`,
          level: 'warn',
          text: 'No enabled models configured.',
        });
        return;
      }

      this.dispatch({ type: 'MODEL_PICKER_OPEN', models, query });
    } catch (e: any) {
      this.dispatch({
        type: 'ALERT_PUSH',
        id: `mp_${Date.now()}`,
        level: 'error',
        text: `Failed to load models: ${e?.message ?? String(e)}`,
      });
    }
  }

  private modelPickerQueryAppend(text: string): void {
    const current = this.state.modelPicker?.query ?? '';
    const next = `${current}${text}`;
    this.filterModelPicker(next);
  }

  private modelPickerQueryBackspace(): void {
    const current = this.state.modelPicker?.query ?? '';
    const next = current.slice(0, -1);
    this.filterModelPicker(next);
  }

  private filterModelPicker(query: string): void {
    const picker = this.state.modelPicker;
    if (!picker) return;

    const q = query.toLowerCase().trim();
    const filtered = q
      ? picker.models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            m.displayName.toLowerCase().includes(q) ||
            m.source.toLowerCase().includes(q)
        )
      : [...picker.models];

    this.dispatch({
      type: 'MODEL_PICKER_FILTER',
      filtered,
      query,
      selectedIndex: 0,
      offset: 0,
    });
  }

  private async handleModelSelect(): Promise<void> {
    const picker = this.state.modelPicker;
    if (!picker?.filtered.length) {
      this.dispatch({ type: 'MODEL_PICKER_CLOSE' });
      return;
    }

    const selected = picker.filtered[picker.selectedIndex];
    if (!selected) {
      this.dispatch({ type: 'MODEL_PICKER_CLOSE' });
      return;
    }

    this.dispatch({ type: 'MODEL_PICKER_CLOSE' });
    this.pushSystemMessage(`Switching to ${selected.displayName}...`);

    try {
      const { plan } = await import('../runtime/planner.js');
      const { execute, loadActiveRuntime } = await import('../runtime/executor.js');
      const { loadRuntimes } = await import('../runtime/store.js');

      const rtConfig = await loadRuntimes();
      const active = await loadActiveRuntime();
      const result = plan({ modelId: selected.id, mode: 'live' }, rtConfig, active);

      if (!result.ok) {
        this.dispatch({
          type: 'ALERT_PUSH',
          id: `sw_${Date.now()}`,
          level: 'error',
          text: `Plan failed: ${result.reason}`,
        });
        return;
      }

      if (result.reuse) {
        this.pushSystemMessage(`Already using ${result.model.display_name}`);
        return;
      }

      const execResult = await execute(result, {
        onStep: async (step, status) => {
          if (status === 'done') {
            this.pushSystemMessage(`✓ ${step.description}`);
          }
        },
        confirm: async (prompt) => {
          this.pushSystemMessage(`⚠️ ${prompt}\nAuto-approving.`);
          return true;
        },
      });

      if (execResult.ok) {
        this.pushSystemMessage(`✅ Switched to ${result.model.display_name}`);
      } else {
        this.dispatch({
          type: 'ALERT_PUSH',
          id: `sw_${Date.now()}`,
          level: 'error',
          text: `Switch failed: ${execResult.error || 'unknown error'}`,
        });
      }
    } catch (e: any) {
      this.dispatch({
        type: 'ALERT_PUSH',
        id: `sw_${Date.now()}`,
        level: 'error',
        text: `Switch failed: ${e?.message ?? String(e)}`,
      });
    }
  }

  /** Push a system-role transcript item and re-render. */
  private pushSystemMessage(text: string): void {
    const item: TranscriptItem = { id: `sys_${Date.now()}`, role: 'system', text, ts: Date.now() };
    this.state = { ...this.state, transcript: [...this.state.transcript, item] };
    renderTui(this.state);
  }

  /** Run a shell command and display output in transcript. */
  private async handleShellCommand(line: string): Promise<void> {
    const result = await runShellCommand(line, this.config);
    if (!result.command) {
      this.dispatch({
        type: 'ALERT_PUSH',
        id: `sh_${Date.now()}`,
        level: 'info',
        text: 'Usage: !<command> or !!<command> to inject output',
      });
      return;
    }
    this.pushSystemMessage(`$ ${result.command}`);
    if (result.output.trim()) this.pushSystemMessage(result.output);
    if (result.rc !== 0)
      this.dispatch({
        type: 'ALERT_PUSH',
        id: `sh_${Date.now()}`,
        level: 'warn',
        text: `Shell exited rc=${result.rc}`,
      });
    if (result.inject && this.session) {
      this.session.messages.push({
        role: 'user',
        content: `[Shell output]\n$ ${result.command}\n${result.output}`,
      } as any);
      this.dispatch({
        type: 'ALERT_PUSH',
        id: `sh_${Date.now()}`,
        level: 'info',
        text: 'Output injected into context',
      });
    }
  }

  /** Handle a slash command. Returns true if handled. */
  private async handleSlashCommand(line: string): Promise<boolean> {
    const parts = splitTokens(line);
    const head = (parts[0] || '').toLowerCase();
    if (!head.startsWith('/')) return false;

    ensureCommandsRegistered();

    // TUI-specific overrides
    if (head === '/quit' || head === '/exit') {
      if (this.cleanupFn) await this.cleanupFn();
      return true;
    }
    if (head === '/cancel') {
      if (this.inFlight && this.aborter) {
        try {
          this.aborter.abort();
        } catch {}
        try {
          this.session?.cancel();
        } catch {}
        this.dispatch({
          type: 'ALERT_PUSH',
          id: `cancel_${Date.now()}`,
          level: 'warn',
          text: '⏹ Cancel requested.',
        });
      } else {
        this.dispatch({
          type: 'ALERT_PUSH',
          id: `cancel_${Date.now()}`,
          level: 'info',
          text: 'Nothing to cancel.',
        });
      }
      return true;
    }
    if (head === '/clear') {
      this.state = { ...this.state, transcript: [], toolEvents: [], alerts: [] };
      renderTui(this.state);
      return true;
    }
    if (head === '/help') {
      const cmds = allCommandNames().join('  ');
      this.pushSystemMessage(
        `Commands: ${cmds}\n` +
          `Shell: !<cmd> to run, !! to inject output\n` +
          `TUI: /cancel (stop active run), /branches [browse|checkout|merge], /steps, /settings, /hooks [status|errors|slow|plugins], /version\n` +
          `Hotkeys: Ctrl+C cancel in-flight run, Ctrl+G step navigator, Ctrl+O quick settings`
      );
      return true;
    }
    if (head === '/branches') {
      const sub = (parts[1] || '').toLowerCase();
      const action =
        sub === 'checkout'
          ? ('checkout' as const)
          : sub === 'merge'
            ? ('merge' as const)
            : ('browse' as const);
      await this.openBranchPicker(action);
      return true;
    }
    if (head === '/steps') {
      const query = line.replace(/^\/steps\s*/i, '').trim();
      this.openStepNavigator(query);
      return true;
    }
    if (head === '/settings') {
      this.openSettingsMenu();
      return true;
    }
    if (head === '/hooks') {
      const modeRaw = line
        .replace(/^\/hooks\s*/i, '')
        .trim()
        .toLowerCase();
      const mode = (modeRaw || 'status') as 'status' | 'errors' | 'slow' | 'plugins';
      if (!['status', 'errors', 'slow', 'plugins'].includes(mode)) {
        this.dispatch({
          type: 'ALERT_PUSH',
          id: `hooks_${Date.now()}`,
          level: 'warn',
          text: 'Usage: /hooks [status|errors|slow|plugins]',
        });
        return true;
      }
      this.openHooksInspector(mode);
      return true;
    }
    if (head === '/models' || head === '/runtimes') {
      const query = line.replace(/^\/(?:models|runtimes)\s*/i, '').trim();
      await this.openModelPicker(query);
      return true;
    }

    const result = await runSlashCommand(line, this.session, this.config, this.cleanupFn, () =>
      this.saveTuiSessionSnapshot()
    );
    if (!result.found) {
      this.dispatch({
        type: 'ALERT_PUSH',
        id: `cmd_${Date.now()}`,
        level: 'warn',
        text: `Unknown command: ${head}`,
      });
    } else if (result.output) {
      this.pushSystemMessage(result.output);
    }
    return true;
  }

  private async saveTuiSessionSnapshot(): Promise<void> {
    if (!this.session) return;
    const payload = {
      savedAt: new Date().toISOString(),
      model: this.session.model,
      harness: this.session.harness,
      contextWindow: this.session.contextWindow,
      messages: this.session.messages,
      mode: 'tui',
    };
    const cwd = projectDir(this.config);
    const targets = new Set<string>([lastSessionPath(), projectSessionPath(cwd)]);
    for (const target of targets) await saveSessionFile(target, payload);
  }

  private async submitInput(text: string): Promise<void> {
    if (!this.session) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // Slash commands: route through registry instead of agent.
    // While a generation is in-flight, only /cancel is accepted immediately.
    if (trimmed.startsWith('/')) {
      const head = (splitTokens(trimmed)[0] || '').toLowerCase();
      if (this.inFlight && head !== '/cancel') {
        this.dispatch({
          type: 'ALERT_PUSH',
          id: `busy_${Date.now()}`,
          level: 'warn',
          text: 'Generation in progress. Use /cancel first.',
        });
        return;
      }
      this.dispatch({ type: 'USER_INPUT_SUBMIT', text: trimmed });
      await this.handleSlashCommand(trimmed);
      return;
    }

    if (this.inFlight) {
      this.dispatch({
        type: 'ALERT_PUSH',
        id: `busy_${Date.now()}`,
        level: 'warn',
        text: 'Generation in progress. Use /cancel first.',
      });
      return;
    }

    // Shell commands: !cmd or !!cmd
    if (/^!{1,2}\s*\S/.test(trimmed)) {
      this.dispatch({ type: 'USER_INPUT_SUBMIT', text: trimmed });
      await this.handleShellCommand(trimmed);
      return;
    }

    this.dispatch({ type: 'USER_INPUT_SUBMIT', text: trimmed });

    const id = `a_${Date.now()}`;
    this.inFlight = true;
    this.aborter = new AbortController();
    this.lastProgressAt = Date.now();
    this.watchdogCompactAttempts = 0;
    this.dispatch({ type: 'AGENT_STREAM_START', id });

    const watchdogSettings = resolveWatchdogSettings(undefined, this.config);
    const watchdogMs = watchdogSettings.timeoutMs;
    const maxWatchdogCompacts = watchdogSettings.maxCompactions;
    const watchdogIdleGraceTimeouts = watchdogSettings.idleGraceTimeouts;
    const debugAbortReason = watchdogSettings.debugAbortReason;
    let watchdogCompactPending = false;
    let watchdogGraceUsed = 0;
    let watchdogForcedCancel = false;
    const presenter = new ProgressPresenter({
      maxToolLines: 6,
      maxTailLines: 4,
      maxDiffLines: 24,
      maxAssistantChars: 800,
      tuiMaxLines: 8,
      toolCallSummary: (c) => formatToolCallSummary({ name: c.name, args: c.args as any }),
    });

    presenter.start();

    // Render status at a steady cadence rather than on every token.
    const statusTimer = setInterval(() => {
      if (!presenter.isDirty()) return;
      const lines = presenter.renderTuiLines();
      const status = lines.find((l) => l.trim().length > 0) ?? '';
      this.dispatch({ type: 'STATUS_SET', text: status });
      presenter.clearDirty();
    }, 250);

    const watchdog = setInterval(() => {
      if (!this.inFlight) return;
      if (watchdogCompactPending) return;
      if (Date.now() - this.lastProgressAt > watchdogMs) {
        if (watchdogGraceUsed < watchdogIdleGraceTimeouts) {
          watchdogGraceUsed += 1;
          this.lastProgressAt = Date.now();
          presenter.setBanner('⏳ Still working... model is taking longer than usual.');
          console.error(
            `[tui] watchdog inactivity — applying grace period (${watchdogGraceUsed}/${watchdogIdleGraceTimeouts})`
          );
          this.dispatch({
            type: 'ALERT_PUSH',
            id: `watchdog_grace_${Date.now()}`,
            level: 'info',
            text: 'Still working... model is taking longer than usual.',
          });
          return;
        }

        if (this.watchdogCompactAttempts < maxWatchdogCompacts) {
          this.watchdogCompactAttempts++;
          watchdogCompactPending = true;
          presenter.setBanner('🧹 Compacting context and retrying...');
          console.error(
            `[tui] watchdog timeout — compacting and retrying (attempt ${this.watchdogCompactAttempts}/${maxWatchdogCompacts})`
          );
          try {
            this.aborter?.abort();
          } catch {}
          this.session!.compactHistory({ force: true })
            .then((result) => {
              console.error(
                `[tui] watchdog compaction: freed ${result.freedTokens} tokens, dropped ${result.droppedMessages} messages`
              );
              presenter.setBanner(null);
              this.lastProgressAt = Date.now();
              watchdogCompactPending = false;
            })
            .catch((e: any) => {
              console.error(`[tui] watchdog compaction failed: ${e?.message ?? e}`);
              presenter.setBanner(null);
              watchdogCompactPending = false;
            });
        } else {
          console.error(`[tui] watchdog timeout — max compaction attempts reached, cancelling`);
          watchdogForcedCancel = true;
          try {
            this.aborter?.abort();
          } catch {}
          try {
            this.session?.cancel();
          } catch {}
        }
      }
    }, 5_000);

    let activeToolId: string | null = null;

    try {
      let askComplete = false;
      let isRetryAfterCompaction = false;
      let isToolLoopRetry = false;
      let toolLoopRetryCount = 0;
      const autoContinueCfg = this.config.tool_loop_auto_continue;
      const autoContinueEnabled = autoContinueCfg?.enabled !== false;
      const autoContinueMaxRetries = autoContinueCfg?.max_retries ?? 3;
      while (!askComplete) {
        const attemptController = new AbortController();
        this.aborter = attemptController;

        const askText = isRetryAfterCompaction
          ? 'Continue working on the task from where you left off. Context was compacted to free memory — do NOT restart from the beginning.'
          : isToolLoopRetry
            ? AUTO_CONTINUE_PROMPT
            : trimmed;
        isToolLoopRetry = false;

        const presenterHooks = presenter.hooks();
        const uiHooks: AgentHooks = {
          signal: attemptController.signal,
          onFirstDelta: () => {
            this.lastProgressAt = Date.now();
            watchdogGraceUsed = 0;
            presenterHooks.onFirstDelta?.();
          },
          onToken: (t) => {
            this.lastProgressAt = Date.now();
            watchdogGraceUsed = 0;
            presenterHooks.onToken?.(t);
            this.dispatch({ type: 'AGENT_STREAM_TOKEN', id, token: t });
          },
          onToolCall: (c) => {
            this.lastProgressAt = Date.now();
            watchdogGraceUsed = 0;
            activeToolId = c.id;
            presenterHooks.onToolCall?.(c);
            this.dispatch({
              type: 'TOOL_START',
              id: c.id,
              name: c.name,
              detail: formatToolCallSummary({ name: c.name, args: c.args as any }),
            });
          },
          onToolStream: (ev) => {
            if (!activeToolId || ev.id !== activeToolId) return;
            presenterHooks.onToolStream?.(ev);
            const chunk = String(ev.chunk ?? '').replace(/\r/g, '\n');
            const last = chunk
              .split(/\n/)
              .map((l) => l.trimEnd())
              .reverse()
              .find((l) => l.trim().length > 0);
            if (last) this.dispatch({ type: 'TOOL_TAIL', id: ev.id, tail: last });
          },
          onToolResult: (r) => {
            this.lastProgressAt = Date.now();
            watchdogGraceUsed = 0;
            presenterHooks.onToolResult?.(r);
            if (activeToolId === r.id) activeToolId = null;
            this.dispatch({
              type: r.success ? 'TOOL_END' : 'TOOL_ERROR',
              id: r.id,
              name: r.name,
              detail: r.summary,
            });
          },
          onTurnEnd: (stats) => {
            this.lastProgressAt = Date.now();
            watchdogGraceUsed = 0;
            presenterHooks.onTurnEnd?.(stats);
          },
        };

        const hooks = chainAgentHooks(uiHooks);

        try {
          await this.session.ask(askText, hooks);
          askComplete = true;
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          const isAbort = msg.includes('AbortError') || msg.toLowerCase().includes('aborted');

          if (isAbort && watchdogCompactPending) {
            this.dispatch({
              type: 'ALERT_PUSH',
              id: `compact_${Date.now()}`,
              level: 'info',
              text: `Context too large — compacting and retrying (attempt ${this.watchdogCompactAttempts}/${maxWatchdogCompacts})...`,
            });
            while (watchdogCompactPending) {
              await new Promise((r) => setTimeout(r, 500));
            }
            isRetryAfterCompaction = true;
            continue;
          }

          // Auto-continue on tool-loop breaks
          if (!isAbort && isToolLoopBreak(e) && autoContinueEnabled && toolLoopRetryCount < autoContinueMaxRetries) {
            toolLoopRetryCount++;
            const notice = formatAutoContinueNotice(msg, toolLoopRetryCount, autoContinueMaxRetries);
            console.error(`[tui] tool-loop auto-continue (retry ${toolLoopRetryCount}/${autoContinueMaxRetries})`);
            this.dispatch({
              type: 'ALERT_PUSH',
              id: `tool_loop_retry_${Date.now()}`,
              level: 'info',
              text: notice,
            });
            isToolLoopRetry = true;
            continue;
          }

          askComplete = true;
          if (isAbort) {
            const text = formatWatchdogCancelMessage({
              watchdogForcedCancel,
              maxCompactions: maxWatchdogCompacts,
              debugAbortReason,
              abortReason: msg,
            });
            this.dispatch({ type: 'ALERT_PUSH', id: `err_${Date.now()}`, level: 'error', text });
          } else {
            this.dispatch({
              type: 'ALERT_PUSH',
              id: `err_${Date.now()}`,
              level: 'error',
              text: msg,
            });
          }
        }
      }
    } finally {
      presenter.stop();
      this.dispatch({ type: 'STATUS_CLEAR' });
      clearInterval(watchdog);
      clearInterval(statusTimer);
      this.dispatch({ type: 'AGENT_STREAM_DONE', id });
      this.inFlight = false;
      this.aborter = null;
    }
  }

  async run(): Promise<void> {
    setRenderTheme(this.config.theme);
    this.session = await createSession({
      config: this.config,
      confirmProvider: this.confirmProvider,
      confirm: async (prompt: string) => {
        // Legacy confirm fallback — route through the TUI confirm provider
        return this.confirmProvider.confirm({
          tool: 'unknown',
          args: {},
          summary: prompt,
          mode: (this.config.approval_mode as any) ?? 'suggest',
        });
      },
    });
    this.dispatch({
      type: 'RUNTIME_STATE_UPDATE',
      runtime: { modelId: this.session.model, endpoint: this.session.endpoint, healthy: true },
    });

    enterFullScreen();
    renderTui(this.state);
    this.dispatch({
      type: 'ALERT_PUSH',
      id: `info_${Date.now()}`,
      level: 'info',
      text: 'Input: Enter=send, Ctrl+J/Alt+Enter=newline, Up/Down=history, Ctrl+G=steps, Ctrl+O=settings, /hooks inspector.',
    });

    const onSigwinch = () => {
      renderTui(this.state);
    };

    const onFatal = async (err: unknown, source: 'uncaughtException' | 'unhandledRejection') => {
      const text = err instanceof Error ? err.message : String(err);
      this.dispatch({
        type: 'ALERT_PUSH',
        id: `fatal_${Date.now()}`,
        level: 'error',
        text: `${source}: ${text}`,
      });
      try {
        await this.saveTuiSessionSnapshot();
      } catch {}
      process.exitCode = 1;
      await cleanup();
    };

    const onData = (buf: Buffer) => {
      const keys = decodeRawInput(buf.toString('utf8'));
      for (const key of keys) {
        // Confirmation mode: route y/n/d to confirm provider
        if (this.state.confirmPending) {
          if (key === 'text:y' || key === 'text:Y') {
            this.confirmProvider.resolve(true);
            continue;
          }
          if (key === 'text:n' || key === 'text:N') {
            this.confirmProvider.resolve(false);
            continue;
          }
          if (key === 'text:d' || key === 'text:D') {
            this.confirmProvider.toggleDiff();
            continue;
          }
          // Ctrl+C rejects during confirm
          const cAction = resolveAction(key);
          if (cAction === 'cancel') {
            this.confirmProvider.resolve(false);
            continue;
          }
          continue; // Ignore all other keys during confirm
        }

        // Branch picker mode: arrow keys navigate, Enter selects, Esc/q closes
        if (this.state.branchPicker) {
          const bAction = resolveAction(key);
          if (bAction === 'history_prev' || key === 'up') {
            this.dispatch({ type: 'BRANCH_PICKER_MOVE', delta: -1 });
            continue;
          }
          if (bAction === 'history_next' || key === 'down') {
            this.dispatch({ type: 'BRANCH_PICKER_MOVE', delta: 1 });
            continue;
          }
          if (bAction === 'send') {
            void this.handleBranchSelect();
            continue;
          }
          if (bAction === 'cancel' || bAction === 'quit' || key === 'text:q') {
            this.dispatch({ type: 'BRANCH_PICKER_CLOSE' });
            continue;
          }
          continue; // swallow all other input during picker
        }

        // Step navigator: type to filter, arrows to select, Enter to jump.
        if (this.state.stepNavigator) {
          const nAction = resolveAction(key);
          if (key.startsWith('text:')) {
            const ch = key.slice(5);
            if (ch === 'q' && !this.state.stepNavigator.query) {
              this.dispatch({ type: 'STEP_NAV_CLOSE' });
            } else {
              this.stepNavigatorQueryAppend(ch);
            }
            continue;
          }
          if (nAction === 'backspace') {
            this.stepNavigatorQueryBackspace();
            continue;
          }
          if (nAction === 'history_prev' || nAction === 'cursor_left') {
            this.dispatch({ type: 'STEP_NAV_MOVE', delta: -1 });
            continue;
          }
          if (nAction === 'history_next' || nAction === 'cursor_right') {
            this.dispatch({ type: 'STEP_NAV_MOVE', delta: 1 });
            continue;
          }
          if (nAction === 'scroll_up') {
            this.dispatch({ type: 'STEP_NAV_MOVE', delta: -10 });
            continue;
          }
          if (nAction === 'scroll_down') {
            this.dispatch({ type: 'STEP_NAV_MOVE', delta: 10 });
            continue;
          }
          if (nAction === 'send') {
            this.jumpToStepSelection();
            continue;
          }
          if (nAction === 'cancel' || nAction === 'quit') {
            this.dispatch({ type: 'STEP_NAV_CLOSE' });
            continue;
          }
          continue;
        }

        // Settings menu: arrows/select to adjust config quickly.
        if (this.state.settingsMenu) {
          const sAction = resolveAction(key);
          if (sAction === 'history_prev') {
            this.dispatch({ type: 'SETTINGS_MOVE', delta: -1 });
            continue;
          }
          if (sAction === 'history_next') {
            this.dispatch({ type: 'SETTINGS_MOVE', delta: 1 });
            continue;
          }
          if (sAction === 'cursor_left') {
            this.adjustSelectedSetting(-1);
            continue;
          }
          if (sAction === 'cursor_right' || sAction === 'send') {
            this.adjustSelectedSetting(1);
            continue;
          }
          if (sAction === 'cancel' || sAction === 'quit' || key === 'text:q') {
            this.dispatch({ type: 'SETTINGS_CLOSE' });
            continue;
          }
          continue;
        }

        if (this.state.hooksInspector) {
          const hAction = resolveAction(key);
          if (hAction === 'history_prev' || hAction === 'scroll_up') {
            this.dispatch({ type: 'HOOKS_INSPECTOR_MOVE', delta: -1 });
            continue;
          }
          if (hAction === 'history_next' || hAction === 'scroll_down') {
            this.dispatch({ type: 'HOOKS_INSPECTOR_MOVE', delta: 1 });
            continue;
          }
          if (
            hAction === 'cancel' ||
            hAction === 'quit' ||
            key === 'text:q' ||
            hAction === 'send'
          ) {
            this.dispatch({ type: 'HOOKS_INSPECTOR_CLOSE' });
            continue;
          }
          continue;
        }

        // Model picker: type to filter, arrows to select, Enter to switch.
        if (this.state.modelPicker) {
          const mAction = resolveAction(key);
          if (key.startsWith('text:')) {
            const ch = key.slice(5);
            if (ch === 'q' && !this.state.modelPicker.query) {
              this.dispatch({ type: 'MODEL_PICKER_CLOSE' });
            } else {
              this.modelPickerQueryAppend(ch);
            }
            continue;
          }
          if (mAction === 'backspace') {
            this.modelPickerQueryBackspace();
            continue;
          }
          if (mAction === 'history_prev') {
            this.dispatch({ type: 'MODEL_PICKER_MOVE', delta: -1 });
            continue;
          }
          if (mAction === 'history_next') {
            this.dispatch({ type: 'MODEL_PICKER_MOVE', delta: 1 });
            continue;
          }
          if (mAction === 'scroll_up') {
            this.dispatch({ type: 'MODEL_PICKER_MOVE', delta: -5 });
            continue;
          }
          if (mAction === 'scroll_down') {
            this.dispatch({ type: 'MODEL_PICKER_MOVE', delta: 5 });
            continue;
          }
          if (mAction === 'send') {
            void this.handleModelSelect();
            continue;
          }
          if (mAction === 'cancel' || mAction === 'quit') {
            this.dispatch({ type: 'MODEL_PICKER_CLOSE' });
            continue;
          }
          continue;
        }

        if (key.startsWith('text:')) {
          this.resetTab();
          this.dispatch({ type: 'USER_INPUT_INSERT', text: key.slice(5) });
          continue;
        }

        const action = resolveAction(key);
        if (!action) continue;

        // Tab completion doesn't reset tab state
        if (action === 'tab_complete') {
          this.handleTabComplete();
          continue;
        }

        // Any non-tab action resets tab cycling
        this.resetTab();

        if (action === 'open_step_navigator') {
          this.openStepNavigator();
          continue;
        }
        if (action === 'open_settings') {
          this.openSettingsMenu();
          continue;
        }
        if (action === 'quit') {
          void cleanup();
          continue;
        }
        if (action === 'cancel') {
          if (this.inFlight && this.aborter) {
            this.aborter.abort();
            this.session?.cancel();
            continue;
          }
          const now = Date.now();
          if (now - this.ctrlCAt < 1200) {
            void cleanup();
            continue;
          }
          this.ctrlCAt = now;
          this.dispatch({
            type: 'ALERT_PUSH',
            id: `warn_${now}`,
            level: 'warn',
            text: 'Press Ctrl+C again to quit',
          });
          continue;
        }
        if (action === 'send') {
          void this.submitInput(this.state.inputBuffer);
          continue;
        }
        if (action === 'insert_newline') {
          this.dispatch({ type: 'USER_INPUT_INSERT', text: '\n' });
          continue;
        }
        if (action === 'backspace') {
          this.dispatch({ type: 'USER_INPUT_BACKSPACE' });
          continue;
        }
        if (action === 'delete_forward') {
          this.dispatch({ type: 'USER_INPUT_DELETE_FORWARD' });
          continue;
        }
        if (action === 'cursor_left') {
          this.dispatch({ type: 'USER_INPUT_CURSOR_MOVE', delta: -1 });
          continue;
        }
        if (action === 'cursor_right') {
          this.dispatch({ type: 'USER_INPUT_CURSOR_MOVE', delta: 1 });
          continue;
        }
        if (action === 'cursor_home') {
          this.dispatch({ type: 'USER_INPUT_CURSOR_HOME' });
          continue;
        }
        if (action === 'cursor_end') {
          this.dispatch({ type: 'USER_INPUT_CURSOR_END' });
          continue;
        }
        if (action === 'history_prev') {
          this.dispatch({ type: 'USER_INPUT_HISTORY_PREV' });
          continue;
        }
        if (action === 'history_next') {
          this.dispatch({ type: 'USER_INPUT_HISTORY_NEXT' });
          continue;
        }
        if (action === 'scroll_up') {
          this.dispatch({ type: 'SCROLL', panel: 'transcript', delta: -5 });
          continue;
        }
        if (action === 'scroll_down') {
          this.dispatch({ type: 'SCROLL', panel: 'transcript', delta: 5 });
        }
      }
    };

    let cleaned = false;

    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      this.cleanupFn = null;
      try {
        process.stdin.off('data', onData);
      } catch {}
      try {
        process.off('SIGWINCH', onSigwinch);
      } catch {}
      try {
        process.off('uncaughtException', onFatal);
      } catch {}
      try {
        process.off('unhandledRejection', onFatal);
      } catch {}
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      } catch {}
      try {
        process.stdin.pause();
      } catch {}
      try {
        await this.saveTuiSessionSnapshot();
      } catch {}
      try {
        await this.session?.close();
      } catch {}
      leaveFullScreen();
      resolveDone();
    };

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.cleanupFn = cleanup;

    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', onData);
      process.on('SIGWINCH', onSigwinch);
      process.on('uncaughtException', onFatal);
      process.on('unhandledRejection', onFatal);
      await done;
    } finally {
      try {
        process.stdin.off('data', onData);
      } catch {}
      try {
        process.off('SIGWINCH', onSigwinch);
      } catch {}
      try {
        process.off('uncaughtException', onFatal);
      } catch {}
      try {
        process.off('unhandledRejection', onFatal);
      } catch {}
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      } catch {}
      if (!cleaned) leaveFullScreen();
    }
  }
}
