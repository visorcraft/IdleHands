/**
 * Tests for Anton parser functionality.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Import from dist (compiled JS)
import {
  parseTaskString,
  parseTaskFile,
  findRunnablePendingTasks,
  markTaskChecked,
  appendTaskNote,
  insertSubTasks,
  autoCompleteAncestors
} from '../dist/anton/parser.js';

describe('Anton Parser Tests', () => {
  test('1. Basic parsing: 3 tasks, 1 header → correct counts, phase values', async () => {
    const content = `# Phase A

- [ ] Task one
- [ ] Task two
- [x] Task three
`;

    const result = parseTaskString(content, '/test.md');
    
    assert.equal(result.totalCount, 3);
    assert.equal(result.pending.length, 2);
    assert.equal(result.completed.length, 1);
    assert.equal(result.roots.length, 3);
    
    // Check phase path
    assert.deepEqual(result.allTasks[0].phasePath, ['Phase A']);
    assert.deepEqual(result.allTasks[1].phasePath, ['Phase A']);
    assert.deepEqual(result.allTasks[2].phasePath, ['Phase A']);
    
    // Check checked status
    assert.equal(result.allTasks[0].checked, false);
    assert.equal(result.allTasks[1].checked, false);
    assert.equal(result.allTasks[2].checked, true);
  });

  test('2. Mixed checked/unchecked → correct pending/completed split', async () => {
    const content = `- [x] Completed task
- [ ] Pending task 1
- [X] Another completed
- [ ] Pending task 2
`;

    const result = parseTaskString(content, '/test.md');
    
    assert.equal(result.totalCount, 4);
    assert.equal(result.pending.length, 2);
    assert.equal(result.completed.length, 2);
    
    assert.equal(result.pending[0].text, 'Pending task 1');
    assert.equal(result.pending[1].text, 'Pending task 2');
    assert.equal(result.completed[0].text, 'Completed task');
    assert.equal(result.completed[1].text, 'Another completed');
  });

  test('3. Nested sub-tasks → depth, parentKey, children', async () => {
    const content = `- [ ] Parent task
  - [ ] Child task 1
    - [ ] Grandchild task
  - [ ] Child task 2
- [ ] Another parent
`;

    const result = parseTaskString(content, '/test.md');
    
    assert.equal(result.totalCount, 5);
    assert.equal(result.roots.length, 2);
    
    const parent = result.allTasks[0];
    const child1 = result.allTasks[1];
    const grandchild = result.allTasks[2];
    const child2 = result.allTasks[3];
    const parent2 = result.allTasks[4];
    
    assert.equal(parent.depth, 0);
    assert.equal(child1.depth, 1);
    assert.equal(grandchild.depth, 2);
    assert.equal(child2.depth, 1);
    assert.equal(parent2.depth, 0);
    
    assert.equal(child1.parentKey, parent.key);
    assert.equal(grandchild.parentKey, child1.key);
    assert.equal(child2.parentKey, parent.key);
    assert.equal(parent2.parentKey, undefined);
    
    assert.equal(parent.children.length, 2);
    assert.equal(child1.children.length, 1);
    assert.equal(grandchild.children.length, 0);
  });

  test('4. Multi-heading → phasePath tracks heading hierarchy correctly', async () => {
    const content = `# Phase A
## Parser
- [ ] Parse tasks
### Validation
- [ ] Validate structure
# Phase B
- [ ] Execute tasks
`;

    const result = parseTaskString(content, '/test.md');
    
    assert.equal(result.totalCount, 3);
    assert.deepEqual(result.allTasks[0].phasePath, ['Phase A', 'Parser']);
    assert.deepEqual(result.allTasks[1].phasePath, ['Phase A', 'Parser', 'Validation']);
    assert.deepEqual(result.allTasks[2].phasePath, ['Phase B']);
  });

  test('5. Code block exclusion → tasks in fenced blocks not parsed', async () => {
    const content = `- [ ] Real task

\`\`\`
- [ ] Fake task in code
- [x] Another fake task
\`\`\`

- [ ] Another real task
`;

    const result = parseTaskString(content, '/test.md');
    
    assert.equal(result.totalCount, 2);
    assert.equal(result.allTasks[0].text, 'Real task');
    assert.equal(result.allTasks[1].text, 'Another real task');
  });

  test('6. Empty task text → skipped (not in allTasks)', async () => {
    const content = `- [ ] Valid task
- [ ] 
- [ ] Another valid task
`;

    const result = parseTaskString(content, '/test.md');
    
    assert.equal(result.totalCount, 2);
    assert.equal(result.allTasks[0].text, 'Valid task');
    assert.equal(result.allTasks[1].text, 'Another valid task');
  });

  test('7. Continuation lines → text concatenated', async () => {
    const content = `- [ ] Multi-line task
      with continuation
      and more text
- [ ] Regular task
`;

    const result = parseTaskString(content, '/test.md');
    
    assert.equal(result.totalCount, 2);
    assert.equal(result.allTasks[0].text, 'Multi-line task with continuation and more text');
    assert.equal(result.allTasks[1].text, 'Regular task');
  });

  test('8. Tab indentation → treated as 1 level', async () => {
    const content = `- [ ] Parent task
\t- [ ] Tab-indented child
\t\t- [ ] Double-tab grandchild
`;

    const result = parseTaskString(content, '/test.md');
    
    assert.equal(result.totalCount, 3);
    assert.equal(result.allTasks[0].depth, 0);
    assert.equal(result.allTasks[1].depth, 1);
    assert.equal(result.allTasks[2].depth, 2);
  });

  test('9. Duplicate task text siblings → different keys (ordinal differs)', async () => {
    const content = `- [ ] Same task
- [ ] Same task
- [ ] Different task
- [ ] Same task
`;

    const result = parseTaskString(content, '/test.md');
    
    assert.equal(result.totalCount, 4);
    
    // All tasks should have different keys
    const keys = result.allTasks.map(t => t.key);
    const uniqueKeys = new Set(keys);
    assert.equal(uniqueKeys.size, 4);
    
    // But same text
    assert.equal(result.allTasks[0].text, 'Same task');
    assert.equal(result.allTasks[1].text, 'Same task');
    assert.equal(result.allTasks[3].text, 'Same task');
  });

  test('10. Key stability → insert unrelated lines above, re-parse: same keys', async () => {
    const originalContent = `# Phase A
- [ ] Task one
- [ ] Task two
`;

    const modifiedContent = `This is a comment

# Phase A
More comments here
- [ ] Task one
- [ ] Task two
`;

    const original = parseTaskString(originalContent, '/test.md');
    const modified = parseTaskString(modifiedContent, '/test.md');
    
    assert.equal(original.totalCount, 2);
    assert.equal(modified.totalCount, 2);
    
    // Keys should remain the same
    assert.equal(original.allTasks[0].key, modified.allTasks[0].key);
    assert.equal(original.allTasks[1].key, modified.allTasks[1].key);
  });

  test('11. markTaskChecked → re-parse confirms checked', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'anton-test-'));
    const testFile = join(tmpDir, 'test.md');
    
    try {
      const content = `- [ ] Task to check
- [ ] Another task
`;
      await writeFile(testFile, content, 'utf8');
      
      const before = await parseTaskFile(testFile);
      const taskKey = before.allTasks[0].key;
      
      await markTaskChecked(testFile, taskKey);
      
      const after = await parseTaskFile(testFile);
      assert.equal(after.allTasks[0].checked, true);
      assert.equal(after.allTasks[1].checked, false);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test('12. markTaskChecked idempotent → calling twice doesn\'t corrupt', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'anton-test-'));
    const testFile = join(tmpDir, 'test.md');
    
    try {
      const content = `- [ ] Task to check`;
      await writeFile(testFile, content, 'utf8');
      
      const before = await parseTaskFile(testFile);
      const taskKey = before.allTasks[0].key;
      
      await markTaskChecked(testFile, taskKey);
      await markTaskChecked(testFile, taskKey); // Second call
      
      const after = await parseTaskFile(testFile);
      assert.equal(after.totalCount, 1);
      assert.equal(after.allTasks[0].checked, true);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test('13. appendTaskNote → note appears, idempotent', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'anton-test-'));
    const testFile = join(tmpDir, 'test.md');
    
    try {
      const content = `- [ ] Task with note
- [ ] Another task
`;
      await writeFile(testFile, content, 'utf8');
      
      const before = await parseTaskFile(testFile);
      const taskKey = before.allTasks[0].key;
      
      await appendTaskNote(testFile, taskKey, 'Test note');
      
      const fileContent = await import('node:fs/promises').then(fs => fs.readFile(testFile, 'utf8'));
      assert.ok(fileContent.includes('<!-- anton: Test note -->'));
      
      // Test idempotent
      await appendTaskNote(testFile, taskKey, 'Test note');
      const contentAfter = await import('node:fs/promises').then(fs => fs.readFile(testFile, 'utf8'));
      const noteCount = (contentAfter.match(/<!-- anton: Test note -->/g) || []).length;
      assert.equal(noteCount, 1);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test('14. insertSubTasks → sub-tasks appear as children with correct depth', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'anton-test-'));
    const testFile = join(tmpDir, 'test.md');
    
    try {
      const content = `- [ ] Parent task
- [ ] Another parent
`;
      await writeFile(testFile, content, 'utf8');
      
      const before = await parseTaskFile(testFile);
      const parentKey = before.allTasks[0].key;
      
      const newTasks = await insertSubTasks(testFile, parentKey, ['Sub-task 1', 'Sub-task 2']);
      
      assert.equal(newTasks.length, 2);
      assert.equal(newTasks[0].text, 'Sub-task 1');
      assert.equal(newTasks[1].text, 'Sub-task 2');
      assert.equal(newTasks[0].depth, 1);
      assert.equal(newTasks[1].depth, 1);
      assert.equal(newTasks[0].parentKey, parentKey);
      assert.equal(newTasks[1].parentKey, parentKey);
      
      const after = await parseTaskFile(testFile);
      assert.equal(after.totalCount, 4);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test('15. insertSubTasks empty → no file modification', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'anton-test-'));
    const testFile = join(tmpDir, 'test.md');
    
    try {
      const content = `- [ ] Parent task`;
      await writeFile(testFile, content, 'utf8');
      
      const before = await parseTaskFile(testFile);
      const parentKey = before.allTasks[0].key;
      
      const newTasks = await insertSubTasks(testFile, parentKey, []);
      
      assert.equal(newTasks.length, 0);
      
      const after = await parseTaskFile(testFile);
      assert.equal(after.totalCount, 1);
      assert.equal(after.contentHash, before.contentHash);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test('16. findRunnablePendingTasks → parent+child both unchecked: only parent', async () => {
    const content = `- [ ] Parent task
  - [ ] Child task
- [ ] Independent task
`;

    const taskFile = parseTaskString(content, '/test.md');
    const runnable = findRunnablePendingTasks(taskFile, new Set());
    
    assert.equal(runnable.length, 2);
    assert.equal(runnable[0].text, 'Parent task');
    assert.equal(runnable[1].text, 'Independent task');
    // Child task should not be runnable since parent is pending
  });

  test('17. File not found → throws descriptive error', async () => {
    await assert.rejects(
      async () => await parseTaskFile('/nonexistent/file.md'),
      /Task file not found/
    );
  });

  test('18. Performance → 200 tasks parse in < 100ms', async () => {
    // Generate content with 200 tasks
    const lines = ['# Performance Test'];
    for (let i = 1; i <= 200; i++) {
      lines.push(`- [ ] Task ${i}`);
    }
    const content = lines.join('\n');
    
    const start = Date.now();
    const result = parseTaskString(content, '/test.md');
    const duration = Date.now() - start;
    
    assert.equal(result.totalCount, 200);
    assert.ok(duration < 100, `Parsing took ${duration}ms, expected < 100ms`);
  });

  test('19. autoCompleteAncestors → marks parent when all children checked', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'anton-test-'));
    const testFile = join(tmpDir, 'test.md');
    
    try {
      const content = `- [ ] Parent task
  - [x] Child 1
  - [ ] Child 2
`;
      await writeFile(testFile, content, 'utf8');
      
      const before = await parseTaskFile(testFile);
      const child2Key = before.allTasks[2].key;
      
      // Mark child 2 as checked
      await markTaskChecked(testFile, child2Key);
      
      // Auto-complete ancestors
      const completed = await autoCompleteAncestors(testFile, child2Key);
      
      assert.equal(completed.length, 1);
      
      const after = await parseTaskFile(testFile);
      assert.equal(after.allTasks[0].checked, true); // Parent should be checked
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test('20. autoCompleteAncestors → cascades to grandparent', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'anton-test-'));
    const testFile = join(tmpDir, 'test.md');
    
    try {
      const content = `- [ ] Grandparent
  - [ ] Parent
    - [x] Child 1
    - [ ] Child 2
  - [x] Uncle task
`;
      await writeFile(testFile, content, 'utf8');
      
      const before = await parseTaskFile(testFile);
      const child2Key = before.allTasks[3].key;
      
      // Mark child 2 as checked
      await markTaskChecked(testFile, child2Key);
      
      // Auto-complete ancestors
      const completed = await autoCompleteAncestors(testFile, child2Key);
      
      assert.equal(completed.length, 2); // Should complete parent and grandparent
      
      const after = await parseTaskFile(testFile);
      assert.equal(after.allTasks[0].checked, true); // Grandparent
      assert.equal(after.allTasks[1].checked, true); // Parent
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test('21. autoCompleteAncestors → returns empty when siblings still unchecked', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'anton-test-'));
    const testFile = join(tmpDir, 'test.md');
    
    try {
      const content = `- [ ] Parent task
  - [ ] Child 1
  - [ ] Child 2
  - [ ] Child 3
`;
      await writeFile(testFile, content, 'utf8');
      
      const before = await parseTaskFile(testFile);
      const child1Key = before.allTasks[1].key;
      
      // Mark child 1 as checked
      await markTaskChecked(testFile, child1Key);
      
      // Auto-complete ancestors (should not complete parent since other children exist)
      const completed = await autoCompleteAncestors(testFile, child1Key);
      
      assert.equal(completed.length, 0);
      
      const after = await parseTaskFile(testFile);
      assert.equal(after.allTasks[0].checked, false); // Parent should still be unchecked
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });
});