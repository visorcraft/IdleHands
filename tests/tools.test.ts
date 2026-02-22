import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';

import {
  read_file,
  read_files,
  write_file,
  edit_file,
  edit_range,
  apply_patch,
  insert_file,
  list_dir,
  search_files,
  exec,
  undo_path,
} from '../dist/tools.js';

let tmpDir: string;
let ctx: any;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-test-'));
  ctx = { cwd: tmpDir, noConfirm: true, dryRun: false };
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('read_file', () => {
  it('reads a text file with line numbers', async () => {
    await fs.writeFile(path.join(tmpDir, 'hello.txt'), 'line1\nline2\nline3\n');
    const r = await read_file(ctx, { path: 'hello.txt' });
    assert.ok(r.includes('hello.txt'));
    assert.ok(r.includes('line1'));
    assert.ok(r.includes('line2'));
  });

  it('search returns all match line numbers', async () => {
    await fs.writeFile(path.join(tmpDir, 'multi.txt'), 'foo\nbar\nfoo\nbaz\nfoo\n');
    const r = await read_file(ctx, { path: 'multi.txt', search: 'foo' });
    assert.ok(r.includes('matches at lines: 1, 3, 5'));
  });

  it('returns descriptive message for binary files with MIME type', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'bin.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00])
    );
    const r = await read_file(ctx, { path: 'bin.png' });
    assert.ok(r.includes('[binary file'));
    assert.ok(r.includes('6 bytes'));
    assert.ok(r.includes('detected type: image/png'));
  });

  it('errors on missing file', async () => {
    await assert.rejects(() => read_file(ctx, { path: 'nope.txt' }), /cannot read/);
  });

  it('returns helpful message when path is a directory', async () => {
    await fs.mkdir(path.join(tmpDir, 'subdir'), { recursive: true });
    const r = await read_file(ctx, { path: 'subdir' });
    assert.ok(r.includes('is a directory'), 'should detect directory');
    assert.ok(r.includes('list_dir'), 'should suggest list_dir');
  });

  it('enforces a safe default line cap when limit is omitted', async () => {
    const p = path.join(tmpDir, 'many-lines.txt');
    const content = Array.from({ length: 650 }, (_, i) => `line-${i + 1}`).join('\n') + '\n';
    await fs.writeFile(p, content, 'utf8');

    const r = await read_file(ctx, { path: 'many-lines.txt' });
    assert.ok(r.includes('line-1'));
    assert.ok(r.includes('line-200'));
    assert.ok(!r.includes('line-650'));
    assert.ok(r.includes('more lines)'), 'should be truncated by default line caps');
  });
});

describe('read_files', () => {
  it('returns partial results when one file read fails', async () => {
    await fs.writeFile(path.join(tmpDir, 'ok.txt'), 'hello\nworld\n', 'utf8');

    const out = await read_files(ctx, {
      requests: [
        { path: 'ok.txt', limit: 10 },
        { path: 'missing.txt', limit: 10 },
      ],
    });

    assert.match(out, /ok\.txt/);
    assert.match(out, /missing\.txt/);
    assert.match(out, /partial failures/i);
  });
});

