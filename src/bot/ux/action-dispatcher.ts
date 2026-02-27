/**
 * Shared action dispatcher for IdleHands bots.
 *
 * This module provides a unified action dispatch path that both Telegram and Discord
 * bots use to handle interactive actions (retry_fast, retry_heavy, cancel, etc.)
 * from button presses, ensuring consistent behavior across platforms.
 */

import type { ManagedSession } from '../session-manager.js';
import type { UXActionPayload, UXActionType } from './actions.js';

/**
 * Action dispatch context passed to handlers.
 */
export type ActionDispatchContext = {
  /** The managed session for this interaction */
  managed: ManagedSession;
  /** The action type being dispatched */
  actionType: UXActionType;
  /** Optional action data payload */
  payload?: Record<string, unknown>;
  /** Platform identifier for logging/debugging */
  platform: 'discord' | 'telegram';
  /** Optional interaction/message context for response */
  context?: any;
};

/**
 * Result of an action dispatch.
 */
export type ActionDispatchResult = {
  /** Whether the action was handled successfully */
  handled: boolean;
  /** Optional response message to show the user */
  message?: string;
  /** Optional error message if handling failed */
  error?: string;
};

/**
 * Action handler function signature.
 */
export type ActionHandler = (ctx: ActionDispatchContext) => Promise<ActionDispatchResult>;

/**
 * Create a shared action dispatcher that both Discord and Telegram can use.
 */
export function createActionDispatcher() {
  const handlers = new Map<UXActionType, ActionHandler>();

  /**
   * Register an action handler.
   */
  function registerHandler(type: UXActionType, handler: ActionHandler): void {
    handlers.set(type, handler);
  }

  /**
   * Dispatch an action to its handler.
   */
  async function dispatch(ctx: ActionDispatchContext): Promise<ActionDispatchResult> {
    const handler = handlers.get(ctx.actionType);
    if (!handler) {
      return {
        handled: false,
        error: `No handler registered for action type: ${ctx.actionType}`,
      };
    }

    try {
      return await handler(ctx);
    } catch (err: any) {
      return {
        handled: false,
        error: `Action handler failed: ${err?.message ?? String(err)}`,
      };
    }
  }

  return {
    registerHandler,
    dispatch,
    handlers: () => Array.from(handlers.keys()),
  };
}

/**
 * Create a dispatcher with default handlers for common actions.
 */
export function createDefaultActionDispatcher(platform: 'discord' | 'telegram') {
  const dispatcher = createActionDispatcher();

  // Register default handlers
  registerRetryFastHandler(dispatcher, platform);
  registerRetryHeavyHandler(dispatcher, platform);
  registerCancelHandler(dispatcher, platform);

  return dispatcher;
}

/**
 * Register the retry_fast action handler.
 */
function registerRetryFastHandler(
  dispatcher: ReturnType<typeof createActionDispatcher>,
  platform: 'discord' | 'telegram'
): void {
  dispatcher.registerHandler('retry_fast', async (ctx): Promise<ActionDispatchResult> => {
    const { managed } = ctx;

    // Check if there's a previous task to retry
    const lastInstruction = managed.session.lastAskInstructionText || '';
    if (!lastInstruction.trim()) {
      return {
        handled: true,
        message:
          platform === 'discord'
            ? '❌ No previous task to retry.'
            : '❌ No previous task to retry.',
      };
    }

    // Set routing mode to fast
    setRoutingMode(managed, 'fast');

    // Re-run the last task by adding it to the queue
    if (platform === 'discord') {
      // Discord uses Message objects
      const { Message } = await import('discord.js');
      const newMessage = {
        content: lastInstruction,
      } as any;
      managed.pendingQueue.push(newMessage);
      return {
        handled: true,
        message: '🔄 Added to queue with routing mode set to `fast`.',
      };
    } else {
      // Telegram uses text/message objects
      const newMessage = {
        text: lastInstruction,
        from: ctx.context?.from,
        chat: ctx.context?.chat,
        date: Date.now(),
      } as any;
      managed.pendingQueue.push(newMessage);
      return {
        handled: true,
        message: '🔄 Added to queue with routing mode set to `fast`.',
      };
    }
  });
}

