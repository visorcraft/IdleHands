import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it.each([
    {
      name: "help flag",
      argv: ["node", "idlehands", "--help"],
      expected: true,
    },
    {
      name: "version flag",
      argv: ["node", "idlehands", "-V"],
      expected: true,
    },
    {
      name: "normal command",
      argv: ["node", "idlehands", "status"],
      expected: false,
    },
    {
      name: "root -v alias",
      argv: ["node", "idlehands", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with profile",
      argv: ["node", "idlehands", "--profile", "work", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with log-level",
      argv: ["node", "idlehands", "--log-level", "debug", "-v"],
      expected: true,
    },
    {
      name: "subcommand -v should not be treated as version",
      argv: ["node", "idlehands", "acp", "-v"],
      expected: false,
    },
    {
      name: "root -v alias with equals profile",
      argv: ["node", "idlehands", "--profile=work", "-v"],
      expected: true,
    },
    {
      name: "subcommand path after global root flags should not be treated as version",
      argv: ["node", "idlehands", "--dev", "skills", "list", "-v"],
      expected: false,
    },
  ])("detects help/version flags: $name", ({ argv, expected }) => {
    expect(hasHelpOrVersion(argv)).toBe(expected);
  });

  it.each([
    {
      name: "single command with trailing flag",
      argv: ["node", "idlehands", "status", "--json"],
      expected: ["status"],
    },
    {
      name: "two-part command",
      argv: ["node", "idlehands", "agents", "list"],
      expected: ["agents", "list"],
    },
    {
      name: "terminator cuts parsing",
      argv: ["node", "idlehands", "status", "--", "ignored"],
      expected: ["status"],
    },
  ])("extracts command path: $name", ({ argv, expected }) => {
    expect(getCommandPath(argv, 2)).toEqual(expected);
  });

  it.each([
    {
      name: "returns first command token",
      argv: ["node", "idlehands", "agents", "list"],
      expected: "agents",
    },
    {
      name: "returns null when no command exists",
      argv: ["node", "idlehands"],
      expected: null,
    },
  ])("returns primary command: $name", ({ argv, expected }) => {
    expect(getPrimaryCommand(argv)).toBe(expected);
  });

  it.each([
    {
      name: "detects flag before terminator",
      argv: ["node", "idlehands", "status", "--json"],
      flag: "--json",
      expected: true,
    },
    {
      name: "ignores flag after terminator",
      argv: ["node", "idlehands", "--", "--json"],
      flag: "--json",
      expected: false,
    },
  ])("parses boolean flags: $name", ({ argv, flag, expected }) => {
    expect(hasFlag(argv, flag)).toBe(expected);
  });

  it.each([
    {
      name: "value in next token",
      argv: ["node", "idlehands", "status", "--timeout", "5000"],
      expected: "5000",
    },
    {
      name: "value in equals form",
      argv: ["node", "idlehands", "status", "--timeout=2500"],
      expected: "2500",
    },
    {
      name: "missing value",
      argv: ["node", "idlehands", "status", "--timeout"],
      expected: null,
    },
    {
      name: "next token is another flag",
      argv: ["node", "idlehands", "status", "--timeout", "--json"],
      expected: null,
    },
    {
      name: "flag appears after terminator",
      argv: ["node", "idlehands", "--", "--timeout=99"],
      expected: undefined,
    },
  ])("extracts flag values: $name", ({ argv, expected }) => {
    expect(getFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "idlehands", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "idlehands", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "idlehands", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it.each([
    {
      name: "missing flag",
      argv: ["node", "idlehands", "status"],
      expected: undefined,
    },
    {
      name: "missing value",
      argv: ["node", "idlehands", "status", "--timeout"],
      expected: null,
    },
    {
      name: "valid positive integer",
      argv: ["node", "idlehands", "status", "--timeout", "5000"],
      expected: 5000,
    },
    {
      name: "invalid integer",
      argv: ["node", "idlehands", "status", "--timeout", "nope"],
      expected: undefined,
    },
  ])("parses positive integer flag values: $name", ({ argv, expected }) => {
    expect(getPositiveIntFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("builds parse argv from raw args", () => {
    const cases = [
      {
        rawArgs: ["node", "idlehands", "status"],
        expected: ["node", "idlehands", "status"],
      },
      {
        rawArgs: ["node-22", "idlehands", "status"],
        expected: ["node-22", "idlehands", "status"],
      },
      {
        rawArgs: ["node-22.2.0.exe", "idlehands", "status"],
        expected: ["node-22.2.0.exe", "idlehands", "status"],
      },
      {
        rawArgs: ["node-22.2", "idlehands", "status"],
        expected: ["node-22.2", "idlehands", "status"],
      },
      {
        rawArgs: ["node-22.2.exe", "idlehands", "status"],
        expected: ["node-22.2.exe", "idlehands", "status"],
      },
      {
        rawArgs: ["/usr/bin/node-22.2.0", "idlehands", "status"],
        expected: ["/usr/bin/node-22.2.0", "idlehands", "status"],
      },
      {
        rawArgs: ["node24", "idlehands", "status"],
        expected: ["node24", "idlehands", "status"],
      },
      {
        rawArgs: ["/usr/bin/node24", "idlehands", "status"],
        expected: ["/usr/bin/node24", "idlehands", "status"],
      },
      {
        rawArgs: ["node24.exe", "idlehands", "status"],
        expected: ["node24.exe", "idlehands", "status"],
      },
      {
        rawArgs: ["nodejs", "idlehands", "status"],
        expected: ["nodejs", "idlehands", "status"],
      },
      {
        rawArgs: ["node-dev", "idlehands", "status"],
        expected: ["node", "idlehands", "node-dev", "idlehands", "status"],
      },
      {
        rawArgs: ["idlehands", "status"],
        expected: ["node", "idlehands", "status"],
      },
      {
        rawArgs: ["bun", "src/entry.ts", "status"],
        expected: ["bun", "src/entry.ts", "status"],
      },
    ] as const;

    for (const testCase of cases) {
      const parsed = buildParseArgv({
        programName: "idlehands",
        rawArgs: [...testCase.rawArgs],
      });
      expect(parsed).toEqual([...testCase.expected]);
    }
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "idlehands",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "idlehands", "status"]);
  });

  it("decides when to migrate state", () => {
    const nonMutatingArgv = [
      ["node", "idlehands", "status"],
      ["node", "idlehands", "health"],
      ["node", "idlehands", "sessions"],
      ["node", "idlehands", "config", "get", "update"],
      ["node", "idlehands", "config", "unset", "update"],
      ["node", "idlehands", "models", "list"],
      ["node", "idlehands", "models", "status"],
      ["node", "idlehands", "memory", "status"],
      ["node", "idlehands", "agent", "--message", "hi"],
    ] as const;
    const mutatingArgv = [
      ["node", "idlehands", "agents", "list"],
      ["node", "idlehands", "message", "send"],
    ] as const;

    for (const argv of nonMutatingArgv) {
      expect(shouldMigrateState([...argv])).toBe(false);
    }
    for (const argv of mutatingArgv) {
      expect(shouldMigrateState([...argv])).toBe(true);
    }
  });

  it.each([
    { path: ["status"], expected: false },
    { path: ["config", "get"], expected: false },
    { path: ["models", "status"], expected: false },
    { path: ["agents", "list"], expected: true },
  ])("reuses command path for migrate state decisions: $path", ({ path, expected }) => {
    expect(shouldMigrateStateFromPath(path)).toBe(expected);
  });
});
