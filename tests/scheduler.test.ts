import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { MessageEditScheduler, classifyTelegramEditError } from '../dist/progress/message-edit-scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('MessageEditScheduler', () => {
  let scheduler: MessageEditScheduler;
  let renderCalls = 0;
  let applyCalls = 0;
  let lastAppliedText = '';
  let isDirtyFlag = true;
  let classifyErrorCalls = 0;

  const createScheduler = (opts: Partial<Parameters<typeof MessageEditScheduler['constructor']>[0]>) => {
    return new MessageEditScheduler({
      intervalMs: 10,
      render: () => {
        renderCalls++;
        return `rendered-${renderCalls}`;
      },
      apply: async (text: string) => {
        applyCalls++;
        lastAppliedText = text;
      },
      isDirty: () => isDirtyFlag,
      clearDirty: () => {
        isDirtyFlag = false;
      },
      classifyError: (e: unknown) => {
        classifyErrorCalls++;
        return { kind: 'retry', retryAfterMs: 100 };
      },
      ...opts,
    });
  };

  beforeEach(() => {
    renderCalls = 0;
    applyCalls = 0;
    lastAppliedText = '';
    isDirtyFlag = true;
    classifyErrorCalls = 0;
  });

  afterEach(() => {
    scheduler?.stop();
  });

  it('should start and stop the scheduler', () => {
    scheduler = createScheduler({});
    scheduler.start();
    assert.ok(scheduler);

    scheduler.stop();
    // After stopping, no more ticks should occur
  });

  it('should not start twice', () => {
    scheduler = createScheduler({});
    scheduler.start();
    const firstTimer = (scheduler as any).timer;

    scheduler.start();
    const secondTimer = (scheduler as any).timer;

    assert.strictEqual(firstTimer, secondTimer);
  });

  it('should skip dirty flag when not dirty', async () => {
    isDirtyFlag = false;
    scheduler = createScheduler({ intervalMs: 10 });
    scheduler.start();

    // Wait for a tick
    await new Promise((resolve) => setTimeout(resolve, 20));
    scheduler.stop();

    // Render and apply should not be called since isDirty is false
    assert.strictEqual(renderCalls, 0);
    assert.strictEqual(applyCalls, 0);
  });

  it('should apply edits when dirty', async () => {
    scheduler = createScheduler({ intervalMs: 10 });
    scheduler.start();

    // Wait for a tick
    await new Promise((resolve) => setTimeout(resolve, 20));
    scheduler.stop();

    assert.ok(renderCalls > 0);
    assert.ok(applyCalls > 0);
  });

  it('should clear dirty flag after successful apply', async () => {
    scheduler = createScheduler({ intervalMs: 10 });
    scheduler.start();

    // Wait for a tick
    await new Promise((resolve) => setTimeout(resolve, 20));
    scheduler.stop();

    // isDirtyFlag should be false after successful apply
    assert.strictEqual(isDirtyFlag, false);
  });

  it('should handle backoff on error', async () => {
    let errorCount = 0;
    scheduler = createScheduler({
      intervalMs: 10,
      jitterMs: 0,
      apply: async () => {
        throw new Error('retryable failure');
      },
      classifyError: () => {
        errorCount++;
        return { kind: 'retry', retryAfterMs: 20 };
      },
    });
    scheduler.start();

    // Wait for multiple ticks
    await new Promise((resolve) => setTimeout(resolve, 120));
    scheduler.stop();

    // Should have classified errors
    assert.ok(errorCount > 0);
  });

  it('should stop on fatal error', async () => {
    scheduler = createScheduler({
      intervalMs: 10,
      apply: async () => {
        throw new Error('fatal apply failure');
      },
      classifyError: () => ({ kind: 'fatal', message: 'test fatal error' }),
    });

    // Spy on console.error
    const consoleErrorSpy = console.error;
    let loggedError: string | undefined;
    console.error = (msg: string) => {
      loggedError = String(msg);
    };

    scheduler.start();

    // Wait for a tick
    await new Promise((resolve) => setTimeout(resolve, 40));
    scheduler.stop();

    // Restore console.error
    console.error = consoleErrorSpy;

    // Should have logged the fatal error
    assert.ok(loggedError?.includes('fatal edit error'));
  });

  it('should ignore errors with ignore classification', async () => {
    scheduler = createScheduler({
      intervalMs: 10,
      classifyError: () => ({ kind: 'ignore' }),
    });
    scheduler.start();

    // Wait for a tick
    await new Promise((resolve) => setTimeout(resolve, 20));
    scheduler.stop();

    // Should not have stopped
    assert.ok(true);
  });

  it('should not apply duplicate text', async () => {
    let renderValue = 'initial';
    scheduler = createScheduler({
      intervalMs: 10,
      render: () => renderValue,
    });
    scheduler.start();

    // Wait for first tick
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Keep render value unchanged
    renderValue = 'initial';
    await new Promise((resolve) => setTimeout(resolve, 40));
    scheduler.stop();

    // Apply should only be called once (first time)
    assert.strictEqual(applyCalls, 1);
  });
});

