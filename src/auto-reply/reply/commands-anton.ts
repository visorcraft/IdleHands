/**
 * /anton command handler — autonomous task execution from chat surfaces.
 *
 *   /anton <taskFile>   → start orchestrator
 *   /anton status       → show progress
 *   /anton stop         → request stop after current task
 */

import type { OriginatingChannelType } from "../templating.js";
import { routeReply } from "./route-reply.js";
import type { CommandHandler, CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";

async function sendProgress(
  params: {
    channel: OriginatingChannelType;
    to: string;
    sessionKey: string;
    accountId?: string;
    threadId?: string | number;
    cfg: Parameters<typeof routeReply>[0]["cfg"];
  },
  text: string,
) {
  await routeReply({
    payload: { text },
    channel: params.channel,
    to: params.to,
    sessionKey: params.sessionKey,
    accountId: params.accountId,
    threadId: params.threadId,
    cfg: params.cfg,
  });
}

export const handleAntonCommand: CommandHandler = async (
  params: HandleCommandsParams,
  _allowTextCommands: boolean,
): Promise<CommandHandlerResult | null> => {
  const body = params.command.commandBodyNormalized;
  if (!body.startsWith("/anton")) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    return { shouldContinue: false };
  }

  const channel: OriginatingChannelType =
    params.ctx.OriginatingChannel ?? (params.command.channel as OriginatingChannelType);
  const to: string =
    params.ctx.OriginatingTo ?? params.command.from ?? params.command.to ?? "";

  const replyCtx = {
    channel,
    to,
    sessionKey: params.sessionKey,
    accountId: params.ctx.AccountId,
    threadId: params.ctx.MessageThreadId,
    cfg: params.cfg,
  };

  const arg = body.slice("/anton".length).trim();

  // /anton status
  if (arg === "status" || arg === "") {
    const { antonStatus } = await import("../../commands/anton.js");
    const lines: string[] = [];
    const mockRuntime = {
      log: (msg: string) => lines.push(msg),
      error: (msg: string) => lines.push(msg),
      exit: () => {},
    } as unknown as Parameters<typeof antonStatus>[0];
    await antonStatus(mockRuntime);
    await sendProgress(replyCtx, lines.join("\n") || "Anton is idle.");
    return { shouldContinue: false };
  }

  // /anton stop
  if (arg === "stop") {
    const { antonStop } = await import("../../commands/anton.js");
    const lines: string[] = [];
    const mockRuntime = {
      log: (msg: string) => lines.push(msg),
      error: (msg: string) => lines.push(msg),
      exit: () => {},
    } as unknown as Parameters<typeof antonStop>[0];
    await antonStop(mockRuntime);
    await sendProgress(replyCtx, lines.join("\n") || "Stop requested.");
    return { shouldContinue: false };
  }

  // /anton <taskFile> — start the orchestrator
  const taskFile = arg;

  // Resolve relative to workspace
  const fs = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const resolvedPath = pathMod.resolve(params.workspaceDir || process.cwd(), taskFile);

  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      await sendProgress(replyCtx, `❌ Not a file: \`${resolvedPath}\``);
      return { shouldContinue: false };
    }
  } catch {
    await sendProgress(replyCtx, `❌ File not found: \`${resolvedPath}\``);
    return { shouldContinue: false };
  }

  // Import Anton and its progress formatter
  const { runAnton, formatProgressMessage } = await import("../../commands/anton.js");
  const { createDefaultDeps } = await import("../../cli/deps.js");
  const { createNonExitingRuntime } = await import("../../runtime.js");

  const runtime = createNonExitingRuntime();
  const deps = createDefaultDeps();

  // Send initial acknowledgement
  await sendProgress(replyCtx, `🤚 **/anton** invoked on \`${pathMod.basename(resolvedPath)}\`\nStarting orchestrator...`);

  // Run Anton in background with progress pushed to chat
  // We don't await this — it runs asynchronously and sends updates as it goes
  (async () => {
    try {
      await runAnton({
        taskFile: resolvedPath,
        runtime,
        deps,
        force: false,
        dryRun: false,
        workspaceDir: params.workspaceDir || undefined,
        onProgress: async (event) => {
          const message = formatProgressMessage(event);
          await sendProgress(replyCtx, message);
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await sendProgress(replyCtx, `❌ **Anton crashed**: ${msg}`);
    }
  })();

  return { shouldContinue: false };
};
