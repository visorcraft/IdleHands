import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { VaultStore } from '../dist/vault.js';
import { LensStore } from '../dist/lens.js';
import {
  runProjectIndex,
  projectIndexKeys,
  parseIndexMeta,
  isFreshIndex,
  indexSummaryLine,
} from '../dist/indexer.js';

describe('project indexer', () => {
  let tmpDir: string;
  let vault: VaultStore;
  let lens: LensStore;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-indexer-'));

    const vaultPath = path.join(tmpDir, 'vault.db');
    vault = new VaultStore({ path: vaultPath, maxEntries: 10_000 });
    await vault.init();

    lens = new LensStore();
    await lens.init();
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('builds index entries with metadata and summary', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });

    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'ignored.ts\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, '.idlehandsignore'), 'secret.py\n', 'utf8');

    await fs.writeFile(path.join(tmpDir, 'src', 'app.ts'), 'export function app() { return 1; }\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'src', 'worker.py'), 'def worker():\n  return 2\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'ignored.ts'), 'export const ignored = true\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'secret.py'), 'def secret():\n  pass\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg', 'skip.ts'), 'export const x = 1\n', 'utf8');

    const progress: Array<{ scanned: number; indexed: number; skipped: number; current?: string }> = [];

    const result = await runProjectIndex({
      projectDir: tmpDir,
      vault,
      lens,
      onProgress: (p) => progress.push(p),
    });

    assert.ok(result.filesIndexed >= 2, `expected indexed >= 2, got ${result.filesIndexed}`);
    assert.equal(result.meta.fileCount, 2, 'only app.ts + worker.py should be indexed');
    assert.ok(result.meta.languages.typescript >= 1);
    assert.ok(result.meta.languages.python >= 1);
    assert.ok(result.totalSkeletonTokens > 0);
    assert.ok(progress.length > 0, 'expected progress callbacks');

    const keys = projectIndexKeys(tmpDir);
    const metaRow = await vault.getLatestByKey(keys.metaKey, 'system');
    const summaryRow = await vault.getLatestByKey(keys.summaryKey, 'system');

    assert.ok(metaRow?.value, 'meta row should exist');
    assert.ok(summaryRow?.value, 'summary row should exist');

    const meta = parseIndexMeta(metaRow!.value!);
    assert.ok(meta);
    assert.equal(meta!.fileCount, 2);
    assert.equal(isFreshIndex(meta!), true);
    assert.ok(summaryRow!.value!.includes('[index]'));
    assert.equal(indexSummaryLine(meta!), summaryRow!.value);

    const hit = await vault.search('function app', 10);
    assert.ok(
      hit.some((r) => (r.key || '').startsWith(keys.filePrefix)),
      'indexed skeleton should be discoverable via vault.search'
    );
  });

  it('re-indexes incrementally and removes deleted file entries', async () => {
    const appPath = path.join(tmpDir, 'src', 'app.ts');
    const workerPath = path.join(tmpDir, 'src', 'worker.py');

    await fs.writeFile(appPath, 'export function app() { return 42; }\n', 'utf8');
    await fs.rm(workerPath, { force: true });

    const result = await runProjectIndex({ projectDir: tmpDir, vault, lens });

    assert.ok(result.filesIndexed >= 1, 'at least one changed file should be re-indexed');
    assert.ok(result.filesRemoved >= 1, 'deleted file index entry should be removed');
    assert.equal(result.meta.fileCount, 1);

    const keys = projectIndexKeys(tmpDir);
    const removedEntry = await vault.getLatestByKey(`${keys.filePrefix}src/worker.py`);
    assert.equal(removedEntry, null, 'deleted file entry should not remain in vault');
  });
});
