import type {
  BlockedNotice,
  ConfirmationProvider,
  ConfirmPlanRequest,
  ConfirmRequest,
  PlanDecision,
} from '../types.js';

import type { TuiEvent } from './events.js';

export type TuiDispatch = (ev: TuiEvent) => void;

/**
 * TUI-native confirmation provider.
 * When confirm() is called by the agent, it dispatches CONFIRM_SHOW to put the TUI
 * into confirmation mode. The controller routes y/n/d keypresses to resolve().
 *
 * Lifecycle:
 * 1. Agent calls confirm(opts) → dispatches CONFIRM_SHOW, returns Promise
 * 2. Controller detects state.confirmPending, routes keys to this provider
 * 3. User presses y/n/d → controller calls resolve(true/false) or toggleDiff()
 * 4. resolve() fulfills the Promise and dispatches CONFIRM_DISMISS
 */
export class TuiConfirmProvider implements ConfirmationProvider {
  private resolveConfirm: ((approved: boolean) => void) | null = null;
  private remembered = new Map<string, boolean>();

  constructor(private readonly dispatch: TuiDispatch) {}

  get isPending(): boolean {
    return this.resolveConfirm !== null;
  }

  async confirm(opts: ConfirmRequest): Promise<boolean> {
    const memKey = this.memoryKey(opts);
    if (memKey && this.remembered.has(memKey)) {
      const decision = this.remembered.get(memKey) ?? false;
      this.dispatch({
        type: 'ALERT_PUSH',
        id: `remembered_${Date.now()}`,
        level: 'info',
        text: `[remembered ${decision ? '✓' : '✗'}] ${opts.summary}`,
      });
      return decision;
    }

    this.dispatch({
      type: 'CONFIRM_SHOW',
      tool: opts.tool,
      summary: opts.summary,
      args: opts.args,
      diff: opts.diff,
    });

    const approved = await new Promise<boolean>((resolve) => {
      this.resolveConfirm = resolve;
    });

    if (memKey) this.remembered.set(memKey, approved);
    return approved;
  }

  resolve(approved: boolean): void {
    if (!this.resolveConfirm) return;
    const fn = this.resolveConfirm;
    this.resolveConfirm = null;
    this.dispatch({ type: 'CONFIRM_DISMISS' });
    fn(approved);
  }

  toggleDiff(): void {
    this.dispatch({ type: 'CONFIRM_TOGGLE_DIFF' });
  }

  async confirmPlan(opts: ConfirmPlanRequest): Promise<PlanDecision[]> {
    const decisions: PlanDecision[] = [];
    for (let i = 0; i < opts.steps.length; i += 1) {
      const approved = await this.confirm(opts.steps[i]);
      decisions.push({ index: i, approved });
    }
    return decisions;
  }

  async showBlocked(opts: BlockedNotice): Promise<void> {
    this.dispatch({
      type: 'ALERT_PUSH',
      id: `blocked_${Date.now()}`,
      level: 'error',
      text: `[blocked] ${opts.tool}: ${opts.reason}`,
    });
  }

  clearRemembered(): void {
    this.remembered.clear();
  }

  private memoryKey(opts: ConfirmRequest): string | null {
    if (opts.tool === 'exec') {
      const cmd = typeof opts.args.command === 'string' ? opts.args.command : '';
      return cmd ? `exec:${cmd}` : null;
    }
    if (['edit_file', 'write_file', 'insert_file'].includes(opts.tool)) {
      const p = typeof opts.args.path === 'string' ? opts.args.path : '';
      return p ? `${opts.tool}:${p}` : null;
    }
    return null;
  }
}
