/**
 * Slot Affinity Manager for llama-server
 *
 * Pins sessions to specific llama-server slots to maximize KV cache reuse.
 * Without affinity, requests may land on different slots, causing expensive
 * cache rebuilds (37k tokens = 2+ minutes).
 */

export type SlotAffinityConfig = {
  enabled?: boolean;
  numSlots?: number;
};

type SlotAssignment = {
  slot: number;
  assignedAt: number;
  lastUsed: number;
};

class SlotAffinityManager {
  private sessionSlots: Map<string, SlotAssignment> = new Map();
  private numSlots: number = 4;
  private enabled: boolean = false;

  configure(config: SlotAffinityConfig | undefined): void {
    this.enabled = config?.enabled ?? false;
    this.numSlots = config?.numSlots ?? 4;
    if (this.enabled) {
      console.log(`[slot-affinity] Enabled with ${this.numSlots} slots`);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get the assigned slot for a session, or assign one if new.
   */
  getSlotForSession(sessionKey: string): number | undefined {
    if (!this.enabled) {
      return undefined;
    }

    const existing = this.sessionSlots.get(sessionKey);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.slot;
    }

    // Find least-used slot
    const slotCounts = Array.from({ length: this.numSlots }, () => 0);
    for (const assignment of this.sessionSlots.values()) {
      slotCounts[assignment.slot]++;
    }

    const slot = slotCounts.indexOf(Math.min(...slotCounts));
    const now = Date.now();

    this.sessionSlots.set(sessionKey, {
      slot,
      assignedAt: now,
      lastUsed: now,
    });

    console.log(`[slot-affinity] Assigned session ${sessionKey.slice(0, 20)}... to slot ${slot}`);
    return slot;
  }

  /**
   * Release a session's slot assignment (e.g., on session end).
   */
  releaseSession(sessionKey: string): void {
    if (this.sessionSlots.delete(sessionKey)) {
      console.log(`[slot-affinity] Released session ${sessionKey.slice(0, 20)}...`);
    }
  }

  /**
   * Get current slot assignments for debugging.
   */
  getStats(): { sessions: number; bySlot: number[] } {
    const bySlot = Array.from({ length: this.numSlots }, () => 0);
    for (const assignment of this.sessionSlots.values()) {
      bySlot[assignment.slot]++;
    }
    return {
      sessions: this.sessionSlots.size,
      bySlot,
    };
  }

  /**
   * Prune stale sessions (not used in last N minutes).
   */
  pruneStale(maxAgeMs: number = 30 * 60 * 1000): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, assignment] of this.sessionSlots.entries()) {
      if (now - assignment.lastUsed > maxAgeMs) {
        this.sessionSlots.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      console.log(`[slot-affinity] Pruned ${pruned} stale sessions`);
    }
    return pruned;
  }
}

// Singleton instance
export const slotAffinity = new SlotAffinityManager();
