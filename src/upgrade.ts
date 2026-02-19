/**
 * Self-upgrade mechanism for Idle Hands.
 *
 * Supports two install sources:
 *   - "github" → GitHub Releases (visorcraft/idlehands)
 *   - "npm"    → npmjs.org registry
 *
 * Install source is auto-detected on first run and stored in config.
 * `--upgrade` pulls the latest from the detected source (fallback to the other).
 * Daily auto-check: on REPL startup, check once per 24h if a newer version exists.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fetchWithTimeout as fetchWithTimeoutStrict, stateDir } from './utils.js';

const GITHUB_OWNER = 'visorcraft';
const GITHUB_REPO = 'idlehands';
const NPM_PACKAGE = 'idlehands';
const STATE_DIR = stateDir();
const UPDATE_CHECK_FILE = path.join(STATE_DIR, 'last-update-check.json');
const ROLLBACK_DIR = path.join(STATE_DIR, 'rollback');

/** Resolve a GitHub token from config, env, or gh CLI config. */
function resolveGitHubToken(): string | null {
  // 1. Environment variable
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) return envToken;

  // 2. gh CLI config (~/.config/gh/hosts.yml)
  try {
    const ghConfigPath = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
    const raw = readFileSync(ghConfigPath, 'utf8');
    // Simple YAML parse — look for oauth_token under github.com
    // Format: github.com:\n    users:\n        <user>:\n            oauth_token: <token>
    // Or: github.com:\n    oauth_token: <token>
    const lines = raw.split('\n');
    let inGithub = false;
    for (const line of lines) {
      if (line.match(/^github\.com:/)) { inGithub = true; continue; }
      if (inGithub && line.match(/^\S/)) break; // next top-level key
      if (inGithub) {
        const m = line.match(/oauth_token:\s*(.+)/);
        if (m) return m[1].trim();
      }
    }
  } catch {}

  return null;
}

export type InstallSource = 'github' | 'npm' | 'unknown';

interface UpdateConfig {
  /** Where idlehands was installed from. Auto-detected if not set. */
  install_source?: InstallSource;
  /** Check for updates automatically (once per day on REPL start). Default: true */
  auto_update_check?: boolean;
}

interface VersionInfo {
  current: string;
  latest: string;
  source: InstallSource;
  updateAvailable: boolean;
}

type UpdateCheckOpts = {
  timeoutMs?: number;
  offline?: boolean;
};

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response | null> {
  try {
    return await fetchWithTimeoutStrict(url, init, timeoutMs);
  } catch {
    return null;
  }
}

/** Compare two semver strings. Returns -1, 0, or 1. */
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

/** Detect how idlehands was installed by examining the install path. */
export function detectInstallSource(): InstallSource {
  try {
    // If installed via npm, the resolved path will be inside a node_modules or npm global dir
    const resolved = execSync('which idlehands 2>/dev/null || echo ""', { encoding: 'utf8' }).trim();
    if (!resolved) return 'unknown';

    // npm global installs go through lib/node_modules
    const npmGlobal = execSync('npm root -g 2>/dev/null || echo ""', { encoding: 'utf8' }).trim();
    if (npmGlobal && resolved.includes('node_modules')) {
      return 'npm';
    }

    // If the binary exists but isn't in node_modules, check if npm knows about it
    try {
      const list = execSync('npm ls -g idlehands --json 2>/dev/null', { encoding: 'utf8' });
      const parsed = JSON.parse(list);
      if (parsed?.dependencies?.idlehands) return 'npm';
    } catch {}

    return 'github';
  } catch {
    return 'unknown';
  }
}

/** Fetch the latest version from GitHub Releases API. */
async function getLatestGitHub(timeoutMs = 3000): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
    const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'idlehands-cli' };
    const token = resolveGitHubToken();
    if (token) headers['Authorization'] = `token ${token}`;
    const res = await fetchWithTimeout(url, { headers }, timeoutMs);
    if (!res) return null;
    if (res.status === 404) { console.log('[github] No releases published yet.'); return null; }
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.tag_name?.replace(/^v/, '') ?? null;
  } catch {
    return null;
  }
}

/** Fetch the latest version from the npm registry. */
async function getLatestNpm(timeoutMs = 3000): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'idlehands-cli' }
    }, timeoutMs);
    if (!res) return null;
    if (res.status === 404) { console.log('[npm] Package not published yet.'); return null; }
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.version ?? null;
  } catch {
    return null;
  }
}

/** Get the latest version, trying the preferred source first, then fallback. */
async function getLatestVersion(source: InstallSource, opts: UpdateCheckOpts = {}): Promise<{ version: string; source: InstallSource } | null> {
  if (opts.offline) return null;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const tryGithub = async () => {
    const v = await getLatestGitHub(timeoutMs);
    return v ? { version: v, source: 'github' as InstallSource } : null;
  };
  const tryNpm = async () => {
    const v = await getLatestNpm(timeoutMs);
    return v ? { version: v, source: 'npm' as InstallSource } : null;
  };

  if (source === 'npm') {
    return (await tryNpm()) ?? (await tryGithub());
  }
  // Default: github first
  return (await tryGithub()) ?? (await tryNpm());
}