describe('write_file', () => {
  it('creates file with content', async () => {
    const r = await write_file(ctx, { path: 'new.txt', content: 'hello world' });
    assert.ok(r.includes('wrote'));
    const content = await fs.readFile(path.join(tmpDir, 'new.txt'), 'utf8');
    assert.equal(content, 'hello world');
  });

  it('creates parent directories', async () => {
    await write_file(ctx, { path: 'sub/dir/deep.txt', content: 'deep' });
    const content = await fs.readFile(path.join(tmpDir, 'sub/dir/deep.txt'), 'utf8');
    assert.equal(content, 'deep');
  });

  it('preserves file permissions', async () => {
    const p = path.join(tmpDir, 'exec.sh');
    await fs.writeFile(p, '#!/bin/bash\necho hi');
    await fs.chmod(p, 0o755);
    await write_file(ctx, {
      path: 'exec.sh',
      content: '#!/bin/bash\necho updated',
      overwrite: true,
    });
    const st = await fs.stat(p);
    assert.equal(st.mode & 0o777, 0o755);
  });

  it('blocks overwrite of existing non-empty files unless overwrite/force is explicit', async () => {
    await fs.writeFile(path.join(tmpDir, 'existing.txt'), 'hello\n', 'utf8');
    await assert.rejects(
      () => write_file(ctx, { path: 'existing.txt', content: 'new text' }),
      /without explicit overwrite=true/i
    );
  });

  it('allows overwrite of existing non-empty files with overwrite=true', async () => {
    await fs.writeFile(path.join(tmpDir, 'existing-overwrite.txt'), 'hello\n', 'utf8');
    await write_file(ctx, { path: 'existing-overwrite.txt', content: 'new text', overwrite: true });
    const content = await fs.readFile(path.join(tmpDir, 'existing-overwrite.txt'), 'utf8');
    assert.equal(content, 'new text');
  });

  it('blocks writes outside cwd in code mode', async () => {
    await assert.rejects(
      () => write_file(ctx, { path: '/tmp/idlehands-outside-write.txt', content: 'x' }),
      /outside the working directory/i
    );
  });

  it('requires explicit dir pin before mutations when configured', async () => {
    const guardedCtx = {
      ...ctx,
      requireDirPinForMutations: true,
      dirPinned: false,
      repoCandidates: ['/home/sitoryp/repos/citadel', '/home/sitoryp/cerby-workspace/citadel-app'],
    } as any;
    await assert.rejects(
      () => write_file(guardedCtx, { path: 'pinned.txt', content: 'x' }),
      /multiple repository candidates detected/i
    );
  });

  it('auto-allows mutations when cwd matches a repo candidate even if dirPinned=false', async () => {
    const autoCtx = {
      ...ctx,
      cwd: path.join(tmpDir, 'repo', 'subdir'),
      requireDirPinForMutations: true,
      dirPinned: false,
      repoCandidates: [path.join(tmpDir, 'repo'), '/home/sitoryp/other-repo'],
    } as any;
    await fs.mkdir(autoCtx.cwd, { recursive: true });
    await write_file(autoCtx, { path: 'auto-pinned.txt', content: 'ok' });
    const got = await fs.readFile(path.join(autoCtx.cwd, 'auto-pinned.txt'), 'utf8');
    assert.equal(got, 'ok');
  });

  it('allows filesystem-wide writes when allowed root is / and dir is pinned', async () => {
    const globalCtx = {
      ...ctx,
      allowedWriteRoots: ['/'],
      requireDirPinForMutations: true,
      dirPinned: true,
    } as any;
    const outside = '/tmp/idlehands-any-root-write.txt';
    await write_file(globalCtx, { path: outside, content: 'ok' });
    const got = await fs.readFile(outside, 'utf8');
    assert.equal(got, 'ok');
  });
});

describe('edit_file', () => {
  it('replaces exact text', async () => {
    await fs.writeFile(path.join(tmpDir, 'edit.txt'), 'hello world');
    await edit_file(ctx, { path: 'edit.txt', old_text: 'hello', new_text: 'goodbye' });
    const content = await fs.readFile(path.join(tmpDir, 'edit.txt'), 'utf8');
    assert.equal(content, 'goodbye world');
  });

  it('errors with helpful message on mismatch', async () => {
    await fs.writeFile(path.join(tmpDir, 'edit2.txt'), 'function hello() {\n  return 1;\n}');
    try {
      await edit_file(ctx, { path: 'edit2.txt', old_text: 'function helo() {', new_text: 'x' });
      assert.fail('should have thrown');
    } catch (e: any) {
      assert.ok(e.message.includes('old_text not found'));
      // Should show nearest match info
      assert.ok(e.message.includes('Closest match') || e.message.includes('File head'));
    }
  });

  it('replace_all replaces all occurrences', async () => {
    await fs.writeFile(path.join(tmpDir, 'edit3.txt'), 'aaa bbb aaa');
    await edit_file(ctx, {
      path: 'edit3.txt',
      old_text: 'aaa',
      new_text: 'ccc',
      replace_all: true,
    });
    const content = await fs.readFile(path.join(tmpDir, 'edit3.txt'), 'utf8');
    assert.equal(content, 'ccc bbb ccc');
  });

  it('without replace_all, only first occurrence is replaced when multiple matches exist', async () => {
    await fs.writeFile(path.join(tmpDir, 'edit4.txt'), 'token x token x token');
    await edit_file(ctx, { path: 'edit4.txt', old_text: 'token', new_text: 'done' });
    const content = await fs.readFile(path.join(tmpDir, 'edit4.txt'), 'utf8');
    assert.equal(content, 'done x token x token');
  });

  it('handles binary-ish files with a clear not-found error (does not corrupt)', async () => {
    const p = path.join(tmpDir, 'edit-binary.bin');
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe]);
    await fs.writeFile(p, original);

    await assert.rejects(
      () => edit_file(ctx, { path: 'edit-binary.bin', old_text: 'hello', new_text: 'world' }),
      /old_text not found|cannot read/i
    );

    const after = await fs.readFile(p);
    assert.equal(
      Buffer.compare(after, original),
      0,
      'binary file should not be modified on failure'
    );
  });

  it('blocks edits outside cwd in code mode', async () => {
    const outside = '/tmp/idlehands-outside-edit.txt';
    await fs.writeFile(outside, 'hello world', 'utf8');
    await assert.rejects(
      () => edit_file(ctx, { path: outside, old_text: 'hello', new_text: 'bye' }),
      /outside the working directory/i
    );
  });
});

