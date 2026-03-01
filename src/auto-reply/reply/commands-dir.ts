/**
 * /dir command handler — view or change the agent workspace directory.
 *
 *   /dir            → print current workspace
 *   /dir /some/path → set workspace to /some/path
 */

import type { OriginatingChannelType } from "../templating.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

export const handleDirCommand: CommandHandler = async (
  params: HandleCommandsParams,
  _allowTextCommands: boolean,
): Promise<CommandHandlerResult | null> => {
  const body = params.command.commandBodyNormalized;
  if (!body.startsWith("/dir")) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    return { shouldContinue: false };
  }

  const channel: OriginatingChannelType =
    params.ctx.OriginatingChannel ?? (params.command.channel as OriginatingChannelType);
  const to: string = params.ctx.OriginatingTo ?? params.command.from ?? params.command.to ?? "";

  const arg = body.slice("/dir".length).trim();
  const canRoute = isRoutableChannel(channel);

  if (!arg) {
    // Print current workspace
    const currentDir = params.workspaceDir || "(not set)";
    const text = `📂 Current workspace: \`${currentDir}\``;
    if (!canRoute) {
      return { shouldContinue: false, reply: { text } };
    }
    await routeReply({
      payload: { text },
      channel,
      to,
      sessionKey: params.sessionKey,
      accountId: params.ctx.AccountId,
      threadId: params.ctx.MessageThreadId,
      cfg: params.cfg,
    });
    return { shouldContinue: false };
  }

  // Set new workspace
  const newPath = arg;

  // Validate the path exists
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const resolved = path.resolve(newPath);

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      const text = `❌ Path exists but is not a directory: \`${resolved}\``;
      if (!canRoute) {
        return { shouldContinue: false, reply: { text } };
      }
      await routeReply({
        payload: { text },
        channel,
        to,
        sessionKey: params.sessionKey,
        accountId: params.ctx.AccountId,
        threadId: params.ctx.MessageThreadId,
        cfg: params.cfg,
      });
      return { shouldContinue: false };
    }
  } catch {
    const text = `❌ Directory not found: \`${resolved}\``;
    if (!canRoute) {
      return { shouldContinue: false, reply: { text } };
    }
    await routeReply({
      payload: { text },
      channel,
      to,
      sessionKey: params.sessionKey,
      accountId: params.ctx.AccountId,
      threadId: params.ctx.MessageThreadId,
      cfg: params.cfg,
    });
    return { shouldContinue: false };
  }

  // Update the live session entry (session-scoped only — does NOT touch config file)
  try {
    if (params.sessionKey) {
      const { updateSessionStoreEntry } = await import("../../config/sessions/store.js");
      const { resolveDefaultSessionStorePath } = await import("../../config/sessions/paths.js");
      const storePath = params.storePath ?? resolveDefaultSessionStorePath();
      await updateSessionStoreEntry({
        storePath,
        sessionKey: params.sessionKey,
        update: async () => ({ workspaceDir: resolved }),
      });
    }
    // Update in-memory params so subsequent commands in the same turn see the new dir
    (params as { workspaceDir: string }).workspaceDir = resolved;

    const text = `✅ Workspace set to: \`${resolved}\`\nActive for this session only.`;
    if (!canRoute) {
      return { shouldContinue: false, reply: { text } };
    }
    await routeReply({
      payload: { text },
      channel,
      to,
      sessionKey: params.sessionKey,
      accountId: params.ctx.AccountId,
      threadId: params.ctx.MessageThreadId,
      cfg: params.cfg,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const text = `❌ Failed to update workspace: ${msg}`;
    if (!canRoute) {
      return { shouldContinue: false, reply: { text } };
    }
    await routeReply({
      payload: { text },
      channel,
      to,
      sessionKey: params.sessionKey,
      accountId: params.ctx.AccountId,
      threadId: params.ctx.MessageThreadId,
      cfg: params.cfg,
    });
  }

  return { shouldContinue: false };
};
