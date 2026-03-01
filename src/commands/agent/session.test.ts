import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IdleHandsConfig } from "../../config/config.js";

const mocks = vi.hoisted(() => ({
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn(),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    loadSessionStore: mocks.loadSessionStore,
    resolveStorePath: mocks.resolveStorePath,
  };
});

const { resolveSessionKeyForRequest } = await import("./session.js");

describe("resolveSessionKeyForRequest", () => {
  const MAIN_STORE_PATH = "/tmp/main-store.json";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
    mocks.loadSessionStore.mockReturnValue({});
  });

  const baseCfg: IdleHandsConfig = {};

  it("returns sessionKey when --to resolves a session key via context", async () => {
    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      to: "+15551234567",
    });
    expect(result.sessionKey).toBe("agent:main:main");
  });

  it("does not reverse-lookup by --session-id and creates isolated key", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:main": { sessionId: "target-session-id", updatedAt: 0 },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "target-session-id",
    });
    expect(result.sessionKey).toBe("agent:main:main:sid:target-session-id");
  });

  it("isolates --to-derived key when --session-id is provided", async () => {
    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      to: "+15551234567",
      sessionId: "target-session-id",
    });
    expect(result.sessionKey).toBe("agent:main:main:sid:target-session-id");
    expect(result.storePath).toBe(MAIN_STORE_PATH);
  });

  it("uses explicit agent id when creating isolated session key", async () => {
    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "target-session-id",
      agentId: "task1",
    });
    expect(result.sessionKey).toBe("agent:task1:main:sid:target-session-id");
  });

  it("still honors explicit sessionKey", async () => {
    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionKey: "agent:main:main",
      sessionId: "target-session-id",
    });
    expect(result.sessionKey).toBe("agent:main:main");
  });
});
