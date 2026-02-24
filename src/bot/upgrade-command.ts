/**
 * Bot /upgrade command — self-upgrade and restart service.
 *
 * Provides same functionality as `idlehands upgrade` CLI but with
 * user feedback and automatic service restart for bots.
 */

import { execFileSync, execSync, spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fetchWithTimeout as fetchWithTimeoutStrict, stateDir, PKG_VERSION } from '../utils.js';

const NPM_SCOPED_PACKAGE = '@visorcraft/idlehands';
const GITHUB_OWNER = 'visorcraft';
const GITHUB_REPO = 'idlehands';
const STATE_DIR = stateDir();
const ROLLBACK_DIR = path.join(STATE_DIR, 'rollback');

type InstallSource = 'github' | 'npm' | 'unknown';

interface VersionInfo {
  current: string;
  latest: string;
  source: InstallSource;
  updateAvailable: boolean;
}

interface UpgradeResult {
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
    execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 5000 });
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
      encoding: 'utf8',
    }).trim();
    if (!binPath) return null;

    const prefix = path.resolve(path.dirname(binPath), '..');
    const installDir = path.join(prefix, 'lib', 'node_modules', NPM_SCOPED_PACKAGE);

    const npmByPrefix = path.join(prefix, 'bin', 'npm');
    const npmByNodeDir = path.join(path.dirname(process.execPath), 'npm');
    const npmBin = isUsableCommand(npmByPrefix)
      ? npmByPrefix
      : isUsableCommand(npmByNodeDir)
        ? npmByNodeDir
        : 'npm';

    return { binPath, prefix, installDir, npmBin };
  } catch {
    return null;
  }
}

function needsElevation(prefix: string): boolean {
  if (process.getuid?.() === 0) return false;
  try {
    const target = path.join(prefix, 'lib', 'node_modules');
    accessSync(target, fsConstants.W_OK);
    return false;
  } catch {
    return true;
  }
}

function hasSudo(): boolean {
  try {
    execFileSync('which', ['sudo'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response | null> {
  try {
    return await fetchWithTimeoutStrict(url, init, timeoutMs);
  } catch {
    return null;
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

function detectInstallSource(): InstallSource {
  const target = resolveInstallPaths();
  if (!target) return 'unknown';
  if (target.installDir.includes('node_modules')) return 'npm';
  return 'github';
}

function resolveGitHubToken(): string | null {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) return envToken;

  try {
    const ghConfigPath = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
    const raw = readFileSync(ghConfigPath, 'utf8');
    const lines = raw.split('\n');
    let inGithub = false;
    for (const line of lines) {
      if (line.match(/^github\.com:/)) {
        inGithub = true;
        continue;
      }
      if (inGithub && line.match(/^\S/)) break;
      if (inGithub) {
        const m = line.match(/oauth_token:\s*(.+)/);
        if (m) return m[1].trim();
      }
    }
  } catch {}

  return null;
}

async function getLatestNpm(timeoutMs = 5000): Promise<string | null> {
  try {
    const pkg = encodeURIComponent(NPM_SCOPED_PACKAGE);
    const res = await fetchWithTimeout(
      `https://registry.npmjs.org/${pkg}/latest`,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'idlehands-bot' },
      },
      timeoutMs
    );
    if (!res || !res.ok) return null;
    const data = (await res.json()) as any;
    return data?.version ?? null;
  } catch {
    return null;
  }
}

async function getLatestGitHub(timeoutMs = 5000): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'idlehands-bot',
    };
    const token = resolveGitHubToken();
    if (token) headers['Authorization'] = `token ${token}`;
    const res = await fetchWithTimeout(url, { headers }, timeoutMs);
    if (!res || !res.ok) return null;
    const data = (await res.json()) as any;
    return data?.tag_name?.replace(/^v/, '') ?? null;
  } catch {
    return null;
  }
}

async function checkForUpdate(source: InstallSource): Promise<VersionInfo | null> {
  const currentVersion = PKG_VERSION;

  let latest: string | null = null;
  let finalSource = source;

  if (source === 'npm') {
    latest = await getLatestNpm();
    if (!latest) {
      latest = await getLatestGitHub();
      if (latest) finalSource = 'github';
    }
  } else {
    latest = await getLatestGitHub();
    if (!latest) {
      latest = await getLatestNpm();
      if (latest) finalSource = 'npm';
    }
  }

  if (!latest) return null;

  return {
    current: currentVersion,
    latest,
    source: finalSource,
    updateAvailable: compareSemver(currentVersion, latest) < 0,
  };
}

function npmInstallGlobal(spec: string, onProgress?: ProgressCallback): void {
  const target = resolveInstallPaths();
  if (target) {
    const args = ['install', '-g', '--prefix', target.prefix, spec];
    const env = { ...process.env, npm_config_prefix: target.prefix };

    if (needsElevation(target.prefix)) {
      if (!hasSudo()) {
        throw new Error(
          `Permission denied: ${target.prefix} requires elevated permissions.`
        );
      }
      execFileSync('sudo', [target.npmBin, ...args], {
        stdio: 'pipe',
        timeout: 120_000,
        env,
      });
      return;
    }

    execFileSync(target.npmBin, args, {
      stdio: 'pipe',
      timeout: 120_000,
      env,
    });
    return;
  }
  execFileSync('npm', ['install', '-g', spec], { stdio: 'pipe', timeout: 120_000 });
}