/**
 * Register the retry_heavy action handler.
 */
function registerRetryHeavyHandler(
  dispatcher: ReturnType<typeof createActionDispatcher>,
  platform: 'discord' | 'telegram'
): void {
  dispatcher.registerHandler('retry_heavy', async (ctx): Promise<ActionDispatchResult> => {
    const { managed } = ctx;

    // Check if there's a previous task to retry
    const lastInstruction = managed.session.lastAskInstructionText || '';
    if (!lastInstruction.trim()) {
      return {
        handled: true,
        message:
          platform === 'discord'
            ? '❌ No previous task to retry.'
            : '❌ No previous task to retry.',
      };
    }

    // Set routing mode to heavy
    setRoutingMode(managed, 'heavy');

    // Re-run the last task by adding it to the queue
    if (platform === 'discord') {
      const newMessage = {
        content: lastInstruction,
      } as any;
      managed.pendingQueue.push(newMessage);
      return {
        handled: true,
        message: '🔄 Added to queue with routing mode set to `heavy`.',
      };
    } else {
      const newMessage = {
        text: lastInstruction,
        from: ctx.context?.from,
        chat: ctx.context?.chat,
        date: Date.now(),
      } as any;
managed.pendingQueue.push(newMessage);
      return {
        handled: true,
        message: '🔄 Added to queue with routing mode set to `heavy`.',
      };
    }
  });
}

/**
 * Register the cancel action handler.
 */
function registerCancelHandler(
  dispatcher: ReturnType<typeof createActionDispatcher>,
  platform: 'discord' | 'telegram'
): void {
  dispatcher.registerHandler('cancel', async (ctx): Promise<ActionDispatchResult> => {
    const { managed } = ctx;

    // Use the shared cancelActive from turn-lifecycle
    const { cancelActive } = await import('../turn-lifecycle.js');
    const result = cancelActive(managed as any);

    if (result.ok) {
      return {
        handled: true,
        message: result.message || '🚫 Cancelled.',
      };
    } else {
      return {
        handled: true,
        message: `❌ ${result.message}`,
      };
    }
  });
}

/**
 * Set routing mode on a managed session.
 */
function setRoutingMode(managed: ManagedSession, mode: 'fast' | 'heavy'): void {
  // Access the routingMode through the session or context
  // This is platform-agnostic - both Discord and Telegram sessions
  // have access to routing configuration through their managed session
  if ('config' in managed && managed.config) {
    // Update routing mode in the session's configuration
    (managed as any)._routingMode = mode;
  }
}

/**
 * Dispatch an action from a callback data string.
 * Parses the action type from data and dispatches to the appropriate handler.
 */
export async function dispatchFromCallbackData(
  dispatcher: ReturnType<typeof createActionDispatcher>,
  data: string,
  ctx: Omit<ActionDispatchContext, 'actionType'>
): Promise<ActionDispatchResult> {
  // Parse action type from callback data
  // Expected format: "action:<type>" or just the type
  let actionType: UXActionType | null = null;

  if (data.startsWith('action:')) {
    const type = data.slice('action:'.length) as UXActionType;
    if (isValidActionType(type)) {
      actionType = type;
    }
  } else if (isValidActionType(data as UXActionType)) {
    actionType = data as UXActionType;
  }

  if (!actionType) {
    return {
      handled: false,
      error: `Invalid action type in callback data: ${data}`,
    };
  }

  return await dispatcher.dispatch({
    ...ctx,
    actionType,
  });
}

/**
 * Check if a string is a valid UXActionType.
 */
function isValidActionType(s: string): s is UXActionType {
  return (
    s === 'retry_fast' ||
    s === 'retry_heavy' ||
    s === 'cancel' ||
    s === 'show_diff' ||
    s === 'apply' ||
    s === 'anton_stop'
  );
}
