/**
 * /upgrade command handler — self-upgrade IdleHands from GitHub/npm.
 *
 * Works on Telegram, Discord, and TUI surfaces.
 */

import type { OriginatingChannelType } from "../templating.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";
import { routeReply } from "./route-reply.js";

export const handleUpgradeCommand: CommandHandler = async (
  params: HandleCommandsParams,
  _allowTextCommands: boolean,
): Promise<CommandHandlerResult | null> => {
  const body = params.command.commandBodyNormalized;
  if (!body.startsWith("/upgrade")) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    return { shouldContinue: false };
  }

  // Dynamic import to avoid loading upgrade machinery at boot
  const { performBotUpgrade } = await import("../../bot/upgrade-command.js");

  const channel: OriginatingChannelType =
    params.ctx.OriginatingChannel ?? (params.command.channel as OriginatingChannelType);
  const to: string = params.ctx.OriginatingTo ?? params.command.from ?? params.command.to ?? "";

  // Send initial status
  await routeReply({
    payload: { text: "🔄 Starting upgrade..." },
    channel,
    to,
    sessionKey: params.sessionKey,
    accountId: params.ctx.AccountId,
    threadId: params.ctx.MessageThreadId,
    cfg: params.cfg,
  });

  const progressLines: string[] = [];

  const result = await performBotUpgrade(async (message: string) => {
    progressLines.push(message);
  });

  // Send final result with all progress
  const finalText =
    progressLines.length > 0 ? `${progressLines.join("\n")}\n\n${result.message}` : result.message;

  await routeReply({
    payload: { text: finalText },
    channel,
    to,
    sessionKey: params.sessionKey,
    accountId: params.ctx.AccountId,
    threadId: params.ctx.MessageThreadId,
    cfg: params.cfg,
  });

  return { shouldContinue: false };
};
