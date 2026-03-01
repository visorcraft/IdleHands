import { describe, expect, it } from "vitest";
import { shortenText } from "./text-format.js";

describe("shortenText", () => {
  it("returns original text when it fits", () => {
    expect(shortenText("idlehands", 16)).toBe("idlehands");
  });

  it("truncates and appends ellipsis when over limit", () => {
    expect(shortenText("idlehands-status-output", 10)).toBe("idlehands-…");
  });

  it("counts multi-byte characters correctly", () => {
    expect(shortenText("hello🙂world", 7)).toBe("hello🙂…");
  });
});
