/**
 * Unified rate-limiting and heartbeat behavior for IdleHands UX.
 *
 * This module provides shared throttling logic for progress updates and
 * heartbeat signals across all bot platforms (Telegram, Discord, TUI, etc.).
 * It ensures consistent behavior while avoiding message spam and respecting
 * platform-specific constraints.
 */

// ---------------------------------------------------------------------------
// Throttle Configuration
// ---------------------------------------------------------------------------

/**
 * Default interval for progress updates (milliseconds).
 * Progress messages should not be sent more frequently than this.
 */
export const DEFAULT_PROGRESS_INTERVAL_MS = 3000;

/**
 * Default interval for heartbeat signals (milliseconds).
 * Heartbeat keeps "typing..." indicators alive on platforms like Telegram.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 4000;

/**
 * Maximum number of progress updates without user activity before warning.
 */
export const MAX_PROGRESS_SILENT_INTERVALS = 3;

/**
 * Throttle configuration for progress updates.
 */
export type ProgressThrottleConfig = {
  /** Minimum interval between progress updates */
  progressIntervalMs?: number;
  /** Minimum interval between heartbeat signals */
  heartbeatIntervalMs?: number;
  /** Maximum silent intervals before warning */
  maxSilentIntervals?: number;
  /** Time source for tests */
  now?: () => number;
};

/**
 * Throttle state for a single session/stream.
 */
export type ProgressThrottleState = {
  /** Timestamp of last progress update */
  lastProgressAt: number;
  /** Timestamp of last heartbeat signal */
  lastHeartbeatAt: number;
  /** Timestamp of last user activity */
  lastUserActivityAt: number;
  /** Count of silent intervals since last user activity */
  silentIntervals: number;
  /** Whether throttle is currently active (blocking updates) */
  isThrottled: boolean;
  /** Whether heartbeat is required */
  heartbeatRequired: boolean;
};

/**
 * Result of a throttle check, indicating whether an action should proceed.
 */
export type ThrottleResult = {
  /** Whether the action should proceed */
  allow: boolean;
  /** Reason for allowing or blocking */
  reason: 'allowed' | 'throttled' | 'heartbeat_required' | 'user_active';
  /** Optional delay until next allowed action (ms) */
  retryAfter?: number;
};

// ---------------------------------------------------------------------------
// Throttle Management
// ---------------------------------------------------------------------------

/**
 * Create a new throttle state for a session.
 */
export function createProgressThrottleState(
  config?: ProgressThrottleConfig
): ProgressThrottleState {
  const now = config?.now?.() ?? Date.now();
  return {
    lastProgressAt: now,
    lastHeartbeatAt: now,
    lastUserActivityAt: now,
    silentIntervals: 0,
    isThrottled: false,
    heartbeatRequired: false,
  };
}

/**
 * Check if a progress update should be allowed based on throttle state.
 */
export function checkProgressThrottle(
  state: ProgressThrottleState,
  config: ProgressThrottleConfig = {}
): ThrottleResult {
  const now = config.now?.() ?? Date.now();
  const progressInterval = config.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const heartbeatInterval = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const _maxSilent = config.maxSilentIntervals ?? MAX_PROGRESS_SILENT_INTERVALS;

  // If user is active, allow progress updates
  const timeSinceUserActivity = now - state.lastUserActivityAt;
  if (timeSinceUserActivity < heartbeatInterval) {
    return {
      allow: true,
      reason: 'user_active',
    };
  }

  // Check if we need to send a heartbeat
  const timeSinceHeartbeat = now - state.lastHeartbeatAt;
  if (timeSinceHeartbeat >= heartbeatInterval) {
    return {
      allow: true,
      reason: 'heartbeat_required',
    };
  }

  // Check progress throttle
  const timeSinceProgress = now - state.lastProgressAt;
  if (timeSinceProgress >= progressInterval) {
    return {
      allow: true,
      reason: 'allowed',
    };
  }

  // Throttled
  const retryAfter = progressInterval - timeSinceProgress;
  return {
    allow: false,
    reason: 'throttled',
    retryAfter,
  };
}

/**
 * Check if a heartbeat signal should be sent.
 */
export function checkHeartbeatRequired(
  state: ProgressThrottleState,
  config: ProgressThrottleConfig = {}
): boolean {
  const now = config.now?.() ?? Date.now();
  const heartbeatInterval = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const timeSinceHeartbeat = now - state.lastHeartbeatAt;

  return timeSinceHeartbeat >= heartbeatInterval;
}

/**
 * Update throttle state after a progress update.
 */
