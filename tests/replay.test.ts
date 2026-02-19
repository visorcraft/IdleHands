import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { ReplayStore } from '../dist/replay.js';
import { LensStore } from '../dist/lens.js';

async function mkTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-replay-test-'));
}

describe('ReplayStore', () => {
  it('creates checkpoints and can retrieve blobs', async () => {
    const dir = await mkTempDir();
    const replay = new ReplayStore({ dir, maxCheckpoints: 50 });

    const cp = await replay.checkpoint({
      op: 'write_file',
      filePath: '/tmp/a.txt',
      before: Buffer.from('before'),
      after: Buffer.from('after'),
      note: 'initial write'
    });

    const got = await replay.get(cp.id);
    assert.equal(got.cp.id, cp.id);
    assert.equal(got.before.toString('utf8'), 'before');
    assert.equal(got.after?.toString('utf8'), 'after');
    assert.equal(got.cp.note, 'initial write');

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rewind warns on SHA mismatch and restores prior bytes', async () => {
    const dir = await mkTempDir();
    const replay = new ReplayStore({ dir, maxCheckpoints: 50 });

    const cp = await replay.checkpoint({
      op: 'edit_file',
      filePath: '/tmp/b.txt',
      before: Buffer.from('OLD'),
      after: Buffer.from('NEW')
    });

    let current = Buffer.from('DIVERGED');
    const msg = await replay.rewind(
      cp.id,
      async () => current,
      async (buf) => {
        current = Buffer.from(buf);
      }
    );

    assert.ok(msg.includes('rewound'));
    assert.ok(msg.includes('checksum mismatch'));
    assert.equal(current.toString('utf8'), 'OLD');

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('truncates checkpoint history to maxCheckpoints', async () => {
    const dir = await mkTempDir();
    const replay = new ReplayStore({ dir, maxCheckpoints: 2 });

    for (let i = 0; i < 5; i++) {
      await replay.checkpoint({
        op: 'other',
        filePath: `/tmp/${i}.txt`,
        before: Buffer.from(`b${i}`),
        after: Buffer.from(`a${i}`),
        note: `cp-${i}`
      });
    }

    const listed = await replay.list(100);
    assert.equal(listed.length, 2, 'history should be truncated to maxCheckpoints');
    assert.equal(listed[0].note, 'cp-4');
    assert.equal(listed[1].note, 'cp-3');

    // Ensure old blobs were cleaned up best-effort (newest two checkpoints => <= 4 blobs)
    const blobDir = path.join(dir, 'blobs');
    const blobs = await fs.readdir(blobDir);
    assert.ok(blobs.length <= 4, `expected <=4 blob files after rotation, got ${blobs.length}`);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stores structural diff note metadata for replay auditing', async () => {
    const dir = await mkTempDir();
    const replay = new ReplayStore({ dir, maxCheckpoints: 50 });
    const lens = new LensStore();

    const before = 'function oldName() {}\n';
    const after = 'function newName() {}\n';
    const note = (await lens.summarizeDiffToText(before, after, '/tmp/c.ts')) ?? 'diff unavailable';

    const cp = await replay.checkpoint({
      op: 'edit_file',
      filePath: '/tmp/c.ts',
      before: Buffer.from(before),
      after: Buffer.from(after),
      note
    });

    const got = await replay.get(cp.id);
    assert.ok((got.cp.note ?? '').includes('diff'));
    assert.ok((got.cp.note ?? '').includes('signature') || (got.cp.note ?? '').includes('added'));

    await fs.rm(dir, { recursive: true, force: true });
  });
});
