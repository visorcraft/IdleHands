/**
 * /anton command handler — autonomous task execution from chat surfaces.
 *
 *   /anton <taskFile>   → start orchestrator
 *   /anton status       → show progress
 *   /anton stop         → request stop after current task
 */

import type { OriginatingChannelType } from "../templating.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
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

  const canRoute = isRoutableChannel(channel);
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
    const text = lines.join("\n") || "Anton is idle.";
    if (!canRoute) {
      return { shouldContinue: false, reply: { text } };
    }
    await sendProgress(replyCtx, text);
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
    const text = lines.join("\n") || "Stop requested.";
    if (!canRoute) {
      return { shouldContinue: false, reply: { text } };
    }
    await sendProgress(replyCtx, text);
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
      const text = `❌ Not a file: \`${resolvedPath}\``;
      if (!canRoute) {
        return { shouldContinue: false, reply: { text } };
      }
      await sendProgress(replyCtx, text);
      return { shouldContinue: false };
    }
  } catch {
    const text = `❌ File not found: \`${resolvedPath}\``;
    if (!canRoute) {
      return { shouldContinue: false, reply: { text } };
    }
    await sendProgress(replyCtx, text);
    return { shouldContinue: false };
  }

  // Import Anton and its progress formatter
  const { runAnton, formatProgressMessage } = await import("../../commands/anton.js");
  const { createDefaultDeps } = await import("../../cli/deps.js");
  const { createNonExitingRuntime } = await import("../../runtime.js");

  const runtime = createNonExitingRuntime();
  const deps = createDefaultDeps();

  // Send initial acknowledgement
  const startText = `🤚 **/anton** invoked on \`${pathMod.basename(resolvedPath)}\`\nStarting orchestrator...`;
  if (canRoute) {
    await sendProgress(replyCtx, startText);
  }

  // Run Anton in background with progress pushed to chat (routable channels only)
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
        ...(canRoute
          ? {
              onProgress: async (event) => {
                const message = formatProgressMessage(event);
                await sendProgress(replyCtx, message);
              },
            }
          : {}),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (canRoute) {
        await sendProgress(replyCtx, `❌ **Anton crashed**: ${msg}`);
      }
    }
  })();

  return canRoute ? { shouldContinue: false } : { shouldContinue: false, reply: { text: startText } };
};
