import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "idlehands",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "idlehands", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "idlehands", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "idlehands", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "idlehands", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "idlehands", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "idlehands", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "idlehands", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "idlehands", "--profile", "work", "--dev", "status"]],
  ])("rejects combining --dev with --profile (%s)", (_name, argv) => {
    const res = parseCliProfileArgs(argv);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".idlehands-dev");
    expect(env.IDLEHANDS_PROFILE).toBe("dev");
    expect(env.IDLEHANDS_STATE_DIR).toBe(expectedStateDir);
    expect(env.IDLEHANDS_CONFIG_PATH).toBe(path.join(expectedStateDir, "idlehands.json"));
    expect(env.IDLEHANDS_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      IDLEHANDS_STATE_DIR: "/custom",
      IDLEHANDS_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.IDLEHANDS_STATE_DIR).toBe("/custom");
    expect(env.IDLEHANDS_GATEWAY_PORT).toBe("19099");
    expect(env.IDLEHANDS_CONFIG_PATH).toBe(path.join("/custom", "idlehands.json"));
  });

  it("uses IDLEHANDS_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      IDLEHANDS_HOME: "/srv/idlehands-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/idlehands-home");
    expect(env.IDLEHANDS_STATE_DIR).toBe(path.join(resolvedHome, ".idlehands-work"));
    expect(env.IDLEHANDS_CONFIG_PATH).toBe(
      path.join(resolvedHome, ".idlehands-work", "idlehands.json"),
    );
  });
});

describe("formatCliCommand", () => {
  it.each([
    {
      name: "no profile is set",
      cmd: "idlehands doctor --fix",
      env: {},
      expected: "idlehands doctor --fix",
    },
    {
      name: "profile is default",
      cmd: "idlehands doctor --fix",
      env: { IDLEHANDS_PROFILE: "default" },
      expected: "idlehands doctor --fix",
    },
    {
      name: "profile is Default (case-insensitive)",
      cmd: "idlehands doctor --fix",
      env: { IDLEHANDS_PROFILE: "Default" },
      expected: "idlehands doctor --fix",
    },
    {
      name: "profile is invalid",
      cmd: "idlehands doctor --fix",
      env: { IDLEHANDS_PROFILE: "bad profile" },
      expected: "idlehands doctor --fix",
    },
    {
      name: "--profile is already present",
      cmd: "idlehands --profile work doctor --fix",
      env: { IDLEHANDS_PROFILE: "work" },
      expected: "idlehands --profile work doctor --fix",
    },
    {
      name: "--dev is already present",
      cmd: "idlehands --dev doctor",
      env: { IDLEHANDS_PROFILE: "dev" },
      expected: "idlehands --dev doctor",
    },
  ])("returns command unchanged when $name", ({ cmd, env, expected }) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("idlehands doctor --fix", { IDLEHANDS_PROFILE: "work" })).toBe(
      "idlehands --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("idlehands doctor --fix", { IDLEHANDS_PROFILE: "  jbidlehands  " })).toBe(
      "idlehands --profile jbidlehands doctor --fix",
    );
  });

  it("handles command with no args after idlehands", () => {
    expect(formatCliCommand("idlehands", { IDLEHANDS_PROFILE: "test" })).toBe(
      "idlehands --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm idlehands doctor", { IDLEHANDS_PROFILE: "work" })).toBe(
      "pnpm idlehands --profile work doctor",
    );
  });
});
