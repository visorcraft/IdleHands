import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { needsElevation } from '../dist/upgrade.js';

describe('needsElevation', () => {
  it('returns false for a user-writable directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-upgrade-test-'));
    const modules = path.join(tmp, 'lib', 'node_modules');
    fs.mkdirSync(modules, { recursive: true });
    try {
      assert.strictEqual(needsElevation(tmp), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns true for a non-writable directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-upgrade-test-'));
    const modules = path.join(tmp, 'lib', 'node_modules');
    fs.mkdirSync(modules, { recursive: true });
    fs.chmodSync(modules, 0o444);
    try {
      assert.strictEqual(needsElevation(tmp), true);
    } finally {
      fs.chmodSync(modules, 0o755);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns true when lib/node_modules does not exist', () => {
    assert.strictEqual(needsElevation('/nonexistent/path/ih-test'), true);
  });

  it('returns false when running as root', function () {
    if (process.getuid?.() !== 0) {
      this.skip();
      return;
    }
    // Root can write anywhere — even /usr/local
    assert.strictEqual(needsElevation('/usr/local'), false);
  });
});
