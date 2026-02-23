import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { SecretsStore, resolveSecretRef } from '../dist/runtime/secrets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to create isolated temp directories per-test
async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-secrets-'));
  const originalConfigDir = process.env.IDLEHANDS_CONFIG_DIR;
  try {
    process.env.IDLEHANDS_CONFIG_DIR = dir;
    await fn(dir);
  } finally {
    if (originalConfigDir !== undefined) {
      process.env.IDLEHANDS_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.IDLEHANDS_CONFIG_DIR;
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe('SecretsStore', () => {
  const testPassphrase = 'test-passphrase-12345';

  it('should create and save a new secrets store', async () => {
    await withTempDir(async (dir) => {
      const storePath = path.join(dir, 'secrets.json');
      const store = new SecretsStore(testPassphrase);
      store.set('test-key', 'test-value');
      await store.save();

      const data = await fs.readFile(storePath, 'utf8');
      const parsed = JSON.parse(data);

      // Should have encrypted structure
      assert.strictEqual(parsed.version, 1);
      assert.ok(parsed.ciphertext !== undefined);
      assert.ok(parsed.iv !== undefined);
      assert.ok(parsed.tag !== undefined);
      assert.ok(parsed.salt !== undefined);

      // Plain text should not be in the file
      assert.ok(!data.includes('test-value'));
    });
  });

  it('should load and decrypt secrets', async () => {
    await withTempDir(async () => {
      const store = new SecretsStore(testPassphrase);
      store.set('api-key', 'sample-config-value-123');
      await store.save();

      // Create new store instance and load
      const newStore = new SecretsStore(testPassphrase);
      await newStore.load();

      assert.strictEqual(newStore.get('api-key'), 'sample-config-value-123');
    });
  });

  it('should handle missing store file gracefully', async () => {
    await withTempDir(async () => {
      const newStore = new SecretsStore(testPassphrase);
      await newStore.load(); // Should not throw

      assert.strictEqual(newStore.store.size, 0);
    });
  });

  it('should throw error when loading with wrong passphrase', async () => {
    await withTempDir(async () => {
      const store = new SecretsStore(testPassphrase);
      store.set('key', 'value');
      await store.save();

      const wrongStore = new SecretsStore('wrong-passphrase');
      await assert.rejects(() => wrongStore.load());
    });
  });

  it('should verify store integrity', async () => {
    await withTempDir(async () => {
      const store = new SecretsStore(testPassphrase);
      store.set('key', 'value');
      await store.save();

      const verified = await store.verify();
      assert.strictEqual(verified, true);
    });
  });

  it('should fail verification with wrong passphrase', async () => {
    await withTempDir(async () => {
      const store = new SecretsStore(testPassphrase);
      store.set('key', 'value');
      await store.save();

      const wrongStore = new SecretsStore('wrong-passphrase');
      const verified = await wrongStore.verify();
      assert.strictEqual(verified, false);
    });
  });

  it('should delete secrets', async () => {
    await withTempDir(async () => {
      const store = new SecretsStore(testPassphrase);
      store.set('key1', 'value1');
      store.set('key2', 'value2');
      await store.save();

      store.delete('key1');
      await store.save();

      const newStore = new SecretsStore(testPassphrase);
      await newStore.load();

      assert.strictEqual(newStore.has('key1'), false);
      assert.strictEqual(newStore.get('key2'), 'value2');
    });
  });

  it('should list all secret keys', async () => {
    await withTempDir(async () => {
      const store = new SecretsStore(testPassphrase);
      store.set('key1', 'value1');
      store.set('key2', 'value2');
      store.set('key3', 'value3');

      const keys = [...store.store.keys()];
      assert.ok(keys.includes('key1'));
      assert.ok(keys.includes('key2'));
      assert.ok(keys.includes('key3'));
      assert.strictEqual(keys.length, 3);
    });
  });

  it('should handle special characters in keys and values', async () => {
    await withTempDir(async () => {
      const specialKey = 'key-with-special-chars!@#$%^&*()';
      const specialValue = 'value with spaces and "quotes" and émojis 🎉';

      const store = new SecretsStore(testPassphrase);
      store.set(specialKey, specialValue);
      await store.save();

      const newStore = new SecretsStore(testPassphrase);
      await newStore.load();

      assert.strictEqual(newStore.get(specialKey), specialValue);
    });
  });

  it('should rotate passphrase correctly', async () => {
    await withTempDir(async () => {
      const store = new SecretsStore(testPassphrase);
      store.set('key', 'value');
      await store.save();

      // Create new store with new passphrase
      const newPassphrase = 'new-passphrase-67890';
      const newStore = new SecretsStore(newPassphrase);

      // Copy all secrets to new store
      for (const [k, v] of store.store) {
        newStore.set(k, v);
      }
      await newStore.save();

      // Verify old passphrase no longer works
      const oldStore = new SecretsStore(testPassphrase);
      await assert.rejects(() => oldStore.load());

      // Verify new passphrase works
      const verifiedStore = new SecretsStore(newPassphrase);
      await verifiedStore.load();
      assert.strictEqual(verifiedStore.get('key'), 'value');
    });
  });
});

describe('resolveSecretRef', () => {
  it('should return non-ref values unchanged', () => {
    const store = new SecretsStore();
    assert.strictEqual(resolveSecretRef('plain-value', store), 'plain-value');
    assert.strictEqual(resolveSecretRef('/path/to/key', store), '/path/to/key');
  });

  it('should resolve secret:// references', () => {
    const store = new SecretsStore();
    store.set('my-key', 'my-secret-value');

    assert.strictEqual(resolveSecretRef('secret://my-key', store), 'my-secret-value');
  });

  it('should throw error for missing secret reference', () => {
    const store = new SecretsStore();

    assert.throws(
      () => resolveSecretRef('secret://missing-key', store),
      /Secret reference not found/
    );
  });
});