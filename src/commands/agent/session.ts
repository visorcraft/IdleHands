import crypto from "node:crypto";
// listAgentIds import removed: --session-id no longer does reverse lookup by id.
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../../auto-reply/thinking.js";
import type { IdleHandsConfig } from "../../config/config.js";
import {
  evaluateSessionFreshness,
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveChannelResetConfig,
  resolveExplicitAgentSessionKey,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../../config/sessions.js";
import { normalizeAgentId, normalizeMainKey } from "../../routing/session-key.js";

export type SessionResolution = {
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  storePath: string;
  isNewSession: boolean;
  persistedThinking?: ThinkLevel;
  persistedVerbose?: VerboseLevel;
};

type SessionKeyResolution = {
  sessionKey?: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
};

export function resolveSessionKeyForRequest(opts: {
  cfg: IdleHandsConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionKeyResolution {
  const sessionCfg = opts.cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const userSessionKey = opts.sessionKey?.trim();
  const agentDefaultSessionKey = resolveExplicitAgentSessionKey({
    cfg: opts.cfg,
    agentId: opts.agentId,
  });
  const explicitSessionKey = userSessionKey || agentDefaultSessionKey;
  const storeAgentId = resolveAgentIdFromSessionKey(explicitSessionKey);
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: storeAgentId,
  });
  const sessionStore = loadSessionStore(storePath);

  const ctx: MsgContext | undefined = opts.to?.trim() ? { From: opts.to } : undefined;
  let sessionKey: string | undefined =
    explicitSessionKey ?? (ctx ? resolveSessionKey(scope, ctx, mainKey) : undefined);

  // IMPORTANT: --session-id is treated as a fresh transcript identifier, not a resume token.
  // To prevent lock contention and accidental history reuse on canonical keys like
  // agent:<id>:main, route explicit session ids to an isolated per-session key.
  const explicitSessionId = opts.sessionId?.trim();
  if (explicitSessionId && !userSessionKey) {
    const derivedAgentId = normalizeAgentId(
      opts.agentId || resolveAgentIdFromSessionKey(sessionKey),
    );
    const baseRest = sessionKey ? sessionKey.replace(/^agent:[^:]+:/i, "") : mainKey;
    sessionKey = `agent:${derivedAgentId}:${baseRest}:sid:${explicitSessionId}`;
  }

  return { sessionKey, sessionStore, storePath };
}

export function resolveSession(opts: {
  cfg: IdleHandsConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionResolution {
  const sessionCfg = opts.cfg.session;
  const { sessionKey, sessionStore, storePath } = resolveSessionKeyForRequest({
    cfg: opts.cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    agentId: opts.agentId,
  });
  const now = Date.now();

  const sessionEntry = sessionKey ? sessionStore[sessionKey] : undefined;

  const resetType = resolveSessionResetType({ sessionKey });
  const channelReset = resolveChannelResetConfig({
    sessionCfg,
    channel: sessionEntry?.lastChannel ?? sessionEntry?.channel,
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    resetOverride: channelReset,
  });
  const fresh = sessionEntry
    ? evaluateSessionFreshness({ updatedAt: sessionEntry.updatedAt, now, policy: resetPolicy })
        .fresh
    : false;
  const explicitSessionId = opts.sessionId?.trim();
  const sessionId =
    explicitSessionId || (fresh ? sessionEntry?.sessionId : undefined) || crypto.randomUUID();
  // Explicit --session-id must always start a new history, even if the session key exists.
  const isNewSession = Boolean(explicitSessionId) || !fresh;

  const persistedThinking =
    !explicitSessionId && fresh && sessionEntry?.thinkingLevel
      ? normalizeThinkLevel(sessionEntry.thinkingLevel)
      : undefined;
  const persistedVerbose =
    !explicitSessionId && fresh && sessionEntry?.verboseLevel
      ? normalizeVerboseLevel(sessionEntry.verboseLevel)
      : undefined;

  return {
    sessionId,
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
  };
}
