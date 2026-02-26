/**
 * Safety module — graduated permission system for exec and file operations.
 *
 * Three tiers:
 * - FORBIDDEN: Always blocked, even in yolo mode. Hard stop, no override.
 * - CAUTIOUS:  Require explicit confirmation in default/auto-edit modes.
 *              Skipped only in yolo mode.
 * - FREE:      No restrictions.
 *
 * Also enforces:
 * - Protected path restrictions (write/edit never touch system-critical files)
 * - Path traversal detection (symlink escape, ../ escape outside cwd)
 * - Working directory containment (optional)
 * - Lockdown mode (--lockdown): promotes ALL cautious → forbidden
 * - User-configurable overrides via ~/.config/idlehands/safety.json
 * - Safety logging to stderr
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { configDir } from './utils.js';

// ──────────────────────────────────────────────────────
// Forbidden patterns — ALWAYS blocked, even in yolo mode
// ──────────────────────────────────────────────────────

export const FORBIDDEN_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // Wipe root / home / system directories
  { re: /\brm\s+(-\w*[rf]\w*\s+)*\s*\/\s*$/, reason: 'rm targeting /' },
  { re: /\brm\s+(-\w*[rf]\w*\s+)+\/$/, reason: 'rm -rf /' },
  {
    re: /\brm\s+(-\w*[rf]\w*\s+)+\/(boot|etc|usr|lib|sbin|bin|var|sys|proc|dev)\b/,
    reason: 'rm targeting system directory',
  },
  { re: /\brm\s+(-\w*[rf]\w*\s+)+~\/?$/, reason: 'rm targeting home directory' },
  { re: /\brm\s+(-\w*[rf]\w*\s+)+\$HOME\b/, reason: 'rm targeting $HOME' },

  // Block device / partition destruction
  { re: /\bdd\b.*\bof\s*=\s*\/dev\//, reason: 'dd writing to block device' },
  { re: /\bmkfs\b/, reason: 'mkfs (filesystem creation)' },
  { re: /\bfdisk\b/, reason: 'fdisk (partition table modification)' },
  { re: /\bparted\b/, reason: 'parted (partition modification)' },

  // Boot/kernel destruction
  { re: /\bupdate-grub\b/, reason: 'GRUB modification' },
  { re: /\bgrub-install\b/, reason: 'GRUB installation' },

  // Recursive permission nuke
  {
    re: /\bchmod\s+(-\w*R\w*\s+)*(0?777|a\+rwx)\s+\/\s*$/,
    reason: 'chmod 777 / (recursive permission nuke)',
  },
  { re: /\bchown\s+(-\w*R\w*\s+).*\s+\/\s*$/, reason: 'chown targeting /' },

  // Fork bomb
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },

  // Direct passwd/shadow manipulation
  { re: />\s*\/etc\/passwd\b/, reason: 'overwriting /etc/passwd' },
  { re: />\s*\/etc\/shadow\b/, reason: 'overwriting /etc/shadow' },

  // Disable firewall entirely
  { re: /\bufw\s+disable\b/, reason: 'disabling firewall' },
  { re: /\biptables\s+-F\b/, reason: 'flushing all iptables rules' },

  // System shutdown/reboot (model shouldn't decide this)
  { re: /\b(shutdown|reboot|poweroff|init\s+[06])\b/, reason: 'system shutdown/reboot' },

  // Wipe entire git history
  { re: /\bgit\s+push\s+--mirror\b/, reason: 'git mirror push (overwrites remote)' },
];

// ──────────────────────────────────────────────────────
// Cautious patterns — require confirmation in default/auto-edit
// ──────────────────────────────────────────────────────

export const CAUTIOUS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // Recursive delete (non-system paths)
  { re: /\brm\s+(-\w*[rf]\w*\s+)/, reason: 'rm with -r or -f flags' },

  // Sudo escalation
  { re: /\bsudo\b/, reason: 'sudo (privilege escalation)' },

  // Remote code execution
  { re: /\bcurl\b.*\|\s*(ba)?sh\b/, reason: 'piping curl to shell' },
  { re: /\bwget\b.*\|\s*(ba)?sh\b/, reason: 'piping wget to shell' },

  // Git force operations
  { re: /\bgit\s+push\s+.*--force\b/, reason: 'git force push' },
  { re: /\bgit\s+push\s+-f\b/, reason: 'git force push' },
  { re: /\bgit\s+reset\s+--hard\b/, reason: 'git reset --hard' },
  { re: /\bgit\s+clean\s+-[dfx]/, reason: 'git clean (removes untracked files)' },
  { re: /\bgit\s+checkout\s+--\s+\S+/, reason: 'git checkout -- (discards local file changes)' },
  { re: /\bgit\s+checkout\s+\./, reason: 'git checkout . (discards local changes)' },
  { re: /\bgit\s+restore\b/, reason: 'git restore (can discard local changes)' },

  // Package management
  {
    re: /\b(apt|apt-get|dnf|yum|pacman|pip|npm)\s+(install|remove|purge|uninstall)\b/,
    reason: 'package install/remove',
  },

  // Service management
  {
    re: /\bsystemctl\s+(start|stop|restart|enable|disable|mask)\b/,
    reason: 'service state change',
  },

  // Network/firewall changes
  { re: /\bufw\s+(allow|deny|reject)\b/, reason: 'firewall rule change' },
  { re: /\biptables\s+(-A|-I|-D)\b/, reason: 'iptables rule change' },

  // Docker management
  { re: /\bdocker\s+(rm|rmi|system\s+prune)\b/, reason: 'docker resource removal' },

  // Dangerous file operations outside of the tool system
  { re: /\bmv\s+.*\/\.\./, reason: 'mv with path traversal' },
  { re: /\bcp\s+.*--no-preserve\b/, reason: 'cp without preserving attributes' },

  // SSH/SCP to remote (model should confirm remote operations)
  { re: /\bssh\b/, reason: 'ssh (remote operation)' },
  { re: /\bscp\b/, reason: 'scp (remote copy)' },
  { re: /\brsync\b/, reason: 'rsync (remote sync)' },
];

// ──────────────────────────────────────────────────────
// Protected paths — file tools can NEVER write to these
// ──────────────────────────────────────────────────────

const PROTECTED_PATHS: string[] = [
  '/boot',
  '/etc/grub.d',
  '/etc/default/grub',
  '/etc/passwd',
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/fstab',
  '/proc',
  '/sys',
  '/dev',
];

/**
 * Paths that should never be the target of rm -rf or similar bulk deletion.
 * These are broader than PROTECTED_PATHS — they protect user data, not just system files.
 */
