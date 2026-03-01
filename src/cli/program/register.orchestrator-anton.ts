import type { Command } from "commander";
import { antonStatus, antonStop, runAnton } from "../../commands/anton.js";
import {
  orchestratorApply,
  orchestratorInit,
  orchestratorPlan,
  orchestratorStatus,
} from "../../commands/orchestrator.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { createDefaultDeps } from "../deps.js";

export function registerOrchestratorAntonCommands(program: Command) {
  const orchestrator = program
    .command("orchestrator")
    .description("Runtime orchestrator (host/backend/model planning + apply)");

  orchestrator
    .command("init")
    .description("Create orchestrator runtime config template")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await orchestratorInit(defaultRuntime);
      });
    });

  orchestrator
    .command("status")
    .description("Show active orchestrator runtime state")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await orchestratorStatus(defaultRuntime);
      });
    });

  orchestrator
    .command("plan")
    .description("Plan runtime actions for a model")
    .requiredOption("--model <id>", "Model id")
    .option("--host <id>", "Host override")
    .option("--backend <id>", "Backend override")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const out = await orchestratorPlan({
          modelId: opts.model,
          host: opts.host,
          backend: opts.backend,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(out, null, 2));
          return;
        }
        defaultRuntime.log(
          `model=${out.model.id} host=${out.host.id} backend=${out.backend?.id ?? "none"}`,
        );
        for (const step of out.steps) {
          defaultRuntime.log(`- [${step.kind}] ${step.command}`);
        }
      });
    });

  orchestrator
    .command("apply")
    .description("Apply runtime plan for a model")
    .requiredOption("--model <id>", "Model id")
    .option("--host <id>", "Host override")
    .option("--backend <id>", "Backend override")
    .option("--force", "Force lock takeover", false)
    .option("--dry-run", "Print plan only", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await orchestratorApply({
          modelId: opts.model,
          host: opts.host,
          backend: opts.backend,
          force: Boolean(opts.force),
          dryRun: Boolean(opts.dryRun),
          runtime: defaultRuntime,
        });
      });
    });

  const anton = program.command("anton").description("Autonomous markdown checklist runner");

  anton
    .command("run <taskFile>")
    .description("Run pending tasks from a markdown checklist file")
    .option("--agent <id>", "Agent id")
    .option("--to <e164>", "Session routing recipient")
    .option("--timeout <seconds>", "Per-task timeout in seconds")
    .option("--mode <mode>", "Execution mode: direct or preflight", undefined)
    .option("--force", "Force lock takeover", false)
    .option("--dry-run", "Show tasks only", false)
    .action(async (taskFile, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const deps = createDefaultDeps();
        const timeoutSec = opts.timeout ? Number.parseInt(String(opts.timeout), 10) : undefined;
        await runAnton({
          taskFile,
          runtime: defaultRuntime,
          deps,
          agent: opts.agent,
          to: opts.to,
          timeoutSec,
          force: Boolean(opts.force),
          dryRun: Boolean(opts.dryRun),
          mode: opts.mode,
        });
      });
    });

  anton
    .command("status")
    .description("Show Anton run status")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await antonStatus(defaultRuntime);
      });
    });

  anton
    .command("stop")
    .description("Request stop for active Anton run")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await antonStop(defaultRuntime);
      });
    });
}
