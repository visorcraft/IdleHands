import type { RoutingConfig, RoutingMode } from '../types.js';

export const ROUTING_MODES: RoutingMode[] = ['auto', 'fast', 'heavy'];

export function normalizeRoutingMode(value: unknown): RoutingMode | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'auto' || trimmed === 'fast' || trimmed === 'heavy') return trimmed;
  return undefined;
}

export function getEffectiveRoutingMode(config: {
  routing_mode?: unknown;
  routing?: Partial<RoutingConfig>;
}): RoutingMode {
  return (
    normalizeRoutingMode(config.routing_mode) ??
    normalizeRoutingMode(config.routing?.defaultMode) ??
    'auto'
  );
}

export function routingModeStatusLines(config: {
  routing_mode?: unknown;
  routing?: Partial<RoutingConfig>;
}): string[] {
  const mode = getEffectiveRoutingMode(config);
  const lines = [`Current routing mode: ${mode}`];
  const routing = config.routing;
  if (!routing) {
    lines.push('Routing policy: not configured');
    return lines;
  }

  lines.push(`Default mode: ${normalizeRoutingMode(routing.defaultMode) ?? 'auto'}`);
  lines.push(`Fast model: ${routing.fastModel ?? 'not configured'}`);
  lines.push(`Heavy model: ${routing.heavyModel ?? 'not configured'}`);
  if (routing.fastProvider) lines.push(`Fast provider: ${routing.fastProvider}`);
  if (routing.heavyProvider) lines.push(`Heavy provider: ${routing.heavyProvider}`);

  return lines;
}
