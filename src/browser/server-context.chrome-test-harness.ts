import { vi } from "vitest";
import { installChromeUserDataDirHooks } from "./chrome-user-data-dir.test-harness.js";

const chromeUserDataDir = { dir: "/tmp/idlehands" };
installChromeUserDataDirHooks(chromeUserDataDir);

vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchIdleHandsChrome: vi.fn(async () => {
    throw new Error("unexpected launch");
  }),
  resolveIdleHandsUserDataDir: vi.fn(() => chromeUserDataDir.dir),
  stopIdleHandsChrome: vi.fn(async () => {}),
}));
