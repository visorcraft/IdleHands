/**
 * sys_context tool — Scoped system snapshot (Phase 9a).
 *
 * Collects system info on demand via snapshot.sh.
 * Cached for 60s to avoid re-running `df`, `systemctl`, etc. every tool cycle.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dist/, __dirname is dist/sys/ — script is at src/sys/snapshot.sh relative to repo root.
// In source, __dirname is src/sys/ — script is co-located.
const SNAPSHOT_SCRIPT = path.join(__dirname, 'snapshot.sh');

export type SysScope = 'all' | 'services' | 'network' | 'disk' | 'packages';

const VALID_SCOPES: SysScope[] = ['all', 'services', 'network', 'disk', 'packages'];

// Cache: scope → { text, timestamp }
const cache = new Map<string, { text: string; ts: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Detect the package manager on this system.
 * Returns: 'apt' | 'dnf' | 'pacman' | 'unknown'
 */
export function detectPackageManager(): string {
  const has = (cmd: string) =>
    spawnSync('bash', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
  if (has('apt')) return 'apt';
  if (has('dnf')) return 'dnf';
  if (has('pacman')) return 'pacman';
  return 'unknown';
}

/**
 * Run snapshot.sh with the given scope and return the output.
 * Caches results for 60s per scope.
 */
export async function collectSnapshot(scope: SysScope = 'all'): Promise<string> {
  // Check cache
  const cached = cache.get(scope);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.text;
  }

  const text = await runSnapshotScript(scope);
  cache.set(scope, { text, ts: Date.now() });
  return text;
}

/** Clear snapshot cache (for testing). */
export function clearSnapshotCache(): void {
  cache.clear();
}

/**
 * Resolve the snapshot script path. In the built dist, the script lives in
 * src/sys/snapshot.sh relative to the repo root. We try the source path first,
 * then fall back to a co-located path.
 */
function resolveSnapshotScript(): string {
  // Try likely locations in source checkout and installed package.
  const candidates = [
    SNAPSHOT_SCRIPT, // co-located (src/sys/ or dist/sys/)
    path.join(process.cwd(), 'src', 'sys', 'snapshot.sh'), // repo root → source
    path.join(process.cwd(), 'dist', 'sys', 'snapshot.sh'), // repo root → dist
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to the canonical source path for a clear error.
  return SNAPSHOT_SCRIPT;
}

async function runSnapshotScript(scope: string): Promise<string> {
  const scriptPath = resolveSnapshotScript();

  return new Promise<string>((resolve, reject) => {
    const child = spawn('bash', [scriptPath, scope], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000, // 5s hard limit
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));

    child.on('close', (code) => {
      const out = Buffer.concat(chunks).toString('utf8').trim();
      if (code !== 0) {
        const err = Buffer.concat(errChunks).toString('utf8').trim();
        reject(new Error(`snapshot.sh exited ${code}: ${err || out}`));
        return;
      }
      resolve(out);
    });

    child.on('error', (e) => reject(e));
  });
}

/**
 * Tool handler for sys_context.
 * Matches the ToolContext pattern used by other tools.
 */
export async function sys_context(_ctx: any, args: any): Promise<string> {
  const scope = typeof args?.scope === 'string' ? args.scope.toLowerCase() : 'all';

  if (!VALID_SCOPES.includes(scope as SysScope)) {
    throw new Error(`sys_context: invalid scope "${scope}". Valid: ${VALID_SCOPES.join(', ')}`);
  }

  const result = await collectSnapshot(scope as SysScope);
  if (!result) return `[sys_context: no data returned for scope "${scope}"]`;
  return result;
}

/**
 * Tool schema for sys_context (registered only when sys mode is active).
 */
export const SYS_CONTEXT_SCHEMA = {
  type: 'function' as const,
  function: {
    name: 'sys_context',
    description:
      'Get system information snapshot. Use this when you need to know about the OS, services, network, disk, or packages.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['all', 'services', 'network', 'disk', 'packages'],
          description:
            'What info to collect. "all" returns everything (~500 tokens). Individual scopes return ~100 tokens each.',
        },
      },
    },
  },
};
