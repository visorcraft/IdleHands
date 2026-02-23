import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type Message,
  type TextBasedChannel,
} from 'discord.js';

import type {
  ConfirmationProvider,
  ConfirmRequest,
  ConfirmPlanRequest,
  PlanDecision,
  BlockedNotice,
} from '../types.js';

const MAX_DIFF_CHARS = 1800;

export class DiscordConfirmProvider implements ConfirmationProvider {
  private seq = 0;

  constructor(
    private channel: TextBasedChannel,
    private userId: string,
    private timeoutSec: number = 300
  ) {}

  private async send(payload: string | { content: string; components?: any[] }): Promise<Message> {
    return await (this.channel as any).send(payload);
  }

  async confirm(opts: ConfirmRequest): Promise<boolean> {
    const id = this.nextId('c');
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${id}:approve`)
        .setLabel('✅ Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${id}:reject`)
        .setLabel('❌ Reject')
        .setStyle(ButtonStyle.Danger),
      ...(opts.diff
        ? [
            new ButtonBuilder()
              .setCustomId(`${id}:diff`)
              .setLabel('📋 Diff')
              .setStyle(ButtonStyle.Secondary),
          ]
        : [])
    );

    const message = await this.send({
      content: [
        `🔧 **Agent requests approval**`,
        `**Action:** \`${opts.tool}\``,
        `**Summary:** ${opts.summary}`,
      ].join('\n'),
      components: [row],
    });

    const deadline = Date.now() + this.timeoutSec * 1000;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await this.safeEdit(message, {
          content: `🔧 **Timed out — rejected**\n${opts.summary}`,
          components: [],
        });
        return false;
      }

      try {
        const interaction = await message.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: remaining,
          filter: (i: any) => i.user.id === this.userId && i.customId.startsWith(`${id}:`),
        });

        const action = interaction.customId.slice(id.length + 1);

        if (action === 'diff') {
          const diff = opts.diff?.slice(0, MAX_DIFF_CHARS) ?? '(no diff)';
          await interaction
            .reply({
              content: `\`\`\`diff\n${diff}\n\`\`\``,
              ephemeral: true,
            })
            .catch(() => {});
          continue;
        }

        const approved = action === 'approve';
        await interaction
          .update({
            content: `🔧 **Action ${approved ? 'approved' : 'rejected'}**\n${opts.summary}`,
            components: [],
          })
          .catch(() => {});
        return approved;
      } catch {
        await this.safeEdit(message, {
          content: `🔧 **Timed out — rejected**\n${opts.summary}`,
          components: [],
        });
        return false;
      }
    }
  }

  async confirmPlan(opts: ConfirmPlanRequest): Promise<PlanDecision[]> {
    const id = this.nextId('p');

    const lines = [
      `📋 **Plan approval requested**`,
      ...opts.steps.map((s, i) => `${i + 1}. ${s.summary}`),
    ];

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${id}:all-approve`)
        .setLabel('✅ Approve All')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${id}:all-reject`)
        .setLabel('❌ Reject All')
        .setStyle(ButtonStyle.Danger)
    );

    const stepButtons = opts.steps.slice(0, 5).map((_, i) =>
      new ButtonBuilder()
        .setCustomId(`${id}:step-${i}`)
        .setLabel(`▶ #${i + 1}`)
        .setStyle(ButtonStyle.Secondary)
    );

    const rows = [row1] as ActionRowBuilder<ButtonBuilder>[];
    if (stepButtons.length > 0) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...stepButtons));
    }

    const message = await this.send({ content: lines.join('\n'), components: rows });

    try {
      const interaction = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: this.timeoutSec * 1000,
        filter: (i: any) => i.user.id === this.userId && i.customId.startsWith(`${id}:`),
      });

      const action = interaction.customId.slice(id.length + 1);
      let decisions: PlanDecision[];
      if (action === 'all-approve') {
        decisions = opts.steps.map((_, i) => ({ index: i, approved: true }));
      } else if (action === 'all-reject') {
        decisions = opts.steps.map((_, i) => ({ index: i, approved: false }));
      } else if (action.startsWith('step-')) {
        const idx = Number(action.slice('step-'.length));
        decisions = opts.steps.map((_, i) => ({ index: i, approved: i === idx }));
      } else {
        decisions = opts.steps.map((_, i) => ({ index: i, approved: false }));
      }

      const approvedCount = decisions.filter((d) => d.approved).length;
      await interaction
        .update({
          content: `📋 **Plan resolved** — approved ${approvedCount}/${opts.steps.length} step(s).`,
          components: [],
        })
        .catch(() => {});

      return decisions;
    } catch {
      await this.safeEdit(message, {
        content: `📋 **Timed out — rejected all**`,
        components: [],
      });
      return opts.steps.map((_, i) => ({ index: i, approved: false }));
    }
  }

  async showBlocked(opts: BlockedNotice): Promise<void> {
    await this.send(`🚫 Blocked: \`${opts.tool}\` — ${opts.reason}`).catch(() => {});
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq.toString(16).padStart(4, '0')}`;
  }

  private async safeEdit(
    message: Message,
    payload: { content: string; components: [] }
  ): Promise<void> {
    await message.edit(payload).catch(() => {});
  }
}