/** Check if an update is available. */
async function checkForUpdate(currentVersion: string, source: InstallSource, opts: UpdateCheckOpts = {}): Promise<VersionInfo | null> {
  const result = await getLatestVersion(source, opts);
  if (!result) return null;
  return {
    current: currentVersion,
    latest: result.version,
    source: result.source,
    updateAvailable: compareSemver(currentVersion, result.version) < 0
  };
}

/** Daily update check — returns update info if check is due and update available. */
export async function dailyUpdateCheck(currentVersion: string, source: InstallSource, opts: UpdateCheckOpts = {}): Promise<VersionInfo | null> {
  if (opts.offline) return null;
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });

    // Check if we already checked today
    try {
      const raw = await fs.readFile(UPDATE_CHECK_FILE, 'utf8');
      const data = JSON.parse(raw);
      const lastCheck = new Date(data.timestamp).getTime();
      const now = Date.now();
      if (now - lastCheck < 24 * 60 * 60 * 1000) {
        // Already checked within 24h — return cached result if update was available
        if (data.updateAvailable && data.latest && compareSemver(currentVersion, data.latest) < 0) {
          return {
            current: currentVersion,
            latest: data.latest,
            source: data.source ?? source,
            updateAvailable: true
          };
        }
        return null;
      }
    } catch {} // No file or parse error — proceed with check

    const info = await checkForUpdate(currentVersion, source, opts);

    // Cache the result
    await fs.writeFile(UPDATE_CHECK_FILE, JSON.stringify({
      timestamp: new Date().toISOString(),
      latest: info?.latest ?? currentVersion,
      source: info?.source ?? source,
      updateAvailable: info?.updateAvailable ?? false
    }, null, 2), 'utf8');

    return info?.updateAvailable ? info : null;
  } catch {
    return null; // Never crash on update check failure
  }
}

// ─── Rollback Support ──────────────────────────────────────

interface RollbackInfo {
  version: string;
  source: InstallSource;
  backupPath: string;
  timestamp: string;
}

/** Get the current npm global root for idlehands. */
function getNpmGlobalDir(): string | null {
  try {
    const root = execSync('npm root -g 2>/dev/null', { encoding: 'utf8' }).trim();
    if (root) return path.join(root, NPM_PACKAGE);
    return null;
  } catch {
    return null;
  }
}

/**
 * Backup the current installation before upgrade.
 * Only 1 rollback version is retained.
 */
async function backupForRollback(currentVersion: string, source: InstallSource): Promise<RollbackInfo | null> {
  try {
    const installDir = getNpmGlobalDir();
    if (!installDir) {
      console.warn('[rollback] cannot determine install directory; skipping backup');
      return null;
    }

    // Check if install dir exists
    try {
      await fs.access(installDir);
    } catch {
      console.warn('[rollback] install directory not found; skipping backup');
      return null;
    }

    // Ensure rollback dir exists; wipe old backup (max 1 retained)
    await fs.rm(ROLLBACK_DIR, { recursive: true, force: true });
    await fs.mkdir(ROLLBACK_DIR, { recursive: true });

    // Pack the current install into a tarball
    const tgzName = `${NPM_PACKAGE}-${currentVersion}-rollback.tgz`;
    const tgzPath = path.join(ROLLBACK_DIR, tgzName);

    // Use npm pack from the install directory
    execSync(`npm pack --pack-destination "${ROLLBACK_DIR}" 2>/dev/null`, {
      cwd: installDir,
      encoding: 'utf8',
      timeout: 30_000
    });

    // npm pack outputs the filename; find it
    const files = await fs.readdir(ROLLBACK_DIR);
    const packed = files.find((f) => f.endsWith('.tgz'));
    if (!packed) throw new Error('npm pack produced no .tgz file');

    // Rename to our convention
    const packedPath = path.join(ROLLBACK_DIR, packed);
    if (packedPath !== tgzPath) {
      await fs.rename(packedPath, tgzPath);
    }

    // Write metadata
    const info: RollbackInfo = {
      version: currentVersion,
      source,
      backupPath: tgzPath,
      timestamp: new Date().toISOString()
    };
    await fs.writeFile(path.join(ROLLBACK_DIR, 'rollback.json'), JSON.stringify(info, null, 2), 'utf8');

    console.log(`[rollback] backed up v${currentVersion} to ${tgzPath}`);
    return info;
  } catch (e: any) {
    console.warn(`[rollback] backup failed (non-fatal): ${e?.message ?? String(e)}`);
    return null;
  }
}

/** Read rollback metadata, if available. */
async function getRollbackInfo(): Promise<RollbackInfo | null> {
  try {
    const raw = await fs.readFile(path.join(ROLLBACK_DIR, 'rollback.json'), 'utf8');
    const info = JSON.parse(raw) as RollbackInfo;
    // Verify tarball still exists
    await fs.access(info.backupPath);
    return info;
  } catch {
    return null;
  }
}