describe('edit_range', () => {
  it('replaces an inclusive line range', async () => {
    await fs.writeFile(path.join(tmpDir, 'range.txt'), 'a\nb\nc\nd\n');
    await edit_range(ctx, {
      path: 'range.txt',
      start_line: 2,
      end_line: 3,
      replacement: 'X\nY',
    });
    const content = await fs.readFile(path.join(tmpDir, 'range.txt'), 'utf8');
    assert.equal(content, 'a\nX\nY\nd\n');
  });

  it('rejects invalid ranges', async () => {
    await fs.writeFile(path.join(tmpDir, 'range-bad.txt'), 'one\ntwo\n');
    await assert.rejects(
      () =>
        edit_range(ctx, { path: 'range-bad.txt', start_line: 3, end_line: 2, replacement: 'x' }),
      /invalid end_line/i
    );
  });

  it('rejects double-escaped replacement payloads and asks for real newlines', async () => {
    await fs.writeFile(path.join(tmpDir, 'range-escaped.txt'), 'one\ntwo\nthree\n', 'utf8');
    await assert.rejects(
      () =>
        edit_range(ctx, {
          path: 'range-escaped.txt',
          start_line: 2,
          end_line: 2,
          replacement: 'alpha\\nbeta',
        }),
      /double-escaped|real newline/i
    );
  });

  it('blocks range edits outside cwd in code mode', async () => {
    const outside = '/tmp/idlehands-outside-range.txt';
    await fs.writeFile(outside, 'a\nb\nc\n', 'utf8');
    await assert.rejects(
      () => edit_range(ctx, { path: outside, start_line: 1, end_line: 1, replacement: 'z' }),
      /outside the working directory/i
    );
  });
});

describe('apply_patch', () => {
  it('applies a unified diff patch when patch binary exists', async () => {
    const hasPatch = spawnSync('bash', ['-lc', 'command -v patch >/dev/null 2>&1']).status === 0;
    if (!hasPatch) return;

    await fs.writeFile(path.join(tmpDir, 'patch.txt'), 'hello\nworld\n', 'utf8');
    const patch = [
      '--- patch.txt',
      '+++ patch.txt',
      '@@ -1,2 +1,2 @@',
      '-hello',
      '+hola',
      ' world',
      '',
    ].join('\n');

    const out = await apply_patch(ctx, {
      patch,
      files: ['patch.txt'],
      strip: 0,
    });

    const content = await fs.readFile(path.join(tmpDir, 'patch.txt'), 'utf8');
    assert.ok(out.includes('applied patch'));
    assert.equal(content, 'hola\nworld\n');
  });
});

