import type { Message } from 'discord.js';

import { formatMarkdown } from './command-format.js';
import type { CmdResult } from './command-logic.js';

/** Render and deliver a structured command result to Discord. */
export async function sendDiscordResult(
  msg: Message,
  sendUserVisible: (msg: Message, text: string) => Promise<Message>,
  res: CmdResult
): Promise<void> {
  const text = formatMarkdown(res);
  if (!text) return;
  await sendUserVisible(msg, text).catch(() => {});
}
