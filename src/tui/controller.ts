import { createSession, type AgentSession } from "../agent.js";
import type { IdlehandsConfig } from "../types.js";
import type { TranscriptItem } from "./types.js";
import { decodeRawInput, resolveAction } from "./keymap.js";
import { createInitialTuiState, reduceTuiState } from "./state.js";
import { renderTui, setRenderTheme } from "./render.js";
import { enterFullScreen, leaveFullScreen } from "./screen.js";
import { saveSessionFile, lastSessionPath, projectSessionPath } from "../cli/session-state.js";
import { loadBranches, executeBranchSelect } from "./branch-picker.js";
import { ensureCommandsRegistered, allCommandNames, runShellCommand, runSlashCommand } from "./command-handler.js";
import { projectDir } from "../utils.js";
import type { TuiState } from "./types.js";
import { TuiConfirmProvider } from "./confirm.js";

/** Commands that need special TUI handling instead of the registry adapter. */
const TUI_OVERRIDES = new Set(['/quit', '/exit', '/clear', '/help', '/branches']);

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
      const extra = ['/quit', '/exit', '/clear', '/help'];
      const all = [...new Set([...names, ...extra])];
      this.tabCandidates = all.filter(n => n.toLowerCase().startsWith(prefix)).sort();
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
    if (!picker || !picker.branches.length) { this.dispatch({ type: 'BRANCH_PICKER_CLOSE' }); return; }
    const selected = picker.branches[picker.selectedIndex];
    if (!selected) { this.dispatch({ type: 'BRANCH_PICKER_CLOSE' }); return; }
    this.dispatch({ type: 'BRANCH_PICKER_CLOSE' });

    if (picker.action === 'browse') {
      this.pushSystemMessage(`Branch: ${selected.name} (${selected.messageCount} messages)\n${selected.preview || '(no preview)'}`);
      return;
    }

    if (!this.session) return;
    const result = await executeBranchSelect(this.session, selected.name, picker.action);
    if (result.message) {
      if (result.ok) this.pushSystemMessage(result.message);
      else this.dispatch({ type: 'ALERT_PUSH', id: `br_${Date.now()}`, level: result.level ?? 'error', text: result.message });
    }
  }

  /** Push a system-role transcript item and re-render. */
  private pushSystemMessage(text: string): void {
    const item: TranscriptItem = { id: `sys_${Date.now()}`, role: "system", text, ts: Date.now() };
    this.state = { ...this.state, transcript: [...this.state.transcript, item] };
    renderTui(this.state);
  }

  /** Run a shell command and display output in transcript. */
  private async handleShellCommand(line: string): Promise<void> {
    const result = await runShellCommand(line, this.config);
    if (!result.command) {
      this.dispatch({ type: "ALERT_PUSH", id: `sh_${Date.now()}`, level: "info", text: "Usage: !<command> or !!<command> to inject output" });
      return;
    }
    this.pushSystemMessage(`$ ${result.command}`);
    if (result.output.trim()) this.pushSystemMessage(result.output);
    if (result.rc !== 0) this.dispatch({ type: "ALERT_PUSH", id: `sh_${Date.now()}`, level: "warn", text: `Shell exited rc=${result.rc}` });
    if (result.inject && this.session) {
      this.session.messages.push({ role: "user", content: `[Shell output]\n$ ${result.command}\n${result.output}` } as any);
      this.dispatch({ type: "ALERT_PUSH", id: `sh_${Date.now()}`, level: "info", text: "Output injected into context" });
    }
  }

  /** Handle a slash command. Returns true if handled. */
  private async handleSlashCommand(line: string): Promise<boolean> {
    const head = (line.trim().split(/\s+/)[0] || "").toLowerCase();
    if (!head.startsWith("/")) return false;

    ensureCommandsRegistered();

    // TUI-specific overrides
    if (head === "/quit" || head === "/exit") {
      if (this.cleanupFn) await this.cleanupFn();
      return true;
    }
    if (head === "/clear") {
      this.state = { ...this.state, transcript: [], toolEvents: [], alerts: [] };
      renderTui(this.state);
      return true;
    }
    if (head === "/help") {
      const cmds = allCommandNames().join("  ");
      this.pushSystemMessage(`Commands: ${cmds}\nShell: !<cmd> to run, !! to inject output\nTUI: /branches to browse conversation branches`);
      return true;
    }
    if (head === "/branches") {
      const parts = line.trim().split(/\s+/);
      const sub = (parts[1] || '').toLowerCase();
      const action = sub === 'checkout' ? 'checkout' as const : sub === 'merge' ? 'merge' as const : 'browse' as const;
      await this.openBranchPicker(action);
      return true;
    }

    const result = await runSlashCommand(
      line, this.session, this.config, this.cleanupFn,
      () => this.saveTuiSessionSnapshot(),
    );
    if (!result.found) {
      this.dispatch({ type: "ALERT_PUSH", id: `cmd_${Date.now()}`, level: "warn", text: `Unknown command: ${head}` });
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
      mode: "tui",
    };
    const cwd = projectDir(this.config);
    const targets = new Set<string>([lastSessionPath(), projectSessionPath(cwd)]);
    for (const target of targets) await saveSessionFile(target, payload);
  }

  private async submitInput(text: string): Promise<void> {
    if (!this.session || this.inFlight) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // Slash commands: route through registry instead of agent
    if (trimmed.startsWith("/")) {
      this.dispatch({ type: "USER_INPUT_SUBMIT", text: trimmed });
      await this.handleSlashCommand(trimmed);
      return;
    }

    // Shell commands: !cmd or !!cmd
    if (/^!{1,2}\s*\S/.test(trimmed)) {
      this.dispatch({ type: "USER_INPUT_SUBMIT", text: trimmed });
      await this.handleShellCommand(trimmed);
      return;
    }

    this.dispatch({ type: "USER_INPUT_SUBMIT", text: trimmed });

    const id = `a_${Date.now()}`;
    this.inFlight = true;
    this.aborter = new AbortController();
    this.lastProgressAt = Date.now();
    this.watchdogCompactAttempts = 0;
    this.dispatch({ type: "AGENT_STREAM_START", id });

    const watchdogMs = 120_000;
    const maxWatchdogCompacts = 3;
    let watchdogCompactPending = false;
    const watchdog = setInterval(() => {
      if (!this.inFlight) return;
      if (watchdogCompactPending) return;
      if (Date.now() - this.lastProgressAt > watchdogMs) {
        if (this.watchdogCompactAttempts < maxWatchdogCompacts) {
          this.watchdogCompactAttempts++;
          watchdogCompactPending = true;
          console.error(`[tui] watchdog timeout — compacting and retrying (attempt ${this.watchdogCompactAttempts}/${maxWatchdogCompacts})`);
          try { this.aborter?.abort(); } catch {}
          this.session!.compactHistory().then((result) => {
            console.error(`[tui] watchdog compaction: freed ${result.freedTokens} tokens, dropped ${result.droppedMessages} messages`);
            this.lastProgressAt = Date.now();
            watchdogCompactPending = false;
          }).catch((e: any) => {
            console.error(`[tui] watchdog compaction failed: ${e?.message ?? e}`);
            watchdogCompactPending = false;
          });
        } else {
          console.error(`[tui] watchdog timeout — max compaction attempts reached, cancelling`);
          try { this.aborter?.abort(); } catch {}
          try { this.session?.cancel(); } catch {}
        }
      }
    }, 5_000);

    try {
      let askComplete = false;
      let isRetryAfterCompaction = false;
      while (!askComplete) {
        const attemptController = new AbortController();
        this.aborter = attemptController;

        const askText = isRetryAfterCompaction
          ? 'Continue working on the task from where you left off. Context was compacted to free memory — do NOT restart from the beginning.'
          : trimmed;

        try {
          await this.session.ask(askText, {
            signal: attemptController.signal,
            onToken: (t) => { this.lastProgressAt = Date.now(); this.dispatch({ type: "AGENT_STREAM_TOKEN", id, token: t }); },
            onToolCall: (c) => { this.lastProgressAt = Date.now(); this.dispatch({ type: "TOOL_START", id: `${c.name}-${Date.now()}`, name: c.name, detail: JSON.stringify(c.args).slice(0, 120) }); },
            onToolResult: async (r) => {
              this.lastProgressAt = Date.now();
              this.dispatch({ type: r.success ? "TOOL_END" : "TOOL_ERROR", id: `${r.name}-${Date.now()}`, name: r.name, detail: r.summary });
            },
          });
          askComplete = true;
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          const isAbort = msg.includes('AbortError') || msg.toLowerCase().includes('aborted');

          if (isAbort && watchdogCompactPending) {
            this.dispatch({ type: "ALERT_PUSH", id: `compact_${Date.now()}`, level: "info", text: `Context too large — compacting and retrying (attempt ${this.watchdogCompactAttempts}/${maxWatchdogCompacts})...` });
            while (watchdogCompactPending) {
              await new Promise((r) => setTimeout(r, 500));
            }
            isRetryAfterCompaction = true;
            continue;
          }

          askComplete = true;
          this.dispatch({ type: "ALERT_PUSH", id: `err_${Date.now()}`, level: "error", text: msg });
        }
      }
    } finally {
      clearInterval(watchdog);
      this.dispatch({ type: "AGENT_STREAM_DONE", id });
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
          tool: 'unknown', args: {}, summary: prompt, mode: this.config.approval_mode as any ?? 'suggest',
        });
      },
    });
    this.dispatch({ type: "RUNTIME_STATE_UPDATE", runtime: { modelId: this.session.model, endpoint: this.session.endpoint, healthy: true } });

    enterFullScreen();
    renderTui(this.state);
    this.dispatch({
      type: "ALERT_PUSH",
      id: `info_${Date.now()}`,
      level: "info",
      text: "Input policy: Enter=send, Ctrl+J/Alt+Enter=newline, Up/Down=history.",
    });

    const onSigwinch = () => {
      renderTui(this.state);
    };

    const onFatal = async (err: unknown, source: "uncaughtException" | "unhandledRejection") => {
      const text = err instanceof Error ? err.message : String(err);
      this.dispatch({ type: "ALERT_PUSH", id: `fatal_${Date.now()}`, level: "error", text: `${source}: ${text}` });
      try { await this.saveTuiSessionSnapshot(); } catch {}
      process.exitCode = 1;
      await cleanup();
    };

    const onData = (buf: Buffer) => {
      const keys = decodeRawInput(buf.toString("utf8"));
      for (const key of keys) {
        // Confirmation mode: route y/n/d to confirm provider
        if (this.state.confirmPending) {
          if (key === "text:y" || key === "text:Y") { this.confirmProvider.resolve(true); continue; }
          if (key === "text:n" || key === "text:N") { this.confirmProvider.resolve(false); continue; }
          if (key === "text:d" || key === "text:D") { this.confirmProvider.toggleDiff(); continue; }
          // Ctrl+C rejects during confirm
          const cAction = resolveAction(key);
          if (cAction === "cancel") { this.confirmProvider.resolve(false); continue; }
          continue; // Ignore all other keys during confirm
        }

        // Branch picker mode: arrow keys navigate, Enter selects, Esc/q closes
        if (this.state.branchPicker) {
          const bAction = resolveAction(key);
          if (bAction === "history_prev" || key === "up") { this.dispatch({ type: "BRANCH_PICKER_MOVE", delta: -1 }); continue; }
          if (bAction === "history_next" || key === "down") { this.dispatch({ type: "BRANCH_PICKER_MOVE", delta: 1 }); continue; }
          if (bAction === "send") { void this.handleBranchSelect(); continue; }
          if (bAction === "cancel" || bAction === "quit" || key === "text:q") { this.dispatch({ type: "BRANCH_PICKER_CLOSE" }); continue; }
          continue; // swallow all other input during picker
        }

        if (key.startsWith("text:")) {
          this.resetTab();
          this.dispatch({ type: "USER_INPUT_INSERT", text: key.slice(5) });
          continue;
        }

        const action = resolveAction(key);
        if (!action) continue;

        // Tab completion doesn't reset tab state
        if (action === "tab_complete") { this.handleTabComplete(); continue; }

        // Any non-tab action resets tab cycling
        this.resetTab();

        if (action === "quit") { void cleanup(); continue; }
        if (action === "cancel") {
          if (this.inFlight && this.aborter) { this.aborter.abort(); this.session?.cancel(); continue; }
          const now = Date.now();
          if (now - this.ctrlCAt < 1200) { void cleanup(); continue; }
          this.ctrlCAt = now;
          this.dispatch({ type: "ALERT_PUSH", id: `warn_${now}`, level: "warn", text: "Press Ctrl+C again to quit" });
          continue;
        }
        if (action === "send") { void this.submitInput(this.state.inputBuffer); continue; }
        if (action === "insert_newline") { this.dispatch({ type: "USER_INPUT_INSERT", text: "\n" }); continue; }
        if (action === "backspace") { this.dispatch({ type: "USER_INPUT_BACKSPACE" }); continue; }
        if (action === "delete_forward") { this.dispatch({ type: "USER_INPUT_DELETE_FORWARD" }); continue; }
        if (action === "cursor_left") { this.dispatch({ type: "USER_INPUT_CURSOR_MOVE", delta: -1 }); continue; }
        if (action === "cursor_right") { this.dispatch({ type: "USER_INPUT_CURSOR_MOVE", delta: 1 }); continue; }
        if (action === "cursor_home") { this.dispatch({ type: "USER_INPUT_CURSOR_HOME" }); continue; }
        if (action === "cursor_end") { this.dispatch({ type: "USER_INPUT_CURSOR_END" }); continue; }
        if (action === "history_prev") { this.dispatch({ type: "USER_INPUT_HISTORY_PREV" }); continue; }
        if (action === "history_next") { this.dispatch({ type: "USER_INPUT_HISTORY_NEXT" }); continue; }
        if (action === "scroll_up") { this.dispatch({ type: "SCROLL", panel: "transcript", delta: -5 }); continue; }
        if (action === "scroll_down") { this.dispatch({ type: "SCROLL", panel: "transcript", delta: 5 }); }
      }
    };

    let cleaned = false;

    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      this.cleanupFn = null;
      try { process.stdin.off("data", onData); } catch {}
      try { process.off("SIGWINCH", onSigwinch); } catch {}
      try { process.off("uncaughtException", onFatal); } catch {}
      try { process.off("unhandledRejection", onFatal); } catch {}
      try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
      try { process.stdin.pause(); } catch {}
      try { await this.saveTuiSessionSnapshot(); } catch {}
      try { await this.session?.close(); } catch {}
      leaveFullScreen();
      resolveDone();
    };

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    this.cleanupFn = cleanup;

    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
      process.on("SIGWINCH", onSigwinch);
      process.on("uncaughtException", onFatal);
      process.on("unhandledRejection", onFatal);
      await done;
    } finally {
      try { process.stdin.off("data", onData); } catch {}
      try { process.off("SIGWINCH", onSigwinch); } catch {}
      try { process.off("uncaughtException", onFatal); } catch {}
      try { process.off("unhandledRejection", onFatal); } catch {}
      try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
      if (!cleaned) leaveFullScreen();
    }
  }
}
