import fs from "node:fs/promises";
import path from "node:path";
import type { CliDeps } from "../cli/deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { CONFIG_DIR } from "../utils.js";

// ─── Types ──────────────────────────────────────────────────────────────────

type ParsedTask = {
  line: number;
  indent: string;
  text: string;
};

type AntonState = {
  running: boolean;
  taskFile?: string;
  startedAt?: string;
  currentIndex?: number;
  total?: number;
  completed?: number;
  skipped?: number;
  lastSummary?: string;
  stopRequested?: boolean;
  updatedAt?: string;
};

export type AntonProgressEvent =
  | { phase: "start"; taskFile: string; totalTasks: number }
  | { phase: "task_start"; index: number; total: number; task: string }
  | { phase: "discovery_start"; index: number; total: number; task: string }
  | { phase: "discovery_complete"; index: number; total: number; task: string; planFile: string }
  | { phase: "discovery_failed"; index: number; total: number; task: string; error: string }
  | { phase: "discovery_already_complete"; index: number; total: number; task: string }
  | { phase: "review_start"; index: number; total: number; task: string; planFile: string }
  | { phase: "review_complete"; index: number; total: number; task: string; planFile: string }
  | { phase: "review_failed"; index: number; total: number; task: string; error: string }
  | { phase: "implementation_start"; index: number; total: number; task: string; planFile?: string }
  | { phase: "task_agent_spawned"; index: number; total: number; task: string; sessionId: string }
  | { phase: "task_complete"; index: number; total: number; task: string }
  | { phase: "task_failed"; index: number; total: number; task: string; error: string }
  | { phase: "task_skipped"; index: number; total: number; task: string; reason: string }
  | { phase: "stopped"; completedSoFar: number; total: number }
  | { phase: "finish"; completed: number; skipped: number; total: number; durationMs: number };

export type AntonProgressCallback = (event: AntonProgressEvent) => Promise<void>;

/** Configuration for Anton's execution mode. */
export type AntonConfig = {
  /** Execution mode: "direct" (single agent) or "preflight" (discovery → implementation). Default: "direct". */
  mode?: "direct" | "preflight";
  /** Enable requirements review stage between discovery and implementation. Default: false. */
  requirementsReview?: boolean;
  /** Per-task timeout in seconds. Default: 1200. */
  taskTimeoutSec?: number;
  /** Discovery-stage timeout in seconds. Falls back to taskTimeoutSec. */
  discoveryTimeoutSec?: number;
  /** Requirements-review-stage timeout in seconds. Falls back to taskTimeoutSec. */
  reviewTimeoutSec?: number;
  /** Max retries for discovery/review before skipping. Default: 2. */
  preflightMaxRetries?: number;
  /** Directory to store plan files. Default: .agents/tasks/ relative to workspace. */
  planDir?: string;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const ANTON_STATE_PATH = path.join(CONFIG_DIR, "anton.state.json");
const ANTON_LOCK_PATH = path.join(CONFIG_DIR, "anton.lock");

// ─── State Management ───────────────────────────────────────────────────────

async function ensureStateDir() {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
}

async function readState(): Promise<AntonState> {
  try {
    return JSON.parse(await fs.readFile(ANTON_STATE_PATH, "utf8")) as AntonState;
  } catch {
    return { running: false };
  }
}

async function writeState(state: AntonState) {
  await ensureStateDir();
  await fs.writeFile(
    ANTON_STATE_PATH,
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

async function acquireLock(force = false) {
  await ensureStateDir();
  try {
    await fs.writeFile(
      ANTON_LOCK_PATH,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { encoding: "utf8", flag: "wx" },
    );
  } catch {
    if (!force) {
      throw new Error("Anton is already running (lock held)");
    }
    await fs.rm(ANTON_LOCK_PATH, { force: true });
    await fs.writeFile(
      ANTON_LOCK_PATH,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), force: true }),
      { encoding: "utf8", flag: "wx" },
    );
  }
}

