import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { normalizePluginName, scaffoldHookPlugin } from '../dist/hooks/scaffold.js';

describe('hooks scaffold', () => {
  it('normalizes/validates plugin names', () => {
    assert.equal(normalizePluginName('My-Plugin'.toLowerCase()), 'my-plugin');
    assert.equal(normalizePluginName(''), '');
    assert.equal(normalizePluginName('bad name'), '');
    assert.equal(normalizePluginName('..hidden'), '');
  });

  it('creates plugin scaffold files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-hook-scaffold-'));
    try {
      const out = await scaffoldHookPlugin({
        pluginName: 'sample-plugin',
        baseDir: dir,
      });

      assert.equal(out.pluginName, 'sample-plugin');
      assert.equal(out.files.length, 2);

      const indexRaw = await fs.readFile(path.join(out.targetDir, 'index.ts'), 'utf8');
      const readmeRaw = await fs.readFile(path.join(out.targetDir, 'README.md'), 'utf8');
      assert.match(indexRaw, /capabilities: \['observe'\]/);
      assert.match(readmeRaw, /Generated hook plugin scaffold/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects existing target without --force', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-hook-scaffold-force-'));
    try {
      await scaffoldHookPlugin({
        pluginName: 'sample-plugin',
        baseDir: dir,
      });

      await assert.rejects(
        scaffoldHookPlugin({
          pluginName: 'sample-plugin',
          baseDir: dir,
          force: false,
        }),
        /Target already exists/i
      );

      await scaffoldHookPlugin({
        pluginName: 'sample-plugin',
        baseDir: dir,
        force: true,
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
