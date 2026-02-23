/** Clamp `n` between `min` and `max` inclusive. */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