describe('insert_file', () => {
  it('appends with line=-1', async () => {
    await fs.writeFile(path.join(tmpDir, 'ins.txt'), 'line1\nline2');
    await insert_file(ctx, { path: 'ins.txt', line: -1, text: 'line3' });
    const content = await fs.readFile(path.join(tmpDir, 'ins.txt'), 'utf8');
    assert.ok(content.includes('line3'));
  });

  it('prepends with line=0', async () => {
    await fs.writeFile(path.join(tmpDir, 'ins2.txt'), 'existing');
    await insert_file(ctx, { path: 'ins2.txt', line: 0, text: 'first' });
    const content = await fs.readFile(path.join(tmpDir, 'ins2.txt'), 'utf8');
    assert.ok(content.startsWith('first'));
  });

  it('preserves CRLF line endings', async () => {
    await fs.writeFile(path.join(tmpDir, 'crlf.txt'), 'line1\r\nline2\r\nline3');
    await insert_file(ctx, { path: 'crlf.txt', line: 1, text: 'inserted' });
    const content = await fs.readFile(path.join(tmpDir, 'crlf.txt'), 'utf8');
    assert.ok(content.includes('\r\n'), 'Should preserve CRLF');
    assert.ok(content.includes('inserted'));
  });

  it('appends to empty file without leading newline', async () => {
    await fs.writeFile(path.join(tmpDir, 'empty-ins.txt'), '');
    await insert_file(ctx, { path: 'empty-ins.txt', line: -1, text: 'hello' });
    const content = await fs.readFile(path.join(tmpDir, 'empty-ins.txt'), 'utf8');
    assert.equal(content, 'hello');
  });

  it('appends to file ending with newline without double-newline', async () => {
    await fs.writeFile(path.join(tmpDir, 'trailing-nl.txt'), 'line1\nline2\n');
    await insert_file(ctx, { path: 'trailing-nl.txt', line: -1, text: 'line3' });
    const content = await fs.readFile(path.join(tmpDir, 'trailing-nl.txt'), 'utf8');
    // Should be "line1\nline2\nline3\n" — NOT "line1\nline2\n\nline3"
    assert.ok(
      !content.includes('\n\n'),
      `Should not have double newline, got: ${JSON.stringify(content)}`
    );
    assert.ok(content.includes('line3'), 'Should contain appended text');
    assert.equal(content, 'line1\nline2\nline3\n');
  });

  it('blocks inserts outside cwd in code mode', async () => {
    const outside = '/tmp/idlehands-outside-insert.txt';
    await fs.writeFile(outside, 'base\n', 'utf8');
    await assert.rejects(
      () => insert_file(ctx, { path: outside, line: -1, text: 'x' }),
      /outside the working directory/i
    );
  });
});

describe('undo_path', () => {
  it('restores last edited file when path omitted', async () => {
    const backupDir = path.join(tmpDir, 'backups');
    const ctxBase = {
      cwd: tmpDir,
      noConfirm: true,
      dryRun: false,
      backupDir,
    };

    await write_file(ctxBase as any, { path: 'undo.txt', content: 'original' });
    await write_file(ctxBase as any, { path: 'undo.txt', content: 'changed', overwrite: true });

    const restored = await undo_path(
      {
        ...ctxBase,
        lastEditedPath: path.join(tmpDir, 'undo.txt'),
      } as any,
      {}
    );

    const got = await fs.readFile(path.join(tmpDir, 'undo.txt'), 'utf8');
    assert.equal(got, 'original');
    assert.equal(restored.startsWith('restored'), true);

    const key = crypto.createHash('sha256').update(path.join(tmpDir, 'undo.txt')).digest('hex');
    const stateDir = path.join(backupDir, key);
    const entries = await fs.readdir(stateDir);
    assert.ok(
      entries.some((e) => e.endsWith('.bak')),
      'expected .bak backup file in per-file backup dir'
    );
    assert.ok(
      entries.some((e) => e.endsWith('.meta.json')),
      'expected metadata sidecar file in per-file backup dir'
    );
  });
});

describe('list_dir', () => {
  it('lists directory contents', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), '');
    await fs.writeFile(path.join(tmpDir, 'b.txt'), '');
    const r = await list_dir(ctx, { path: '.' });
    assert.ok(r.includes('a.txt'));
    assert.ok(r.includes('b.txt'));
  });
});

