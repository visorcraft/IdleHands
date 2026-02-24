/**
 * Normalized action schema for IdleHands UX.
 *
 * This module defines the canonical action types and structure that can be
 * presented to users across all platforms (Discord, Telegram, TUI, etc.).
 * Actions represent operations users can take in response to events.
 */

// ---------------------------------------------------------------------------
// Action Types
// ---------------------------------------------------------------------------

/**
 * Normalized action type representing a user-initiated operation.
 */
export type UXActionType =
  | 'retry_fast' // Quick retry (e.g., same parameters, faster model)
  | 'retry_heavy' // Full retry (e.g., different parameters, heavier model)
  | 'cancel' // Cancel current operation
  | 'show_diff' // Show diff of changes
  | 'apply' // Apply proposed changes
  | 'anton_stop'; // Stop Anton completely

// ---------------------------------------------------------------------------
// Action Structure
// ---------------------------------------------------------------------------

/**
 * Normalized action payload that can be executed by the system.
 */
export type UXActionPayload = {
  /** Action type identifier */
  type: UXActionType;
  /** Optional structured data for the action */
  data?: Record<string, unknown>;
};

/**
 * Human-readable action button/command available to user.
 */
export type UXAction = {
  /** Action type identifier */
  type: UXActionType;
  /** Display label for the action */
  label: string;
  /** Optional payload for the action */
  payload?: UXActionPayload;
  /** Optional short description/hint */
  hint?: string;
  /** Optional icon/emoji for UI rendering */
  icon?: string;
};

// ---------------------------------------------------------------------------
// Action Factories
// ---------------------------------------------------------------------------

/**
 * Create a retry_fast action.
 */
export function createRetryFastAction(label?: string): UXAction {
  return {
    type: 'retry_fast',
    label: label ?? 'Retry (fast)',
    hint: 'Quick retry with same parameters',
  };
}

/**
 * Create a retry_heavy action.
 */
export function createRetryHeavyAction(label?: string): UXAction {
  return {
    type: 'retry_heavy',
    label: label ?? 'Retry (heavy)',
    hint: 'Full retry with different/heavier parameters',
  };
}

/**
 * Create a cancel action.
 */
export function createCancelAction(label?: string): UXAction {
  return {
    type: 'cancel',
    label: label ?? 'Cancel',
    hint: 'Cancel current operation',
  };
}

/**
 * Create a show_diff action.
 */
export function createShowDiffAction(label?: string): UXAction {
  return {
    type: 'show_diff',
    label: label ?? 'Show Diff',
    hint: 'View changes before applying',
  };
}

/**
 * Create an apply action.
 */
export function createApplyAction(label?: string): UXAction {
  return {
    type: 'apply',
    label: label ?? 'Apply',
    hint: 'Apply proposed changes',
  };
}

/**
 * Create an anton_stop action.
 */
export function createAntonStopAction(label?: string): UXAction {
  return {
    type: 'anton_stop',
    label: label ?? 'Stop Anton',
    hint: 'Stop Anton completely',
  };
}

// ---------------------------------------------------------------------------
// Action Utilities
// ---------------------------------------------------------------------------

/**
 * Get the default label for an action type.
 */
export function getActionLabel(type: UXActionType): string {
  switch (type) {
    case 'retry_fast':
      return 'Retry (fast)';
    case 'retry_heavy':
      return 'Retry (heavy)';
    case 'cancel':
      return 'Cancel';
    case 'show_diff':
      return 'Show Diff';
    case 'apply':
      return 'Apply';
    case 'anton_stop':
      return 'Stop Anton';
  }
}

/**
 * Get the default hint for an action type.
 */
export function getActionHint(type: UXActionType): string {
  switch (type) {
    case 'retry_fast':
      return 'Quick retry with same parameters';
    case 'retry_heavy':
      return 'Full retry with different/heavier parameters';
    case 'cancel':
      return 'Cancel current operation';
    case 'show_diff':
      return 'View changes before applying';
    case 'apply':
      return 'Apply proposed changes';
    case 'anton_stop':
      return 'Stop Anton completely';
  }
}

/**
 * Get the default icon for an action type (for UI rendering).
 */
export function getActionIcon(type: UXActionType): string {
  switch (type) {
    case 'retry_fast':
      return '⚡';
    case 'retry_heavy':
      return '🏋️';
    case 'cancel':
      return '❌';
    case 'show_diff':
      return '📊';
    case 'apply':
      return '✅';
    case 'anton_stop':
      return '🛑';
  }
}

/**
 * Create a complete action with all defaults filled in.
 */
export function createAction(type: UXActionType, overrides?: Partial<UXAction>): UXAction {
  return {
    type,
    label: overrides?.label ?? getActionLabel(type),
    hint: overrides?.hint ?? getActionHint(type),
    icon: overrides?.icon ?? getActionIcon(type),
    payload: overrides?.payload,
  };
}

/**
 * Check if two actions are equivalent.
 */
export function areActionsEqual(a: UXAction, b: UXAction): boolean {
  return a.type === b.type && a.label === b.label;
}

/**
 * Filter actions by type.
 */
export function filterActionsByType(actions: UXAction[], type: UXActionType): UXAction[] {
  return actions.filter((a) => a.type === type);
}

/**
 * Find an action by type.
 */
export function findActionByType(actions: UXAction[], type: UXActionType): UXAction | undefined {
  return actions.find((a) => a.type === type);
}
