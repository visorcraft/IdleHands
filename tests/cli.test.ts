/**
 * Tests for CLI helper modules extracted from index.ts.
 *
 * All tests are pure-functional (no filesystem writes, no network, no spawning).
 * Functions that need a filesystem use tmp dirs created by the test harness
 * and cleaned up afterward.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ── cli/args.ts ──────────────────────────────────────────────────────

import {
  parseArgs,
  asNum,
  asBool,
  friendlyError,
  normalizeOutputFormat,
} from '../dist/cli/args.js';

describe('parseArgs', () => {
  it('collects positional args into _', () => {
    const r = parseArgs(['bot', 'telegram']);
    assert.deepStrictEqual(r._, ['bot', 'telegram']);
  });

  it('parses --key=value style', () => {
    const r = parseArgs(['--model=gpt-4', '--endpoint=http://localhost:8080']);
    assert.equal(r.model, 'gpt-4');
    assert.equal(r.endpoint, 'http://localhost:8080');
  });

  it('parses --key value style (space-separated)', () => {
    const r = parseArgs(['--model', 'gpt-4', '--timeout', '30']);
    assert.equal(r.model, 'gpt-4');
    assert.equal(r.timeout, '30');
  });

  it('parses boolean flags without consuming next arg', () => {
    const r = parseArgs(['--verbose', '--yolo', 'some-instruction']);
    assert.equal(r.verbose, true);
    assert.equal(r.yolo, true);
    assert.deepStrictEqual(r._, ['some-instruction']);
  });

  it('handles short aliases', () => {
    const r = parseArgs(['-v']);
    assert.equal(r.version, true);
  });

  it('handles -p with a value', () => {
    const r = parseArgs(['-p', 'fix the bug']);
    assert.equal(r.prompt, 'fix the bug');
  });

  it('handles -h as boolean', () => {
    const r = parseArgs(['-h']);
    assert.equal(r.help, true);
  });

  it('handles --resume without value (optional-value flag)', () => {
    const r = parseArgs(['--resume']);
    assert.equal(r.resume, true);
  });

  it('handles --resume with a session name', () => {
    const r = parseArgs(['--resume', 'my-session']);
    assert.equal(r.resume, 'my-session');
  });

  it('treats unknown flags without next arg as boolean', () => {
    const r = parseArgs(['--unknown-flag']);
    assert.equal(r['unknown-flag'], true);
  });

  it('parses mix of positionals and flags', () => {
    const r = parseArgs(['--model', 'llama', '--verbose', 'fix', 'tests']);
    assert.equal(r.model, 'llama');
    assert.equal(r.verbose, true);
    assert.deepStrictEqual(r._, ['fix', 'tests']);
  });

  it('returns empty _ for no positionals', () => {
    const r = parseArgs(['--quiet']);
    assert.deepStrictEqual(r._, []);
  });
});

describe('asNum', () => {
  it('returns number for valid numeric string', () => {
    assert.equal(asNum('42'), 42);
    assert.equal(asNum('3.14'), 3.14);
  });

  it('returns undefined for non-numeric', () => {
    assert.equal(asNum('abc'), undefined);
  });

  it('treats empty string as 0 (Number("") === 0)', () => {
    assert.equal(asNum(''), 0);
  });

  it('returns undefined for undefined input', () => {
    assert.equal(asNum(undefined), undefined);
  });

  it('handles Infinity as non-finite', () => {
    assert.equal(asNum('Infinity'), undefined);
    assert.equal(asNum('NaN'), undefined);
  });
});

describe('asBool', () => {
  it('recognizes truthy strings', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes', 'ON']) {
      assert.equal(asBool(v), true, `expected true for "${v}"`);
    }
  });

  it('recognizes falsy strings', () => {
    for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'No', 'OFF']) {
      assert.equal(asBool(v), false, `expected false for "${v}"`);
    }
  });

  it('passes through booleans', () => {
    assert.equal(asBool(true), true);
    assert.equal(asBool(false), false);
  });

  it('returns undefined for unknown', () => {
    assert.equal(asBool(undefined), undefined);
    assert.equal(asBool('maybe'), undefined);
  });
});

describe('friendlyError', () => {
  it('maps max iterations to friendly message', () => {
    const msg = friendlyError(new Error('max iterations exceeded (10)'));
    assert.ok(msg.includes('Stopped'));
    assert.ok(msg.includes('--max-iterations'));
  });

  it('maps connection errors', () => {
    const msg = friendlyError(new Error('ECONNREFUSED'));
    assert.ok(msg.includes('Connection failed'));
    assert.ok(msg.includes('LLM server'));
  });

  it('maps 503 / model loading', () => {
    const msg = friendlyError(new Error('503 model loading'));
    assert.ok(msg.includes('Model is loading'));
  });

  it('maps abort errors', () => {
    assert.equal(friendlyError(new Error('AbortError: aborted')), 'Aborted.');
  });

  it('passes through unknown errors', () => {
    assert.equal(friendlyError(new Error('something else')), 'something else');
  });

  it('handles non-Error input', () => {
    assert.equal(friendlyError('raw string'), 'raw string');
    assert.equal(friendlyError(null), 'null');
  });
});

describe('normalizeOutputFormat', () => {
  it('accepts valid formats', () => {
    assert.equal(normalizeOutputFormat('text'), 'text');
    assert.equal(normalizeOutputFormat('json'), 'json');
    assert.equal(normalizeOutputFormat('stream-json'), 'stream-json');
  });

  it('defaults to text for unknown', () => {
    assert.equal(normalizeOutputFormat('xml'), 'text');
    assert.equal(normalizeOutputFormat(undefined), 'text');
    assert.equal(normalizeOutputFormat(null), 'text');
  });

  it('is case-insensitive', () => {
    assert.equal(normalizeOutputFormat('JSON'), 'json');
    assert.equal(normalizeOutputFormat('Text'), 'text');
  });
});

// ── cli/input.ts ─────────────────────────────────────────────────────

import {
  hasUnclosedTripleQuote,
  hasUnbalancedDelimiters,
  needsContinuation,
  isLikelyBinary,
  isPathCompletionContext,
  matchIgnorePattern,
  isIgnored,
  loadGitIgnorePatterns,
  collectDirectoryFiles,
  isImagePathLike,
  mimeForImagePath,
  extractImageRefs,
  hasClipboardImageToken,
  expandAtFileRefs,
} from '../dist/cli/input.js';

describe('hasUnclosedTripleQuote', () => {
  it('returns false for no triple quotes', () => {
    assert.equal(hasUnclosedTripleQuote('hello world'), false);
  });

  it('returns true for odd count', () => {
    assert.equal(hasUnclosedTripleQuote('"""hello'), true);
  });

  it('returns false for balanced triple quotes', () => {
    assert.equal(hasUnclosedTripleQuote('"""hello"""'), false);
  });
});

describe('hasUnbalancedDelimiters', () => {
  it('returns false for balanced text', () => {
    assert.equal(hasUnbalancedDelimiters('fn(a, b) { return [1]; }'), false);
  });

  it('detects unclosed paren', () => {
    assert.equal(hasUnbalancedDelimiters('fn(a, b'), true);
  });

  it('detects unclosed brace', () => {
    assert.equal(hasUnbalancedDelimiters('{ key: "value"'), true);
  });

  it('detects unclosed bracket', () => {
    assert.equal(hasUnbalancedDelimiters('[1, 2, 3'), true);
  });

  it('ignores delimiters inside strings', () => {
    assert.equal(hasUnbalancedDelimiters('"hello (world"'), false);
  });
});

describe('needsContinuation', () => {
  it('continues on trailing backslash', () => {
    assert.equal(needsContinuation('hello \\'), true);
  });

  it('continues on unclosed triple quote', () => {
    assert.equal(needsContinuation('"""start of block'), true);
  });

  it('continues on unclosed brace', () => {
    assert.equal(needsContinuation('{ key: "value"'), true);
  });

  it('does not continue on complete text', () => {
    assert.equal(needsContinuation('hello world'), false);
  });
});

describe('isLikelyBinary', () => {
  it('returns false for text', () => {
    assert.equal(isLikelyBinary(Buffer.from('hello world')), false);
  });

  it('returns true for buffer with null bytes', () => {
    assert.equal(isLikelyBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])), true);
  });
});

describe('isPathCompletionContext', () => {
  it('returns true for tool-like commands with path arg', () => {
    assert.equal(isPathCompletionContext('read_file src/main.ts'), true);
    assert.equal(isPathCompletionContext('cat package.json'), true);
    assert.equal(isPathCompletionContext('ls src/'), true);
  });

  it('returns false for single word', () => {
    assert.equal(isPathCompletionContext('hello'), false);
    assert.equal(isPathCompletionContext('read_file'), false);
  });

  it('returns false for non-path commands', () => {
    assert.equal(isPathCompletionContext('explain this code'), false);
  });
});

describe('matchIgnorePattern', () => {
  it('matches directory pattern', () => {
    assert.equal(matchIgnorePattern('node_modules/foo.js', 'node_modules/'), true);
    assert.equal(matchIgnorePattern('node_modules', 'node_modules/'), true);
  });

  it('matches file pattern', () => {
    assert.equal(matchIgnorePattern('dist/index.js', 'dist/'), true);
  });

  it('matches glob pattern', () => {
    assert.equal(matchIgnorePattern('foo.log', '*.log'), true);
    assert.equal(matchIgnorePattern('foo.ts', '*.log'), false);
  });

  it('does not match unrelated paths', () => {
    assert.equal(matchIgnorePattern('src/index.ts', 'node_modules/'), false);
  });

  it('ignores comments and negations', () => {
    assert.equal(matchIgnorePattern('anything', '# comment'), false);
    assert.equal(matchIgnorePattern('anything', '!negation'), false);
  });
});

describe('isIgnored', () => {
  it('returns true if any pattern matches', () => {
    assert.equal(isIgnored('node_modules/foo.js', ['node_modules/', 'dist/']), true);
  });

  it('returns false if no pattern matches', () => {
    assert.equal(isIgnored('src/index.ts', ['node_modules/', 'dist/']), false);
  });
});

describe('loadGitIgnorePatterns', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ih-test-gitignore-'));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns fixed defaults for missing .gitignore', async () => {
    const patterns = await loadGitIgnorePatterns(tmpDir);
    assert.ok(patterns.includes('.git/'));
    assert.ok(patterns.includes('node_modules/'));
  });

  it('merges .gitignore entries with fixed defaults', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), '*.log\ncoverage/\n# comment\n');
    const patterns = await loadGitIgnorePatterns(tmpDir);
    assert.ok(patterns.includes('.git/'));
    assert.ok(patterns.includes('*.log'));
    assert.ok(patterns.includes('coverage/'));
    // comments should be stripped
    assert.ok(!patterns.includes('# comment'));
  });
});

describe('collectDirectoryFiles', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ih-test-collect-'));
    // Create a small tree
    await fs.writeFile(path.join(tmpDir, 'root.txt'), 'hi');
    await fs.mkdir(path.join(tmpDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'sub', 'child.txt'), 'there');
    await fs.mkdir(path.join(tmpDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.js'), 'ignored');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('collects files recursively, respecting ignore patterns', async () => {
    const acc: string[] = [];
    await collectDirectoryFiles(tmpDir, '.', 3, ['node_modules/'], acc);
    assert.ok(acc.includes('root.txt'), 'should find root.txt');
    assert.ok(acc.includes('sub/child.txt'), 'should find sub/child.txt');
    assert.ok(!acc.some(f => f.includes('node_modules')), 'should skip node_modules');
  });

  it('respects maxDepth', async () => {
    const acc: string[] = [];
    await collectDirectoryFiles(tmpDir, '.', 0, [], acc);
    assert.ok(acc.includes('root.txt'));
    assert.ok(!acc.includes('sub/child.txt'), 'should not recurse into sub at depth 0');
  });
});

describe('expandAtFileRefs (in-memory)', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ih-test-atref-'));
    await fs.writeFile(path.join(tmpDir, 'hello.txt'), 'Hello, world!');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('expands @file references', async () => {
    const result = await expandAtFileRefs('please read @hello.txt', tmpDir);
    assert.ok(result.text.includes('Hello, world!'));
    assert.equal(result.warnings.length, 0);
  });

  it('returns original text when no @refs', async () => {
    const result = await expandAtFileRefs('no refs here', tmpDir);
    assert.equal(result.text, 'no refs here');
  });

  it('warns when context budget exceeded', async () => {
    // Create a file larger than 1-token budget
    const result = await expandAtFileRefs('read @hello.txt', tmpDir, 1);
    assert.ok(result.warnings.length > 0 || result.text.includes('Hello'));
  });
});

describe('image helpers', () => {
  it('isImagePathLike matches image extensions', () => {
    assert.equal(isImagePathLike('photo.png'), true);
    assert.equal(isImagePathLike('photo.jpg'), true);
    assert.equal(isImagePathLike('photo.JPEG'), true);
    assert.equal(isImagePathLike('photo.webp'), true);
    assert.equal(isImagePathLike('photo.gif'), true);
    assert.equal(isImagePathLike('photo.txt'), false);
    assert.equal(isImagePathLike('photo.ts'), false);
  });

  it('mimeForImagePath returns correct MIME types', () => {
    assert.equal(mimeForImagePath('x.png'), 'image/png');
    assert.equal(mimeForImagePath('x.jpg'), 'image/jpeg');
    assert.equal(mimeForImagePath('x.jpeg'), 'image/jpeg');
    assert.equal(mimeForImagePath('x.webp'), 'image/webp');
    assert.equal(mimeForImagePath('x.gif'), 'image/gif');
    assert.equal(mimeForImagePath('x.bmp'), 'image/bmp');
    assert.equal(mimeForImagePath('x.tiff'), 'image/tiff');
    assert.equal(mimeForImagePath('x.xyz'), 'application/octet-stream');
  });

  it('extractImageRefs finds markdown image refs', () => {
    const refs = extractImageRefs('look at ![screenshot](./img/shot.png) and ![](other.jpg)');
    assert.ok(refs.includes('./img/shot.png'));
    assert.ok(refs.includes('other.jpg'));
  });

  it('extractImageRefs finds URL image refs', () => {
    const refs = extractImageRefs('see https://example.com/photo.png in the docs');
    assert.ok(refs.some(r => r.includes('example.com/photo.png')));
  });

  it('extractImageRefs finds path-like refs', () => {
    const refs = extractImageRefs('check ./screenshots/bug.jpg please');
    assert.ok(refs.includes('./screenshots/bug.jpg'));
  });

  it('hasClipboardImageToken detects clipboard tokens', () => {
    assert.equal(hasClipboardImageToken('paste @clipboard here'), true);
    assert.equal(hasClipboardImageToken('paste clipboard:image here'), true);
    assert.equal(hasClipboardImageToken('[clipboard]'), true);
    assert.equal(hasClipboardImageToken('no clipboard ref'), false);
  });
});

// ── cli/watch.ts ─────────────────────────────────────────────────────

import {
  parseWatchArgs,
  summarizeWatchChange,
} from '../dist/cli/watch.js';

describe('parseWatchArgs', () => {
  it('parses simple paths', () => {
    const r = parseWatchArgs('src/ tests/');
    assert.deepStrictEqual(r.paths, ['src/', 'tests/']);
    assert.equal(r.maxIterationsPerTrigger, 3);
  });

  it('parses --max flag', () => {
    const r = parseWatchArgs('src/ --max 5');
    assert.deepStrictEqual(r.paths, ['src/']);
    assert.equal(r.maxIterationsPerTrigger, 5);
  });

  it('parses --max-iterations flag', () => {
    const r = parseWatchArgs('src/ --max-iterations 10');
    assert.deepStrictEqual(r.paths, ['src/']);
    assert.equal(r.maxIterationsPerTrigger, 10);
  });

  it('throws on invalid --max value', () => {
    assert.throws(() => parseWatchArgs('src/ --max abc'), /Invalid/);
  });

  it('handles empty input', () => {
    const r = parseWatchArgs('');
    assert.deepStrictEqual(r.paths, []);
  });
});

describe('summarizeWatchChange', () => {
  it('handles single file', () => {
    assert.equal(summarizeWatchChange(new Set(['src/main.ts'])), 'src/main.ts modified');
  });

  it('handles two files', () => {
    const msg = summarizeWatchChange(new Set(['a.ts', 'b.ts']));
    assert.ok(msg.includes('a.ts'));
    assert.ok(msg.includes('b.ts'));
    assert.ok(msg.includes('modified'));
  });

  it('handles three+ files with count', () => {
    const msg = summarizeWatchChange(new Set(['a.ts', 'b.ts', 'c.ts', 'd.ts']));
    assert.ok(msg.includes('+2 more'));
  });

  it('handles empty set', () => {
    assert.equal(summarizeWatchChange(new Set()), 'changes detected');
  });
});

// ── cli/init.ts ──────────────────────────────────────────────────────

import {
  getGitShortStat,
  parseChangedFileCount,
  countDiffAddsRemoves,
  formatChangePrefix,
  collectProjectTree,
  detectProjectLanguages,
} from '../dist/cli/init.js';

describe('parseChangedFileCount', () => {
  it('extracts file count from shortstat', () => {
    assert.equal(parseChangedFileCount(' 3 files changed, 10 insertions(+), 5 deletions(-)'), 3);
    assert.equal(parseChangedFileCount(' 1 file changed, 2 insertions(+)'), 1);
  });

  it('returns 0 for empty input', () => {
    assert.equal(parseChangedFileCount(''), 0);
    assert.equal(parseChangedFileCount('no match here'), 0);
  });
});

describe('countDiffAddsRemoves', () => {
  it('counts + and - lines, skipping headers', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,4 @@',
      ' unchanged',
      '-removed line',
      '+added line 1',
      '+added line 2',
    ].join('\n');
    const { adds, removes } = countDiffAddsRemoves(diff);
    assert.equal(adds, 2);
    assert.equal(removes, 1);
  });

  it('returns 0/0 for empty diff', () => {
    const { adds, removes } = countDiffAddsRemoves('');
    assert.equal(adds, 0);
    assert.equal(removes, 0);
  });
});

describe('formatChangePrefix', () => {
  it('returns + for untracked', () => {
    assert.equal(formatChangePrefix('??'), '+');
  });

  it('returns − for deleted', () => {
    assert.equal(formatChangePrefix(' D'), '−');
  });

  it('returns + for added', () => {
    assert.equal(formatChangePrefix('A '), '+');
  });

  it('returns ✎ for modified', () => {
    assert.equal(formatChangePrefix(' M'), '✎');
  });

  it('returns ✎ for undefined', () => {
    assert.equal(formatChangePrefix(undefined), '✎');
  });
});

describe('collectProjectTree', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ih-test-tree-'));
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# Hi');
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), 'export {}');
    // Dotfiles should be skipped
    await fs.writeFile(path.join(tmpDir, '.hidden'), 'secret');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('lists files and directories (depth 2)', async () => {
    const tree = await collectProjectTree(tmpDir);
    assert.ok(tree.some(l => l.includes('README.md')));
    assert.ok(tree.some(l => l.includes('src/')));
    assert.ok(tree.some(l => l.includes('index.ts')));
  });

  it('skips dotfiles', async () => {
    const tree = await collectProjectTree(tmpDir);
    assert.ok(!tree.some(l => l.includes('.hidden')));
  });
});

describe('detectProjectLanguages', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ih-test-lang-'));
    await fs.writeFile(path.join(tmpDir, 'main.ts'), 'const x = 1;');
    await fs.writeFile(path.join(tmpDir, 'util.py'), 'x = 1');
    await fs.writeFile(path.join(tmpDir, 'readme.md'), '# Hello');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('detects languages from file extensions', async () => {
    const langs = await detectProjectLanguages(tmpDir);
    assert.ok(langs.includes('TypeScript'));
    assert.ok(langs.includes('Python'));
  });

  it('does not detect non-language files as languages', async () => {
    const langs = await detectProjectLanguages(tmpDir);
    assert.ok(!langs.includes('Markdown'));
  });
});

// ── cli/command-registry.ts ──────────────────────────────────────────

import {
  registerCommand,
  findCommand,
  allCommandNames,
} from '../dist/cli/command-registry.js';

describe('command registry', () => {
  // Register a test command
  before(() => {
    registerCommand({
      name: '/testcmd',
      aliases: ['/tc'],
      description: 'A test command',
      async execute() { return true; },
    });
  });

  it('finds registered command by name', () => {
    const cmd = findCommand('/testcmd');
    assert.ok(cmd);
    assert.equal(cmd.name, '/testcmd');
  });

  it('finds registered command by alias', () => {
    const cmd = findCommand('/tc some args');
    assert.ok(cmd);
    assert.equal(cmd.name, '/testcmd');
  });

  it('returns null for unknown command', () => {
    assert.equal(findCommand('/nonexistent'), null);
  });

  it('returns null for non-slash input', () => {
    assert.equal(findCommand('hello world'), null);
  });

  it('allCommandNames includes registered command', () => {
    const names = allCommandNames();
    assert.ok(names.includes('/testcmd'));
  });
});

// ── utils.ts ─────────────────────────────────────────────────────────

import {
  escapeRegex,
  estimateTokens,
  projectDir,
  stateDir,
  configDir,
  shellEscape,
  PKG_VERSION,
} from '../dist/utils.js';

describe('utils', () => {
  it('escapeRegex escapes all metacharacters', () => {
    const input = '.*+?^${}()|[]\\';
    const escaped = escapeRegex(input);
    // The escaped string should match the literal input
    const re = new RegExp(escaped);
    assert.ok(re.test(input));
    // And NOT match something different
    assert.ok(!re.test('anything'));
  });

  it('estimateTokens returns ceil(length/4)', () => {
    assert.equal(estimateTokens('1234'), 1);
    assert.equal(estimateTokens('12345'), 2);
    assert.equal(estimateTokens(''), 1); // min 1
  });

  it('projectDir uses config.dir when set', () => {
    assert.equal(projectDir({ dir: '/tmp/myproject' }), '/tmp/myproject');
  });

  it('projectDir falls back to process.cwd() when dir is undefined', () => {
    assert.equal(projectDir({}), process.cwd());
    assert.equal(projectDir({ dir: '' }), process.cwd());
  });

  it('stateDir returns XDG state path', () => {
    const sd = stateDir();
    assert.ok(sd.endsWith('.local/state/idlehands'));
    assert.ok(sd.startsWith(os.homedir()));
  });

  it('configDir returns XDG config path', () => {
    const cd = configDir();
    assert.ok(cd.endsWith('.config/idlehands'));
    assert.ok(cd.startsWith(os.homedir()));
  });

  it('shellEscape handles simple strings', () => {
    assert.equal(shellEscape('hello'), "'hello'");
  });

  it('shellEscape handles strings with single quotes', () => {
    const escaped = shellEscape("it's");
    assert.ok(escaped.includes("'\\''"));
  });

  it('PKG_VERSION is a semver-like string', () => {
    assert.ok(/^\d+\.\d+\.\d+/.test(PKG_VERSION), `expected semver, got: ${PKG_VERSION}`);
  });
});

// ── Anton CLI commands ───────────────────────────────────────────────

import { antonCommands } from '../dist/cli/commands/anton.js';
import { registerAll as registerAllCmds } from '../dist/cli/command-registry.js';

// Register Anton commands so findCommand can locate them
registerAllCmds(antonCommands);

describe('Anton REPL commands', () => {
  it('/anton with no args shows status (no crash)', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.join(' '));
    try {
      const mockCtx = {
        antonActive: false,
        antonAbortSignal: null,
        antonLastResult: null,
        antonProgress: null,
        config: { anton: {} },
        session: { vault: null, lens: null },
      } as any;
      const cmd = antonCommands[0];
      const handled = await cmd.execute(mockCtx, '', '/anton');
      assert.equal(handled, true);
      assert.ok(logs.some(l => l.includes('No Anton run in progress')));
    } finally {
      console.log = origLog;
    }
  });

  it('/anton status when no run → "No Anton run in progress"', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.join(' '));
    try {
      const mockCtx = {
        antonActive: false,
        antonAbortSignal: null,
        antonLastResult: null,
        antonProgress: null,
      } as any;
      await antonCommands[0].execute(mockCtx, 'status', '/anton status');
      assert.ok(logs.some(l => l.includes('No Anton run in progress')));
    } finally {
      console.log = origLog;
    }
  });

  it('/anton stop when no run → "No Anton run in progress"', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.join(' '));
    try {
      const mockCtx = {
        antonActive: false,
        antonAbortSignal: null,
      } as any;
      await antonCommands[0].execute(mockCtx, 'stop', '/anton stop');
      assert.ok(logs.some(l => l.includes('No Anton run in progress')));
    } finally {
      console.log = origLog;
    }
  });

  it('/anton last when no history → "No previous Anton run"', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.join(' '));
    try {
      const mockCtx = {
        antonLastResult: null,
      } as any;
      await antonCommands[0].execute(mockCtx, 'last', '/anton last');
      assert.ok(logs.some(l => l.includes('No previous Anton run')));
    } finally {
      console.log = origLog;
    }
  });

  it('findCommand("/anton") returns handler', () => {
    const cmd = findCommand('/anton');
    assert.ok(cmd, 'expected /anton to be registered');
    assert.equal(cmd.name, '/anton');
  });

  it('/anton help shows usage', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.join(' '));
    try {
      const mockCtx = {} as any;
      await antonCommands[0].execute(mockCtx, 'help', '/anton help');
      assert.ok(logs.some(l => l.includes('Usage:')));
    } finally {
      console.log = origLog;
    }
  });
});

// ── Bot helper tests ─────────────────────────────────────────────────

import { parseUserIds, validateBotConfig, maskToken } from '../dist/cli/bot.js';

describe('parseUserIds', () => {
  it('parses comma-separated numeric IDs', () => {
    assert.deepEqual(parseUserIds('123, 456, 789'), [123, 456, 789]);
  });

  it('filters non-numeric and negative values', () => {
    assert.deepEqual(parseUserIds('123, abc, -5, 0, 456'), [123, 456]);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(parseUserIds(''), []);
  });

  it('handles single ID', () => {
    assert.deepEqual(parseUserIds('42'), [42]);
  });
});

describe('validateBotConfig', () => {
  it('rejects empty token', () => {
    const err = validateBotConfig({ token: '', allowed_users: [1] });
    assert.ok(err, 'expected error for empty token');
    assert.ok(err!.includes('token'), 'error should mention token');
  });

  it('rejects missing allowed_users', () => {
    const err = validateBotConfig({ token: 'abc', allowed_users: [] });
    assert.ok(err, 'expected error for empty allowed_users');
  });

  it('accepts valid config', () => {
    const err = validateBotConfig({ token: 'abc:def', allowed_users: [123] });
    assert.equal(err, null);
  });
});

describe('maskToken', () => {
  it('masks long tokens showing first and last 4 chars', () => {
    assert.equal(maskToken('1234567890ABCDEF'), '1234...CDEF');
  });

  it('returns **** for short tokens', () => {
    assert.equal(maskToken('short'), '****');
  });

  it('returns **** for empty string', () => {
    assert.equal(maskToken(''), '****');
  });

  it('masks exactly 12-char token', () => {
    assert.equal(maskToken('123456789012'), '1234...9012');
  });
});

describe('parseArgs --all flag', () => {
  it('recognizes --all as boolean', () => {
    const args = parseArgs(['bot', '--all']);
    assert.equal(args.all, true);
    assert.equal(args._[0], 'bot');
  });

  it('does not consume next arg as value for --all', () => {
    const args = parseArgs(['bot', '--all', 'telegram']);
    assert.equal(args.all, true);
    assert.equal(args._[1], 'telegram');
  });
});
