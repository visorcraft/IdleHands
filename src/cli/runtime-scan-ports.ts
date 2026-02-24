/** Parse --scan-ports values like '8000-8100', '8080,8081', or single port. */
export function parseScanPorts(input: string | undefined): number[] | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (/^\d+-\d+$/.test(trimmed)) {
    const [start, end] = trimmed.split('-').map(Number);
    if (start > end || start < 1 || end > 65535) return null;
    const ports: number[] = [];
    for (let p = start; p <= end; p++) ports.push(p);
    return ports;
  }

  if (trimmed.includes(',')) {
    const parts = trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const ports = parts.map(Number).filter((p) => Number.isFinite(p) && p >= 1 && p <= 65535);
    return ports.length > 0 ? ports : null;
  }

  const port = Number(trimmed);
  if (Number.isFinite(port) && port >= 1 && port <= 65535) return [port];
  return null;
}
