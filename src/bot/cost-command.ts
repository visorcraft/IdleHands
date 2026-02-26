import type { CmdResult, ManagedLike } from './command-logic.js';

/**
 * Approximate cost per 1M tokens for known models.
 * Values in USD. Format: [input_per_1M, output_per_1M].
 */
const MODEL_PRICING: Record<string, [number, number]> = {
  // OpenAI
  'gpt-4o': [2.50, 10.00],
  'gpt-4o-mini': [0.15, 0.60],
  'gpt-4.1': [2.00, 8.00],
  'gpt-4.1-mini': [0.40, 1.60],
  'gpt-4.1-nano': [0.10, 0.40],
  'gpt-5': [10.00, 30.00],
  'gpt-5-mini': [1.50, 6.00],
  'gpt-5.2-codex': [0.50, 2.00],
  'gpt-5.3-codex': [0.50, 2.00],
  'o3': [10.00, 40.00],
  'o3-mini': [1.10, 4.40],
  'o4-mini': [1.10, 4.40],
  // Anthropic
  'claude-sonnet-4-20250514': [3.00, 15.00],
  'claude-opus-4-20250514': [15.00, 75.00],
  'claude-opus-4-6': [15.00, 75.00],
  // Google
  'gemini-2.5-pro': [1.25, 10.00],
  'gemini-2.5-flash': [0.15, 0.60],
  'gemini-3-flash': [0.10, 0.40],
  'gemini-3-pro': [1.00, 4.00],
  // Local models are free
};

function findPricing(model: string): [number, number] | null {
  // Exact match first
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // Prefix match (e.g. "gpt-4o-2024-11-20" → "gpt-4o")
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key)) return price;
  }
  // Check if it contains a known model name
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (model.includes(key)) return price;
  }
  return null;
}

/**
 * /cost — Show estimated API costs for the current session.
 */
export function costCommand(managed: ManagedLike): CmdResult {
  const session = managed.session;
  const model = session.model;
  const usage = session.usage;
  const pricing = findPricing(model);

  if (!pricing) {
    return {
      title: 'Session Cost',
      lines: [
        `Model: ${model}`,
        `Tokens: ${usage.prompt.toLocaleString()} in / ${usage.completion.toLocaleString()} out`,
        '',
        'No pricing data available for this model.',
        'Local models are free! 🎉',
      ],
    };
  }

  const [inputPer1M, outputPer1M] = pricing;
  const inputCost = (usage.prompt / 1_000_000) * inputPer1M;
  const outputCost = (usage.completion / 1_000_000) * outputPer1M;
  const totalCost = inputCost + outputCost;

  return {
    title: 'Session Cost',
    kv: [
      ['Model', model],
      ['Input', `${usage.prompt.toLocaleString()} tokens · $${inputCost.toFixed(4)}`],
      ['Output', `${usage.completion.toLocaleString()} tokens · $${outputCost.toFixed(4)}`],
      ['Total', `$${totalCost.toFixed(4)}`],
    ],
  };
}
