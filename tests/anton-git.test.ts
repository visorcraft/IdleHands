import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { 
  ensureCleanWorkingTree, 
  commitAll, 
  restoreTrackedChanges, 
  getWorkingDiff, 
  createBranch, 
  commitAmend 
} from '../dist/git.js';

function createTempGitRepo(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anton-git-test-'));
  
  // Initialize git repo
  execSync('git init', { cwd: tmpDir });
  execSync('git config user.email "test@example.com"', { cwd: tmpDir });
  execSync('git config user.name "Test User"', { cwd: tmpDir });
  
  // Create initial commit
  fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'initial content');
  execSync('git add initial.txt', { cwd: tmpDir });
  execSync('git commit -m "Initial commit"', { cwd: tmpDir });
  
  return tmpDir;
}

function cleanup(tmpDir: string): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

describe('Anton git functions', () => {
  test('ensureCleanWorkingTree passes on clean repo', () => {
    const tmpDir = createTempGitRepo();
    try {
      assert.doesNotThrow(() => ensureCleanWorkingTree(tmpDir));
    } finally {
      cleanup(tmpDir);
    }
  });

  test('ensureCleanWorkingTree throws on dirty repo', () => {
    const tmpDir = createTempGitRepo();
    try {
      // Make repo dirty
      fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'dirty content');
      
      assert.throws(
        () => ensureCleanWorkingTree(tmpDir),
        /Anton: Working tree not clean. Commit or stash first./
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('commitAll creates commit and returns hash', () => {
    const tmpDir = createTempGitRepo();
    try {
      // Add some changes
      fs.writeFileSync(path.join(tmpDir, 'new.txt'), 'new content');
      
      const hash = commitAll(tmpDir, 'Test commit message');
      
      assert.match(hash, /^[a-f0-9]{7,}$/);
      
      // Verify commit was created
      const log = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf8' });
      assert(log.includes('Test commit message'));
    } finally {
      cleanup(tmpDir);
    }
  });

  test('commitAll returns empty string when nothing to commit', () => {
    const tmpDir = createTempGitRepo();
    try {
      const hash = commitAll(tmpDir, 'Nothing to commit');
      assert.strictEqual(hash, '');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('restoreTrackedChanges reverts modified files', () => {
    const tmpDir = createTempGitRepo();
    try {
      // Modify existing file
      const filePath = path.join(tmpDir, 'initial.txt');
      const originalContent = fs.readFileSync(filePath, 'utf8');
      fs.writeFileSync(filePath, 'modified content');
      
      restoreTrackedChanges(tmpDir);
      
      // Verify file was restored
      const restoredContent = fs.readFileSync(filePath, 'utf8');
      assert.strictEqual(restoredContent, originalContent);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('getWorkingDiff returns diff content', () => {
    const tmpDir = createTempGitRepo();
    try {
      // Modify a file
      fs.writeFileSync(path.join(tmpDir, 'initial.txt'), 'modified content');
      
      const diff = getWorkingDiff(tmpDir);
      
      assert(diff.includes('initial content'));
      assert(diff.includes('modified content'));
      assert(diff.includes('diff --git'));
    } finally {
      cleanup(tmpDir);
    }
  });

  test('createBranch creates and checks out new branch', () => {
    const tmpDir = createTempGitRepo();
    try {
      createBranch(tmpDir, 'feature-branch');
      
      // Verify we're on the new branch
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
      assert.strictEqual(currentBranch, 'feature-branch');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('createBranch throws on duplicate branch name', () => {
    const tmpDir = createTempGitRepo();
    try {
      // Remember the initial branch name (main, master, etc.)
      const origBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
      
      // Create branch first time
      createBranch(tmpDir, 'test-branch');
      
      // Go back to the original branch
      execSync(`git checkout ${origBranch}`, { cwd: tmpDir });
      
      // Try to create same branch again
      assert.throws(
        () => createBranch(tmpDir, 'test-branch'),
        /git checkout -b failed/
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('commitAmend amends last commit without changing message', () => {
    const tmpDir = createTempGitRepo();
    try {
      // Add some changes and commit
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'test content');
      commitAll(tmpDir, 'Test commit for amend');
      
      // Get original commit hash
      const originalHash = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
      
      // Add more changes
      fs.writeFileSync(path.join(tmpDir, 'test2.txt'), 'more content');
      
      // Amend the commit
      commitAmend(tmpDir);
      
      // Verify commit hash changed but message stayed the same
      const newHash = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
      assert.notStrictEqual(originalHash, newHash);
      
      const commitMessage = execSync('git log -1 --pretty=format:"%s"', { cwd: tmpDir, encoding: 'utf8' });
      assert.strictEqual(commitMessage, 'Test commit for amend');
      
      // Verify both files are in the amended commit
      const files = execSync('git show --name-only --pretty=format:', { cwd: tmpDir, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      assert(files.includes('test.txt'));
      assert(files.includes('test2.txt'));
    } finally {
      cleanup(tmpDir);
    }
  });
});