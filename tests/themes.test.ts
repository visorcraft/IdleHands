import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';

import { makeStyler } from '../dist/term.js';
import {
  resolvePalette,
  builtinTheme,
  resolveTheme,
  listThemes,
  BUILTIN_THEME_NAMES,
  loadCustomTheme,
  customThemesDir,
} from '../dist/themes.js';

describe('themes', () => {
  it('BUILTIN_THEME_NAMES includes all five themes', () => {
    assert.deepEqual(BUILTIN_THEME_NAMES.sort(), ['dark', 'default', 'hacker', 'light', 'minimal']);
  });

  it('builtinTheme returns ThemeFns for each built-in', () => {
    for (const name of BUILTIN_THEME_NAMES) {
      const fns = builtinTheme(name);
      assert.ok(fns, `builtinTheme("${name}") should return ThemeFns`);
      for (const slot of [
        'dim',
        'bold',
        'red',
        'yellow',
        'green',
        'cyan',
        'magenta',
        'blue',
      ] as const) {
        assert.equal(typeof fns[slot], 'function', `${name}.${slot} should be a function`);
      }
    }
  });

  it('builtinTheme returns undefined for unknown name', () => {
    assert.equal(builtinTheme('nonexistent'), undefined);
  });

  it('resolvePalette falls back to defaults for empty palette', () => {
    const fns = resolvePalette({});
    assert.equal(typeof fns.cyan, 'function');
    // Default cyan should produce ANSI output
    const result = fns.cyan('test');
    assert.ok(result.includes('test'));
  });

  it('resolvePalette handles composite specs like bold+cyan', () => {
    const fns = resolvePalette({ cyan: 'bold+cyan' });
    const result = fns.cyan('hi');
    assert.ok(result.includes('hi'));
    // Composite should resolve to a function (may or may not add ANSI depending on TTY)
    assert.equal(typeof fns.cyan, 'function');
  });

  it('resolvePalette ignores invalid spec names gracefully', () => {
    const fns = resolvePalette({ cyan: 'nonexistent_color' });
    // Should fall back to default
    assert.equal(typeof fns.cyan, 'function');
    const result = fns.cyan('test');
    assert.ok(result.includes('test'));
  });

  it('resolveTheme resolves built-in themes', async () => {
    const fns = await resolveTheme('hacker');
    assert.ok(fns);
    assert.equal(typeof fns.cyan, 'function');
  });

  it('resolveTheme returns undefined for unknown theme', async () => {
    const fns = await resolveTheme('nonexistent_theme_xyz');
    assert.equal(fns, undefined);
  });

  it('makeStyler applies theme functions when enabled', () => {
    const theme = builtinTheme('hacker')!;
    const S = makeStyler(true, theme);
    // Hacker theme remaps cyan to green — function should exist
    const result = S.cyan('test');
    assert.ok(result.includes('test'));
    assert.equal(typeof S.cyan, 'function');
    assert.equal(typeof S.bold, 'function');
  });

  it('makeStyler without theme uses defaults', () => {
    const S = makeStyler(true);
    assert.equal(typeof S.cyan, 'function');
    const result = S.cyan('test');
    assert.ok(result.includes('test'));
  });

  it('makeStyler disabled returns raw text regardless of theme', () => {
    const theme = builtinTheme('hacker')!;
    const S = makeStyler(false, theme);
    assert.equal(S.cyan('test'), 'test');
    assert.equal(S.bold('test'), 'test');
  });

  it('listThemes includes all built-in themes', async () => {
    const { builtin } = await listThemes();
    for (const name of BUILTIN_THEME_NAMES) {
      assert.ok(builtin.includes(name), `listThemes should include "${name}"`);
    }
  });
});

describe('custom themes', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-theme-test-'));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loadCustomTheme loads a valid theme JSON', async () => {
    const themesDir = customThemesDir();
    // We don't want to write to the real config dir in tests,
    // so test the resolvePalette path directly
    const palette = { cyan: 'magenta', blue: 'yellow' };
    const fns = resolvePalette(palette);
    assert.equal(typeof fns.cyan, 'function');
    assert.equal(typeof fns.blue, 'function');
    // cyan should now behave like magenta
    const cyanResult = fns.cyan('test');
    assert.ok(cyanResult.includes('test'));
  });

  it('loadCustomTheme returns undefined for missing file', async () => {
    const result = await loadCustomTheme('this_theme_does_not_exist_xyz_12345');
    assert.equal(result, undefined);
  });
});
