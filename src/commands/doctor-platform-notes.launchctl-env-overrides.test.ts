import { describe, expect, it, vi } from "vitest";
import type { IdleHandsConfig } from "../config/config.js";
import { noteMacLaunchctlGatewayEnvOverrides } from "./doctor-platform-notes.js";

describe("noteMacLaunchctlGatewayEnvOverrides", () => {
  it("prints clear unsetenv instructions for token override", async () => {
    const noteFn = vi.fn();
    const getenv = vi.fn(async (name: string) =>
      name === "IDLEHANDS_GATEWAY_TOKEN" ? "launchctl-token" : undefined,
    );
    const cfg = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    } as IdleHandsConfig;

    await noteMacLaunchctlGatewayEnvOverrides(cfg, { platform: "darwin", getenv, noteFn });

    expect(noteFn).toHaveBeenCalledTimes(1);
    expect(getenv).toHaveBeenCalledTimes(4);

    const [message, title] = noteFn.mock.calls[0] ?? [];
    expect(title).toBe("Gateway (macOS)");
    expect(message).toContain("launchctl environment overrides detected");
    expect(message).toContain("IDLEHANDS_GATEWAY_TOKEN");
    expect(message).toContain("launchctl unsetenv IDLEHANDS_GATEWAY_TOKEN");
    expect(message).not.toContain("IDLEHANDS_GATEWAY_PASSWORD");
  });

  it("does nothing when config has no gateway credentials", async () => {
    const noteFn = vi.fn();
    const getenv = vi.fn(async () => "launchctl-token");
    const cfg = {} as IdleHandsConfig;

    await noteMacLaunchctlGatewayEnvOverrides(cfg, { platform: "darwin", getenv, noteFn });

    expect(getenv).not.toHaveBeenCalled();
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("does nothing on non-darwin platforms", async () => {
    const noteFn = vi.fn();
    const getenv = vi.fn(async () => "launchctl-token");
    const cfg = {
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    } as IdleHandsConfig;

    await noteMacLaunchctlGatewayEnvOverrides(cfg, { platform: "linux", getenv, noteFn });

    expect(getenv).not.toHaveBeenCalled();
    expect(noteFn).not.toHaveBeenCalled();
  });
});
