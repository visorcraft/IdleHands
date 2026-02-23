import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { stateDir, randomId } from './utils.js';

export type Checkpoint = {
  id: string;
  ts: string;
  op: 'write_file' | 'edit_file' | 'edit_range' | 'insert_file' | 'apply_patch' | 'undo' | 'other';
  filePath: string;
  sha256_before: string;
  sha256_after?: string;
  note?: string;
};

export type ReplayOptions = {
  dir?: string; // default ~/.local/state/idlehands/replay
  maxCheckpoints?: number; // default 200
};

function defaultReplayDir() {
  return path.join(stateDir(), 'replay');
}

function sha256Bytes(buf: Buffer) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export class ReplayStore {
  private readonly dir: string;
  private readonly max: number;
  private readonly indexPath: string;

  constructor(opts: ReplayOptions = {}) {
    this.dir = opts.dir ?? defaultReplayDir();
    this.max = opts.maxCheckpoints ?? 200;
    this.indexPath = path.join(this.dir, 'checkpoints.jsonl');
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    // touch index
    await fs.appendFile(this.indexPath, '');
  }

  async list(limit = 50): Promise<Checkpoint[]> {
    const raw = await fs.readFile(this.indexPath, 'utf8').catch(() => '');
    const rows: Checkpoint[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // ignore
      }
    }
    return rows.slice(-limit).reverse();
  }

  async checkpoint(args: {
    op: Checkpoint['op'];
    filePath: string;
    before: Buffer;
    after?: Buffer;
    note?: string;
  }): Promise<Checkpoint> {
    await this.init();

    const ts = new Date().toISOString();
    const id = `${ts.replace(/[:.]/g, '-')}_${randomId()}`;

    const beforeHash = sha256Bytes(args.before);
    const afterHash = args.after ? sha256Bytes(args.after) : undefined;

    const cp: Checkpoint = {
      id,
      ts,
      op: args.op,
      filePath: args.filePath,
      sha256_before: beforeHash,
      sha256_after: afterHash,
      note: args.note,
    };

    const blobDir = path.join(this.dir, 'blobs');
    await fs.mkdir(blobDir, { recursive: true });
    await fs.writeFile(path.join(blobDir, `${id}.before`), args.before);
    if (args.after) await fs.writeFile(path.join(blobDir, `${id}.after`), args.after);

    await fs.appendFile(this.indexPath, JSON.stringify(cp) + '\n', 'utf8');
    await this.rotate();

    return cp;
  }

  async get(id: string): Promise<{ cp: Checkpoint; before: Buffer; after?: Buffer }> {
    const cands = await this.list(10000);
    const cp = cands.find((x) => x.id === id);
    if (!cp) throw new Error(`checkpoint not found: ${id}`);

    const blobDir = path.join(this.dir, 'blobs');
    const before = await fs.readFile(path.join(blobDir, `${id}.before`));
    let after: Buffer | undefined;
    try {
      after = await fs.readFile(path.join(blobDir, `${id}.after`));
    } catch {
      // ignore
    }
    return { cp, before, after };
  }

  async rewind(
    id: string,
    readCurrent: () => Promise<Buffer>,
    write: (buf: Buffer) => Promise<void>
  ): Promise<string> {
    const { cp, before } = await this.get(id);

    const cur = await readCurrent().catch((e: any) => {
      if (e?.code === 'ENOENT') {
        return Buffer.from('');
      }
      throw e;
    });

    let warn = '';
    // best-effort safety: ensure current matches cp.after if we have it
    if (cp.sha256_after) {
      const curHash = sha256Bytes(cur);
      if (curHash !== cp.sha256_after) {
        warn = ` [warn: checksum mismatch for ${cp.filePath} (expected ${cp.sha256_after.slice(0, 8)}..., got ${curHash.slice(0, 8)}...)]`;
      }
    }

    const msg = `rewound ${cp.filePath} to checkpoint ${id}`;
    try {
      await this.checkpoint({
        op: 'undo',
        filePath: cp.filePath,
        before: cur,
        after: before,
        note: `rewind to ${id}`,
      });
    } catch (e) {
      throw new Error(
        `${msg}${warn}: checkpoint failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    await write(before);
    return `${msg}${warn}`;
  }

  private async rotate() {
    const cps = await this.list(10000);
    if (cps.length <= this.max) return;
    // cps returned newest-first; delete oldest
    const keep = new Set(cps.slice(0, this.max).map((c) => c.id));
    const blobDir = path.join(this.dir, 'blobs');

    // Rewrite index with kept checkpoints in chronological order.
    const kept = cps.slice(0, this.max).reverse();
    await fs.writeFile(
      this.indexPath,
      kept.map((c) => JSON.stringify(c)).join('\n') + '\n',
      'utf8'
    );

    // best-effort blob cleanup
    const ents = await fs.readdir(blobDir).catch(() => []);
    for (const name of ents) {
      const m = /^(.*)\.(before|after)$/.exec(name);
      if (!m) continue;
      const id = m[1];
      if (!keep.has(id)) {
        await fs.rm(path.join(blobDir, name), { force: true }).catch(() => {});
      }
    }
  }
}
