/**
 * TelegramConfirmProvider — inline-button confirmations for bot frontend.
 *
 * Supports:
 * - Single-action confirm() with ✅/❌/📋 buttons
 * - Plan confirmations (approve/reject all, approve single step)
 * - Timeout auto-reject
 * - Idempotent callback handling (ignore duplicates)
 * - Action dispatching for retry_fast, retry_heavy, cancel, etc.
 */

import type { Bot } from 'grammy';

import type {
  ConfirmationProvider,
  ConfirmRequest,
  ConfirmPlanRequest,
  PlanDecision,
  BlockedNotice,
} from '../types.js';
import { randomId } from '../utils.js';

import { escapeHtml } from './format.js';

/**
 * Action callback handler signature for handling interactive actions.
 * Allows the provider to delegate action handling to a shared dispatcher.
 */
export type ActionCallbackHandler = (actionType: string, data: string) => Promise<boolean>;

type PendingSingle = {
  kind: 'single';
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  messageId: number;
  settled: boolean;
  opts: ConfirmRequest;
};

type PendingPlan = {
  kind: 'plan';
  resolve: (decisions: PlanDecision[]) => void;
  timer: ReturnType<typeof setTimeout>;
  messageId: number;
  settled: boolean;
  req: ConfirmPlanRequest;
};

type BatchItem = {
  opts: ConfirmRequest;
  resolve: (approved: boolean) => void;
};

type PendingBatch = {
  kind: 'batch';
  items: BatchItem[];
  timer: ReturnType<typeof setTimeout>;
  messageId: number;
  settled: boolean;
  decisions: Map<number, boolean>; // per-item toggle state
};

export class TelegramConfirmProvider implements ConfirmationProvider {
  private readonly sid: string;
  private seq = 0;
  private pending = new Map<string, PendingSingle | PendingPlan | PendingBatch>();

  // Batching: buffer confirm() calls that arrive within a short window
  private batchQueue: BatchItem[] = [];
  private batchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly BATCH_WINDOW_MS = 100;

  // Optional action handler for shared action dispatch
  private actionHandler?: ActionCallbackHandler;

  constructor(
    private bot: Bot,
    private chatId: number,
    private timeoutSec: number = 300,
    actionHandler?: ActionCallbackHandler
  ) {
    this.sid = randomId(3);
    this.actionHandler = actionHandler;
  }

  /**
   * Set the action handler for delegated action processing.
   */
  setActionHandler(handler: ActionCallbackHandler): void {
    this.actionHandler = handler;
  }

  async confirm(opts: ConfirmRequest): Promise<boolean> {
    // Buffer into batch queue; flush after a short window
    return new Promise<boolean>((resolve) => {
      this.batchQueue.push({ opts, resolve });
      if (!this.batchFlushTimer) {
        this.batchFlushTimer = setTimeout(
          () => this.flushBatch(),
          TelegramConfirmProvider.BATCH_WINDOW_MS
        );
      }
    });
  }

  private async flushBatch(): Promise<void> {
    this.batchFlushTimer = null;
    const items = this.batchQueue.splice(0);
    if (items.length === 0) return;
    if (items.length === 1) {
      // Single item — send as individual confirmation
      await this.confirmSingle(items[0].opts, items[0].resolve);
      return;
    }
    // Multiple items — send as batched confirmation
    await this.confirmBatched(items);
  }

