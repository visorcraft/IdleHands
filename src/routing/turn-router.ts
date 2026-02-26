import {
  classify,
  defaultClassificationRules,
  type ClassificationRule,
} from '../agent/query-classifier.js';
import type { IdlehandsConfig, RoutingMode } from '../types.js';
import { determineRouting, type RoutingDecision } from './policy.js';
import { getEffectiveRoutingMode, normalizeRoutingMode } from './mode.js';

export type RouteLane = Exclude<RoutingMode, 'auto'>;

export type RouteProviderTarget = {
  name: string;
  endpoint?: string;
  model: string;
  fallbackModels: string[];
};

export type TurnRoutePlan = {
  requestedMode: RoutingMode;
  selectedMode: RouteLane;
  selectedModeSource: 'override' | 'classifier' | 'heuristic' | 'hysteresis';
  classificationHint: string | null;
  heuristicDecision?: RoutingDecision;
  providerTargets: RouteProviderTarget[];
};

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === 'string' && v.trim().length > 0))];
}

function normalizeRules(raw: unknown): ClassificationRule[] {
  if (!Array.isArray(raw) || raw.length === 0) return defaultClassificationRules();

  const out: ClassificationRule[] = [];
  for (const item of raw) {
    const r = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    if (!r) continue;

    const hint = typeof r.hint === 'string' ? r.hint.trim() : '';
    if (!hint) continue;

    const keywords = Array.isArray(r.keywords)
      ? r.keywords.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const patterns = Array.isArray(r.patterns)
      ? r.patterns.map((x) => String(x)).filter(Boolean)
      : [];

    const priority =
      typeof r.priority === 'number' && Number.isFinite(r.priority) ? Math.floor(r.priority) : 0;

    const minLength =
      typeof r.minLength === 'number' && Number.isFinite(r.minLength)
        ? Math.max(0, Math.floor(r.minLength))
        : undefined;

    const maxLength =
      typeof r.maxLength === 'number' && Number.isFinite(r.maxLength)
        ? Math.max(0, Math.floor(r.maxLength))
        : undefined;

    out.push({ hint, keywords, patterns, priority, minLength, maxLength });
  }

  return out.length ? out : defaultClassificationRules();
}

function laneFromHint(hint: string | null, configHintMap?: Record<string, string>): RouteLane | null {
  if (!hint) return null;

  const mapped = configHintMap?.[hint];
  const normalizedMapped = normalizeRoutingMode(mapped);
  if (normalizedMapped === 'fast' || normalizedMapped === 'heavy') return normalizedMapped;

  const lower = hint.toLowerCase();
  if (lower === 'fast') return 'fast';
  if (lower === 'code' || lower === 'reasoning') return 'heavy';
  return null;
}

function laneFromHeuristicDecision(decision: RoutingDecision): RouteLane {
  return decision.includes('heavy') ? 'heavy' : 'fast';
}

export function decideTurnRoute(config: IdlehandsConfig, prompt: string, currentModel: string): TurnRoutePlan {
  const requestedMode = getEffectiveRoutingMode(config);
  const routing = config.routing;

  const classificationEnabled = config.query_classification?.enabled !== false;
  const rules = normalizeRules(config.query_classification?.rules);
  const classificationHint = classificationEnabled
    ? classify({ enabled: true, rules }, prompt)
    : null;

  const hintLane = laneFromHint(classificationHint, routing?.hintModeMap as Record<string, string>);

  let selectedMode: RouteLane;
  let selectedModeSource: TurnRoutePlan['selectedModeSource'];
  let heuristicDecision: RoutingDecision | undefined;

  if (requestedMode === 'fast' || requestedMode === 'heavy') {
    selectedMode = requestedMode;
    selectedModeSource = 'override';
  } else if (hintLane) {
    selectedMode = hintLane;
    selectedModeSource = 'classifier';
  } else {
    heuristicDecision = determineRouting(prompt, undefined, undefined, 'auto', undefined, routing);
    selectedMode = laneFromHeuristicDecision(heuristicDecision);
    selectedModeSource = 'heuristic';
  }

  const laneModel =
    selectedMode === 'fast'
      ? (routing?.fastModel?.trim() || currentModel)
      : (routing?.heavyModel?.trim() || currentModel);

  const laneFallbacks =
    selectedMode === 'fast' ? routing?.fastFallbackModels ?? [] : routing?.heavyFallbackModels ?? [];
  const modelFallbacks = routing?.modelFallbacks?.[laneModel] ?? [];
  const baseFallbacks = uniq([...laneFallbacks, ...modelFallbacks].filter((m) => m !== laneModel));

  const primaryProvider =
    (selectedMode === 'fast' ? routing?.fastProvider : routing?.heavyProvider) || 'default';
  const fallbackProviders = Array.isArray(routing?.fallbackProviders) ? routing!.fallbackProviders : [];
  const providerOrder = uniq([primaryProvider, ...fallbackProviders]);

  const targets: RouteProviderTarget[] = [];
  for (const providerName of providerOrder) {
    if (providerName === 'default') {
      targets.push({
        name: 'default',
        model: laneModel,
        fallbackModels: baseFallbacks,
      });
      continue;
    }

    const providerCfg = routing?.providers?.[providerName];
    if (!providerCfg || providerCfg.enabled === false) continue;

    const endpoint = providerCfg.endpoint?.trim();
    const providerModel = providerCfg.model?.trim() || laneModel;
    const providerFallbacks = uniq([
      ...baseFallbacks,
      ...(Array.isArray(providerCfg.fallbackModels) ? providerCfg.fallbackModels : []),
    ]).filter((m) => m !== providerModel);

    targets.push({
      name: providerName,
      endpoint: endpoint && endpoint.length ? endpoint : undefined,
      model: providerModel,
      fallbackModels: providerFallbacks,
    });
  }

  if (!targets.length) {
    targets.push({
      name: 'default',
      model: laneModel,
      fallbackModels: baseFallbacks,
    });
  }

  return {
    requestedMode,
    selectedMode,
    selectedModeSource,
    classificationHint,
    heuristicDecision,
    providerTargets: targets,
  };
}