const PROTECTED_DELETE_ROOTS: string[] = [
  '/',
  '/home',
  '/root',
  '/var',
  '/usr',
  '/lib',
  '/bin',
  '/sbin',
  '/etc',
  '/boot',
  '/opt',
];

// ──────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────

type SafetyVerdict = {
  allowed: boolean;
  tier: 'forbidden' | 'cautious' | 'free';
  reason?: string;
  /** If cautious, this is the human-readable prompt to show the user */
  prompt?: string;
};

/**
 * User-configurable safety overrides from ~/.config/idlehands/safety.json
 */
export type SafetyConfig = {
  /** Extra forbidden patterns (always blocked, supplements built-ins) */
  forbidden_patterns?: string[];
  /** Extra cautious patterns (require confirmation, supplements built-ins) */
  cautious_patterns?: string[];
  /** Extra protected paths (file tools can never write here) */
  protected_paths?: string[];
  /** Extra protected delete roots (rm can never target these) */
  protected_delete_roots?: string[];
  /** Patterns to explicitly allow (bypass cautious for known-safe commands) */
  allow_patterns?: string[];
};

// ──────────────────────────────────────────────────────
// Safety options (set once at startup, consulted per-check)
// ──────────────────────────────────────────────────────

let _lockdown = false;
let _logEnabled = false;
let _userForbidden: Array<{ re: RegExp; reason: string }> = [];
let _userCautious: Array<{ re: RegExp; reason: string }> = [];
let _userAllow: RegExp[] = [];
let _userProtectedPaths: string[] = [];
let _userProtectedDeleteRoots: string[] = [];

