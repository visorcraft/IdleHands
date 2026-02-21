import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadProjectContext } from '../dist/context.js';

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-ctx-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('loadProjectContext', () => {
  it('returns empty when no context files exist', async () => {
    const r = await loadProjectContext({ endpoint: '', max_tokens: 16384, temperature: 0.2, top_p: 0.95, timeout: 60, max_iterations: 20, no_confirm: false, verbose: false, dry_run: false, dir: tmpDir });
    assert.equal(r, '');
  });

  it('loads .idlehands.md when present', async () => {
    await fs.writeFile(path.join(tmpDir, '.idlehands.md'), '# My Project\nSome info');
    const r = await loadProjectContext({ endpoint: '', max_tokens: 16384, temperature: 0.2, top_p: 0.95, timeout: 60, max_iterations: 20, no_confirm: false, verbose: false, dry_run: false, dir: tmpDir, context_file_names: ['.idlehands.md', 'AGENTS.md'] });
    assert.ok(r.includes('My Project'));
  });

  it('first match wins — does not load both files', async () => {
    await fs.writeFile(path.join(tmpDir, '.idlehands.md'), '# First');
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# Second');
    const r = await loadProjectContext({ endpoint: '', max_tokens: 16384, temperature: 0.2, top_p: 0.95, timeout: 60, max_iterations: 20, no_confirm: false, verbose: false, dry_run: false, dir: tmpDir, context_file_names: ['.idlehands.md', 'AGENTS.md'] });
    assert.ok(r.includes('First'));
    assert.ok(!r.includes('Second'));
  });

  it('skips loading when no_context is true', async () => {
    await fs.writeFile(path.join(tmpDir, '.idlehands.md'), '# Skipped');
    const r = await loadProjectContext({ endpoint: '', max_tokens: 16384, temperature: 0.2, top_p: 0.95, timeout: 60, max_iterations: 20, no_confirm: false, verbose: false, dry_run: false, dir: tmpDir, no_context: true, context_file_names: ['.idlehands.md'] });
    assert.equal(r, '');
  });

  it('summarizes files exceeding context budget by default', async () => {
    const huge = [
      '# Project Mission',
      ...Array.from({ length: 3000 }, (_, i) => `- important line ${i} ${'x'.repeat(30)}`),
    ].join('\n');
    await fs.writeFile(path.join(tmpDir, 'huge.md'), huge);

    const r = await loadProjectContext({
      endpoint: '', max_tokens: 16384, temperature: 0.2, top_p: 0.95, timeout: 60, max_iterations: 20,
      no_confirm: false, verbose: false, dry_run: false, dir: tmpDir,
      context_file: path.join(tmpDir, 'huge.md'), context_max_tokens: 8192,
    });

    assert.ok(r.includes('[Project context summary from'));
    assert.ok(r.includes('full context omitted'));
    assert.ok(r.includes('read_file('));
  });

  it('can refuse oversized context when summarization is disabled', async () => {
    const huge = 'x'.repeat(100_000); // ~25K tokens
    await fs.writeFile(path.join(tmpDir, 'huge-no-summary.md'), huge);
    await assert.rejects(
      () => loadProjectContext({
        endpoint: '', max_tokens: 16384, temperature: 0.2, top_p: 0.95, timeout: 60, max_iterations: 20,
        no_confirm: false, verbose: false, dry_run: false, dir: tmpDir,
        context_file: path.join(tmpDir, 'huge-no-summary.md'), context_max_tokens: 8192,
        context_summarize: false,
      } as any),
      /tokens.*Max is 8192|Trim it/
    );
  });
});
