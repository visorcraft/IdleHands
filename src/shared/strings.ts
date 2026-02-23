/** Truncate `s` to at most `n` characters, appending '…' if shortened. */
export function truncate(s: string, n: number): string {
  if (n <= 0) return '';
  const t = String(s ?? '');
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + '…';
}
