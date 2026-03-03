import { describe, expect, it } from "vitest";
import { resolveAntonExecutionConfig } from "./anton.js";

describe("resolveAntonExecutionConfig", () => {
  it("falls back to direct mode when preflight.enabled is false", () => {
    const resolved = resolveAntonExecutionConfig({
      config: {
        mode: "preflight",
        preflight: {
          enabled: false,
        },
      },
    });

    expect(resolved.mode).toBe("direct");
  });

  it("keeps preflight mode when preflight.enabled is true and reads nested settings", () => {
    const resolved = resolveAntonExecutionConfig({
      config: {
        mode: "preflight",
        preflight: {
          enabled: true,
          requirementsReview: true,
          discoveryTimeoutSec: 321,
          reviewTimeoutSec: 654,
          maxRetries: 7,
        },
        taskTimeoutSec: 999,
      },
    });

    expect(resolved.mode).toBe("preflight");
    expect(resolved.requirementsReview).toBe(true);
    expect(resolved.discoveryTimeoutSec).toBe(321);
    expect(resolved.reviewTimeoutSec).toBe(654);
    expect(resolved.preflightMaxRetries).toBe(7);
    expect(resolved.codebaseSnapshot).toBe(true);
  });

  it("reads preflight.codebaseSnapshot override", () => {
    const resolved = resolveAntonExecutionConfig({
      config: {
        mode: "preflight",
        preflight: {
          enabled: true,
          codebaseSnapshot: false,
        },
      },
    });

    expect(resolved.codebaseSnapshot).toBe(false);
  });

  it("resolves Anton-specific thinking defaults per mode/phase", () => {
    const resolved = resolveAntonExecutionConfig({
      config: {
        mode: "preflight",
        thinking: {
          direct: "off",
          preflight: {
            phase1: "minimal",
            phase2: "high",
          },
        },
      },
    });

    expect(resolved.directThinkLevel).toBe("off");
    expect(resolved.preflightPhase1ThinkLevel).toBe("minimal");
    expect(resolved.preflightPhase2ThinkLevel).toBe("high");
  });

  it("supports legacy flat anton fields and prefers them over nested values", () => {
    const resolved = resolveAntonExecutionConfig({
      config: {
        mode: "preflight",
        requirementsReview: true,
        discoveryTimeoutSec: 111,
        reviewTimeoutSec: 222,
        preflightMaxRetries: 5,
        preflight: {
          enabled: true,
          requirementsReview: false,
          discoveryTimeoutSec: 333,
          reviewTimeoutSec: 444,
          maxRetries: 6,
        },
      },
    });

    expect(resolved.mode).toBe("preflight");
    expect(resolved.requirementsReview).toBe(true);
    expect(resolved.discoveryTimeoutSec).toBe(111);
    expect(resolved.reviewTimeoutSec).toBe(222);
    expect(resolved.preflightMaxRetries).toBe(5);
  });

  it("applies mode override and still enforces preflight.enabled=false fallback", () => {
    const resolved = resolveAntonExecutionConfig({
      modeOverride: "preflight",
      config: {
        mode: "direct",
        preflight: {
          enabled: false,
        },
      },
    });

    expect(resolved.mode).toBe("direct");
  });
});