async function backupForRollback(currentVersion: string): Promise<boolean> {
  try {
    const installDir = resolveInstallPaths()?.installDir;
    if (!installDir) return false;

    try {
      await fs.access(installDir);
    } catch {
      return false;
    }

    await fs.rm(ROLLBACK_DIR, { recursive: true, force: true });
    await fs.mkdir(ROLLBACK_DIR, { recursive: true });

    execSync(`npm pack --pack-destination "${ROLLBACK_DIR}" 2>/dev/null`, {
      cwd: installDir,
      encoding: 'utf8',
      timeout: 30_000,
    });

    return true;
  } catch {
    return false;
  }
}

// ─── Service Restart ────────────────────────────────────────────────────────

function detectServiceManager(): 'systemd-user' | 'systemd-system' | 'none' {
  // Check for systemd user service
  try {
    const result = execSync('systemctl --user is-active idlehands-bot 2>/dev/null || true', {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (result === 'active' || result === 'inactive') {
      return 'systemd-user';
    }
  } catch {}

  // Check for system service
  try {
    const result = execSync('systemctl is-active idlehands-bot 2>/dev/null || true', {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (result === 'active' || result === 'inactive') {
      return 'systemd-system';
    }
  } catch {}

  return 'none';
}

function scheduleServiceRestart(serviceManager: 'systemd-user' | 'systemd-system'): void {
  // Schedule restart in background after a short delay to allow response to be sent
  const restartCmd =
    serviceManager === 'systemd-user'
      ? 'sleep 2 && systemctl --user restart idlehands-bot'
      : 'sleep 2 && sudo systemctl restart idlehands-bot';

  spawn('bash', ['-c', restartCmd], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

// ─── Main Upgrade Function ──────────────────────────────────────────────────

/**
 * Perform the upgrade with progress callbacks for bot feedback.
 */
export async function performBotUpgrade(
  onProgress: ProgressCallback
): Promise<UpgradeResult> {
  const currentVersion = PKG_VERSION;
  const source = detectInstallSource();

  await onProgress(`🔍 Current version: **v${currentVersion}**`);
  await onProgress(`📦 Install source: ${source}`);
  await onProgress('🔄 Checking for updates...');

  const info = await checkForUpdate(source);

  if (!info) {
    return {
      success: false,
      message: '❌ Could not check for updates. Network issue or no releases published.',
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

  await onProgress(`📥 Update available: **v${info.current}** → **v${info.latest}** (from ${info.source})`);
  await onProgress('💾 Creating backup for rollback...');

  const backed = await backupForRollback(currentVersion);
  if (backed) {
    await onProgress('✅ Backup created');
  } else {
    await onProgress('⚠️ Backup skipped (non-fatal)');
  }

  await onProgress('⬇️ Downloading and installing update...');

  try {
    if (info.source === 'npm') {
      npmInstallGlobal(`${NPM_SCOPED_PACKAGE}@latest`);
    } else {
      // GitHub release download
      const token = resolveGitHubToken();
      const releaseUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/v${info.latest}`;
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'idlehands-bot',
      };
      if (token) headers['Authorization'] = `token ${token}`;

      const releaseRes = await fetch(releaseUrl, { headers });
      if (!releaseRes.ok) {
        throw new Error(`Failed to fetch release v${info.latest}`);
      }
      const releaseData = (await releaseRes.json()) as any;

      const tgzName = `idlehands-${info.latest}.tgz`;
      const asset = (releaseData.assets ?? []).find((a: any) => a.name === tgzName);
      if (!asset) throw new Error(`Release has no asset named ${tgzName}`);

      await onProgress(`📦 Downloading ${tgzName}...`);

      const dlHeaders: Record<string, string> = {
        Accept: 'application/octet-stream',
        'User-Agent': 'idlehands-bot',
      };
      if (token) dlHeaders['Authorization'] = `token ${token}`;
      const dlRes = await fetch(asset.url, { headers: dlHeaders });
      if (!dlRes.ok) throw new Error('Failed to download asset');

      const tmpPath = path.join(os.tmpdir(), tgzName);
      const buf = Buffer.from(await dlRes.arrayBuffer());
      await fs.writeFile(tmpPath, buf);

      npmInstallGlobal(tmpPath);
      await fs.unlink(tmpPath).catch(() => {});
    }

    await onProgress(`✅ Upgraded to **v${info.latest}**`);

    // Detect and schedule service restart
    const serviceManager = detectServiceManager();
    if (serviceManager !== 'none') {
      await onProgress(`🔄 Scheduling service restart (${serviceManager})...`);
      scheduleServiceRestart(serviceManager);
      return {
        success: true,
        message: `✅ Upgraded from **v${info.current}** to **v${info.latest}**\n🔄 Service restarting in 2 seconds...`,
        fromVersion: info.current,
        toVersion: info.latest,
        needsRestart: true,
      };
    }

    return {
      success: true,
      message: `✅ Upgraded from **v${info.current}** to **v${info.latest}**\n⚠️ No service manager detected. Please restart manually.`,
      fromVersion: info.current,
      toVersion: info.latest,
      needsRestart: true,
    };
  } catch (e: any) {
    return {
      success: false,
      message: `❌ Upgrade failed: ${e?.message ?? String(e)}`,
      fromVersion: currentVersion,
      error: e?.message ?? String(e),
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
    return { available: false, current: PKG_VERSION };
  }

  return {
    available: info.updateAvailable,
    current: info.current,
    latest: info.latest,
    source: info.source,
  };
}
