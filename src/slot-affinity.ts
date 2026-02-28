type SlotAffinityConfig = {
  enabled?: boolean;
  num_slots?: number;
};

const sessionToSlot = new Map<string, number>();
const slotToSession = new Map<number, string>();
const slotLastUsed = new Map<number, number>();
let usageTick = 0;

function touch(slot: number) {
  usageTick += 1;
  slotLastUsed.set(slot, usageTick);
}

function pickLeastRecentlyUsedSlot(maxSlots: number): number {
  let lruSlot = 0;
  let lruTs = Number.POSITIVE_INFINITY;
  for (let slot = 0; slot < maxSlots; slot += 1) {
    const ts = slotLastUsed.get(slot) ?? 0;
    if (ts < lruTs) {
      lruTs = ts;
      lruSlot = slot;
    }
  }
  return lruSlot;
}

/**
 * Resolve llama.cpp slot assignment for a session.
 * - When slot affinity is disabled, returns cfg.id_slot (if any).
 * - When enabled, assigns slots [0..num_slots-1] with LRU replacement.
 */
export function resolveIdSlot(opts: {
  sessionKey: string;
  id_slot?: number;
  slot_affinity?: SlotAffinityConfig;
}): number | undefined {
  const enabled = opts.slot_affinity?.enabled === true;
  if (!enabled) return opts.id_slot;

  const maxSlots = Math.max(1, Math.floor(opts.slot_affinity?.num_slots ?? 1));

  const existing = sessionToSlot.get(opts.sessionKey);
  if (typeof existing === 'number') {
    touch(existing);
    return existing;
  }

  for (let slot = 0; slot < maxSlots; slot += 1) {
    if (!slotToSession.has(slot)) {
      sessionToSlot.set(opts.sessionKey, slot);
      slotToSession.set(slot, opts.sessionKey);
      touch(slot);
      return slot;
    }
  }

  const evictSlot = pickLeastRecentlyUsedSlot(maxSlots);
  const previousSession = slotToSession.get(evictSlot);
  if (previousSession) sessionToSlot.delete(previousSession);

  sessionToSlot.set(opts.sessionKey, evictSlot);
  slotToSession.set(evictSlot, opts.sessionKey);
  touch(evictSlot);
  return evictSlot;
}

export function resetSlotAffinityState(): void {
  sessionToSlot.clear();
  slotToSession.clear();
  slotLastUsed.clear();
  usageTick = 0;
}
