import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { buildAntonPrompt, parseAntonResult } from '../dist/anton/prompt.js';
import type { AntonTask, AntonTaskFile, AntonRunConfig, AntonPromptOpts } from '../dist/anton/types.js';

// Mock vault store for testing
class MockVaultStore {
  private results: any[] = [];

  setSearchResults(results: any[]) {
    this.results = results;
  }

  async search(query: string, limit: number) {
    return this.results.slice(0, limit);
  }
}

// Helper to create test task
function createTestTask(overrides: Partial<AntonTask> = {}): AntonTask {
  return {
    key: 'test-key',
    text: 'Implement feature X',
    phasePath: ['Phase A', 'Implementation'],
    depth: 0,
    line: 42,
    checked: false,
    parentKey: undefined,
    children: [],
    ...overrides
  };
}

// Helper to create test task file
function createTestTaskFile(overrides: Partial<AntonTaskFile> = {}): AntonTaskFile {
  return {
    filePath: '/path/to/tasks.md',
    allTasks: [],
    roots: [],
    pending: [],
    completed: [],
    totalCount: 100,
    contentHash: 'abc123',
    ...overrides
  };
}

// Helper to create test config
function createTestConfig(overrides: Partial<AntonRunConfig> = {}): AntonRunConfig {
  return {
    taskFile: '/path/to/tasks.md',
    projectDir: '/path/to/project',
    maxRetriesPerTask: 3,
    maxIterations: 50,
    taskTimeoutSec: 300,
    totalTimeoutSec: 3600,
    maxTotalTokens: 100000,
    maxPromptTokensPerAttempt: 128000,
    autoCommit: true,
    branch: false,
    allowDirty: false,
    aggressiveCleanOnFail: true,
    verifyAi: false,
    verifyModel: undefined,
    decompose: false,
    maxDecomposeDepth: 3,
    maxTotalTasks: 500,
    buildCommand: undefined,
    testCommand: undefined,
    lintCommand: undefined,
    skipOnFail: false,
    approvalMode: 'auto',
    verbose: false,
    dryRun: false,
    ...overrides
  };
}

describe('buildAntonPrompt', () => {
  it('should contain basic task information and rules', async () => {
    const task = createTestTask();
    const taskFile = createTestTaskFile();
    const config = createTestConfig();
    
    const opts: AntonPromptOpts = {
      task,
      taskFile,
      taskFilePath: '/path/to/tasks.md',
      projectDir: '/project',
      config,
      retryContext: undefined,
      vault: undefined,
      lens: undefined,
      maxContextTokens: 1000
    };

    const prompt = await buildAntonPrompt(opts);

    assert.ok(prompt.includes('You are an autonomous coding agent working on ONE task'));
    assert.ok(prompt.includes('Complete the task, then emit exactly one `<anton-result>` block'));
    assert.ok(prompt.includes('Do NOT edit the task file checkboxes'));
    assert.ok(prompt.includes('Keep changes minimal and focused'));
    assert.ok(prompt.includes('Implement feature X'));
    assert.ok(prompt.includes('**Line:** 42'));
    assert.ok(prompt.includes('<anton-result>'));
  });

  it('should include retry context when provided', async () => {
    const task = createTestTask();
    const taskFile = createTestTaskFile();
    const config = createTestConfig();
    
    const opts: AntonPromptOpts = {
      task,
      taskFile,
      taskFilePath: '/path/to/tasks.md',
      projectDir: '/project',
      config,
      retryContext: 'Previous attempt failed due to syntax error',
      vault: undefined,
      lens: undefined,
      maxContextTokens: 1000
    };

    const prompt = await buildAntonPrompt(opts);

    assert.ok(prompt.includes('Previous Attempt Failed'));
    assert.ok(prompt.includes('Previous attempt failed due to syntax error'));
    assert.ok(prompt.includes('Do not repeat the same mistake'));
  });

  it('should include decompose instructions when enabled, omit when disabled', async () => {
    const task = createTestTask();
    const taskFile = createTestTaskFile();
    
    // Test with decompose enabled
    const configEnabled = createTestConfig({ decompose: true, maxDecomposeDepth: 3 });
    const optsEnabled: AntonPromptOpts = {
      task,
      taskFile,
      taskFilePath: '/path/to/tasks.md',
      projectDir: '/project',
      config: configEnabled,
      retryContext: undefined,
      vault: undefined,
      lens: undefined,
      maxContextTokens: 1000
    };

    const promptEnabled = await buildAntonPrompt(optsEnabled);
    assert.ok(promptEnabled.includes('you can decompose it into smaller subtasks'));
    assert.ok(promptEnabled.includes('Maximum decomposition depth: 3'));

    // Test with decompose disabled
    const configDisabled = createTestConfig({ decompose: false });
    const optsDisabled: AntonPromptOpts = {
      ...optsEnabled,
      config: configDisabled
    };

    const promptDisabled = await buildAntonPrompt(optsDisabled);
    assert.ok(!promptDisabled.includes('decompose'));
    assert.ok(!promptDisabled.includes('Maximum decomposition depth'));
  });

  it('should list children under current task', async () => {
    const child1 = createTestTask({ key: 'child1', text: 'Child task 1', checked: false });
    const child2 = createTestTask({ key: 'child2', text: 'Child task 2', checked: true });
    const task = createTestTask({ children: [child1, child2] });
    const taskFile = createTestTaskFile();
    const config = createTestConfig();
    
    const opts: AntonPromptOpts = {
      task,
      taskFile,
      taskFilePath: '/path/to/tasks.md',
      projectDir: '/project',
      config,
      retryContext: undefined,
      vault: undefined,
      lens: undefined,
      maxContextTokens: 1000
    };

    const prompt = await buildAntonPrompt(opts);

    assert.ok(prompt.includes('**Children:**'));
    assert.ok(prompt.includes('- [ ] Child task 1'));
    assert.ok(prompt.includes('- [x] Child task 2'));
  });

  it('should respect token budget for vault results', async () => {
    const mockVault = new MockVaultStore();
    
    // Create large mock results
    const largeResults = [
      { id: 'file1', content: 'x'.repeat(2000), key: 'large-file-1.ts' },
      { id: 'file2', content: 'y'.repeat(2000), key: 'large-file-2.ts' },
      { id: 'file3', content: 'z'.repeat(2000), key: 'large-file-3.ts' }
    ];
    
    mockVault.setSearchResults(largeResults);

    const task = createTestTask({ text: 'implement file parsing' });
    const taskFile = createTestTaskFile();
    const config = createTestConfig();
    
    const opts: AntonPromptOpts = {
      task,
      taskFile,
      taskFilePath: '/path/to/tasks.md',
      projectDir: '/project',
      config,
      retryContext: undefined,
      vault: mockVault as any,
      lens: undefined,
      maxContextTokens: 100 // Very small budget
    };

    const prompt = await buildAntonPrompt(opts);
    
    // Should not include all the large content due to token budget
    const tokenUsage = Math.ceil(prompt.length / 4); // Rough estimate
    assert.ok(tokenUsage < 5000, 'Prompt should respect token budget');
  });
});

