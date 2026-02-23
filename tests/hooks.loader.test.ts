import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadHookPlugins } from '../dist/hooks/loader.js';

describe('hooks loader', () => {
  it('loads valid plugins and skips invalid ones in non-strict mode', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-hooks-loader-'));
    try {
      const okPlugin = path.join(dir, 'ok.mjs');
      const badPlugin = path.join(dir, 'bad.mjs');

      await fs.writeFile(
        okPlugin,
        `
        export default {
          hooks: {
            ask_start: ({ askId }, ctx) => {
              if (!askId || !ctx?.sessionId) throw new Error('invalid');
            }
          }
        };
      `,
        'utf8'
      );

      await fs.writeFile(badPlugin, `export const foo = 123;`, 'utf8');

      const loaded = await loadHookPlugins({
        pluginPaths: [okPlugin, badPlugin],
        cwd: dir,
        strict: false,
        logger: () => {},
      });

      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]?.path, okPlugin);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('throws on bad plugin in strict mode', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-hooks-loader-strict-'));
    try {
      const badPlugin = path.join(dir, 'bad.mjs');
      await fs.writeFile(badPlugin, `export const foo = 123;`, 'utf8');

      await assert.rejects(
        loadHookPlugins({
          pluginPaths: [badPlugin],
          cwd: dir,
          strict: true,
        }),
        /did not export a valid hook plugin|failed to load plugin/i
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
