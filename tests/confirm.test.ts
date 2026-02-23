import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HeadlessConfirmProvider } from '../dist/confirm/headless.js';

describe('HeadlessConfirmProvider', () => {
  it('reject mode allows read-only tools', async () => {
    const p = new HeadlessConfirmProvider('reject');
    assert.equal(
      await p.confirm({ tool: 'read_file', args: {}, summary: 'read foo.ts', mode: 'reject' }),
      true
    );
    assert.equal(
      await p.confirm({ tool: 'list_dir', args: {}, summary: 'list dir', mode: 'reject' }),
      true
    );
    assert.equal(
      await p.confirm({ tool: 'search_files', args: {}, summary: 'search', mode: 'reject' }),
      true
    );
    assert.equal(
      await p.confirm({ tool: 'read_files', args: {}, summary: 'batch read', mode: 'reject' }),
      true
    );
    assert.equal(
      await p.confirm({ tool: 'vault_search', args: {}, summary: 'vault search', mode: 'reject' }),
      true
    );
  });

  it('reject mode blocks mutating tools', async () => {
    const p = new HeadlessConfirmProvider('reject');
    assert.equal(
      await p.confirm({ tool: 'write_file', args: {}, summary: 'write foo.ts', mode: 'reject' }),
      false
    );
    assert.equal(
      await p.confirm({ tool: 'edit_file', args: {}, summary: 'edit foo.ts', mode: 'reject' }),
      false
    );
    assert.equal(
      await p.confirm({ tool: 'exec', args: {}, summary: 'run cmd', mode: 'reject' }),
      false
    );
    assert.equal(
      await p.confirm({ tool: 'insert_file', args: {}, summary: 'insert', mode: 'reject' }),
      false
    );
  });

  it('yolo mode approves everything', async () => {
    const p = new HeadlessConfirmProvider('yolo');
    assert.equal(
      await p.confirm({ tool: 'exec', args: {}, summary: 'run dangerous', mode: 'yolo' }),
      true
    );
    assert.equal(
      await p.confirm({ tool: 'write_file', args: {}, summary: 'write', mode: 'yolo' }),
      true
    );
  });

  it('auto-edit mode approves file ops but rejects exec', async () => {
    const p = new HeadlessConfirmProvider('auto-edit');
    assert.equal(
      await p.confirm({ tool: 'write_file', args: {}, summary: 'write', mode: 'auto-edit' }),
      true
    );
    assert.equal(
      await p.confirm({ tool: 'edit_file', args: {}, summary: 'edit', mode: 'auto-edit' }),
      true
    );
    assert.equal(
      await p.confirm({ tool: 'exec', args: {}, summary: 'run', mode: 'auto-edit' }),
      false
    );
  });

  it('default mode rejects all mutating ops', async () => {
    const p = new HeadlessConfirmProvider('default');
    assert.equal(
      await p.confirm({ tool: 'write_file', args: {}, summary: 'write', mode: 'default' }),
      false
    );
    assert.equal(
      await p.confirm({ tool: 'exec', args: {}, summary: 'run', mode: 'default' }),
      false
    );
    // But read-only still works
    assert.equal(
      await p.confirm({ tool: 'read_file', args: {}, summary: 'read', mode: 'default' }),
      true
    );
  });
});
