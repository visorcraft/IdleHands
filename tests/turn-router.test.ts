import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideTurnRoute } from '../dist/routing/turn-router.js';

function makeConfig(overrides: Record<string, any> = {}): any {
  return {
    endpoint: 'http://localhost:8080/v1',
    model: 'default-model',
    mode: 'code',
    routing_mode: 'auto',
    max_tokens: 16384,
    temperature: 0.2,
    top_p: 0.95,
    timeout: 600,
    max_iterations: 100,
    response_timeout: 600,
    approval_mode: 'auto-edit',
    no_confirm: false,
    verbose: false,
    dry_run: false,
    ...overrides,
  };
}

describe('turn-router: decideTurnRoute', () => {
  describe('override modes (fast/heavy)', () => {
    it('routing_mode=fast forces fast lane', () => {
      const plan = decideTurnRoute(
        makeConfig({ routing_mode: 'fast' }),
        'explain quantum physics in detail with examples',
        'default-model',
      );
      assert.equal(plan.requestedMode, 'fast');
      assert.equal(plan.selectedMode, 'fast');
      assert.equal(plan.selectedModeSource, 'override');
    });

    it('routing_mode=heavy forces heavy lane', () => {
      const plan = decideTurnRoute(
        makeConfig({ routing_mode: 'heavy' }),
        'hi',
        'default-model',
      );
      assert.equal(plan.requestedMode, 'heavy');
      assert.equal(plan.selectedMode, 'heavy');
      assert.equal(plan.selectedModeSource, 'override');
    });
  });

  describe('auto mode with classifier', () => {
    it('short greeting classifies as fast', () => {
      const plan = decideTurnRoute(
        makeConfig({ routing_mode: 'auto' }),
        'hello',
        'default-model',
      );
      assert.equal(plan.requestedMode, 'auto');
      assert.equal(plan.selectedMode, 'fast');
      assert.equal(plan.classificationHint, 'fast');
      assert.equal(plan.selectedModeSource, 'classifier');
    });

    it('code keywords classify as heavy (code→heavy)', () => {
      const plan = decideTurnRoute(
        makeConfig({ routing_mode: 'auto' }),
        'refactor the auth module to use dependency injection',
        'default-model',
      );
      assert.equal(plan.classificationHint, 'code');
      assert.equal(plan.selectedMode, 'heavy');
      assert.equal(plan.selectedModeSource, 'classifier');
    });

    it('reasoning keywords classify as heavy (reasoning→heavy)', () => {
      const plan = decideTurnRoute(
        makeConfig({ routing_mode: 'auto' }),
        'analyze the performance implications of this architecture change and explain why it matters',
        'default-model',
      );
      assert.equal(plan.classificationHint, 'reasoning');
      assert.equal(plan.selectedMode, 'heavy');
      assert.equal(plan.selectedModeSource, 'classifier');
    });

    it('ambiguous prompt falls through to heuristic', () => {
      const plan = decideTurnRoute(
        makeConfig({ routing_mode: 'auto' }),
        'what time is it?',
        'default-model',
      );
      // No classifier hit — should fall to heuristic
      assert.equal(plan.classificationHint, null);
      assert.equal(plan.selectedModeSource, 'heuristic');
      assert.ok(plan.heuristicDecision != null);
    });
  });

  describe('routing config: model selection', () => {
    it('fast lane uses fastModel from routing config', () => {
      const plan = decideTurnRoute(
        makeConfig({
          routing_mode: 'fast',
          routing: { fastModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
        }),
        'hi',
        'default-model',
      );
      assert.equal(plan.providerTargets[0].model, 'gpt-4o-mini');
    });

    it('heavy lane uses heavyModel from routing config', () => {
      const plan = decideTurnRoute(
        makeConfig({
          routing_mode: 'heavy',
          routing: { fastModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
        }),
        'hi',
        'default-model',
      );
      assert.equal(plan.providerTargets[0].model, 'gpt-4o');
    });

    it('falls back to current model when routing config has no model for lane', () => {
      const plan = decideTurnRoute(
        makeConfig({ routing_mode: 'fast', routing: {} }),
        'hi',
        'my-current-model',
      );
      assert.equal(plan.providerTargets[0].model, 'my-current-model');
    });
  });

  describe('routing config: providers', () => {
    it('uses configured provider endpoint', () => {
      const plan = decideTurnRoute(
        makeConfig({
          routing_mode: 'fast',
          routing: {
            fastModel: 'small-model',
            heavyModel: 'big-model',
            fastProvider: 'local',
            providers: {
              local: {
                endpoint: 'http://192.168.1.100:8080/v1',
                enabled: true,
              },
            },
          },
        }),
        'hi',
        'default-model',
      );
      assert.equal(plan.providerTargets[0].name, 'local');
      assert.equal(plan.providerTargets[0].endpoint, 'http://192.168.1.100:8080/v1');
      assert.equal(plan.providerTargets[0].model, 'small-model');
    });

    it('skips disabled providers', () => {
      const plan = decideTurnRoute(
        makeConfig({
          routing_mode: 'fast',
          routing: {
            fastModel: 'small-model',
            fastProvider: 'local',
            providers: {
              local: { endpoint: 'http://x:8080/v1', enabled: false },
            },
          },
        }),
        'hi',
        'default-model',
      );
      // Should fall back to default provider
      assert.equal(plan.providerTargets.length, 1);
      assert.equal(plan.providerTargets[0].name, 'default');
    });

    it('includes fallback providers in order', () => {
      const plan = decideTurnRoute(
        makeConfig({
          routing_mode: 'fast',
          routing: {
            fastModel: 'small-model',
            heavyModel: 'big-model',
            fastProvider: 'primary',
            fallbackProviders: ['secondary'],
            providers: {
              primary: { endpoint: 'http://a:8080/v1', enabled: true },
              secondary: { endpoint: 'http://b:8080/v1', enabled: true },
            },
          },
        }),
        'hi',
        'default-model',
      );
      assert.equal(plan.providerTargets.length, 2);
      assert.equal(plan.providerTargets[0].name, 'primary');
      assert.equal(plan.providerTargets[1].name, 'secondary');
    });
  });

  describe('routing config: fallback models', () => {
    it('attaches lane-specific fallback models', () => {
      const plan = decideTurnRoute(
        makeConfig({
          routing_mode: 'fast',
          routing: {
            fastModel: 'small-v1',
            heavyModel: 'big-v1',
            fastFallbackModels: ['small-v0', 'tiny-v1'],
          },
        }),
        'hi',
        'default-model',
      );
      assert.deepEqual(plan.providerTargets[0].fallbackModels, ['small-v0', 'tiny-v1']);
    });

    it('merges model-specific fallbacks with lane fallbacks', () => {
      const plan = decideTurnRoute(
        makeConfig({
          routing_mode: 'heavy',
          routing: {
            fastModel: 'small',
            heavyModel: 'big-v2',
            heavyFallbackModels: ['big-v1'],
            modelFallbacks: { 'big-v2': ['big-v0'] },
          },
        }),
        'hi',
        'default-model',
      );
      const fb = plan.providerTargets[0].fallbackModels;
      assert.ok(fb.includes('big-v1'));
      assert.ok(fb.includes('big-v0'));
    });
  });

  describe('routing config: hintModeMap', () => {
    it('custom hint mapping overrides default code→heavy', () => {
      const plan = decideTurnRoute(
        makeConfig({
          routing_mode: 'auto',
          routing: {
            fastModel: 'small',
            heavyModel: 'big',
            hintModeMap: { code: 'fast' },
          },
        }),
        'refactor the database layer to use connection pooling',
        'default-model',
      );
      assert.equal(plan.classificationHint, 'code');
      assert.equal(plan.selectedMode, 'fast');
      assert.equal(plan.selectedModeSource, 'classifier');
    });
  });

  describe('routing config: defaultMode from routing block', () => {
    it('routing.defaultMode=heavy overrides routing_mode=auto when routing_mode not explicitly set', () => {
      const plan = decideTurnRoute(
        makeConfig({
          routing_mode: undefined,
          routing: {
            defaultMode: 'heavy',
            fastModel: 'small',
            heavyModel: 'big',
          },
        }),
        'what time is it?',
        'default-model',
      );
      assert.equal(plan.requestedMode, 'heavy');
      assert.equal(plan.selectedMode, 'heavy');
      assert.equal(plan.selectedModeSource, 'override');
    });
  });

  describe('query classification disabled', () => {
    it('falls to heuristic when query_classification.enabled=false', () => {
      const plan = decideTurnRoute(
        makeConfig({
          routing_mode: 'auto',
          query_classification: { enabled: false },
        }),
        'hello',
        'default-model',
      );
      assert.equal(plan.classificationHint, null);
      assert.equal(plan.selectedModeSource, 'heuristic');
    });
  });

  describe('provider target always present', () => {
    it('returns at least one default provider target even with no routing config', () => {
      const plan = decideTurnRoute(
        makeConfig({ routing_mode: 'auto' }),
        'hello',
        'my-model',
      );
      assert.ok(plan.providerTargets.length >= 1);
      assert.equal(plan.providerTargets[0].name, 'default');
    });
  });
});
