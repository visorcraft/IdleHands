/**
 * Routing hysteresis / anti-thrash.
 *
 * Tracks consecutive lane selections and enforces a minimum dwell of N turns
 * in the current lane before allowing a switch in auto mode. Explicit overrides
 * always bypass hysteresis.
 */

import type { RouteLane } from './turn-router.js';

export type HysteresisConfig = {
  /** Minimum consecutive turns in a lane before auto-switch is allowed. Default: 2. */
  minDwell?: number;
  /** Enable/disable hysteresis. Default: true. */
  enabled?: boolean;
};

export class RouteHysteresis {
  private currentLane: RouteLane | null = null;
  private dwellCount = 0;
  private readonly minDwell: number;
  readonly enabled: boolean;

  constructor(cfg?: HysteresisConfig) {
    this.minDwell = Math.max(1, cfg?.minDwell ?? 2);
    this.enabled = cfg?.enabled !== false;
  }

  /**
   * Apply hysteresis to a candidate lane selection.
   *
   * @param candidate - The lane the classifier/heuristic wants.
   * @param source - How the lane was selected ('override' bypasses hysteresis).
   * @returns The effective lane after hysteresis. May differ from candidate if
   *          dwell hasn't been met.
   */
  apply(
    candidate: RouteLane,
    source: 'override' | 'classifier' | 'heuristic' | 'hysteresis'
  ): { lane: RouteLane; suppressed: boolean } {
    // Overrides always take effect immediately.
    if (source === 'override' || !this.enabled) {
      this.currentLane = candidate;
      this.dwellCount = 1;
      return { lane: candidate, suppressed: false };
    }

    // First turn — no history yet.
    if (this.currentLane === null) {
      this.currentLane = candidate;
      this.dwellCount = 1;
      return { lane: candidate, suppressed: false };
    }

    // Same lane — just increment dwell.
    if (candidate === this.currentLane) {
      this.dwellCount++;
      return { lane: candidate, suppressed: false };
    }

    // Different lane — check dwell threshold.
    if (this.dwellCount >= this.minDwell) {
      // Enough dwell in current lane; allow the switch.
      this.currentLane = candidate;
      this.dwellCount = 1;
      return { lane: candidate, suppressed: false };
    }

    // Not enough dwell — suppress the switch, stay in current lane.
    this.dwellCount++;
    return { lane: this.currentLane, suppressed: true };
  }

  /** Reset state (e.g. on session reset). */
  reset(): void {
    this.currentLane = null;
    this.dwellCount = 0;
  }

  /** Current state for debug/status. */
  get state() {
    return {
      currentLane: this.currentLane,
      dwellCount: this.dwellCount,
      minDwell: this.minDwell,
      enabled: this.enabled,
    };
  }
}
