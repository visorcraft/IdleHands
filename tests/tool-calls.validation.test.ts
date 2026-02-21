import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getArgValidationIssues } from '../dist/agent/tool-calls.js';

test('flags unknown keys and enum/range violations', () => {
  const issues = getArgValidationIssues('read_file', {
    path: 'a.ts',
    limit: 999,
    format: 'weird',
    bogus: true,
  } as any);

  const fields = issues.map((i: any) => i.field);
  assert.ok(fields.includes('bogus'));
  assert.ok(fields.includes('limit'));
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
