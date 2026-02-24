// Shared escalation detection logic for bot frontends

export interface EscalationTier {
  keywords?: string[];
  keyword_presets?: string[];
}

export interface ModelEscalation {
  enabled: boolean;
  tiers?: EscalationTier[];
  keywords?: string[];
}

export interface EscalationResult {
  escalate: boolean;
  tier?: number;
  reason?: string;
}

/** Keyword presets for common escalation triggers */
const ESCALATION_PRESETS: Record<string, string[]> = {
  human: [
    'human',
    'person',
    'real person',
    'actual person',
    'not an ai',
    'not ai',
    'not an ai',
    'not an assistant',
    'not a bot',
    'not a machine',
  ],
  emergency: [
    'emergency',
    'urgent',
    'critical',
    'immediate',
    'help',
    'save',
    'rescue',
    'danger',
    'hurt',
    'injured',
  ],
  abuse: [
    'abuse',
    'harassment',
    'bullying',
    'threat',
    'threaten',
    'violence',
    'violence',
    'attack',
    'assault',
  ],
};

/** Check if the model response contains an escalation request.
 * Returns { escalate: true, reason: string } if escalation marker found at start of response.
 */
export function detectEscalation(text: string): EscalationResult {
  const trimmed = text.trim().toLowerCase();
  const markers = [
    'escalate',
    'escalate to human',
    'escalate to a human',
    'escalate to the human',
    'transfer to human',
    'transfer to a human',
    'transfer to the human',
    'human takeover',
    'human please',
    'human operator',
    'operator please',
    'agent please',
    'agent takeover',
  ];

  for (const marker of markers) {
    if (trimmed.startsWith(marker)) {
      return { escalate: true, reason: `escalation marker: "${marker}"` };
    }
  }

  return { escalate: false };
}

/** Check if text matches a set of keywords.
 * Returns matched keywords or empty array if none match.
 */
export function matchKeywords(text: string, keywords: string[], presets?: string[]): string[] {
  const allKeywords: string[] = [...keywords];
  if (presets) {
    for (const preset of presets) {
      const presetKeywords = ESCALATION_PRESETS[preset.toLowerCase()];
      if (presetKeywords) {
        allKeywords.push(...presetKeywords);
      }
    }
  }

  const matched: string[] = [];
  const lowerText = text.toLowerCase();

  for (const keyword of allKeywords) {
    if (lowerText.includes(keyword.toLowerCase()) && !matched.includes(keyword)) {
      matched.push(keyword);
    }
  }

  return matched;
}

/** Check if user message matches keyword escalation triggers.
 * Returns { escalate: true, tier: number, reason: string } if keywords match.
 */
export function checkKeywordEscalation(
  text: string,
  escalation: ModelEscalation | undefined
): EscalationResult {
  if (!escalation) return { escalate: false };

  // Tiered keyword escalation
  if (escalation.tiers && escalation.tiers.length > 0) {
    let highestTier = 0;
    let highestReason = '';

    for (let i = 0; i < escalation.tiers.length; i++) {
      const tier = escalation.tiers[i];
      const matched = matchKeywords(
        text,
        tier.keywords || [],
        tier.keyword_presets as string[] | undefined
      );

      if (matched.length > 0) {
        highestTier = i + 1;
        highestReason = `tier ${i + 1} keyword match: ${matched.slice(0, 3).join(', ')}${
          matched.length > 3 ? '...' : ''
        }`;
      }
    }

    if (highestTier > 0) {
      return { escalate: true, tier: highestTier, reason: highestReason };
    }
  }

  // Legacy flat keywords (treated as tier 0)
  if (escalation.keywords && escalation.keywords.length > 0) {
    const matched = matchKeywords(text, escalation.keywords);
    if (matched.length > 0) {
      return {
        escalate: true,
        tier: 0,
        reason: `keyword match: ${matched.slice(0, 3).join(', ')}${matched.length > 3 ? '...' : ''}`,
      };
    }
  }

  return { escalate: false };
}