describe('parseAntonResult', () => {
  it('should parse valid done block', () => {
    const output = `
Task completed successfully.

<anton-result>
status: done
</anton-result>
    `;

    const result = parseAntonResult(output);
    assert.equal(result.status, 'done');
    assert.equal(result.reason, undefined);
    assert.deepEqual(result.subtasks, []);
  });

  it('should parse valid blocked block with reason', () => {
    const output = `
Cannot proceed due to missing dependencies.

<anton-result>
status: blocked
reason: Missing required dependencies xyz
</anton-result>
    `;

    const result = parseAntonResult(output);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'Missing required dependencies xyz');
    assert.deepEqual(result.subtasks, []);
  });

  it('should parse valid decompose block with subtasks', () => {
    const output = `
This task is too complex and needs to be broken down.

<anton-result>
status: decompose
subtasks:
- Implement parser module
- Add validation logic  
- Write unit tests
</anton-result>
    `;

    const result = parseAntonResult(output);
    assert.equal(result.status, 'decompose');
    assert.equal(result.reason, undefined);
    assert.deepEqual(result.subtasks, [
      'Implement parser module',
      'Add validation logic',
      'Write unit tests'
    ]);
  });

  it('should return blocked when no result block found', () => {
    const output = `
This is just regular agent output without any structured result.
Task completed successfully but no proper result block.
    `;

    const result = parseAntonResult(output);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'Agent did not emit structured result');
    assert.deepEqual(result.subtasks, []);
  });

  it('should return blocked for unknown status', () => {
    const output = `
<anton-result>
status: invalid_status
</anton-result>
    `;

    const result = parseAntonResult(output);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'Unknown status: invalid_status');
    assert.deepEqual(result.subtasks, []);
  });

  it('should return blocked for malformed result block', () => {
    const output = `
<anton-result>
malformed content without status line
</anton-result>
    `;

    const result = parseAntonResult(output);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'No status line found in result block');
    assert.deepEqual(result.subtasks, []);
  });

  it('should use last result block when multiple present', () => {
    const output = `
First attempt:
<anton-result>
status: blocked
reason: First failure
</anton-result>

Retrying...

Final result:
<anton-result>
status: done
</anton-result>
    `;

    const result = parseAntonResult(output);
    assert.equal(result.status, 'done');
    assert.equal(result.reason, undefined);
    assert.deepEqual(result.subtasks, []);
  });
});