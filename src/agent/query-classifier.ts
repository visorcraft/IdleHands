/**
 * Query Classifier
 *
 * Classifies user messages against configurable rules to produce routing
 * hints like "fast", "reasoning", "code". These hints can be used by a
 * model router to dispatch to different provider+model combos.
 *
 * Inspired by ZeroClaw's classifier.rs.
 */

export interface ClassificationRule {
  /** Routing hint to produce when matched (e.g., "fast", "reasoning", "code"). */
  hint: string;
  /** Keywords to match (case-insensitive). */
  keywords: string[];
  /** Patterns to match (case-sensitive). */
  patterns: string[];
  /** Priority for tie-breaking (higher wins). */
  priority: number;
  /** Minimum message length to match. */
  minLength?: number;
  /** Maximum message length to match. */
  maxLength?: number;
}

export interface QueryClassificationConfig {
  enabled: boolean;
  rules: ClassificationRule[];
}

export interface ClassificationDecision {
  hint: string;
  priority: number;
}

/**
 * Classify a user message and return the matched hint.
 * Returns null when classification is disabled, no rules are configured,
 * or no rule matches the message.
 */
export function classify(config: QueryClassificationConfig, message: string): string | null {
  const decision = classifyWithDecision(config, message);
  return decision?.hint ?? null;
}

/**
 * Classify a user message and return the matched hint with metadata.
 */
export function classifyWithDecision(
  config: QueryClassificationConfig,
  message: string
): ClassificationDecision | null {
  if (!config.enabled || config.rules.length === 0) return null;

  const lower = message.toLowerCase();
  const len = message.length;

  // Sort by priority descending (highest first)
  const sortedRules = [...config.rules].sort((a, b) => b.priority - a.priority);

  for (const rule of sortedRules) {
    // Length constraints
    if (rule.minLength != null && len < rule.minLength) continue;
    if (rule.maxLength != null && len > rule.maxLength) continue;

    // Check keywords (case-insensitive) and patterns (case-sensitive)
    const keywordHit = rule.keywords.some((kw) => lower.includes(kw.toLowerCase()));
    const patternHit = rule.patterns.some((pat) => message.includes(pat));

    if (keywordHit || patternHit) {
      return { hint: rule.hint, priority: rule.priority };
    }
  }

  return null;
}

/**
 * Built-in default classification rules for common patterns.
 * Users can override or extend these.
 */
export function defaultClassificationRules(): ClassificationRule[] {
  return [
    {
      hint: 'fast',
      keywords: ['hi', 'hello', 'hey', 'thanks', 'yes', 'no', 'ok', 'sure', 'bye'],
      patterns: [],
      priority: 1,
      maxLength: 50,
    },
    {
      hint: 'code',
      keywords: ['code', 'function', 'class', 'refactor', 'debug', 'fix', 'implement', 'build', 'test', 'compile'],
      patterns: ['fn ', 'def ', 'class ', 'const ', 'let ', 'var ', 'import ', 'export '],
      priority: 5,
    },
    {
      hint: 'reasoning',
      keywords: ['explain', 'why', 'analyze', 'compare', 'evaluate', 'think about', 'reason', 'consider'],
      patterns: [],
      priority: 3,
      minLength: 30,
    },
  ];
}
