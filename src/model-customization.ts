import type { Harness } from './harnesses.js';

export const BASE_MAX_TOKENS = 16384;

export function supportsVisionModel(model: string, modelMeta: any, harness: Harness): boolean {
  if (typeof harness.supportsVision === 'boolean') return harness.supportsVision;
  if (typeof modelMeta?.vision === 'boolean') return modelMeta.vision;

  const inputModalities = modelMeta?.input_modalities;
  if (
    Array.isArray(inputModalities) &&
    inputModalities.some((m) => String(m).toLowerCase().includes('image'))
  ) {
    return true;
  }

  const modalities = modelMeta?.modalities;
  if (
    Array.isArray(modalities) &&
    modalities.some((m) => String(m).toLowerCase().includes('image'))
  ) {
    return true;
  }

  const id = model.toLowerCase();
  if (/(vision|multimodal|\bvl\b|llava|qwen2\.5-vl|gpt-4o|gemini|claude-3)/i.test(id)) return true;
  if (harness.id.includes('vision') || harness.id.includes('vl')) return true;

  return false;
}

function asNumber(...vals: any[]): number | undefined {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

export function deriveContextWindow(opts: {
  explicitContextWindow: boolean;
  configuredContextWindow?: number;
  previousContextWindow?: number;
  modelMeta?: any;
  fallback?: number;
}): number {
  const fallback = opts.fallback ?? 131072;

  if (opts.explicitContextWindow) {
    return opts.configuredContextWindow ?? opts.previousContextWindow ?? fallback;
  }

  const derived = asNumber(
    opts.modelMeta?.context_window,
    opts.modelMeta?.context_length,
    opts.modelMeta?.max_context_length
  );

  return derived ?? opts.previousContextWindow ?? fallback;
}

export function deriveGenerationParams(opts: {
  harness: Harness;
  configuredMaxTokens?: number;
  configuredTemperature?: number;
  configuredTopP?: number;
  baseMaxTokens?: number;
}): { maxTokens: number; temperature: number; topP: number } {
  const base = opts.baseMaxTokens ?? BASE_MAX_TOKENS;

  let maxTokens = opts.configuredMaxTokens ?? base;
  if (
    maxTokens === base &&
    opts.harness.defaults?.max_tokens &&
    opts.harness.defaults.max_tokens > base
  ) {
    maxTokens = opts.harness.defaults.max_tokens;
  }

  const temperature = opts.configuredTemperature ?? opts.harness.defaults?.temperature ?? 0.2;
  const topP = opts.configuredTopP ?? opts.harness.defaults?.top_p ?? 0.95;

  return { maxTokens, temperature, topP };
}
