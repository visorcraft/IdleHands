import type { Message } from 'discord.js';

import type {
  ApprovalMode,
  AgentPersona,
  AgentRouting,
  BotDiscordConfig,
  ModelEscalation,
} from '../types.js';

import { sanitizeBotOutputText } from './format.js';

export function parseAllowedUsers(cfg: BotDiscordConfig): Set<string> {
  const fromEnv = process.env.IDLEHANDS_DISCORD_ALLOWED_USERS;
  if (fromEnv && fromEnv.trim()) {
    return new Set(
      fromEnv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }

  const values = Array.isArray(cfg.allowed_users) ? cfg.allowed_users : [];
  return new Set(values.map((v) => String(v).trim()).filter(Boolean));
}

export function normalizeApprovalMode(
  mode: string | undefined,
  fallback: ApprovalMode
): ApprovalMode {
  const m = String(mode ?? '')
    .trim()
    .toLowerCase();
  if (m === 'plan' || m === 'default' || m === 'auto-edit' || m === 'yolo') return m;
  return fallback;
}

export function splitDiscord(text: string, limit = 1900): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + limit));
    i += limit;
  }
  return chunks;
}

export function safeContent(text: string): string {
  const t = sanitizeBotOutputText(text).trim();
  if (t.length) return t;

  // Provide informative fallback based on context
  // If we have some content but it was all stripped, mention that
  if (text && text.trim().length) {
    return '(response contained only protocol artifacts - no user-visible content)';
  }
  return '(no response generated - task may be complete or awaiting further input)';
}

/**
 * Check if the model response contains an escalation request.
 * Returns { escalate: true, reason: string } if escalation marker found at start of response.
 */
export function detectEscalation(text: string): { escalate: boolean; reason?: string } {
  const trimmed = text.trim();
  const match = trimmed.match(/^\[ESCALATE:\s*([^\]]+)\]/i);
  if (match) {
    return { escalate: true, reason: match[1].trim() };
  }
  return { escalate: false };
}

/** Keyword presets for common escalation triggers */
const KEYWORD_PRESETS: Record<string, string[]> = {
  coding: [
    'build',
    'implement',
    'create',
    'develop',
    'architect',
    'refactor',
    'debug',
    'fix',
    'code',
    'program',
    'write',
  ],
  planning: ['plan', 'design', 'roadmap', 'strategy', 'analyze', 'research', 'evaluate', 'compare'],
  complex: [
    'full',
    'complete',
    'comprehensive',
    'multi-step',
    'integrate',
    'migration',
    'overhaul',
    'entire',
    'whole',
  ],
};

/**
 * Check if text matches a set of keywords.
 * Returns matched keywords or empty array if none match.
 */
function matchKeywords(text: string, keywords: string[], presets?: string[]): string[] {
  const allKeywords: string[] = [...keywords];

  // Add preset keywords
  if (presets) {
    for (const preset of presets) {
      const presetWords = KEYWORD_PRESETS[preset];
      if (presetWords) allKeywords.push(...presetWords);
    }
  }

  if (allKeywords.length === 0) return [];

  const lowerText = text.toLowerCase();
  const matched: string[] = [];

  for (const kw of allKeywords) {
    if (kw.startsWith('re:')) {
      // Regex pattern
      try {
        const regex = new RegExp(kw.slice(3), 'i');
        if (regex.test(text)) matched.push(kw);
      } catch {
        // Invalid regex, skip
      }
    } else {
      // Word boundary match (case-insensitive)
      const wordRegex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (wordRegex.test(lowerText)) matched.push(kw);
    }
  }

  return matched;
}

/**
 * Check if user message matches keyword escalation triggers.
 * Returns { escalate: true, tier: number, reason: string } if keywords match.
 * Tier indicates which model index to escalate to (highest matching tier wins).
 */
export function checkKeywordEscalation(
  text: string,
  escalation: ModelEscalation | undefined
): { escalate: boolean; tier?: number; reason?: string } {
  if (!escalation) return { escalate: false };

  // Tiered keyword escalation
  if (escalation.tiers && escalation.tiers.length > 0) {
    let highestTier = -1;
    let highestReason = '';

    // Check each tier, highest matching tier wins
    for (let i = 0; i < escalation.tiers.length; i++) {
      const tier = escalation.tiers[i];
      const matched = matchKeywords(
        text,
        tier.keywords || [],
        tier.keyword_presets as string[] | undefined
      );

      if (matched.length > 0 && i > highestTier) {
        highestTier = i;
        highestReason = `tier ${i} keyword match: ${matched.slice(0, 3).join(', ')}${matched.length > 3 ? '...' : ''}`;
      }
    }

    if (highestTier >= 0) {
      return { escalate: true, tier: highestTier, reason: highestReason };
    }

    return { escalate: false };
  }

  // Legacy flat keywords (treated as tier 0)
  const matched = matchKeywords(
    text,
    escalation.keywords || [],
    escalation.keyword_presets as string[] | undefined
  );

  if (matched.length > 0) {
    return {
      escalate: true,
      tier: 0,
      reason: `keyword match: ${matched.slice(0, 3).join(', ')}${matched.length > 3 ? '...' : ''}`,
    };
  }

  return { escalate: false };
}

/**
 * Resolve which agent persona should handle a message.
 * Priority: user > channel > guild > default > first agent > null
 */
export function resolveAgentForMessage(
  msg: Message,
  agents: Record<string, AgentPersona> | undefined,
  routing: AgentRouting | undefined
): { agentId: string; persona: AgentPersona | null } {
  const agentMap = agents ?? {};
  const agentIds = Object.keys(agentMap);

  // No agents configured — return null persona (use global config)
  if (agentIds.length === 0) {
    return { agentId: '_default', persona: null };
  }

  const route = routing ?? {};
  let resolvedId: string | undefined;

  // Priority 1: User-specific routing
  if (route.users && route.users[msg.author.id]) {
    resolvedId = route.users[msg.author.id];
  }
  // Priority 2: Channel-specific routing
  else if (route.channels && route.channels[msg.channelId]) {
    resolvedId = route.channels[msg.channelId];
  }
  // Priority 3: Guild-specific routing
  else if (msg.guildId && route.guilds && route.guilds[msg.guildId]) {
    resolvedId = route.guilds[msg.guildId];
  }
  // Priority 4: Default agent
  else if (route.default) {
    resolvedId = route.default;
  }
  // Priority 5: First defined agent
  else {
    resolvedId = agentIds[0];
  }

  // Validate the resolved agent exists
  const persona = agentMap[resolvedId];
  if (!persona) {
    // Fallback to first agent if routing points to non-existent agent
    const fallbackId = agentIds[0];
    return { agentId: fallbackId, persona: agentMap[fallbackId] ?? null };
  }

  return { agentId: resolvedId, persona };
}

export function sessionKeyForMessage(msg: Message, allowGuilds: boolean, agentId: string): string {
  // Include agentId in session key so switching agents creates a new session
  if (allowGuilds) {
    // Per-agent+channel+user session in guilds
    return `${agentId}:${msg.channelId}:${msg.author.id}`;
  }
  // DM-only mode: per-agent+user session
  return `${agentId}:${msg.author.id}`;
}
