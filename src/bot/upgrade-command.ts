/**
 * Bot /upgrade command — check GitHub for latest release, install, restart.
 *
 * Replaces the complex update-cli pipeline with a simple:
 *   1. Check GitHub releases (+ npm fallback)
 *   2. npm install -g the tarball or package
 *   3. Restart gateway + bot service
 *
 * Surfaces: Telegram /upgrade, Discord /upgrade, TUI /upgrade
 */

import { execFileSync, execSync, spawn } from "node:child_process";
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Lazily resolve package version to avoid import-time side effects.
let _pkgVersion: string | null = null;
function getPkgVersion(): string {
  if (_pkgVersion) {
    return _pkgVersion;
  }
  try {
    // Walk up from this file to find the nearest package.json
    let dir = path.dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, "package.json");
      try {
        const raw = readFileSync(candidate, "utf8");
        const parsed = JSON.parse(raw) as { version?: string };
        if (parsed.version) {
          _pkgVersion = parsed.version;
          return _pkgVersion;
        }
      } catch {
        // keep walking
      }
      dir = path.dirname(dir);
    }
  } catch {
    // fallback
  }
  _pkgVersion = "0.0.0";
  return _pkgVersion;
}

const GITHUB_OWNER = "visorcraft";
const GITHUB_REPO = "idlehands";
const NPM_SCOPED_PACKAGE = "@visorcraft/idlehands";
const RELEASE_ASSET_PREFIX = "idlehands";

type InstallSource = "github" | "npm" | "unknown";

interface VersionInfo {
  current: string;
  latest: string;
  source: InstallSource;
  updateAvailable: boolean;
}

export interface UpgradeResult {
  success: boolean;
  message: string;
  fromVersion?: string;
  toVersion?: string;
  needsRestart?: boolean;
  error?: string;
}

type ProgressCallback = (message: string) => Promise<void>;

// ─── Helpers ────────────────────────────────────────────────────────────────

function isUsableCommand(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function resolveInstallPaths(): {
  binPath: string;
  prefix: string;
  installDir: string;
  npmBin: string;
} | null {
  try {
    const binPath = execSync('command -v idlehands 2>/dev/null || echo ""', {
      encoding: "utf8",
    }).trim();
    if (!binPath) {
      return null;
    }
    const prefix = path.resolve(path.dirname(binPath), "..");
    const installDir = path.join(prefix, "lib", "node_modules", NPM_SCOPED_PACKAGE);
    const npmByPrefix = path.join(prefix, "bin", "npm");
    const npmByNodeDir = path.join(path.dirname(process.execPath), "npm");
    const npmBin = isUsableCommand(npmByPrefix)
      ? npmByPrefix
      : isUsableCommand(npmByNodeDir)
        ? npmByNodeDir
        : "npm";
    return { binPath, prefix, installDir, npmBin };
  } catch {
    return null;
  }
}

function needsElevation(prefix: string): boolean {
  if (process.getuid?.() === 0) {
    return false;
  }
  try {
    accessSync(path.join(prefix, "lib", "node_modules"), fsConstants.W_OK);
    return false;
  } catch {
    return true;
  }
}

function hasSudo(): boolean {
  try {
    execFileSync("which", ["sudo"], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function npmInstallGlobal(spec: string): void {
  const target = resolveInstallPaths();
  if (target) {
    const args = ["install", "-g", "--prefix", target.prefix, spec];
    const env = { ...process.env, npm_config_prefix: target.prefix };
    if (needsElevation(target.prefix)) {
      if (!hasSudo()) {
        throw new Error(
          `Permission denied: ${target.prefix} requires elevated permissions.\nRe-run as root or install to a user-writable prefix.`,
        );
      }
      execFileSync("sudo", [target.npmBin, ...args], {
        stdio: "pipe",
        timeout: 120_000,
        env,
      });
      return;
    }
    execFileSync(target.npmBin, args, { stdio: "pipe", timeout: 120_000, env });
    return;
  }
  execFileSync("npm", ["install", "-g", spec], { stdio: "pipe", timeout: 120_000 });
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) {
      return -1;
    }
    if (va > vb) {
      return 1;
    }
  }
  return 0;
}

function detectInstallSource(): InstallSource {
  const target = resolveInstallPaths();
  if (!target) {
    return "unknown";
  }
  if (target.installDir.includes("node_modules")) {
    return "npm";
  }
  return "github";
}

function resolveGitHubToken(): string | null {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) {
    return envToken;
  }
  try {
    const ghConfigPath = path.join(os.homedir(), ".config", "gh", "hosts.yml");
    const raw = readFileSync(ghConfigPath, "utf8");
    const lines = raw.split("\n");
    let inGithub = false;
    for (const line of lines) {
      if (line.match(/^github\.com:/)) {
        inGithub = true;
        continue;
      }
      if (inGithub && line.match(/^\S/)) {
        break;
      }
      if (inGithub) {
        const m = line.match(/oauth_token:\s*(.+)/);
        if (m) {
          return (m[1] ?? "").trim();
        }
      }
    }
  } catch {
    // gh config may not exist
  }
  return null;
}

async function safeFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch {
    return null;
  }
}