async function releaseLock() {
  await fs.rm(ANTON_LOCK_PATH, { force: true });
}

async function shouldStop(): Promise<boolean> {
  const s = await readState();
  return Boolean(s.stopRequested);
}

// ─── Task Parsing ───────────────────────────────────────────────────────────

function parsePendingTasks(markdown: string): ParsedTask[] {
  const lines = markdown.split(/\r?\n/);
  const tasks: ParsedTask[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(/^(\s*)- \[ \] (.+)$/);
    if (!m) { continue; }
    tasks.push({ line: i + 1, indent: m[1] ?? "", text: (m[2] ?? "").trim() });
  }
  return tasks;
}

function markTaskDone(markdown: string, lineNo: number): string {
  const lines = markdown.split(/\r?\n/);
  const idx = lineNo - 1;
  if (idx < 0 || idx >= lines.length) { return markdown; }
  lines[idx] = (lines[idx] ?? "").replace(/^(\s*)- \[ \] /, "$1- [x] ");
  return `${lines.join("\n")}\n`;
}

// ─── Prompts ────────────────────────────────────────────────────────────────

function buildDirectTaskPrompt(task: string): string {
  return [
    "You are executing one item from a managed checklist.",
    `Task: ${task}`,
    "Rules:",
    "1) Make the minimal code changes required for this task.",
    "2) Run targeted tests for your change.",
    "3) Return a concise completion summary.",
  ].join("\n");
}

function buildDiscoveryPrompt(task: string, taskFile: string, planFilePath: string): string {
  return `You are running PRE-FLIGHT for an autonomous coding orchestrator.

## RULES
- DO NOT implement code changes. DO NOT modify source files.
- You may ONLY write to the plan file specified below.
- Read the codebase to understand what needs to change.

## TASK
From task file: ${taskFile}
Task: ${task}

## DECISION FLOW

**If task is ALREADY COMPLETE** (you are CERTAIN it's done after checking with tools):
→ Return ONLY: {"status":"complete","filename":""}

**If task is INCOMPLETE or UNCERTAIN**:
1. Read relevant source files to understand the current state
2. Write a detailed implementation plan to: ${planFilePath}
3. The plan MUST include:
   - Task description (verbatim from above)
   - What needs to change and why
   - Implementation approach with specific steps
   - Files to modify/create
   - How to verify (test commands)
4. Verify the file exists and is non-empty
5. Return ONLY: {"status":"incomplete","filename":"${planFilePath}"}

## OUTPUT
Return ONLY the JSON object. No markdown fences. No explanation.`;
}

function buildReviewPrompt(planFilePath: string): string {
  return `Review this implementation plan and improve it:
${planFilePath}

Treat it as written by a junior developer. Look for:
- Missing edge cases
- Opportunities to reuse existing code
- Unclear or ambiguous steps
- Missing test scenarios

Update the SAME file in-place with your improvements.

After review, return ONLY:
{"status":"ready","filename":"${planFilePath}"}

Do not return status=ready unless the file exists and has content.
Return JSON only. No markdown fences. No commentary.`;
}

function buildImplementationPrompt(task: string, planFilePath: string): string {
  return [
    "You are implementing a task from a managed checklist.",
    "A planning agent has already analyzed the codebase and written a detailed spec.",
    "",
    `Task: ${task}`,
    "",
    `Implementation plan: ${planFilePath}`,
    "",
    "Rules:",
    "1) Read the plan file FIRST — it contains the implementation approach.",
    "2) Follow the plan precisely. Make the code changes specified.",
    "3) Run the verification steps from the plan.",
    "4) Return a concise completion summary.",
    "",
    "Do not deviate from the plan unless you find a clear error in it.",
  ].join("\n");
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) { return `${seconds}s`; }
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) { return `${minutes}m ${secs}s`; }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

