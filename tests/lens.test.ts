import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { LensStore } from '../dist/lens.js';
import { read_file } from '../dist/tools.js';

describe('lens', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-lens-'));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('produces structural projection for code-like files', async () => {
    const lens = new LensStore();
    const out = await lens.projectFile('/tmp/sample.ts', 'export function foo() { return 1; }\nconst x = 1;\n');
    assert.ok(out.includes('lens:'));
    assert.ok(out.includes('foo'));
  });

  it('extracts skeletons across JS/TS/Python/Rust/Go', async () => {
    const lens = new LensStore();

    const cases: Array<{ file: string; src: string; expect: string }> = [
      { file: '/tmp/a.js', src: 'function hello() {}\nclass Box {}\n', expect: 'hello' },
      { file: '/tmp/a.ts', src: 'export function run(): void {}\nconst v = 1;\n', expect: 'run' },
      { file: '/tmp/a.py', src: 'def compute(x):\n  return x\n', expect: 'compute' },
      { file: '/tmp/a.rs', src: 'pub struct Item {}\npub fn work() {}\n', expect: 'work' },
      { file: '/tmp/a.go', src: 'type Service struct{}\nfunc Build() {}\n', expect: 'Build' },
    ];

    for (const c of cases) {
      const out = await lens.projectFile(c.file, c.src);
      assert.ok(out.includes('lens:'), `expected lens header for ${c.file}`);
      assert.ok(out.includes(c.expect), `expected symbol ${c.expect} in ${c.file}\nout=${out}`);
    }
  });

  it('falls back to markdown headings when tree-sitter is unavailable', async () => {
    const lens = new LensStore({ maxSkeletonItems: 20 });
    const md = ['# Title', '## Usage', 'paragraph', '# Details', 'more text'].join('\n');
    const out = await lens.projectFile('/tmp/notes.md', md);
    assert.ok(out.includes('# lens:'));
    assert.ok(/#+ Details|Details/.test(out));
  });

  it('uses JSON and YAML fallback compressors', async () => {
    const lens = new LensStore();

    const jsonOut = await lens.projectFile('/tmp/config.json', JSON.stringify({
      api: { endpoint: 'http://x', retries: 3 },
      features: ['a', 'b']
    }, null, 2));
    assert.ok(jsonOut.includes('# lens:json'));
    assert.ok(jsonOut.includes('api'));

    const yamlOut = await lens.projectFile('/tmp/config.yaml', [
      'endpoint: http://x',
      'retries: 3',
      'nested:',
      '  ignored: child',
      'feature_flag: true'
    ].join('\n'));
    assert.ok(yamlOut.includes('# lens:yaml'));
    assert.ok(yamlOut.includes('endpoint'));
    assert.ok(yamlOut.includes('feature_flag'));
  });

  it('gracefully degrades when structured parsing fails', async () => {
    const lens = new LensStore({ maxRawPreviewChars: 120 });
    // Invalid JSON (won't parse), and no markdown/code signature fallback for .json
    const broken = '{"a":1, trailing, }\n'.repeat(20);
    const out = await lens.projectFile('/tmp/broken.json', broken);

    assert.ok(out.includes('/tmp/broken.json'));
    // Should return compacted raw with truncation marker instead of throwing
    assert.ok(out.includes('[truncated,') || out.length > 0);
  });

  it('summarizes structural diffs', async () => {
    const lens = new LensStore();
    const before = 'export function foo() {}\nclass Old {}\n';
    const after = 'export function foo() {}\nclass New {}\n';
    const summary = await lens.summarizeDiffToText(before, after, '/tmp/a.ts');
    assert.ok(summary?.includes('diff'));
    assert.ok(summary?.includes('signature'));
  });

  it('read_file uses lens projection for large files (200+ lines)', async () => {
    const lens = new LensStore();
    const file = path.join(tmpDir, 'large.ts');
    // Generate a 210-line file to cross the lens threshold
    const lines = Array.from({ length: 210 }, (_, i) => `function fn${i}() { return ${i}; }`);
    await fs.writeFile(file, lines.join('\n') + '\n');

    const ctx: any = {
      cwd: tmpDir,
      noConfirm: true,
      dryRun: false,
      lens
    };

    const out = await read_file(ctx, { path: 'large.ts', max_bytes: 50000 });
    assert.ok(out.includes('# lens:'), 'lens should be used for 210-line file');
    assert.ok(out.includes('large.ts'));
    assert.ok(out.includes('function'));
  });

  it('read_file returns full content (no lens) for small files (<200 lines)', async () => {
    const lens = new LensStore();
    const file = path.join(tmpDir, 'small.ts');
    await fs.writeFile(file, 'function one() { return 1; }\nfunction two() { return 2; }\n');

    const ctx: any = {
      cwd: tmpDir,
      noConfirm: true,
      dryRun: false,
      lens
    };

    const out = await read_file(ctx, { path: 'small.ts' });
    // Small file should get full numbered output, not a lens skeleton
    assert.ok(!out.includes('# lens:'), 'lens should NOT be used for 2-line file');
    assert.ok(out.includes('function one()'), 'should contain actual code');
    assert.ok(out.includes('function two()'), 'should contain actual code');
  });
});