async function getLatestGitHub(timeoutMs = 5000): Promise<string | null> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "idlehands-bot",
  };
  const token = resolveGitHubToken();
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  const res = await safeFetch(url, { headers }, timeoutMs);
  if (!res || !res.ok) {
    return null;
  }
  const data = (await res.json()) as { tag_name?: string };
  return data?.tag_name?.replace(/^v/, "") ?? null;
}

async function getLatestNpm(timeoutMs = 5000): Promise<string | null> {
  const pkg = encodeURIComponent(NPM_SCOPED_PACKAGE);
  const res = await safeFetch(
    `https://registry.npmjs.org/${pkg}/latest`,
    { headers: { Accept: "application/json", "User-Agent": "idlehands-bot" } },
    timeoutMs,
  );
  if (!res || !res.ok) {
    return null;
  }
  const data = (await res.json()) as { version?: string };
  return data?.version ?? null;
}

async function npmVersionExists(version: string, timeoutMs = 5000): Promise<boolean> {
  const pkg = encodeURIComponent(NPM_SCOPED_PACKAGE);
  const res = await safeFetch(
    `https://registry.npmjs.org/${pkg}/${encodeURIComponent(version)}`,
    { headers: { Accept: "application/json", "User-Agent": "idlehands-bot" } },
    timeoutMs,
  );
  return Boolean(res && res.ok);
}

async function installFromGitHubRelease(version: string, onProgress: ProgressCallback): Promise<void> {
  const token = resolveGitHubToken();
  const releaseUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/v${version}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "idlehands-bot",
  };
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }

  const releaseRes = await fetch(releaseUrl, { headers });
  if (!releaseRes.ok) {
    throw new Error(`Failed to fetch release v${version}`);
  }
  const releaseData = (await releaseRes.json()) as {
    assets?: Array<{ name: string; url: string; size: number }>;
  };

  const tgzName = `${RELEASE_ASSET_PREFIX}-${version}.tgz`;
  const asset = (releaseData.assets ?? []).find((a) => a.name === tgzName);
  if (!asset) {
    throw new Error(`Release has no asset named ${tgzName}`);
  }

  await onProgress(`📦 Downloading ${tgzName}...`);

  const dlHeaders: Record<string, string> = {
    Accept: "application/octet-stream",
    "User-Agent": "idlehands-bot",
  };
  if (token) {
    dlHeaders["Authorization"] = `token ${token}`;
  }
  const dlRes = await fetch(asset.url, { headers: dlHeaders });
  if (!dlRes.ok) {
    throw new Error("Failed to download asset");
  }

  const tmpPath = path.join(os.tmpdir(), tgzName);
  const buf = Buffer.from(await dlRes.arrayBuffer());
  await fs.writeFile(tmpPath, buf);

  npmInstallGlobal(tmpPath);
  await fs.unlink(tmpPath).catch(() => {});
}

async function checkForUpdate(source: InstallSource): Promise<VersionInfo | null> {
  const currentVersion = getPkgVersion();
  let latest: string | null = null;
  let finalSource = source;

  if (source === "npm") {
    latest = await getLatestNpm();
    if (!latest) {
      latest = await getLatestGitHub();
      if (latest) {
        finalSource = "github";
      }
    }
  } else {
    latest = await getLatestGitHub();
    if (!latest) {
      latest = await getLatestNpm();
      if (latest) {
        finalSource = "npm";
      }
    }
  }

  if (!latest) {
    return null;
  }
  return {
    current: currentVersion,
    latest,
    source: finalSource,
    updateAvailable: compareSemver(currentVersion, latest) < 0,
  };
}

// ─── Service Restart ────────────────────────────────────────────────────────

