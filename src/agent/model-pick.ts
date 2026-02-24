import type { OpenAIClient } from '../client.js';

import { normalizeModelsResponse } from './review-artifact.js';
import { makeAbortController } from './session-utils.js';

/** Pick a default model from endpoint model list (prefer qwen). */
export async function autoPickModel(
  client: OpenAIClient,
  cached?: { data: Array<{ id: string }> }
): Promise<string> {
  const ac = makeAbortController();
  const timer = setTimeout(() => ac.abort(), 3000);
  try {
    const models = cached ?? normalizeModelsResponse(await client.models(ac.signal));
    const q = models.data.find((m) => /qwen/i.test(m.id));
    if (q) return q.id;
    const first = models.data[0]?.id;
    if (!first)
      throw new Error('No models found on server. Check your endpoint and that a model is loaded.');
    return first;
  } finally {
    clearTimeout(timer);
  }
}