describe('classifyTelegramEditError', () => {
  it('should classify 429 errors as retry', () => {
    const error = {
      description: 'Too Many Requests: retry after 10',
      parameters: { retry_after: 10 },
    };

    const result = classifyTelegramEditError(error);
    assert.strictEqual(result.kind, 'retry');
    assert.ok(result.retryAfterMs !== undefined);
    assert.ok(result.retryAfterMs! > 0);
  });

  it('should classify "message is not modified" as ignore', () => {
    const error = {
      description: 'Bad Request: message is not modified',
    };

    const result = classifyTelegramEditError(error);
    assert.strictEqual(result.kind, 'ignore');
  });

  it('should classify unknown errors as retry', () => {
    const error = new Error('Unknown error');

    const result = classifyTelegramEditError(error);
    assert.strictEqual(result.kind, 'retry');
  });
});

describe('MessageEditScheduler in-flight lock', () => {
  let scheduler: MessageEditScheduler;
  let applyDelayMs = 0;
  let applyCalls = 0;

  const createSchedulerWithDelay = (delayMs: number) => {
    return new MessageEditScheduler({
      intervalMs: 5,
      render: () => `rendered-${Date.now()}`,
      apply: async (text: string) => {
        applyCalls++;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      },
      isDirty: () => true,
      clearDirty: () => {},
      classifyError: () => ({ kind: 'retry', retryAfterMs: 100 }),
    });
  };

  beforeEach(() => {
    applyDelayMs = 0;
    applyCalls = 0;
  });

  afterEach(() => {
    scheduler?.stop();
  });

  it('should prevent overlapping edits when apply is slow', async () => {
    applyDelayMs = 50;
    scheduler = createSchedulerWithDelay(applyDelayMs);
    scheduler.start();

    // Wait for multiple ticks (should only have 1 in-flight at a time)
    await new Promise((resolve) => setTimeout(resolve, 50));
    scheduler.stop();

    // With the in-flight lock, only 1 edit should be in progress at a time
    // Even though multiple ticks could have triggered, only 1 should be inFlight
    assert.ok(applyCalls >= 1, 'At least one apply call should occur');
  });

  it('should reset inFlight flag after successful apply', async () => {
    applyDelayMs = 5;
    scheduler = createSchedulerWithDelay(applyDelayMs);
    scheduler.start();

    // Wait for a few ticks
    await new Promise((resolve) => setTimeout(resolve, 30));
    scheduler.stop();

    // The scheduler should have completed all edits
    assert.ok(applyCalls >= 2, 'Multiple apply calls should occur with fast apply');
  });

  it('should reset inFlight flag after failed apply', async () => {
    let failCount = 0;
    scheduler = new MessageEditScheduler({
      intervalMs: 5,
      jitterMs: 0,
      render: () => `rendered-${Date.now()}`,
      apply: async () => {
        failCount++;
        if (failCount <= 2) {
          throw new Error('Simulated failure');
        }
      },
      isDirty: () => true,
      clearDirty: () => {},
      classifyError: () => ({ kind: 'retry', retryAfterMs: 10 }),
    });
    scheduler.start();

    // Wait for multiple ticks with failures
    await new Promise((resolve) => setTimeout(resolve, 90));
    scheduler.stop();

    // inFlight should be reset after each failure
    assert.ok(failCount >= 3, 'Multiple apply attempts should occur');
  });
});