  private async confirmSingle(
    opts: ConfirmRequest,
    resolve: (approved: boolean) => void
  ): Promise<void> {
    const aid = this.nextId();
    const title = `🔧 Agent requests approval`;
    const body = [
      `<b>${escapeHtml(title)}</b>`,
      '',
      `<b>Action:</b> <code>${escapeHtml(opts.tool || 'action')}</code>`,
      `<b>Summary:</b> ${escapeHtml(opts.summary)}`,
    ];
    if (opts.diff) {
      body.push('', '<i>Diff available via 📋 Diff</i>');
    }

    const msg = await this.bot.api.sendMessage(this.chatId, body.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: this.cb('c', aid, 'a') },
            { text: '❌ Reject', callback_data: this.cb('c', aid, 'r') },
            ...(opts.diff ? [{ text: '📋 Diff', callback_data: this.cb('c', aid, 'd') }] : []),
          ],
        ],
      },
    });

    const timer = setTimeout(async () => {
      const p = this.pending.get(aid);
      if (!p || p.settled) return;
      p.settled = true;
      this.pending.delete(aid);
      await this.safeEdit(msg.message_id, `${body.join('\n')}\n\n⏱ <i>Timed out — rejected</i>`);
      resolve(false);
    }, this.timeoutSec * 1000);

    this.pending.set(aid, {
      kind: 'single',
      resolve,
      timer,
      messageId: msg.message_id,
      settled: false,
      opts,
    });
  }

  /** Send batched confirmation message for multiple actions. */
  private async confirmBatched(items: BatchItem[]): Promise<void> {
    const aid = this.nextId();
    const icons: Record<string, string> = {
      edit_file: '✎',
      write_file: '✎',
      insert_file: '✎',
      exec: '▶',
      default: '◆',
    };
    const lines = [
      `<b>🔧 Agent wants to make ${items.length} changes:</b>`,
      '',
      ...items.map((it, i) => {
        const icon = icons[it.opts.tool] ?? icons.default;
        return `${i + 1}. ${icon} <code>${escapeHtml(it.opts.tool)}</code>: ${escapeHtml(it.opts.summary)}`;
      }),
    ];

    // Per-item toggle buttons (up to 8 items per row, Telegram max)
    const itemButtons = items.slice(0, 8).map((_, i) => ({
      text: `${i + 1}️⃣`,
      callback_data: this.cb('b', aid, `t${i}`),
    }));

    const msg = await this.bot.api.sendMessage(this.chatId, lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve All', callback_data: this.cb('b', aid, 'aa') },
            { text: '❌ Reject All', callback_data: this.cb('b', aid, 'ra') },
          ],
          itemButtons,
        ],
      },
    });

    const timer = setTimeout(async () => {
      const p = this.pending.get(aid);
      if (!p || p.settled) return;
      p.settled = true;
      this.pending.delete(aid);
      await this.safeEdit(
        msg.message_id,
        `${lines.join('\n')}\n\n⏱ <i>Timed out — rejected all</i>`
      );
      for (const it of items) it.resolve(false);
    }, this.timeoutSec * 1000);

    this.pending.set(aid, {
      kind: 'batch',
      items,
      timer,
      messageId: msg.message_id,
      settled: false,
      decisions: new Map(),
    });
  }

  async confirmPlan(opts: ConfirmPlanRequest): Promise<PlanDecision[]> {
    const aid = this.nextId();
    const lines = [
      `<b>📋 Plan approval requested</b>`,
      '',
      ...opts.steps.map((s, i) => `${i + 1}. ${escapeHtml(s.summary)}`),
    ];

    const msg = await this.bot.api.sendMessage(this.chatId, lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve All', callback_data: this.cb('p', aid, 'aa') },
            { text: '❌ Reject All', callback_data: this.cb('p', aid, 'ra') },
          ],
          opts.steps.length > 0
            ? opts.steps.slice(0, 5).map((_, i) => ({
                text: `▶️ #${i + 1}`,
                callback_data: this.cb('p', aid, `s${i + 1}`),
              }))
            : [{ text: '—', callback_data: this.cb('p', aid, 'ra') }],
        ],
      },
    });

    return await new Promise<PlanDecision[]>((resolve) => {
      const timer = setTimeout(async () => {
        const p = this.pending.get(aid);
        if (!p || p.settled) return;
        p.settled = true;
        this.pending.delete(aid);
        await this.safeEdit(
          msg.message_id,
          `${lines.join('\n')}\n\n⏱ <i>Timed out — rejected all</i>`
        );
        resolve(opts.steps.map((_, i) => ({ index: i, approved: false })));
      }, this.timeoutSec * 1000);

      this.pending.set(aid, {
        kind: 'plan',
        resolve,
        timer,
        messageId: msg.message_id,
        settled: false,
        req: opts,
      });
    });
  }

  async showBlocked(opts: BlockedNotice): Promise<void> {
    await this.bot.api
      .sendMessage(
        this.chatId,
        `🚫 Blocked: <code>${escapeHtml(opts.tool)}</code> — ${escapeHtml(opts.reason)}`,
        {
          parse_mode: 'HTML',
        }
      )
      .catch(() => {});
  }

  /** Handle callback query data. Returns true if handled by this provider. */
  async handleCallback(data: string): Promise<boolean> {
    // First, check for action callbacks (action:<type>)
    if (data.startsWith('action:')) {
      const actionType = data.slice('action:'.length);
      if (this.actionHandler) {
        // For action callbacks, the handler returns a boolean indicating if handled
        const handled = await this.actionHandler(actionType, data);
        if (handled) {
          return true;
        }
      }
      // Fall through to default handling if no action handler or not handled
      // But for action callbacks, we should return true to prevent the "Unknown action" message
      return true;
    }

    // Format: c:<sid>:<aid>:a|r|d OR p:<sid>:<aid>:aa|ra|sN
    const parts = data.split(':');
    if (parts.length !== 4) return false;
    const [kind, sid, aid, action] = parts;
    if (sid !== this.sid) return false;

    const pending = this.pending.get(aid);
    if (!pending) return false;
    if (pending.settled) return true; // idempotent ignore duplicate taps

    if (pending.kind === 'single' && kind === 'c') {
      if (action === 'd') {
        if (pending.opts.diff) {
          await this.bot.api
            .sendMessage(
              this.chatId,
              `<pre>${escapeHtml(pending.opts.diff).slice(0, 4000)}</pre>`,
              { parse_mode: 'HTML' }
            )
            .catch(() => {});
        }
        return true; // keep pending open
      }
      pending.settled = true;
      clearTimeout(pending.timer);
      this.pending.delete(aid);
      const approved = action === 'a';
      await this.safeEdit(
        pending.messageId,
        `🔧 <b>Action ${approved ? 'approved' : 'rejected'}</b>\n${escapeHtml(pending.opts.summary)}`
      );
      pending.resolve(approved);
      return true;
    }

    if (pending.kind === 'batch' && kind === 'b') {
      if (action === 'aa') {
        // Approve all
        pending.settled = true;
        clearTimeout(pending.timer);
        this.pending.delete(aid);
        await this.safeEdit(
          pending.messageId,
          `🔧 <b>All ${pending.items.length} actions approved</b>`
        );
        for (const it of pending.items) it.resolve(true);
        return true;
      }
      if (action === 'ra') {
        // Reject all
        pending.settled = true;
        clearTimeout(pending.timer);
        this.pending.delete(aid);
        await this.safeEdit(
          pending.messageId,
          `🔧 <b>All ${pending.items.length} actions rejected</b>`
        );
        for (const it of pending.items) it.resolve(false);
        return true;
      }
      if (action.startsWith('t')) {
        // Toggle individual item
        const idx = parseInt(action.slice(1), 10);
        if (idx >= 0 && idx < pending.items.length) {
          const current = pending.decisions.get(idx) ?? false;
          pending.decisions.set(idx, !current);
          // Update button text to show toggle state (don't settle yet)
          // User taps "Approve All" when ready
        }
        return true;
      }
      return false;
    }

    if (pending.kind === 'plan' && kind === 'p') {
      pending.settled = true;
      clearTimeout(pending.timer);
      this.pending.delete(aid);

      let decisions: PlanDecision[] = [];
      if (action === 'aa') {
        decisions = pending.req.steps.map((_, i) => ({ index: i, approved: true }));
        await this.safeEdit(pending.messageId, '📋 <b>Plan approved (all steps)</b>');
      } else if (action === 'ra') {
        decisions = pending.req.steps.map((_, i) => ({ index: i, approved: false }));
        await this.safeEdit(pending.messageId, '📋 <b>Plan rejected</b>');
      } else if (action.startsWith('s')) {
        const n = parseInt(action.slice(1), 10) - 1;
        decisions = pending.req.steps.map((_, i) => ({ index: i, approved: i === n }));
        await this.safeEdit(pending.messageId, `📋 <b>Plan step #${n + 1} approved</b>`);
      } else {
        decisions = pending.req.steps.map((_, i) => ({ index: i, approved: false }));
      }

      pending.resolve(decisions);
      return true;
    }

    return false;
  }

  private cb(kind: 'c' | 'p' | 'b', aid: string, action: string): string {
    // <=64 bytes compact callback payload
    return `${kind}:${this.sid}:${aid}:${action}`;
  }

  private nextId(): string {
    this.seq += 1;
    return this.seq.toString(16).padStart(4, '0');
  }

  private async safeEdit(messageId: number, text: string): Promise<void> {
    await this.bot.api
      .editMessageText(this.chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => {});
  }
}