export function formatProgressMessage(event: AntonProgressEvent): string {
  switch (event.phase) {
    case "start":
      return `🤚 **Anton activated**\n📄 Task file: \`${path.basename(event.taskFile)}\`\n📋 ${event.totalTasks} task${event.totalTasks === 1 ? "" : "s"} pending`;
    case "task_start":
      return `\n🔪 **Task ${event.index}/${event.total}**: ${event.task}`;
    case "discovery_start":
      return `🔎 Discovery: analyzing codebase for task ${event.index}/${event.total}...`;
    case "discovery_complete":
      return `📝 Plan written: \`${path.basename(event.planFile)}\``;
    case "discovery_failed":
      return `⚠️ Discovery failed: ${event.error}\n└ Falling back to direct execution`;
    case "discovery_already_complete":
      return `✅ Discovery says task already complete — skipping implementation`;
    case "review_start":
      return `🧪 Reviewing plan: \`${path.basename(event.planFile)}\`...`;
    case "review_complete":
      return `✅ Plan reviewed and refined`;
    case "review_failed":
      return `⚠️ Review failed: ${event.error}\n└ Proceeding with unreviewed plan`;
    case "implementation_start":
      return event.planFile
        ? `🛠️ Implementation: following spec \`${path.basename(event.planFile)}\``
        : `🛠️ Implementation: direct execution`;
    case "task_agent_spawned":
      return `🤖 Agent spawned (session: \`${event.sessionId}\`)`;
    case "task_complete":
      return `✅ **Task ${event.index}/${event.total} complete**: ${event.task}`;
    case "task_failed":
      return `❌ **Task ${event.index}/${event.total} failed**: ${event.task}\n└ ${event.error}`;
    case "task_skipped":
      return `⏭️ **Task ${event.index}/${event.total} skipped**: ${event.task}\n└ ${event.reason}`;
    case "stopped":
      return `🛑 **Anton stopped** (${event.completedSoFar}/${event.total} completed before stop)`;
    case "finish":
      return [
        `\n🏁 **Anton finished**`,
        `✅ Completed: ${event.completed}/${event.total}`,
        event.skipped > 0 ? `⏭️ Skipped: ${event.skipped}` : null,
        `⏱️ Duration: ${formatDuration(event.durationMs)}`,
      ]
        .filter(Boolean)
        .join("\n");
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function antonStatus(runtime: RuntimeEnv) {
  const s = await readState();
  if (!s.running) {
    runtime.log("Anton is idle.");
    if (s.lastSummary) { runtime.log(s.lastSummary); }
    return;
  }
  runtime.log(
    `Anton running: ${s.completed ?? 0}/${s.total ?? 0} complete` +
      (s.taskFile ? ` | file=${s.taskFile}` : "") +
      (typeof s.currentIndex === "number" ? ` | current=${s.currentIndex + 1}` : ""),
  );
}

export async function antonStop(runtime: RuntimeEnv) {
  const s = await readState();
  if (!s.running) {
    runtime.log("Anton is not running.");
    return;
  }
  await writeState({ ...s, stopRequested: true });
  runtime.log("Anton stop requested. It will stop after current task.");
}

/** Load Anton config from the IdleHands config file. */
async function loadAntonConfig(): Promise<AntonConfig> {
  try {
    const { loadConfig } = await import("../config/config.js");
    const cfg = loadConfig();
    return (cfg as Record<string, unknown>).anton as AntonConfig ?? {};
  } catch {
    return {};
  }
}

// ─── Agent Execution Helper ─────────────────────────────────────────────────

async function runAgentTask(args: {
  message: string;
  sessionId: string;
  timeout: string;
  agent?: string;
  to?: string;
  runtime: RuntimeEnv;
  deps: CliDeps;
  workspaceDir?: string;
}) {
  const { agentCliCommand } = await import("./agent-via-gateway.js");
  const extraSystemPrompt = args.workspaceDir
    ? `Your working directory is: ${args.workspaceDir}\nAll file paths are relative to this directory. Use this as your cwd for all operations.`
    : undefined;
  await agentCliCommand(
    {
      message: args.message,
      agent: args.agent,
      to: args.to,
      sessionId: args.sessionId,
      timeout: args.timeout,
      json: false,
      deliver: false,
      extraSystemPrompt,
    },
    args.runtime,
    args.deps,
  );
}

// ─── Plan File Helpers ──────────────────────────────────────────────────────

function makePlanFilePath(planDir: string, taskIndex: number): string {
  return path.join(planDir, `task-${taskIndex}-${Date.now()}.md`);
}

async function ensurePlanDir(planDir: string) {
  await fs.mkdir(planDir, { recursive: true });
}

async function isPlanFileValid(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 10;
  } catch {
    return false;
  }
}

// ─── Discovery Phase ────────────────────────────────────────────────────────

async function runDiscoveryPhase(args: {
  task: ParsedTask;
  taskNum: number;
  total: number;
  taskFile: string;
  planDir: string;
  timeout: string;
  maxRetries: number;
  agent?: string;
  to?: string;
  runtime: RuntimeEnv;
  deps: CliDeps;
  notify: AntonProgressCallback;
  workspaceDir?: string;
}): Promise<{ status: "complete" | "plan_ready" | "failed"; planFile?: string; error?: string }> {
  const planFile = makePlanFilePath(args.planDir, args.taskNum);
  await ensurePlanDir(args.planDir);

  await args.notify({
    phase: "discovery_start",
    index: args.taskNum,
    total: args.total,
    task: args.task.text,
  });

  for (let attempt = 0; attempt <= args.maxRetries; attempt++) {
    const sessionId = `anton-discovery-${Date.now()}-${args.taskNum}-${attempt}`;
    try {
      await args.notify({
        phase: "task_agent_spawned",
        index: args.taskNum,
        total: args.total,
        task: `Discovery (attempt ${attempt + 1})`,
        sessionId,
      });

      await runAgentTask({
        message: buildDiscoveryPrompt(args.task.text, args.taskFile, planFile),
        sessionId,
        timeout: args.timeout,
        agent: args.agent,
        to: args.to,
        runtime: args.runtime,
        deps: args.deps,
        workspaceDir: args.workspaceDir,
      });

      // Check if the agent wrote a valid plan file
      if (await isPlanFileValid(planFile)) {
        await args.notify({
          phase: "discovery_complete",
          index: args.taskNum,
          total: args.total,
          task: args.task.text,
          planFile,
        });
        return { status: "plan_ready", planFile };
      }

      // Agent may have determined task is already complete (no plan file written)
      // We can't parse JSON from agent output easily, so if no plan file exists
      // and the agent completed without error, treat as potentially complete.
      // For safety, we'll still run implementation on it.
      if (attempt === args.maxRetries) {
        return { status: "failed", error: "Discovery did not produce a valid plan file" };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (attempt === args.maxRetries) {
        await args.notify({
          phase: "discovery_failed",
          index: args.taskNum,
          total: args.total,
          task: args.task.text,
          error: errorMsg,
        });
        return { status: "failed", error: errorMsg };
      }
    }
  }

  return { status: "failed", error: "Discovery exhausted retries" };
}

// ─── Review Phase ───────────────────────────────────────────────────────────

async function runReviewPhase(args: {
  task: ParsedTask;
  taskNum: number;
  total: number;
  planFile: string;
  timeout: string;
  agent?: string;
  to?: string;
  runtime: RuntimeEnv;
  deps: CliDeps;
  notify: AntonProgressCallback;
  workspaceDir?: string;
}): Promise<{ success: boolean; error?: string }> {
  await args.notify({
    phase: "review_start",
    index: args.taskNum,
    total: args.total,
    task: args.task.text,
    planFile: args.planFile,
  });

  const sessionId = `anton-review-${Date.now()}-${args.taskNum}`;
  try {
    await args.notify({
      phase: "task_agent_spawned",
      index: args.taskNum,
      total: args.total,
      task: "Requirements review",
      sessionId,
    });

    await runAgentTask({
      message: buildReviewPrompt(args.planFile),
      sessionId,
      timeout: args.timeout,
      agent: args.agent,
      to: args.to,
      runtime: args.runtime,
      deps: args.deps,
      workspaceDir: args.workspaceDir,
    });

    await args.notify({
      phase: "review_complete",
      index: args.taskNum,
      total: args.total,
      task: args.task.text,
      planFile: args.planFile,
    });
    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await args.notify({
      phase: "review_failed",
      index: args.taskNum,
      total: args.total,
      task: args.task.text,
      error: errorMsg,
    });
    return { success: false, error: errorMsg };
  }
}

// ─── Main Runner ────────────────────────────────────────────────────────────

export async function runAnton(args: {
  taskFile: string;
  runtime: RuntimeEnv;
  deps: CliDeps;
  agent?: string;
  to?: string;
  timeoutSec?: number;
  force?: boolean;
  dryRun?: boolean;
  onProgress?: AntonProgressCallback;
  /** Override config mode (takes precedence over config file). */
  mode?: "direct" | "preflight";
  /** Override workspace directory for spawned agents. */
  workspaceDir?: string;
}) {
  const filePath = path.resolve(args.taskFile);
  const raw = await fs.readFile(filePath, "utf8");
  const pending = parsePendingTasks(raw);
  const notify = args.onProgress ?? (async () => {});

  if (args.dryRun) {
    args.runtime.log(`Dry run: ${pending.length} pending task(s)`);
    for (const t of pending) {
      args.runtime.log(`- [ ] ${t.text}`);
    }
    return;
  }

  if (pending.length === 0) {
    args.runtime.log("No pending tasks.");
    await notify({ phase: "finish", completed: 0, skipped: 0, total: 0, durationMs: 0 });
    return;
  }

  // Load config
  const antonCfg = await loadAntonConfig();
  const mode = args.mode ?? antonCfg.mode ?? "direct";
  const requirementsReview = antonCfg.requirementsReview ?? false;
  const taskTimeout = antonCfg.taskTimeoutSec ?? 1200;
  const discoveryTimeout = antonCfg.discoveryTimeoutSec ?? taskTimeout;
  const reviewTimeout = antonCfg.reviewTimeoutSec ?? taskTimeout;
  const preflightMaxRetries = antonCfg.preflightMaxRetries ?? 2;
  const planDir = antonCfg.planDir
    ? path.resolve(antonCfg.planDir)
    : path.resolve(path.dirname(filePath), ".agents", "tasks");

  const { loadConfig } = await import("../config/config.js");
  const cfg = loadConfig();
  const defaultTimeout = String(
    Number.isFinite(args.timeoutSec) && (args.timeoutSec ?? 0) > 0
      ? args.timeoutSec
      : cfg.agents?.defaults?.timeoutSeconds ?? taskTimeout,
  );

  await acquireLock(Boolean(args.force));
  const startedAt = Date.now();
  await writeState({
    running: true,
    taskFile: filePath,
    startedAt: new Date(startedAt).toISOString(),
    currentIndex: 0,
    total: pending.length,
    completed: 0,
    skipped: 0,
    stopRequested: false,
  });

  await notify({ phase: "start", taskFile: filePath, totalTasks: pending.length });
  args.runtime.log(`[Anton] Mode: ${mode}${mode === "preflight" ? (requirementsReview ? " (with review)" : " (discovery → implementation)") : ""}`);

  let completed = 0;
  let skipped = 0;

  try {
    for (let i = 0; i < pending.length; i++) {
      if (await shouldStop()) {
        args.runtime.log("Anton stop acknowledged.");
        await notify({ phase: "stopped", completedSoFar: completed, total: pending.length });
        break;
      }

      const task = pending[i];
      if (!task) { continue; }
      const taskNum = i + 1;

      await writeState({
        running: true,
        taskFile: filePath,
        startedAt: new Date(startedAt).toISOString(),
        currentIndex: i,
        total: pending.length,
        completed,
        skipped,
        stopRequested: false,
      });

      args.runtime.log(`\n[Anton] Task ${taskNum}/${pending.length}: ${task.text}`);
      await notify({ phase: "task_start", index: taskNum, total: pending.length, task: task.text });

      try {
        let planFile: string | undefined;

        if (mode === "preflight") {
          // ── Phase 1: Discovery ──
          const discoveryResult = await runDiscoveryPhase({
            task,
            taskNum,
            total: pending.length,
            taskFile: filePath,
            planDir,
            timeout: String(discoveryTimeout),
            maxRetries: preflightMaxRetries,
            agent: args.agent,
            to: args.to,
            runtime: args.runtime,
            deps: args.deps,
            notify,
            workspaceDir: args.workspaceDir,
          });

          if (discoveryResult.status === "complete") {
            // Task already done — mark and continue
            await notify({
              phase: "discovery_already_complete",
              index: taskNum,
              total: pending.length,
              task: task.text,
            });
            const latest = await fs.readFile(filePath, "utf8");
            const updated = markTaskDone(latest, task.line);
            await fs.writeFile(filePath, updated, "utf8");
            completed += 1;
            await notify({ phase: "task_complete", index: taskNum, total: pending.length, task: task.text });
            continue;
          }

          if (discoveryResult.status === "plan_ready" && discoveryResult.planFile) {
            planFile = discoveryResult.planFile;

            // ── Phase 1.5: Requirements Review (optional) ──
            if (requirementsReview) {
              await runReviewPhase({
                task,
                taskNum,
                total: pending.length,
                planFile,
                timeout: String(reviewTimeout),
                agent: args.agent,
                to: args.to,
                runtime: args.runtime,
                deps: args.deps,
                notify,
                workspaceDir: args.workspaceDir,
              });
              // Review failure is non-fatal — we proceed with the unreviewed plan
            }
          }
          // If discovery failed, planFile is undefined → fall through to direct execution
        }

        // ── Phase 2: Implementation ──
        await notify({
          phase: "implementation_start",
          index: taskNum,
          total: pending.length,
          task: task.text,
          planFile,
        });

        const implSessionId = `anton-impl-${Date.now()}-${taskNum}`;
        await notify({
          phase: "task_agent_spawned",
          index: taskNum,
          total: pending.length,
          task: task.text,
          sessionId: implSessionId,
        });

        const implPrompt = planFile
          ? buildImplementationPrompt(task.text, planFile)
          : buildDirectTaskPrompt(task.text);

        await runAgentTask({
          message: implPrompt,
          sessionId: implSessionId,
          timeout: defaultTimeout,
          agent: args.agent,
          to: args.to,
          runtime: args.runtime,
          deps: args.deps,
          workspaceDir: args.workspaceDir,
        });

        const latest = await fs.readFile(filePath, "utf8");
        const updated = markTaskDone(latest, task.line);
        await fs.writeFile(filePath, updated, "utf8");
        completed += 1;

        await notify({ phase: "task_complete", index: taskNum, total: pending.length, task: task.text });
      } catch (err) {
        skipped += 1;
        const errorMsg = err instanceof Error ? err.message : String(err);
        args.runtime.error(`[Anton] Task failed and was skipped: ${task.text}`);
        args.runtime.error(errorMsg);
        await notify({
          phase: "task_failed",
          index: taskNum,
          total: pending.length,
          task: task.text,
          error: errorMsg,
        });
      }
    }

    const durationMs = Date.now() - startedAt;
    const summary = `Anton finished: completed=${completed}, skipped=${skipped}, total=${pending.length}, duration=${formatDuration(durationMs)}`;
    await writeState({
      running: false,
      taskFile: filePath,
      startedAt: new Date(startedAt).toISOString(),
      total: pending.length,
      completed,
      skipped,
      lastSummary: summary,
      stopRequested: false,
    });
    args.runtime.log(`\n${summary}`);
    await notify({ phase: "finish", completed, skipped, total: pending.length, durationMs });
  } finally {
    await releaseLock();
  }
}
