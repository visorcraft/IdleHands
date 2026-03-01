/**
 * Emergency stop — bypass all queues and debouncing.
 * Called at the earliest ingress point (before debouncer) to guarantee immediate execution.
 */

import { abortEmbeddedPiRun } from "../../agents/pi-embedded.js";
import type { IdleHandsConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { logVerbose } from "../../globals.js";
import { isAbortRequestText } from "./abort.js";
import { formatAbortReplyText, stopSubagentsForRequester } from "./abort.js";
import { clearSessionQueues } from "./queue.js";

export { isAbortRequestText };

export type EmergencyStopResult = {
  aborted: boolean;
  replyText: string;
  sessionKey?: string;
};

/**
 * Execute an emergency stop for a session.
 * Clears all queues, aborts embedded runs, and stops subagents.
 * Returns the reply text to send to the user.
 */
export function emergencyStop(params: {
  cfg: IdleHandsConfig;
  sessionKey?: string;
  sessionId?: string;
  sessionStore?: Record<string, SessionEntry>;
}): EmergencyStopResult {
  const { cfg, sessionKey, sessionId } = params;

  // 1. Clear all queues for this session
  const cleared = clearSessionQueues([sessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `emergency-stop: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }

  // 2. Abort embedded run
  if (sessionId) {
    abortEmbeddedPiRun(sessionId);
  }

  // 3. Stop subagents
  const { stopped } = stopSubagentsForRequester({
    cfg,
    requesterSessionKey: sessionKey,
  });

  logVerbose(
    `emergency-stop: sessionKey=${sessionKey} sessionId=${sessionId} stoppedSubagents=${stopped}`,
  );

  return {
    aborted: true,
    replyText: formatAbortReplyText(stopped),
    sessionKey,
  };
}

/**
 * Resolve session info from the session store for emergency stop.
 * Lightweight — just reads the store, no locks.
 */
export function resolveSessionForEmergencyStop(sessionKey: string): {
  sessionId?: string;
  store?: Record<string, SessionEntry>;
} {
  try {
    const storePath = resolveDefaultSessionStorePath();
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    return {
      sessionId: entry?.sessionId,
      store,
    };
  } catch {
    return {};
  }
}