/** Enable lockdown mode: all cautious commands become forbidden. */
export function setLockdown(enabled: boolean) {
  _lockdown = enabled;
}

/** Enable safety logging to stderr. */
export function setSafetyLogging(enabled: boolean) {
  _logEnabled = enabled;
}

function safetyLog(tier: string, detail: string) {
  if (!_logEnabled) return;
  const tag =
    tier === 'forbidden'
      ? '\x1b[31m[safety] BLOCKED\x1b[0m'
      : tier === 'cautious'
        ? '\x1b[33m[safety] cautious\x1b[0m'
        : '\x1b[2m[safety] free\x1b[0m';
  process.stderr.write(`${tag}: ${detail}\n`);
}

/**
 * Load user safety config from ~/.config/idlehands/safety.json
 * Invalid patterns are silently skipped with a warning on stderr.
 */
export async function loadSafetyConfig(configPath?: string): Promise<SafetyConfig> {
  const p = configPath ?? path.join(configDir(), 'safety.json');
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return {};
    if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
      process.stderr.write(`[safety] warning: failed to read ${p}: ${e?.message}\n`);
    }
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    _userForbidden = compilePatterns(parsed.forbidden_patterns, 'forbidden');
    _userCautious = compilePatterns(parsed.cautious_patterns, 'cautious');
    _userAllow = compileAllowPatterns(parsed.allow_patterns);
    _userProtectedPaths = Array.isArray(parsed.protected_paths)
      ? parsed.protected_paths.filter((s: any) => typeof s === 'string')
      : [];
    _userProtectedDeleteRoots = Array.isArray(parsed.protected_delete_roots)
      ? parsed.protected_delete_roots.filter((s: any) => typeof s === 'string')
      : [];
    return parsed;
  } catch (e: any) {
    if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
      process.stderr.write(`[safety] warning: invalid JSON in ${p}: ${e?.message}\n`);
    }
    return {};
  }
}

function compilePatterns(patterns: unknown, label: string): Array<{ re: RegExp; reason: string }> {
  if (!Array.isArray(patterns)) return [];
  const result: Array<{ re: RegExp; reason: string }> = [];
  for (const p of patterns) {
    if (typeof p !== 'string') continue;
    try {
      result.push({ re: new RegExp(p), reason: `user ${label}: ${p}` });
    } catch (e: any) {
      if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
        process.stderr.write(`[safety] warning: invalid regex in ${label}: ${p} — ${e?.message}\n`);
      }
    }
  }
  return result;
}

function compileAllowPatterns(patterns: unknown): RegExp[] {
  if (!Array.isArray(patterns)) return [];
  const result: RegExp[] = [];
  for (const p of patterns) {
    if (typeof p !== 'string') continue;
    try {
      result.push(new RegExp(p));
    } catch (e: any) {
      if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
        process.stderr.write(`[safety] warning: invalid allow regex: ${p} — ${e?.message}\n`);
      }
    }
  }
  return result;
}

/** Reset all runtime safety state (for testing). */
export function resetSafetyState() {
  _lockdown = false;
  _logEnabled = false;
  _userForbidden = [];
  _userCautious = [];
  _userAllow = [];
  _userProtectedPaths = [];
  _userProtectedDeleteRoots = [];
}

// ──────────────────────────────────────────────────────
// Exec safety check
// ──────────────────────────────────────────────────────

/**
 * Screen an exec command against safety patterns.
 * Returns a verdict indicating whether the command should be blocked, confirmed, or free.
 */
