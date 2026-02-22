import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ChatMessage } from './types.js';
import { stateDir } from './utils.js';

export type VaultMode = 'note' | 'tool';

export type VaultSearchResult = {
  id: string;
  kind: VaultMode | 'system';
  key?: string;
  value?: string;
  tool?: string;
  toolCallId?: string;
  content?: string;
  snippet?: string;
  createdAt: string;
  updatedAt: string;
  score?: number;
};

type VaultDbRow = {
  id: number;
  kind: VaultMode | 'system';
  key: string | null;
  value: string | null;
  tool: string | null;
  tool_call_id: string | null;
  content: string | null;
  snippet: string | null;
  project_dir: string | null;
  created_at: string | null;
  updated_at: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  score?: number | null;
};

type VaultOptions = {
  path?: string;
  maxEntries?: number;
  projectDir?: string;
  /** Retention cap for immutable review artifacts per project (artifact:review:item:*). */
  immutableReviewArtifactsPerProject?: number;
};

function defaultVaultPath() {
  return path.join(stateDir(), 'vault.db');
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function nowIso() {
  return new Date().toISOString();
}

function isToolMessage(
  m: ChatMessage
): m is { role: 'tool'; content: string; tool_call_id: string } {
  return m.role === 'tool' && typeof m.content === 'string' && typeof m.tool_call_id === 'string';
}

function toSearchText(row: VaultDbRow) {
  return normalizeText(
    `${row.key ?? ''} ${row.tool ?? ''} ${row.value ?? ''} ${row.snippet ?? ''} ${row.content ?? ''}`
  );
}

function isProtectedArtifactKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return key.startsWith('artifact:review:latest:') || key.startsWith('artifact:review:item:');
}

function isProtectedArtifactLatestKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return key.startsWith('artifact:review:latest:');
}

function isImmutableArtifactItemKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return key.startsWith('artifact:review:item:');
}

function immutableArtifactProjectId(key: string | null | undefined): string | null {
  if (!isImmutableArtifactItemKey(key)) return null;
  const rest = String(key).slice('artifact:review:item:'.length);
  const idx = rest.indexOf(':');
  if (idx <= 0) return null;
  return rest.slice(0, idx);
}

export class VaultStore {
  private readonly dbPath: string;
  private readonly maxEntries: number;
  private readonly immutableReviewArtifactsPerProject: number;
  private db: DatabaseSync | null = null;
  private initPromise: Promise<void> | null = null;
  private ftsEnabled = false;
  private _projectDir: string | undefined;

  constructor(opts: VaultOptions = {}) {
    this.dbPath = opts.path ?? defaultVaultPath();
    this.maxEntries = opts.maxEntries ?? 500;
    this.immutableReviewArtifactsPerProject = Math.max(
      1,
      Math.floor(opts.immutableReviewArtifactsPerProject ?? 20)
    );
    this._projectDir = opts.projectDir;
  }

  /** Set the project directory for scoping vault entries. */
  setProjectDir(dir: string): void {
    this._projectDir = dir;
  }

  /** Get the current project directory. */
  get projectDir(): string | undefined {
    return this._projectDir;
  }