describe('search_files', () => {
  it('returns file:line:content format (not JSON)', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'searchme.ts'),
      'const a = 1;\nfunction hello() {\n  return a;\n}\n'
    );
    const r = await search_files(ctx, { pattern: 'function', path: '.' });
    // Must NOT be JSON — should be plain grep-style output
    assert.ok(!r.startsWith('{'), 'search_files should not return raw JSON');
    assert.ok(r.includes('searchme.ts'), 'should contain filename');
    assert.ok(r.includes('function'), 'should contain matched text');
  });

  it('respects max_results guardrail and reports truncation', async () => {
    const p = path.join(tmpDir, 'search-many.txt');
    const lines = Array.from({ length: 30 }, (_, i) => `hit-${i}`).join('\n') + '\n';
    await fs.writeFile(p, lines, 'utf8');

    const r = await search_files(ctx, { pattern: 'hit-', path: '.', max_results: 5 });
    const outLines = r.split(/\r?\n/).filter(Boolean);

    // 5 matches + truncation line
    assert.ok(outLines.length >= 5, `expected at least 5 lines, got ${outLines.length}`);
    assert.ok(outLines.some((l) => l.includes('[truncated after 5 results]')));
  });

  it('throws on missing pattern (guardrail)', async () => {
    await assert.rejects(() => search_files(ctx, { path: '.' }), /missing pattern/i);
  });

  it('throws on malformed regex with invalid_args hint', async () => {
    await assert.rejects(
      () => search_files(ctx, { pattern: '([a-z', path: '.' }),
      /invalid regex pattern/i
    );
  });
});

describe('exec', () => {
  it('runs a command and returns JSON', async () => {
    const r = await exec(ctx, { command: 'echo hello' });
    const parsed = JSON.parse(r);
    assert.equal(parsed.rc, 0);
    assert.ok(parsed.out.includes('hello'));
  });

  it('captures stderr', async () => {
    const r = await exec(ctx, { command: 'echo err >&2' });
    const parsed = JSON.parse(r);
    assert.ok(parsed.err.includes('err'));
  });

  it('respects timeout and reports kill', async () => {
    const r = await exec(ctx, { command: 'sleep 10', timeout: 1 });
    const parsed = JSON.parse(r);
    assert.ok(parsed.err.includes('[killed after 1s timeout]'));
  });

  it('blocks dangerous commands without --no-confirm', async () => {
    const safeCtx = { ...ctx, noConfirm: false };
    await assert.rejects(() => exec(safeCtx, { command: 'rm -rf /' }), /BLOCKED.*rm targeting/i);
  });

  it('blocks background shell commands to avoid hangs', async () => {
    await assert.rejects(
      () => exec(ctx, { command: 'node server.js &' }),
      /blocked background command/i
    );
  });

  it('blocks out-of-cwd absolute targets in default approval mode', async () => {
    const outside = `/tmp/idlehands-outside-default-${Date.now()}.txt`;
    await assert.rejects(
      () => exec({ ...ctx, approvalMode: 'default' }, { command: `touch ${outside}` }),
      /outside the working directory/i
    );
  });

  it('allows out-of-cwd absolute targets in auto-edit/yolo approval modes', async () => {
    const outsideAuto = `/tmp/idlehands-outside-auto-${Date.now()}.txt`;
    const outsideYolo = `/tmp/idlehands-outside-yolo-${Date.now()}.txt`;

    const rAuto = await exec(
      { ...ctx, approvalMode: 'auto-edit' },
      { command: `touch ${outsideAuto}` }
    );
    const pAuto = JSON.parse(rAuto);
    assert.equal(pAuto.rc, 0);
    await fs.access(outsideAuto);

    const rYolo = await exec({ ...ctx, approvalMode: 'yolo' }, { command: `touch ${outsideYolo}` });
    const pYolo = JSON.parse(rYolo);
    assert.equal(pYolo.rc, 0);
    await fs.access(outsideYolo);
  });

  it('collapses stack traces', async () => {
    const stackScript = `node -e "
      function a() { throw new Error('boom'); }
      function b() { a(); }
      function c() { b(); }
      function d() { c(); }
      function e() { d(); }
      e();
    "`;
    const r = await exec(ctx, { command: stackScript });
    const parsed = JSON.parse(r);
    const errText = parsed.err;
    assert.ok(errText.includes('more frames'));
  });

  it('caps exec output capture and still reports truncation', async () => {
    const noisy = `node -e "process.stdout.write('x'.repeat(50000))"`;
    const capCtx = { ...ctx, maxExecBytes: 4096, maxExecCaptureBytes: 1024 };
    const r = await exec(capCtx, { command: noisy });
    const parsed = JSON.parse(r);
    assert.equal(parsed.rc, 0);
    assert.equal(parsed.truncated, true);
    assert.ok(
      String(parsed.out).includes('capture truncated') ||
        String(parsed.out).includes('[truncated,'),
      `expected truncation marker, got out=${JSON.stringify(parsed.out).slice(0, 200)}`
    );
  });
});
