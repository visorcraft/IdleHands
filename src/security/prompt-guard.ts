/**
 * Prompt Injection Guard
 *
 * Scans incoming user messages for prompt injection patterns:
 * - System prompt override attempts
 * - Role confusion attacks
 * - Secret extraction attempts
 * - Jailbreak attempts (DAN, developer mode, etc.)
 * - Tool call JSON injection
 *
 * Returns a scored result with configurable action (warn/block/sanitize).
 *
 * Inspired by ZeroClaw's prompt_guard.rs.
 */

export type GuardAction = 'warn' | 'block' | 'sanitize';

export interface GuardResult {
  safe: boolean;
  /** Array of detected pattern category names. */
  patterns: string[];
  /** Normalized score 0-1, higher = more suspicious. */
  score: number;
  /** If action=block and score exceeds sensitivity, this is the block reason. */
  blocked?: string;
}

type CategoryChecker = (content: string, lower: string) => { name: string; score: number } | null;

const systemOverridePatterns = [
  /ignore\s+(?:(?:all\s+)?(?:previous|above|prior)|all)\s+(?:instructions?|prompts?|commands?)/i,
  /disregard\s+(?:previous|all|above|prior)/i,
  /forget\s+(?:previous|all|everything|above)/i,
  /new\s+(?:instructions?|rules?|system\s+prompt)/i,
  /override\s+(?:system|instructions?|rules?)/i,
  /reset\s+(?:instructions?|context|system)/i,
];

const roleConfusionPatterns = [
  /(?:you\s+are\s+now|act\s+as|pretend\s+(?:you're|to\s+be))\s+(?:a|an|the)?/i,
  /(?:your\s+new\s+role|you\s+have\s+become|you\s+must\s+be)/i,
  /from\s+now\s+on\s+(?:you\s+are|act\s+as|pretend)/i,
  /(?:assistant|AI|system|model):\s*\[?(?:system|override|new\s+role)/i,
];

const secretExtractionPatterns = [
  /(?:list|show|print|display|reveal|tell\s+me)\s+(?:all\s+)?(?:secrets?|credentials?|passwords?|tokens?|keys?)/i,
  /(?:what|show)\s+(?:are|is|me)\s+(?:all\s+)?(?:your|the)\s+(?:api\s+)?(?:keys?|secrets?|credentials?)/i,
  /contents?\s+of\s+(?:vault|secrets?|credentials?)/i,
  /(?:dump|export)\s+(?:vault|secrets?|credentials?)/i,
];

const jailbreakPatterns = [
  /\bDAN\b.*mode/i,
  /do\s+anything\s+now/i,
  /enter\s+(?:developer|debug|admin)\s+mode/i,
  /enable\s+(?:developer|debug|admin)\s+mode/i,
  /in\s+this\s+hypothetical/i,
  /imagine\s+you\s+(?:have\s+no|don't\s+have)\s+(?:restrictions?|rules?|limits?)/i,
  /decode\s+(?:this|the\s+following)\s+(?:base64|hex|rot13)/i,
];

const categoryCheckers: CategoryChecker[] = [
  (content, _lower) => {
    for (const re of systemOverridePatterns) {
      if (re.test(content)) return { name: 'system_prompt_override', score: 1.0 };
    }
    return null;
  },
  (content, _lower) => {
    for (const re of roleConfusionPatterns) {
      if (re.test(content)) return { name: 'role_confusion', score: 0.9 };
    }
    return null;
  },
  (content, lower) => {
    // Tool call injection
    if (lower.includes('tool_calls') || lower.includes('function_call')) {
      if (content.includes('{"type":') || content.includes('{"name":')) {
        return { name: 'tool_call_injection', score: 0.8 };
      }
    }
    if (content.includes('}"}') || content.includes("}'}")) {
      return { name: 'json_escape_attempt', score: 0.7 };
    }
    return null;
  },
  (content, _lower) => {
    for (const re of secretExtractionPatterns) {
      if (re.test(content)) return { name: 'secret_extraction', score: 0.95 };
    }
    return null;
  },
  (content, _lower) => {
    for (const re of jailbreakPatterns) {
      if (re.test(content)) return { name: 'jailbreak_attempt', score: 0.85 };
    }
    return null;
  },
];

export class PromptGuard {
  private action: GuardAction;
  private sensitivity: number;

  constructor(action: GuardAction = 'warn', sensitivity = 0.7) {
    this.action = action;
    this.sensitivity = Math.max(0, Math.min(1, sensitivity));
  }

  /** Scan a message for prompt injection patterns. */
  scan(content: string): GuardResult {
    const lower = content.toLowerCase();
    const detected: Array<{ name: string; score: number }> = [];

    for (const checker of categoryCheckers) {
      const result = checker(content, lower);
      if (result) detected.push(result);
    }

    if (detected.length === 0) {
      return { safe: true, patterns: [], score: 0 };
    }

    const maxScore = Math.max(...detected.map((d) => d.score));
    const totalScore = detected.reduce((sum, d) => sum + d.score, 0);
    const normalizedScore = Math.min(1, totalScore / categoryCheckers.length);
    const patterns = detected.map((d) => d.name);

    if (this.action === 'block' && maxScore > this.sensitivity) {
      return {
        safe: false,
        patterns,
        score: normalizedScore,
        blocked: `Potential prompt injection detected (score: ${normalizedScore.toFixed(2)}): ${patterns.join(', ')}`,
      };
    }

    return { safe: false, patterns, score: normalizedScore };
  }
}