  /** Close the database connection. Safe to call multiple times. */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* already closed */
      }
      this.db = null;
    }
    this.initPromise = null;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = this.open();
    }
    return this.initPromise;
  }

  async count(): Promise<number> {
    await this.init();
    const rows = this.rows<{ count: number }>('SELECT COUNT(*) as count FROM vault_entries');
    return Number(rows[0]?.count ?? 0);
  }

  async list(limit = 50): Promise<VaultSearchResult[]> {
    await this.init();
    const n = Math.max(1, limit);
    const rows = this.rows<VaultDbRow>(
      `SELECT id, kind, key, value, tool, tool_call_id, content, snippet, project_dir, created_at, updated_at
       FROM vault_entries
       ORDER BY updated_at DESC
       LIMIT ?`,
      [n]
    );
    return rows.map((r) => this.mapRow(r));
  }

  async note(key: string, value: string): Promise<string> {
    await this.init();
    const cleanKey = key.trim();
    const cleanVal = String(value ?? '');

    const id = this.transaction(() =>
      this.insertAndIndex('note', cleanKey, cleanVal, null, null, cleanVal, truncate(cleanVal, 300))
    );

    await this.pruneToLimit();
    await this.persist();
    return String(id ?? '');
  }

  async upsertNote(key: string, value: string, kind: 'note' | 'system' = 'note'): Promise<string> {
    await this.init();

    const cleanKey = key.trim();
    const cleanVal = String(value ?? '');
    const now = nowIso();
    const snippet = truncate(cleanVal, 300);

    if (!this.db) throw new Error('vault db not initialized');

    let id = 0;
    this.db.exec('BEGIN');
    try {
      const existing = this.rows<{ id: number }>(
        `SELECT id FROM vault_entries WHERE kind = ? AND key = ? ORDER BY id DESC LIMIT 1`,
        [kind, cleanKey]
      );

      if (existing.length) {
        const existingId = Number(existing[0].id);
        const projDir = this._projectDir ?? null;
        this.run(
          `UPDATE vault_entries SET updated_at = ?, value = ?, content = ?, snippet = ?, project_dir = COALESCE(?, project_dir) WHERE id = ?`,
          [now, cleanVal, cleanVal, snippet, projDir, existingId]
        );
        if (this.ftsEnabled) {
          this.run('DELETE FROM vault_fts WHERE rowid = ?', [existingId]);
          const row: VaultDbRow = {
            id: existingId,
            kind,
            key: cleanKey,
            value: cleanVal,
            tool: null,
            tool_call_id: null,
            content: cleanVal,
            snippet,
            project_dir: projDir,
            created_at: now,
            updated_at: now,
            createdAt: now,
            updatedAt: now,
          };
          this.indexFts(existingId, row);
        }
        id = existingId;
      } else {
        id = this.insertAndIndex(kind, cleanKey, cleanVal, null, null, cleanVal, snippet);
      }

      const immutableOverflow = Array.from(this.immutableArtifactOverflowIds());
      if (immutableOverflow.length) {
        this.deleteIds(immutableOverflow);
      }

      const row = this.rows<{ count: number }>('SELECT COUNT(*) as count FROM vault_entries');
      const count = Number(row[0]?.count ?? 0);
      const excess = count - this.maxEntries;
      if (excess > 0) {
        const ids = this.selectPrunableIds(excess);
        if (ids.length) {
          this.deleteIds(ids);
        }
      }

      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }

    await this.persist();
    return String(id);
  }

  async getLatestByKey(
    key: string,
    kind?: VaultMode | 'system'
  ): Promise<VaultSearchResult | null> {
    await this.init();

    const rows = kind
      ? this.rows<VaultDbRow>(
          `SELECT id, kind, key, value, tool, tool_call_id, content, snippet, project_dir, created_at, updated_at
           FROM vault_entries
           WHERE key = ? AND kind = ?
           ORDER BY updated_at DESC, id DESC
           LIMIT 1`,
          [key, kind]
        )
      : this.rows<VaultDbRow>(
          `SELECT id, kind, key, value, tool, tool_call_id, content, snippet, project_dir, created_at, updated_at
           FROM vault_entries
           WHERE key = ?
           ORDER BY updated_at DESC, id DESC
           LIMIT 1`,
          [key]
        );

    if (!rows.length) return null;
    return this.mapRow(rows[0]);
  }

  async deleteByKey(key: string): Promise<number> {
    await this.init();
    const ids = this.rows<{ id: number }>(`SELECT id FROM vault_entries WHERE key = ?`, [key]).map(
      (r) => Number(r.id)
    );
    return this.deleteByIds(ids);
  }

  async deleteByKeyPrefix(prefix: string): Promise<number> {
    await this.init();
    const ids = this.rows<{ id: number }>(`SELECT id FROM vault_entries WHERE key LIKE ?`, [
      `${prefix}%`,
    ]).map((r) => Number(r.id));
    return this.deleteByIds(ids);
  }

  /** Shared delete-by-ids helper (entries + FTS). */
  private async deleteByIds(ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(',');
    this.transaction(() => {
      this.run(`DELETE FROM vault_entries WHERE id IN (${placeholders})`, ids);
      if (this.ftsEnabled) {
        this.run(`DELETE FROM vault_fts WHERE rowid IN (${placeholders})`, ids);
      }
    });
    await this.persist();
    return ids.length;
  }

  async archiveToolResult(message: ChatMessage, toolName?: string): Promise<void> {
    if (!isToolMessage(message)) return;
    if (!message.content?.trim()) return;

    await this.init();

    const exists = this.rows<{ found: number }>(
      `SELECT 1 as found FROM vault_entries WHERE kind='tool' AND tool_call_id = ? LIMIT 1`,
      [message.tool_call_id]
    );
    if (exists.length) return;

    const name = (toolName ?? 'tool').trim() || 'tool';
    const raw = message.content;

    this.transaction(() =>
      this.insertAndIndex(
        'tool',
        `tool:${name}`,
        raw,
        name,
        message.tool_call_id,
        raw,
        truncate(raw, 300)
      )
    );

    await this.pruneToLimit();
    await this.persist();
  }

  async archiveToolMessages(
    messages: ChatMessage[],
    toolNameByCallId: Map<string, string> = new Map()
  ): Promise<number> {
    await this.init();

    // Filter to valid tool messages that aren't already archived
    const toArchive: Array<{ content: string; tool_call_id: string; name: string }> = [];
    for (const m of messages) {
      if (!isToolMessage(m) || !m.content?.trim()) continue;
      const exists = this.rows<{ found: number }>(
        `SELECT 1 as found FROM vault_entries WHERE kind='tool' AND tool_call_id = ? LIMIT 1`,
        [m.tool_call_id]
      );
      if (exists.length) continue;
      toArchive.push({
        content: m.content,
        tool_call_id: m.tool_call_id,
        name: (toolNameByCallId.get(m.tool_call_id) ?? 'tool').trim() || 'tool',
      });
    }

    if (!toArchive.length) return 0;

    // Batch insert in a single transaction
    this.transaction(() => {
      for (const item of toArchive) {
        this.insertAndIndex(
          'tool',
          `tool:${item.name}`,
          item.content,
          item.name,
          item.tool_call_id,
          item.content,
          truncate(item.content, 300)
        );
      }
    });

    await this.pruneToLimit();
    await this.persist();
    return toArchive.length;
  }

  async search(query: string, limit = 5): Promise<VaultSearchResult[]> {
    await this.init();
    const q = normalizeText(query || '');
    if (!q.trim()) return [];

    const n = Math.max(1, limit);
    const projDir = this._projectDir ?? null;

    if (this.ftsEnabled) {
      try {
        const ftsQuery = this.escapeFtsQuery(q);
        // Fetch extra results to allow project-scoping reorder
        const fetchLimit = projDir ? n * 3 : n;
        const rows = this.rows<VaultDbRow & { rank: number }>(
          `SELECT e.id, e.kind, e.key, e.value, e.tool, e.tool_call_id, e.content, e.snippet, e.project_dir, e.created_at, e.updated_at,
                  bm25(vault_fts) as rank
           FROM vault_fts
           JOIN vault_entries e ON e.id = vault_fts.rowid
           WHERE vault_fts MATCH ?
           ORDER BY rank ASC, e.updated_at DESC
           LIMIT ?`,
          [ftsQuery, fetchLimit]
        );

        let results = rows
          .map((r) => ({
            ...this.mapRow(r),
            score: Number(r.rank ?? 0),
            _projectDir: r.project_dir,
          }))
          .filter(Boolean);

        // Project scoping: same-project entries first, then unscoped, then other-project
        if (projDir) {
          results = this.sortByProjectRelevance(results, projDir);
        }

        return results.slice(0, n).map(({ _projectDir, ...rest }) => rest);
      } catch (e) {
        this.ftsEnabled = false;
      }
    }

    const rows = this.rows<VaultDbRow>(
      `SELECT id, kind, key, value, tool, tool_call_id, content, snippet, project_dir, created_at, updated_at
       FROM vault_entries
       WHERE LOWER(COALESCE(key, '')) LIKE ?
          OR LOWER(COALESCE(tool, '')) LIKE ?
          OR LOWER(COALESCE(content, '')) LIKE ?
          OR LOWER(COALESCE(snippet, '')) LIKE ?
       ORDER BY updated_at DESC
       LIMIT ?`,
      [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, n * 10]
    );

    const tokens = q.split(' ').filter(Boolean);
    const scored = rows
      .map((r) => {
        const haystack = toSearchText(r);
        let score = 0;
        if (haystack.includes(q)) score += 4;
        for (const t of tokens) {
          if (!t) continue;
          if (haystack.includes(t)) score += 1;
        }
        return {
          ...r,
          score,
          updatedAt: r.updated_at ?? r.updatedAt ?? '',
          _projectDir: r.project_dir,
        };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));
      });

    let results = scored.slice(0, projDir ? n * 3 : n);

    // Project scoping: same-project entries first
    if (projDir) {
      results = this.sortByProjectRelevance(results, projDir);
    }

    return results.slice(0, n).map((r: any) => {
      const { _projectDir, ...rest } = r;
      return { ...this.mapRow(rest), score: r.score };
    });
  }

  /**
   * Sort results by project relevance:
   * 1. Same project dir (exact match or child path)
   * 2. No project dir (legacy/unscoped entries)
   * 3. Different project dir (cross-project — deprioritized)
   */
  private sortByProjectRelevance<T extends { _projectDir?: string | null; score?: number }>(
    results: T[],
    projDir: string
  ): T[] {
    const norm = projDir.replace(/\/+$/, '');
    return results.sort((a, b) => {
      const aTier = this.projectTier(a._projectDir, norm);
      const bTier = this.projectTier(b._projectDir, norm);
      if (aTier !== bTier) return aTier - bTier;
      // Within same tier, preserve original score ordering
      return (b.score ?? 0) - (a.score ?? 0);
    });
  }

  /** 0 = same project, 1 = unscoped, 2 = different project */
  private projectTier(entryDir: string | null | undefined, normProjDir: string): number {
    if (!entryDir) return 1; // unscoped legacy entry
    const normEntry = entryDir.replace(/\/+$/, '');
    if (normEntry === normProjDir || normEntry.startsWith(normProjDir + '/')) return 0;
    return 2;
  }

  private async open() {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });

    try {
      this.db = new DatabaseSync(this.dbPath);
      this.migrate();
      await this.rebuildFts();
      await this.pruneToLimit();
      return;
    } catch (e) {
      if (this.db) {
        try {
          this.db.close();
        } catch {
          /* ignore */
        }
        this.db = null;
      }
      await this.recoverCorruptDb(e);
      return;
    }
  }

  private async recoverCorruptDb(e: unknown) {
    const backup = `${this.dbPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.rename(this.dbPath, backup).catch(() => {});
    this.db = new DatabaseSync(this.dbPath);
    this.migrate();
    await this.rebuildFts();
    if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
      console.warn(
        `[warn] vault db corrupt, recreated from scratch: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private migrate() {
    if (!this.db) throw new Error('vault db not initialized');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK(kind IN ('note','tool','system')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        key TEXT,
        value TEXT,
        tool TEXT,
        tool_call_id TEXT,
        content TEXT,
        snippet TEXT,
        project_dir TEXT
      );
    `);

    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_vault_updated_at ON vault_entries (updated_at DESC);'
    );
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_vault_tool_call ON vault_entries (tool_call_id);');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_vault_project_dir ON vault_entries (project_dir);'
    );

    // Migration: add project_dir column to existing databases
    try {
      this.db.exec('ALTER TABLE vault_entries ADD COLUMN project_dir TEXT');
    } catch {
      // Column already exists — safe to ignore
    }
  }

  private async rebuildFts() {
    if (!this.db) return;

    try {
      this.db.exec('DROP TABLE IF EXISTS vault_fts;');
      this.db.exec('CREATE VIRTUAL TABLE vault_fts USING fts5(search_text);');
      this.ftsEnabled = true;

      const rows = this.rows<VaultDbRow>(
        `SELECT id, kind, key, value, tool, tool_call_id, content, snippet, project_dir, created_at, updated_at
         FROM vault_entries`
      );

      for (const row of rows) {
        this.indexFts(row.id, row);
      }
      return;
    } catch {
      this.ftsEnabled = false;
      this.db.exec('DROP TABLE IF EXISTS vault_fts;');
    }
  }

  private immutableArtifactOverflowIds(): Set<number> {
    const overflow = new Set<number>();
    const rows = this.rows<{ id: number; key: string | null }>(
      `SELECT id, key
       FROM vault_entries
       WHERE kind = 'system' AND key LIKE 'artifact:review:item:%'
       ORDER BY id DESC`
    );

    const perProject = new Map<string, number>();
    for (const row of rows) {
      const projectId = immutableArtifactProjectId(row.key);
      if (!projectId) continue;
      const seen = perProject.get(projectId) ?? 0;
      const next = seen + 1;
      perProject.set(projectId, next);
      if (next > this.immutableReviewArtifactsPerProject) {
        overflow.add(row.id);
      }
    }

    return overflow;
  }

  private deleteIds(ids: number[]): void {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    this.run(`DELETE FROM vault_entries WHERE id IN (${placeholders})`, ids);
    if (this.ftsEnabled) {
      this.run(`DELETE FROM vault_fts WHERE rowid IN (${placeholders})`, ids);
    }
  }

  private selectPrunableIds(excess: number): number[] {
    if (excess <= 0) return [];

    const immutableOverflow = this.immutableArtifactOverflowIds();
    const candidates = this.rows<{ id: number; kind: VaultMode | 'system'; key: string | null }>(
      'SELECT id, kind, key FROM vault_entries ORDER BY id ASC'
    );

    return candidates
      .filter((item) => {
        if (item.kind !== 'system') return true;
        if (isProtectedArtifactLatestKey(item.key)) return false;
        if (isImmutableArtifactItemKey(item.key)) return immutableOverflow.has(item.id);
        return !isProtectedArtifactKey(item.key);
      })
      .slice(0, excess)
      .map((item) => item.id);
  }

  private async pruneToLimit() {
    if (!this.db) return;

    this.transaction(() => {
      const immutableOverflow = Array.from(this.immutableArtifactOverflowIds());
      if (immutableOverflow.length) {
        this.deleteIds(immutableOverflow);
      }

      const row = this.rows<{ count: number }>('SELECT COUNT(*) as count FROM vault_entries');
      const count = Number(row[0]?.count ?? 0);
      const excess = count - this.maxEntries;
      if (excess <= 0) return;

      const ids = this.selectPrunableIds(excess);
      if (ids.length) {
        this.deleteIds(ids);
      }
    });
  }

  private indexFts(id: number, row: VaultDbRow) {
    if (!this.db || !this.ftsEnabled) return;
    const text = truncate(toSearchText(row), 10000);
    try {
      // Keep FTS row aligned with base table rowid.
      this.db.prepare('INSERT INTO vault_fts(rowid, search_text) VALUES (?, ?)').run(id, text);
    } catch {
      this.ftsEnabled = false;
    }
  }

  private escapeFtsQuery(query: string): string {
    const tokens = normalizeText(query)
      .split(' ')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => t.replace(/[^\p{L}\p{N}_:.\-]/gu, ''))
      .filter(Boolean);

    if (!tokens.length) return query;
    return tokens.map((t) => `"${t}"`).join(' OR ');
  }

  private mapRow(r: VaultDbRow): VaultSearchResult {
    return {
      id: String(r.id),
      kind: r.kind,
      key: r.key ?? undefined,
      value: r.value ?? undefined,
      tool: r.tool ?? undefined,
      toolCallId: r.tool_call_id ?? undefined,
      content: r.content ?? undefined,
      snippet: r.snippet ?? undefined,
      createdAt: r.created_at ?? r.createdAt ?? '',
      updatedAt: r.updated_at ?? r.updatedAt ?? '',
    };
  }

  private run(sql: string, params: any[] = []) {
    if (!this.db) throw new Error('vault db not initialized');
    return this.db.prepare(sql).run(...params);
  }

  private rows<T>(sql: string, params: any[] = []): T[] {
    if (!this.db) throw new Error('vault db not initialized');
    return (this.db.prepare(sql).all(...params) as T[]) ?? [];
  }

  /** Run a function inside a BEGIN/COMMIT transaction. Rolls back on error. */
  private transaction<T>(fn: () => T): T {
    if (!this.db) throw new Error('vault db not initialized');
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  /** Insert + FTS index helper to eliminate duplication across note/upsert/archive methods. */
  private insertAndIndex(
    kind: VaultMode | 'system',
    key: string | null,
    value: string | null,
    tool: string | null,
    toolCallId: string | null,
    content: string | null,
    snippet: string | null
  ): number {
    const now = nowIso();
    const projDir = this._projectDir ?? null;
    const result = this.run(
      `INSERT INTO vault_entries(kind, created_at, updated_at, key, value, tool, tool_call_id, content, snippet, project_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [kind, now, now, key, value, tool, toolCallId, content, snippet, projDir]
    );
    const id = Number(result.lastInsertRowid);
    if (id != null && this.ftsEnabled) {
      const row: VaultDbRow = {
        id,
        kind,
        key,
        value,
        tool,
        tool_call_id: toolCallId,
        content,
        snippet,
        project_dir: projDir,
        created_at: now,
        updated_at: now,
        createdAt: now,
        updatedAt: now,
      };
      this.indexFts(id, row);
    }
    return id;
  }

  private async persist() {
    if (!this.db) return;
    try {
      this.db.exec('PRAGMA wal_checkpoint(FULL);');
    } catch {
      // SQLite sync mode may already flush automatically in local file mode.
    }
  }
}
