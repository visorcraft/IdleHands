/**
 * AutoApproveProvider — always approves everything.
 * Used in yolo mode and for auto-edit mode's file mutations.
 */

import type {
  ConfirmationProvider,
  ConfirmRequest,
  ConfirmPlanRequest,
  PlanDecision,
} from '../types.js';

export class AutoApproveProvider implements ConfirmationProvider {
  async confirm(_opts: ConfirmRequest): Promise<boolean> {
    return true;
  }

  async confirmPlan(opts: ConfirmPlanRequest): Promise<PlanDecision[]> {
    return opts.steps.map((_, i) => ({ index: i, approved: true }));
  }
}
