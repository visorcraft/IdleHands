import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_MAX_TOKENS,
  deriveContextWindow,
  deriveGenerationParams,
  supportsVisionModel,
} from '../dist/model-customization.js';

describe('model customization helpers', () => {
  it('supportsVisionModel respects explicit harness override first', () => {
    const harness: any = { id: 'generic', supportsVision: false };
    const out = supportsVisionModel('gpt-4o', { vision: true }, harness);
    assert.equal(out, false);
  });

  it('deriveContextWindow uses explicit configured value when set', () => {
    const out = deriveContextWindow({
      explicitContextWindow: true,
      configuredContextWindow: 65536,
      modelMeta: { context_window: 999999 },
      previousContextWindow: 2048,
    });
    assert.equal(out, 65536);
  });

  it('deriveContextWindow derives from model metadata when not explicit', () => {
    const out = deriveContextWindow({
      explicitContextWindow: false,
      modelMeta: { context_window: 32768 },
      previousContextWindow: 8192,
    });
    assert.equal(out, 32768);
  });

  it('deriveContextWindow keeps previous value when derived value is absent', () => {
    const out = deriveContextWindow({
      explicitContextWindow: false,
      modelMeta: {},
      previousContextWindow: 16384,
    });
    assert.equal(out, 16384);
  });

  it('deriveGenerationParams applies harness max_tokens only when caller uses base default', () => {
    const harness: any = {
      defaults: {
        max_tokens: 32768,
        temperature: 0.33,
        top_p: 0.88,
      },
    };

    const withBase = deriveGenerationParams({
      harness,
      configuredMaxTokens: BASE_MAX_TOKENS,
    });
    assert.equal(withBase.maxTokens, 32768);

    const explicit = deriveGenerationParams({
      harness,
      configuredMaxTokens: 12000,
    });
    assert.equal(explicit.maxTokens, 12000);
    assert.equal(explicit.temperature, 0.33);
    assert.equal(explicit.topP, 0.88);
  });
});