export function checkExecSafety(command: string): SafetyVerdict {
  // Normalize: collapse whitespace, trim
  const cmd = command.replace(/\s+/g, ' ').trim();

  // Check forbidden patterns first (highest priority)
  // Built-in forbidden
  for (const { re, reason } of FORBIDDEN_PATTERNS) {
    if (re.test(cmd)) {
      safetyLog('forbidden', `${reason} — ${cmd}`);
      return { allowed: false, tier: 'forbidden', reason: `BLOCKED: ${reason}` };
    }
  }
  // User-defined forbidden
  for (const { re, reason } of _userForbidden) {
    if (re.test(cmd)) {
      safetyLog('forbidden', `${reason} — ${cmd}`);
      return { allowed: false, tier: 'forbidden', reason: `BLOCKED: ${reason}` };
    }
  }

  // Check cautious patterns
  // Built-in cautious
  for (const { re, reason } of CAUTIOUS_PATTERNS) {
    if (re.test(cmd)) {
      // Check user allow-list first (explicit bypass for known-safe commands)
      if (_userAllow.some((a) => a.test(cmd))) {
        safetyLog('free', `allowed by user allow_patterns — ${cmd}`);
        return { allowed: true, tier: 'free' };
      }
      // Lockdown: cautious → forbidden
      if (_lockdown) {
        safetyLog('forbidden', `lockdown promoted: ${reason} — ${cmd}`);
        return { allowed: false, tier: 'forbidden', reason: `BLOCKED (lockdown): ${reason}` };
      }
      safetyLog('cautious', `${reason} — ${cmd}`);
      return {
        allowed: true, // allowed but needs confirmation
        tier: 'cautious',
        reason,
        prompt: `⚠️  Cautious command detected: ${reason}\n\n  ${command}\n\nProceed?`,
      };
    }
  }
  // User-defined cautious
  for (const { re, reason } of _userCautious) {
    if (re.test(cmd)) {
      if (_userAllow.some((a) => a.test(cmd))) {
        safetyLog('free', `allowed by user allow_patterns — ${cmd}`);
        return { allowed: true, tier: 'free' };
      }
      if (_lockdown) {
        safetyLog('forbidden', `lockdown promoted: ${reason} — ${cmd}`);
        return { allowed: false, tier: 'forbidden', reason: `BLOCKED (lockdown): ${reason}` };
      }
      safetyLog('cautious', `${reason} — ${cmd}`);
      return {
        allowed: true,
        tier: 'cautious',
        reason,
        prompt: `⚠️  Cautious command detected: ${reason}\n\n  ${command}\n\nProceed?`,
      };
    }
  }

  safetyLog('free', cmd);
  return { allowed: true, tier: 'free' };
}

// ──────────────────────────────────────────────────────
// Path safety check (for write_file / edit_file / insert_file)
// ──────────────────────────────────────────────────────

/**
 * Check if a resolved absolute path is safe to write to.
 * This runs BEFORE any file operation.
 */
export function checkPathSafety(absPath: string): SafetyVerdict {
  const norm = path.normalize(absPath);

  // Check against built-in protected paths
  for (const pp of PROTECTED_PATHS) {
    if (norm === pp || norm.startsWith(pp + '/')) {
      safetyLog('forbidden', `write to protected path ${pp}: ${norm}`);
      return {
        allowed: false,
        tier: 'forbidden',
        reason: `BLOCKED: write to protected path ${pp}`,
      };
    }
  }

  // Check against user-defined protected paths
  for (const pp of _userProtectedPaths) {
    const normPP = path.normalize(pp);
    if (norm === normPP || norm.startsWith(normPP + '/')) {
      safetyLog('forbidden', `write to user-protected path ${pp}: ${norm}`);
      return {
        allowed: false,
        tier: 'forbidden',
        reason: `BLOCKED: write to user-protected path ${pp}`,
      };
    }
  }

  // Warn on writes outside home directory (likely unintentional)
  const home = os.homedir();
  if (!norm.startsWith(home + path.sep) && norm !== home) {
    // /tmp or Windows Temp is fine for scratch work
    const isTemp =
      process.platform === 'win32'
        ? (process.env.TEMP && norm.startsWith(path.normalize(process.env.TEMP))) ||
          (process.env.TMP && norm.startsWith(path.normalize(process.env.TMP)))
        : norm.startsWith('/tmp/') || norm.startsWith('/var/tmp/');

    if (!isTemp) {
      if (_lockdown) {
        safetyLog('forbidden', `lockdown: write outside home: ${norm}`);
        return {
          allowed: false,
          tier: 'forbidden',
          reason: `BLOCKED (lockdown): write outside home directory: ${norm}`,
        };
      }
      safetyLog('cautious', `write outside home: ${norm}`);
      return {
        allowed: true,
        tier: 'cautious',
        reason: `writing outside home directory: ${norm}`,
        prompt: `⚠️  Writing outside home directory:\n  ${norm}\n\nProceed?`,
      };
    }
  }

  safetyLog('free', `path ok: ${norm}`);
  return { allowed: true, tier: 'free' };
}