function detectServiceManager(): "systemd-user" | "systemd-system" | "none" {
  try {
    const result = execSync("systemctl --user is-active idlehands-gateway.service 2>/dev/null || true", {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (result === "active" || result === "inactive") {
      return "systemd-user";
    }
  } catch {
    // not available
  }
  try {
    const result = execSync("systemctl is-active idlehands-gateway.service 2>/dev/null || true", {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (result === "active" || result === "inactive") {
      return "systemd-system";
    }
  } catch {
    // not available
  }
  return "none";
}

function scheduleServiceRestart(serviceManager: "systemd-user" | "systemd-system"): void {
  const restartCmd =
    serviceManager === "systemd-user"
      ? "sleep 2 && systemctl --user restart idlehands-gateway.service"
      : "sleep 2 && sudo systemctl restart idlehands-gateway.service";
  spawn("bash", ["-c", restartCmd], { detached: true, stdio: "ignore" }).unref();
}

function scheduleGatewayRestart(): void {
  // Send SIGUSR1 to the current process after a short delay to trigger graceful restart.
  // If running inside a gateway, this triggers the built-in restart handler.
  // If not, it's a no-op (SIGUSR1 default is ignore on most platforms).
  setTimeout(() => {
    try {
      process.kill(process.pid, "SIGUSR1");
    } catch {
      // ignore
    }
  }, 2000);
}

// ─── Main Upgrade Function ──────────────────────────────────────────────────

export async function performBotUpgrade(onProgress: ProgressCallback): Promise<UpgradeResult> {
  const currentVersion = getPkgVersion();
  const source = detectInstallSource();

  await onProgress(`🔍 Current version: **v${currentVersion}**`);
  await onProgress(`📦 Install source: ${source}`);
  await onProgress("🔄 Checking for updates...");

  const info = await checkForUpdate(source);

  if (!info) {
    return {
      success: false,
      message: "❌ Could not check for updates. Network issue or no releases published.",
      fromVersion: currentVersion,
    };
  }

  if (!info.updateAvailable) {
    return {
      success: true,
      message: `✅ Already on the latest version (**v${currentVersion}**).`,
      fromVersion: currentVersion,
      toVersion: currentVersion,
      needsRestart: false,
    };
  }

  await onProgress(
    `📥 Update available: **v${info.current}** → **v${info.latest}** (from ${info.source})`,
  );
  await onProgress("⬇️ Downloading and installing update...");

  try {
    if (info.source === "npm") {
      const npmHasVersion = await npmVersionExists(info.latest);
      if (npmHasVersion) {
        npmInstallGlobal(`${NPM_SCOPED_PACKAGE}@${info.latest}`);
      } else {
        await onProgress(
          `📦 npm has not published v${info.latest} yet; falling back to GitHub release asset...`,
        );
        await installFromGitHubRelease(info.latest, onProgress);
      }
    } else {
      await installFromGitHubRelease(info.latest, onProgress);
    }

    await onProgress(`✅ Upgraded to **v${info.latest}**`);

    // Restart gateway via SIGUSR1
    scheduleGatewayRestart();

    // Detect and schedule bot service restart
    const serviceManager = detectServiceManager();
    if (serviceManager !== "none") {
      await onProgress(`🔄 Scheduling service restart (${serviceManager})...`);
      scheduleServiceRestart(serviceManager);
      return {
        success: true,
        message: `✅ Upgraded from **v${info.current}** to **v${info.latest}**\n🔄 Gateway + service restarting...`,
        fromVersion: info.current,
        toVersion: info.latest,
        needsRestart: true,
      };
    }

    return {
      success: true,
      message: `✅ Upgraded from **v${info.current}** to **v${info.latest}**\n🔄 Gateway restarting via SIGUSR1...\n⚠️ No systemd service detected — bot may need manual restart.`,
      fromVersion: info.current,
      toVersion: info.latest,
      needsRestart: true,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      message: `❌ Upgrade failed: ${msg}`,
      fromVersion: currentVersion,
      error: msg,
    };
  }
}

/**
 * Check for available updates without performing upgrade.
 */
export async function checkBotUpdate(): Promise<{
  available: boolean;
  current: string;
  latest?: string;
  source?: InstallSource;
}> {
  const source = detectInstallSource();
  const info = await checkForUpdate(source);
  if (!info) {
    return { available: false, current: getPkgVersion() };
  }
  return {
    available: info.updateAvailable,
    current: info.current,
    latest: info.latest,
    source: info.source,
  };
}
