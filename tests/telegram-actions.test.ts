import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultActionDispatcher } from '../dist/bot/ux/action-dispatcher.js';
import { TelegramConfirmProvider } from '../dist/bot/confirm-telegram.js';

// Simple mock for testing
class MockSessionManager {
  constructor() {
    this.sessions = new Map();
  }

  get(chatId) {
    return this.sessions.get(chatId);
  }

  set(chatId, session) {
    this.sessions.set(chatId, session);
  }
}

describe('Telegram Actions', () => {
  let bot;
  let chatId;
  let confirmProvider;
  let dispatcher;

  beforeEach(() => {
    // Create a minimal mock bot (we won't actually send any messages)
    bot = {
      api: {
        sendMessage: () => Promise.resolve({ chat: { id: 123 }, message_id: 1 }),
        editMessageText: () => Promise.resolve(true),
        sendChatAction: () => Promise.resolve(true),
      },
    };

    chatId = 123;

    // Create dispatcher with handlers
    dispatcher = createDefaultActionDispatcher('telegram');

    // Create confirm provider with action handler
    confirmProvider = new TelegramConfirmProvider(
      bot,
      chatId,
      300,
      async (actionType, data) => {
        const managed = {
          session: {
            lastAskInstructionText: 'Test instruction',
          },
          pendingQueue: [],
          config: {},
        };

        // Mock session manager
        const sessionManager = new MockSessionManager();
        sessionManager.set(chatId, managed);

        const result = await dispatcher.dispatch({
          managed,
          actionType: actionType,
          platform: 'telegram',
          context: {
            from: 456,
            chat: { id: chatId }
          }
        });

        return result.handled;
      }
    );
  });

  afterEach(() => {
    // Cleanup
    confirmProvider = null;
    dispatcher = null;
  });

  it('should handle retry_fast action through dispatcher', async () => {
    const data = 'action:retry_fast';

    // The action should be handled by the dispatcher
    const handled = await confirmProvider.handleCallback(data);

    assert.strictEqual(handled, true, 'retry_fast action should be handled');
  });

  it('should handle retry_heavy action through dispatcher', async () => {
    const data = 'action:retry_heavy';

    const handled = await confirmProvider.handleCallback(data);

    assert.strictEqual(handled, true, 'retry_heavy action should be handled');
  });

  it('should handle cancel action through dispatcher', async () => {
    const data = 'action:cancel';

    const handled = await confirmProvider.handleCallback(data);

    assert.strictEqual(handled, true, 'cancel action should be handled');
  });

  it('should return true for action: prefixed callbacks (prevents Unknown action error)', async () => {
    const data = 'action:unknown_action';

    const handled = await confirmProvider.handleCallback(data);

    // Action prefixed callbacks always return true to prevent "Unknown action" error
    assert.strictEqual(handled, true, 'action: prefixed callbacks should be treated as handled');
  });

  it('should handle regular confirmation callbacks', async () => {
    // Create a regular confirmation callback
    // Format: c:<sid>:<aid>:a
    const sid = 'abc';
    const aid = '0001';
    const data = `c:${sid}:${aid}:a`;

    // This should be handled by the confirm provider itself, not the dispatcher
    // For this test, we just verify that the callback doesn't throw
    const handled = await confirmProvider.handleCallback(data);

    // The callback should be handled (either by provider or dispatcher)
    // Since we don't have a pending confirmation, it will fall through
    // But the important thing is it doesn't throw
    assert.strictEqual(typeof handled, 'boolean');
  });
});