import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getArgValidationIssues } from '../dist/agent/tool-calls.js';

test('flags unknown keys and enum/range violations', () => {
  const issues = getArgValidationIssues('read_file', {
    path: 'a.ts',
    limit: 999999,
    format: 'weird',
    bogus: true,
  } as any);

  const fields = issues.map((i: any) => i.field);
  assert.ok(fields.includes('bogus'));
  assert.ok(fields.includes('format'));
});

test('valid read_file args produce no issues', () => {
  const issues = getArgValidationIssues('read_file', {
    path: 'a.ts',
    limit: 100,
    offset: 1,
    format: 'numbered',
  } as any);
  assert.equal(issues.length, 0);
});

test('write_file accepts overwrite/force booleans and rejects wrong types', () => {
  const ok = getArgValidationIssues('write_file', {
    path: 'a.ts',
    content: 'x',
    overwrite: true,
    force: false,
  } as any);
  assert.equal(ok.length, 0);

  const bad = getArgValidationIssues('write_file', {
    path: 'a.ts',
    content: 'x',
    overwrite: 'yes',
  } as any);
  const fields = bad.map((i: any) => i.field);
  assert.ok(fields.includes('overwrite'));
});

// ============================================================================
// #1: stripUnknownArgs tests
// ============================================================================

import { stripUnknownArgs } from '../dist/agent/tool-calls.js';

test('stripUnknownArgs removes unknown keys from read_file', () => {
  const result = stripUnknownArgs('read_file', {
    path: 'a.ts',
    limit: 100,
    bogus: true,
    extra: 'hello',
  });
  assert.deepEqual(result.cleaned, { path: 'a.ts', limit: 100 });
  assert.deepEqual(result.stripped.sort(), ['bogus', 'extra']);
});

test('stripUnknownArgs preserves all valid keys', () => {
  const result = stripUnknownArgs('read_file', {
    path: 'a.ts',
    limit: 50,
    offset: 10,
    search: 'foo',
  });
  assert.deepEqual(result.cleaned, { path: 'a.ts', limit: 50, offset: 10, search: 'foo' });
  assert.deepEqual(result.stripped, []);
});

test('stripUnknownArgs passes through unknown tool names unchanged', () => {
  const args = { x: 1, y: 2 };
  const result = stripUnknownArgs('unknown_tool', args);
  assert.deepEqual(result.cleaned, args);
  assert.deepEqual(result.stripped, []);
});

test('stripUnknownArgs works for exec tool', () => {
  const result = stripUnknownArgs('exec', {
    command: 'ls',
    cwd: '/tmp',
    verbose: true,
    debug: false,
  });
  assert.deepEqual(result.cleaned, { command: 'ls', cwd: '/tmp' });
  assert.deepEqual(result.stripped.sort(), ['debug', 'verbose']);
});
