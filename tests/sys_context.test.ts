import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  sys_context,
  collectSnapshot,
  clearSnapshotCache,
  detectPackageManager,
} from '../dist/sys/context.js';

describe('sys_context tool', () => {
  it('collects full system context', async () => {
    clearSnapshotCache();
    const out = await sys_context({} as any, { scope: 'all' });
    assert.ok(out.includes('[System context]'));
    assert.ok(out.includes('[End system context]'));
  });

  it('supports scoped snapshots', async () => {
    clearSnapshotCache();
    const services = await sys_context({} as any, { scope: 'services' });
    assert.ok(services.includes('[System context]'));

    const network = await sys_context({} as any, { scope: 'network' });
    assert.ok(network.includes('[System context]'));

    const disk = await sys_context({} as any, { scope: 'disk' });
    assert.ok(disk.includes('[System context]'));

    const packages = await sys_context({} as any, { scope: 'packages' });
    assert.ok(packages.includes('[System context]'));
  });

  it('rejects invalid scope', async () => {
    await assert.rejects(() => sys_context({} as any, { scope: 'bad-scope' }), /invalid scope/i);
  });

  it('cache returns stable output within ttl', async () => {
    clearSnapshotCache();
    const a = await collectSnapshot('services');
    const b = await collectSnapshot('services');
    assert.equal(a, b);
  });

  it('detects package manager', () => {
    const pm = detectPackageManager();
    assert.ok(['apt', 'dnf', 'pacman', 'unknown'].includes(pm));
  });
});
