import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ChatMessage } from '../dist/types.js';
import { VaultStore } from '../dist/vault.js';

async function mkTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-vault-test-'));
}

describe('VaultStore', () => {
  it('stores notes and searches by key/value', async () => {
    const dir = await mkTempDir();
    const dbPath = path.join(dir, 'vault.db');
    const vault = new VaultStore({ path: dbPath });

    await vault.init();
    await vault.note('deploy', 'Prefer running tests before restart.');
    await vault.note('lint', 'Use npm run lint if available.');

    const all = await vault.search('deploy', 10);
    const deploy = all.find((x) => x.key === 'deploy');
    assert.ok(deploy);
    assert.equal(deploy?.kind, 'note');
    assert.ok((deploy?.value ?? '').includes('tests'));

    const count = await vault.count();
    assert.equal(count, 2);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('archives tool messages and lists recent entries', async () => {
    const dir = await mkTempDir();
    const dbPath = path.join(dir, 'vault.db');
    const vault = new VaultStore({ path: dbPath });

    await vault.init();

    const toolMsg: ChatMessage = {
      role: 'tool',
      tool_call_id: 'abc123',
      content: JSON.stringify({ ok: true, result: 'hello' }),
    };

    await vault.archiveToolResult(toolMsg, 'read_file');
    const listed = await vault.list(10);
    const first = listed[0];
    assert.equal(first.kind, 'tool');
    assert.equal(first.key, 'tool:read_file');

    const hits = await vault.search('hello', 5);
    assert.equal(hits[0].kind, 'tool');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('ranks more relevant matches above weak matches', async () => {
    const dir = await mkTempDir();
    const dbPath = path.join(dir, 'vault.db');
    const vault = new VaultStore({ path: dbPath });

    await vault.init();
    await vault.note('deploy-checklist', 'deploy restart service verify smoke tests pass');
    await vault.note('misc', 'deploy maybe someday');

    const hits = await vault.search('deploy restart service smoke tests', 5);
    assert.ok(hits.length >= 2);
    // High-signal note should rank first (FTS bm25 or fallback score)
    assert.equal(hits[0].key, 'deploy-checklist');

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('evicts oldest entries when maxEntries limit is exceeded', async () => {
    const dir = await mkTempDir();
    const dbPath = path.join(dir, 'vault.db');
    const vault = new VaultStore({ path: dbPath, maxEntries: 2 });

    await vault.init();
    await vault.note('k1', 'v1');
    await vault.note('k2', 'v2');
    await vault.note('k3', 'v3');

    const count = await vault.count();
    assert.equal(count, 2);

    const listed = await vault.list(10);
    const keys = listed.map((x) => x.key);
    assert.ok(!keys.includes('k1'), `expected oldest key k1 evicted, got ${keys.join(', ')}`);
    assert.ok(keys.includes('k2'));
    assert.ok(keys.includes('k3'));

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('recovers from corrupt db file', async () => {
    const dir = await mkTempDir();
    const dbPath = path.join(dir, 'vault.db');
    await fs.writeFile(dbPath, 'this is not json', 'utf8');

    const vault = new VaultStore({ path: dbPath });
    await vault.init();
    await vault.note('recovered', 'yes');

    const list = await vault.list(5);
    assert.equal(list.length, 1);
    assert.equal(list[0].key, 'recovered');

    const dirEntries = await fs.readdir(dir);
    assert.ok(dirEntries.some((p) => p.startsWith('vault.db.corrupt-')));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('supports getLatestByKey + deleteByKey for indexed metadata management', async () => {
    const dir = await mkTempDir();
    const dbPath = path.join(dir, 'vault.db');
    const vault = new VaultStore({ path: dbPath });

    await vault.init();
    await vault.upsertNote('index:meta:test', JSON.stringify({ version: 1 }), 'system');
    await vault.upsertNote('index:meta:test', JSON.stringify({ version: 2 }), 'system');

    const latest = await vault.getLatestByKey('index:meta:test', 'system');
    assert.ok(latest);
    assert.ok((latest?.value ?? '').includes('"version":2'));

    const removed = await vault.deleteByKey('index:meta:test');
    assert.equal(removed, 1);

    const after = await vault.getLatestByKey('index:meta:test', 'system');
    assert.equal(after, null);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('scopes search results by project directory', async () => {
    const dir = await mkTempDir();
    const dbPath = path.join(dir, 'vault.db');

    // Session 1: project A stores notes
    const vaultA = new VaultStore({ path: dbPath, projectDir: '/home/user/project-a' });
    await vaultA.init();
    await vaultA.note('setup', 'Project A uses React and TypeScript');
    await vaultA.note('deploy', 'Deploy to staging server at port 3000');
    vaultA.close();

    // Session 2: project B stores notes
    const vaultB = new VaultStore({ path: dbPath, projectDir: '/home/user/project-b' });
    await vaultB.init();
    await vaultB.note('setup', 'Project B uses Vue and JavaScript');
    await vaultB.note('deploy', 'Deploy to production server at port 8080');
    vaultB.close();

    // Search from project A: should see project A results first
    const vaultSearchA = new VaultStore({ path: dbPath, projectDir: '/home/user/project-a' });
    await vaultSearchA.init();
    const hitsA = await vaultSearchA.search('deploy', 5);
    assert.ok(hitsA.length >= 2, `expected at least 2 results, got ${hitsA.length}`);
    assert.ok(
      (hitsA[0].value ?? '').includes('staging'),
      `expected project A deploy result first, got: ${hitsA[0].value}`
    );
    vaultSearchA.close();

    // Search from project B: should see project B results first
    const vaultSearchB = new VaultStore({ path: dbPath, projectDir: '/home/user/project-b' });
    await vaultSearchB.init();
    const hitsB = await vaultSearchB.search('deploy', 5);
    assert.ok(hitsB.length >= 2, `expected at least 2 results, got ${hitsB.length}`);
    assert.ok(
      (hitsB[0].value ?? '').includes('production'),
      `expected project B deploy result first, got: ${hitsB[0].value}`
    );
    vaultSearchB.close();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('legacy entries without project_dir appear but after scoped entries', async () => {
    const dir = await mkTempDir();
    const dbPath = path.join(dir, 'vault.db');

    // Create legacy entries (no project dir)
    const vaultLegacy = new VaultStore({ path: dbPath });
    await vaultLegacy.init();
    await vaultLegacy.note('config', 'Legacy config note with database settings');
    vaultLegacy.close();

    // Create scoped entries
    const vaultScoped = new VaultStore({ path: dbPath, projectDir: '/home/user/myapp' });
    await vaultScoped.init();
    await vaultScoped.note('config', 'Scoped config note with API keys');

    // Search: scoped entry should come first
    const hits = await vaultScoped.search('config', 5);
    assert.ok(hits.length >= 2, `expected at least 2 results, got ${hits.length}`);
    assert.ok(
      (hits[0].value ?? '').includes('API keys'),
      `expected scoped entry first, got: ${hits[0].value}`
    );
    vaultScoped.close();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('setProjectDir changes scoping mid-session', async () => {
    const dir = await mkTempDir();
    const dbPath = path.join(dir, 'vault.db');
    const vault = new VaultStore({ path: dbPath, projectDir: '/home/user/alpha' });
    await vault.init();

    await vault.note('target', 'alpha project target');

    vault.setProjectDir('/home/user/beta');
    await vault.note('target', 'beta project target');

    // Search from beta: beta result should come first
    const hits = await vault.search('target', 5);
    assert.ok(hits.length >= 2);
    assert.ok(
      (hits[0].value ?? '').includes('beta'),
      `expected beta result first, got: ${hits[0].value}`
    );

    vault.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('caps immutable review artifacts per project while keeping latest pointer', async () => {
    const dir = await mkTempDir();
    const dbPath = path.join(dir, 'vault.db');
    const projectId = 'project-cap-test';
    const vault = new VaultStore({
      path: dbPath,
      maxEntries: 500,
      immutableReviewArtifactsPerProject: 2,
    });

    await vault.init();

    const latestKey = `artifact:review:latest:${projectId}`;
    await vault.upsertNote(
      latestKey,
      JSON.stringify({ id: 'latest', kind: 'code_review' }),
      'system'
    );

    for (let i = 1; i <= 5; i++) {
      await vault.upsertNote(
        `artifact:review:item:${projectId}:review-${i}`,
        JSON.stringify({ id: `review-${i}`, kind: 'code_review', content: `body-${i}` }),
        'system'
      );
    }

    const listed = await vault.list(100);
    const immutableKeys = listed
      .map((x) => x.key ?? '')
      .filter((k) => k.startsWith(`artifact:review:item:${projectId}:`));

    assert.equal(
      immutableKeys.length,
      2,
      `expected only 2 immutable artifacts retained, got: ${immutableKeys.length}`
    );

    const latest = await vault.getLatestByKey(latestKey, 'system');
    assert.ok(latest, 'latest artifact pointer should be retained');

    vault.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
