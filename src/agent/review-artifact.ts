import { spawnSync } from 'node:child_process';
import { projectIndexKeys } from '../indexer.js';
import { isGitDirty } from '../git.js';
import { BASH_PATH as BASH } from '../utils.js';

export type ReviewArtifact = {
  id: string;
  kind: 'code_review';
  createdAt: string;
  model: string;
  projectId: string;
  projectDir: string;
  prompt: string;
  content: string;
  gitHead?: string;
  gitDirty?: boolean;
};

export function reviewArtifactKeys(projectDir: string): { latestKey: string; byIdPrefix: string; projectId: string } {
  const { projectId } = projectIndexKeys(projectDir);
  return {
    projectId,
    latestKey: `artifact:review:latest:${projectId}`,
    byIdPrefix: `artifact:review:item:${projectId}:`,
  };
}

export function looksLikeCodeReviewRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  if (/^\s*\/review\b/.test(t)) return true;
  if (/\b(?:code\s+review|security\s+review|review\s+the\s+(?:code|diff|changes|repo|repository|pr)|audit\s+the\s+code)\b/.test(t)) return true;
  return /\breview\b/.test(t) && /\b(?:code|repo|repository|diff|changes|pull\s*request|pr)\b/.test(t);
}

export function looksLikeReviewRetrievalRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;

  if (/^\s*\/review\s+(?:print|show|replay|latest|last|full)\b/.test(t)) return true;

  if (!/\breview\b/.test(t)) return false;

  if (/\bprint\s+stale\s+review\s+anyway\b/.test(t)) return true;
  if (/\b(?:print|show|display|repeat|paste|send|output|give)\b[^\n.]{0,80}\breview\b[^\n.]{0,40}\b(?:again|back)\b/.test(t)) return true;
  if (/\b(?:print|show|display|repeat|paste|send|output|give)\b[^\n.]{0,80}\b(?:full|entire|complete|whole)\b[^\n.]{0,80}\breview\b/.test(t)) return true;
  if (/\b(?:full|entire|complete|whole)\b[^\n.]{0,30}\bcode\s+review\b/.test(t) && /\b(?:print|show|display|repeat|paste|send|output|give)\b/.test(t)) return true;
  if (/\b(?:print|show|display|repeat|paste|send|output|give)\b[^\n.]{0,80}\b(?:last|latest|previous)\b[^\n.]{0,40}\breview\b/.test(t)) return true;
  return false;
}

export function retrievalAllowsStaleArtifact(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  if (/\bprint\s+stale\s+review\s+anyway\b/.test(t)) return true;
  if (/\b(?:force|override|ignore)\b[^\n.]{0,80}\b(?:stale|old|previous)\b[^\n.]{0,80}\breview\b/.test(t)) return true;
  if (/\b(?:stale|old|previous)\b[^\n.]{0,80}\breview\b[^\n.]{0,80}\b(?:anyway|still|force|override|ignore)\b/.test(t)) return true;
  return false;
}

export type ReviewArtifactStalePolicy = 'warn' | 'block';

export function parseReviewArtifactStalePolicy(raw: unknown): ReviewArtifactStalePolicy {
  const v = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  if (v === 'block') return 'block';
  return 'warn';
}

export function parseReviewArtifact(raw: string): ReviewArtifact | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.kind !== 'code_review') return null;
    if (typeof parsed.id !== 'string' || !parsed.id) return null;
    if (typeof parsed.createdAt !== 'string' || !parsed.createdAt) return null;
    if (typeof parsed.model !== 'string') return null;
    if (typeof parsed.projectId !== 'string' || !parsed.projectId) return null;
    if (typeof parsed.projectDir !== 'string' || !parsed.projectDir) return null;
    if (typeof parsed.prompt !== 'string') return null;
    if (typeof parsed.content !== 'string') return null;
    return parsed as ReviewArtifact;
  } catch {
    return null;
  }
}

export function gitHead(cwd: string): string | undefined {
  const inside = spawnSync(BASH, ['-lc', 'git rev-parse --is-inside-work-tree'], {
    cwd,
    encoding: 'utf8',
    timeout: 1000,
  });
  if (inside.status !== 0 || !String(inside.stdout || '').trim().startsWith('true')) return undefined;

  const head = spawnSync(BASH, ['-lc', 'git rev-parse HEAD'], {
    cwd,
    encoding: 'utf8',
    timeout: 1000,
  });
  if (head.status !== 0) return undefined;
  const sha = String(head.stdout || '').trim();
  return sha || undefined;
}

function shortSha(sha?: string): string {
  if (!sha) return 'unknown';
  return sha.slice(0, 8);
}

export function reviewArtifactStaleReason(artifact: ReviewArtifact, cwd: string): string {
  const currentHead = gitHead(cwd);
  const currentDirty = isGitDirty(cwd);

  if (artifact.gitHead && currentHead && artifact.gitHead !== currentHead) {
    return `Stored review was generated at commit ${shortSha(artifact.gitHead)}; repository is now at ${shortSha(currentHead)}.`;
  }
  if (artifact.gitDirty === false && currentDirty) {
    return 'Stored review was generated on a clean tree; working tree now has uncommitted changes.';
  }
  return '';
}

export function normalizeModelsResponse(raw: any): { data: Array<{ id: string; [k: string]: any }> } {
  if (Array.isArray(raw)) {
    return {
      data: raw
        .map((m: any) => {
          if (!m) return null;
          if (typeof m === 'string') return { id: m };
          if (typeof m.id === 'string' && m.id) return m;
          return null;
        })
        .filter(Boolean) as Array<{ id: string; [k: string]: any }>
    };
  }

  if (raw && Array.isArray(raw.data)) {
    return {
      data: raw.data
        .map((m: any) => (m && typeof m.id === 'string' && m.id ? m : null))
        .filter(Boolean) as Array<{ id: string; [k: string]: any }>
    };
  }

  return { data: [] };
}
