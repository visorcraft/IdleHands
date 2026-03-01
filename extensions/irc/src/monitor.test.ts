import { describe, expect, it } from "vitest";
import { resolveIrcInboundTarget } from "./monitor.js";

describe("irc monitor inbound target", () => {
  it("keeps channel target for group messages", () => {
    expect(
      resolveIrcInboundTarget({
        target: "#idlehands",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: true,
      target: "#idlehands",
      rawTarget: "#idlehands",
    });
  });

  it("maps DM target to sender nick and preserves raw target", () => {
    expect(
      resolveIrcInboundTarget({
        target: "idlehands-bot",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: false,
      target: "alice",
      rawTarget: "idlehands-bot",
    });
  });

  it("falls back to raw target when sender nick is empty", () => {
    expect(
      resolveIrcInboundTarget({
        target: "idlehands-bot",
        senderNick: " ",
      }),
    ).toEqual({
      isGroup: false,
      target: "idlehands-bot",
      rawTarget: "idlehands-bot",
    });
  });
});
