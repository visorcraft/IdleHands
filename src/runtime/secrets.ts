import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { configDir } from '../utils.js';

const SECRETS_FILE = 'secrets.json';
const SECRETS_VERSION = 1;

interface EncryptedSecret {
  version: number;
  ciphertext: string;
  iv: string;
  tag: string;
  salt: string;
}

export class SecretsStore {
  private readonly storePath: string;
  private passphrase: string | null = null;
  public store: Map<string, string> = new Map();

  constructor(passphrase: string | null = null) {
    this.storePath = path.join(configDir(), SECRETS_FILE);
    this.passphrase = passphrase;
  }

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(data) as EncryptedSecret;
      this.store = this._decrypt(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Failed to load secrets: ${(err as Error).message}`);
      }
      this.store = new Map();
    }
  }

  async save(): Promise<void> {
    const encrypted = this._encrypt();
    await fs.writeFile(this.storePath, JSON.stringify(encrypted, null, 2), 'utf8');
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  async verify(): Promise<boolean> {
    try {
      const data = await fs.readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(data) as EncryptedSecret;
      if (parsed.version !== SECRETS_VERSION) return false;
      if (!this.passphrase) return true;
      this._decrypt(parsed);
      return true;
    } catch {
      return false;
    }
  }

  private _encrypt(): EncryptedSecret {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = crypto.pbkdf2Sync(this.passphrase || '', salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const plaintext = JSON.stringify(Object.fromEntries(this.store));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      version: SECRETS_VERSION,
      ciphertext: encrypted.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      salt,
    };
  }

  private _decrypt(encrypted: EncryptedSecret): Map<string, string> {
    if (!this.passphrase) {
      throw new Error('Passphrase required to decrypt secrets');
    }

    // Salt is stored as hex string; pass directly to match _encrypt() behavior.
    const salt = encrypted.salt;
    const key = crypto.pbkdf2Sync(this.passphrase, salt, 100000, 32, 'sha256');
    const iv = Buffer.from(encrypted.iv, 'hex');
    const tag = Buffer.from(encrypted.tag, 'hex');
    const ciphertext = Buffer.from(encrypted.ciphertext, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return new Map(Object.entries(JSON.parse(decrypted.toString('utf8'))));
  }
}

export function resolveSecretRef(ref: string, store: SecretsStore): string {
  if (!ref.startsWith('secret://')) {
    return ref;
  }
  const key = ref.slice('secret://'.length);
  const value = store.get(key);
  if (value === undefined) {
    throw new Error(`Secret reference not found: ${ref}`);
  }
  return value;
}
