import type { Message } from 'discord.js';

import { formatMarkdown } from './command-format.js';
import { antonCommand, type ManagedLike } from './command-logic.js';
import type { DiscordCommandContext } from './discord-commands.js';
import type { ManagedSession } from './discord.js';

const DISCORD_RATE_LIMIT_MS = 3_000;

/** Handle `/anton ...` command flow for Discord, including heartbeat edits. */
export async function handleDiscordAnton(
  managed: ManagedSession,
  msg: Message,
  content: string,
  ctx: Pick<DiscordCommandContext, 'sendUserVisible'>
): Promise<void> {
  const { sendUserVisible } = ctx;
  const args = content.replace(/^\/anton\s*/, '').trim();
  const m = managed as unknown as ManagedLike;
  const channel = msg.channel as { send: (c: string) => Promise<any> };

  let antonStatusMsg: { edit: (content: string) => Promise<any> } | null = null;
  let antonStatusLastText = '';

  const result = await antonCommand(
    m,
    args,
    (t) => {
      const isStatusUpdate = t.startsWith('⏳ Still working:');

      if (!isStatusUpdate) {
        antonStatusMsg = null;
        antonStatusLastText = '';
        channel.send(t).catch(() => {});
        return;
      }

      if (t === antonStatusLastText) return;
      antonStatusLastText = t;

      if (antonStatusMsg) {
        antonStatusMsg.edit(t).catch(() => {
          channel
            .send(t)
            .then((m: any) => {
              antonStatusMsg = m;
            })
            .catch(() => {});
        });
        return;
      }

      channel
        .send(t)
        .then((m: any) => {
          antonStatusMsg = m;
        })
        .catch(() => {});
    },
    DISCORD_RATE_LIMIT_MS
  );

  const text = formatMarkdown(result);
  if (text) await sendUserVisible(msg, text).catch(() => {});
}