// ──────────────────────────────────────────────────────
// Path traversal detection
// ──────────────────────────────────────────────────────

/**
 * Detect if a resolved path escapes the given working directory.
 * Also checks for symlink escapes (resolves real path).
 *
 * Returns null if safe, or an error message if escaping.
 */
export async function checkPathTraversal(
  absPath: string,
  cwd: string,
  allowedDirs?: string[]
): Promise<string | null> {
  const norm = path.normalize(absPath);

  // Check if within cwd
  if (norm.startsWith(cwd + '/') || norm === cwd) return null;

  // Check if within any allowed directory
  if (allowedDirs) {
    for (const dir of allowedDirs) {
      const resolved = path.resolve(dir);
      if (norm.startsWith(resolved + '/') || norm === resolved) return null;
    }
  }

  // Check home directory — always allow access to files under home
  const home = os.homedir();
  if (norm.startsWith(home + path.sep) || norm === home) return null;

  // If path exists, check for symlink escape
  try {
    const realPath = await fs.realpath(absPath);
    if (realPath !== norm) {
      // Symlink resolved to different location — re-check
      if (!realPath.startsWith(cwd + '/') && realPath !== cwd) {
        if (allowedDirs) {
          const inAllowed = allowedDirs.some((d) => {
            const rd = path.resolve(d);
            return realPath.startsWith(rd + '/') || realPath === rd;
          });
          if (inAllowed) return null;
        }
        return `path traversal: ${absPath} resolves to ${realPath} (outside working directory ${cwd})`;
      }
    }
  } catch {
    // File doesn't exist yet — that's fine for write operations
  }

  return `path outside working directory: ${norm} is not within ${cwd}`;
}

// ──────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────

/**
 * Check if a command targets a protected delete root.
 * Used for extra protection on rm commands beyond pattern matching.
 */
export function isProtectedDeleteTarget(command: string): boolean {
  // Extract paths from rm commands
  const rmMatch = /\brm\s+(-\w+\s+)*(.+)/.exec(command);
  if (!rmMatch) return false;

  const allRoots = [...PROTECTED_DELETE_ROOTS, ..._userProtectedDeleteRoots];

  const targets = rmMatch[2].split(/\s+/).filter((t) => t.startsWith('/'));
  for (const target of targets) {
    const norm = path.normalize(target).replace(/\/+$/, '') || '/';
    if (allRoots.includes(norm)) return true;
    // Also catch /home/username (protect entire user homes)
    if (/^\/home\/[^/]+\/?$/.test(norm)) return true;
  }
  return false;
}

/**
 * Summary of all safety classifications for a command (for testing/debugging).
 */
export function classifyCommand(command: string): {
  forbidden: Array<{ pattern: string; reason: string }>;
  cautious: Array<{ pattern: string; reason: string }>;
} {
  const cmd = command.replace(/\s+/g, ' ').trim();
  const forbidden: Array<{ pattern: string; reason: string }> = [];
  const cautious: Array<{ pattern: string; reason: string }> = [];

  for (const { re, reason } of FORBIDDEN_PATTERNS) {
    if (re.test(cmd)) forbidden.push({ pattern: re.source, reason });
  }
  for (const { re, reason } of CAUTIOUS_PATTERNS) {
    if (re.test(cmd)) cautious.push({ pattern: re.source, reason });
  }

  return { forbidden, cautious };
}