export function recordProgressUpdate(
  state: ProgressThrottleState,
  config: ProgressThrottleConfig = {}
): void {
  const now = config.now?.() ?? Date.now();
  state.lastProgressAt = now;
  state.silentIntervals = 0;
  state.isThrottled = false;
}

/**
 * Update throttle state after sending a heartbeat signal.
 */
export function recordHeartbeat(
  state: ProgressThrottleState,
  config: ProgressThrottleConfig = {}
): void {
  const now = config.now?.() ?? Date.now();
  state.lastHeartbeatAt = now;
  state.heartbeatRequired = false;
}

/**
 * Update throttle state when user activity is detected.
 */
export function recordUserActivity(
  state: ProgressThrottleState,
  config: ProgressThrottleConfig = {}
): void {
  const now = config.now?.() ?? Date.now();
  state.lastUserActivityAt = now;
  state.silentIntervals = 0;
  state.isThrottled = false;
}

/**
 * Increment silent interval counter (called periodically).
 */
export function incrementSilentInterval(
  state: ProgressThrottleState,
  config: ProgressThrottleConfig = {}
): void {
  const now = config.now?.() ?? Date.now();
  const heartbeatInterval = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxSilent = config.maxSilentIntervals ?? MAX_PROGRESS_SILENT_INTERVALS;

  // Only count silent intervals when user is not active
  const timeSinceUserActivity = now - state.lastUserActivityAt;
  if (timeSinceUserActivity >= heartbeatInterval) {
    state.silentIntervals += 1;
    if (state.silentIntervals >= maxSilent) {
      state.isThrottled = true;
    }
  }
}

/**
 * Reset throttle state for a new session.
 */
export function resetThrottleState(
  state: ProgressThrottleState,
  config: ProgressThrottleConfig = {}
): void {
  const now = config.now?.() ?? Date.now();
  state.lastProgressAt = now;
  state.lastHeartbeatAt = now;
  state.lastUserActivityAt = now;
  state.silentIntervals = 0;
  state.isThrottled = false;
  state.heartbeatRequired = false;
}

// ---------------------------------------------------------------------------
// Throttled Progress Updater
// ---------------------------------------------------------------------------

/**
 * Helper class for managing throttled progress updates.
 */
export class ThrottledProgressUpdater {
  private state: ProgressThrottleState;
  private config: ProgressThrottleConfig;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private silentIntervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ProgressThrottleConfig = {}) {
    this.config = config;
    this.state = createProgressThrottleState(config);
  }

  /**
   * Start the throttling timers.
   */
  start(): void {
    const heartbeatInterval = this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const progressInterval = this.config.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;

    // Heartbeat timer - keeps "typing..." indicators alive
    this.heartbeatTimer = setInterval(() => {
      if (checkHeartbeatRequired(this.state, this.config)) {
        this.state.heartbeatRequired = true;
      }
    }, heartbeatInterval);

    // Silent interval counter - tracks inactivity
    this.silentIntervalTimer = setInterval(() => {
      incrementSilentInterval(this.state, this.config);
    }, progressInterval);
  }

  /**
   * Stop all timers.
   */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.silentIntervalTimer) {
      clearInterval(this.silentIntervalTimer);
      this.silentIntervalTimer = null;
    }
  }

  /**
   * Check if a progress update should be allowed.
   */
  checkProgress(): ThrottleResult {
    return checkProgressThrottle(this.state, this.config);
  }

  /**
   * Check if a heartbeat signal is required.
   */
  checkHeartbeat(): boolean {
    return checkHeartbeatRequired(this.state, this.config);
  }

  /**
   * Record a progress update.
   */
  recordProgress(): void {
    recordProgressUpdate(this.state, this.config);
  }

  /**
   * Record a heartbeat signal.
   */
  recordHeartbeat(): void {
    recordHeartbeat(this.state, this.config);
  }

  /**
   * Record user activity.
   */
  recordUserActivity(): void {
    recordUserActivity(this.state, this.config);
  }

  /**
   * Get current throttle state.
   */
  getState(): ProgressThrottleState {
    return { ...this.state };
  }

  /**
   * Reset state for a new session.
   */
  reset(): void {
    resetThrottleState(this.state, this.config);
  }
}

// ---------------------------------------------------------------------------
// Configuration constants (also exported at module level)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

// DEFAULT_PROGRESS_INTERVAL_MS = 3000
// DEFAULT_HEARTBEAT_INTERVAL_MS = 4000
// MAX_PROGRESS_SILENT_INTERVALS = 3