/** Perform rollback: install the backed-up version. */
export async function performRollback(): Promise<void> {
  const info = await getRollbackInfo();
  if (!info) {
    console.error('No rollback backup found. Run --upgrade first to create one.');
    process.exit(1);
  }

  console.log(`Rolling back to v${info.version} (backed up ${info.timestamp})`);
  console.log(`Installing from: ${info.backupPath}`);

  try {
    execSync(`npm install -g "${info.backupPath}"`, { stdio: 'inherit' });
    console.log(`\n✓ Rolled back to v${info.version}`);

    // Clean up rollback dir after successful rollback
    await fs.rm(ROLLBACK_DIR, { recursive: true, force: true }).catch(() => {});
  } catch (e: any) {
    console.error(`\n✗ Rollback failed: ${e?.message ?? String(e)}`);
    console.error(`\nManual rollback: npm install -g "${info.backupPath}"`);
    process.exit(1);
  }
}

/** Perform the actual upgrade. */
export async function performUpgrade(currentVersion: string, source: InstallSource): Promise<void> {
  console.log(`Current version: ${currentVersion}`);
  console.log(`Install source: ${source}`);
  console.log('Checking for updates...');

  const info = await checkForUpdate(currentVersion, source);

  if (!info) {
    console.log('No releases found. Publish a release on GitHub or npm first.');
    process.exit(1);
  }

  if (!info.updateAvailable) {
    console.log(`Already on the latest version (${currentVersion}).`);
    process.exit(0);
  }

  console.log(`Update available: ${currentVersion} → ${info.latest} (from ${info.source})`);

  // Backup current installation for rollback (best-effort)
  await backupForRollback(currentVersion, source);

  console.log('Upgrading...\n');

  try {
    if (info.source === 'npm') {
      // npm global install
      execSync(`npm install -g ${NPM_PACKAGE}@latest`, { stdio: 'inherit' });
    } else {
      // GitHub release — download tarball with auth (private repos), then install locally
      const token = resolveGitHubToken();

      // Find the asset download URL from the release
      const releaseUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/v${info.latest}`;
      const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'idlehands-cli' };
      if (token) headers['Authorization'] = `token ${token}`;

      const releaseRes = await fetch(releaseUrl, { headers });
      if (!releaseRes.ok) throw new Error(`Failed to fetch release v${info.latest}: HTTP ${releaseRes.status}`);
      const releaseData = await releaseRes.json() as any;

      const tgzName = `${NPM_PACKAGE}-${info.latest}.tgz`;
      const asset = (releaseData.assets ?? []).find((a: any) => a.name === tgzName);
      if (!asset) throw new Error(`Release v${info.latest} has no asset named ${tgzName}`);

      console.log(`Downloading: ${tgzName} (${(asset.size / 1024).toFixed(0)} KB)`);

      // Download the asset binary
      const dlHeaders: Record<string, string> = { 'Accept': 'application/octet-stream', 'User-Agent': 'idlehands-cli' };
      if (token) dlHeaders['Authorization'] = `token ${token}`;
      const dlRes = await fetch(asset.url, { headers: dlHeaders });
      if (!dlRes.ok) throw new Error(`Failed to download asset: HTTP ${dlRes.status}`);

      const tmpPath = path.join(os.tmpdir(), tgzName);
      const buf = Buffer.from(await dlRes.arrayBuffer());
      await fs.writeFile(tmpPath, buf);
      console.log(`Saved to ${tmpPath}`);

      execSync(`npm install -g ${tmpPath}`, { stdio: 'inherit' });

      // Clean up
      await fs.unlink(tmpPath).catch(() => {});
    }

    console.log(`\n✓ Upgraded to ${info.latest}`);

    // Clear the update check cache so we don't nag
    try { await fs.unlink(UPDATE_CHECK_FILE); } catch {}
  } catch (e: any) {
    console.error(`\n✗ Upgrade failed: ${e?.message ?? String(e)}`);

    // Auto-rollback on failure
    const rollbackInfo = await getRollbackInfo();
    if (rollbackInfo) {
      console.error('\nAttempting auto-rollback...');
      try {
        execSync(`npm install -g "${rollbackInfo.backupPath}"`, { stdio: 'inherit' });
        console.error(`✓ Auto-rolled back to v${rollbackInfo.version}`);
      } catch (re: any) {
        console.error(`✗ Auto-rollback also failed: ${re?.message ?? String(re)}`);
        console.error(`\nManual rollback: npm install -g "${rollbackInfo.backupPath}"`);
      }
    } else {
      console.error('\nManual upgrade:');
      if (info.source === 'npm') {
        console.error(`  npm install -g ${NPM_PACKAGE}@latest`);
      } else {
        console.error(`  npm install -g https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${info.latest}/${NPM_PACKAGE}-${info.latest}.tgz`);
      }
    }
    process.exit(1);
  }
}
