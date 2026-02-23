import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';

import { SecretsStore } from '../../runtime/secrets.js';
import { configDir } from '../../utils.js';

const SECRETS_FILE = 'secrets.json';

function secretsFilePath(): string {
  return `${configDir()}/${SECRETS_FILE}`;
}

function isTTY(): boolean {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

async function askPassphrase(prompt: string, confirm = false): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${prompt}: `);
    rl.close();
    return answer;
  } catch {
    rl.close();
    throw new Error('Operation cancelled');
  }
}

async function askSecretValue(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${prompt}: `);
    rl.close();
    return answer;
  } catch {
    rl.close();
    throw new Error('Operation cancelled');
  }
}

export async function runSecretsInit(passphrase?: string): Promise<void> {
  const storePath = secretsFilePath();
  
  // Check if secrets file already exists
  try {
    const fs = await import('node:fs/promises');
    await fs.access(storePath);
    console.log(`Secrets store already exists at: ${storePath}`);
    console.log('Use "idlehands secrets unlock" to access it.');
    return;
  } catch {
    // File doesn't exist, proceed with initialization
  }

  let secretPassphrase = passphrase;
  if (!secretPassphrase) {
    if (!isTTY()) {
      throw new Error('Passphrase required in non-TTY mode. Use --passphrase flag.');
    }
    secretPassphrase = await askPassphrase('Enter new passphrase for secrets store');
    const confirm = await askPassphrase('Confirm passphrase');
    if (secretPassphrase !== confirm) {
      throw new Error('Passphrases do not match');
    }
  }

  const store = new SecretsStore(secretPassphrase);
  await store.save();
  console.log(`Secrets store initialized at: ${storePath}`);
  console.log('Store passphrase is required to access stored secrets.');
  console.log('Set IDLEHANDS_SECRETS_PASSPHRASE environment variable or use "idlehands secrets unlock".');
}

export async function runSecretsUnlock(passphrase?: string): Promise<void> {
  const store = new SecretsStore(passphrase ?? process.env.IDLEHANDS_SECRETS_PASSPHRASE ?? null);
  
  try {
    await store.load();
    console.log('Secrets store unlocked successfully.');
    console.log(`Store path: ${secretsFilePath()}`);
    console.log(`Secrets count: ${store.store.size}`);
    
    // Store passphrase in environment for subsequent commands
    if (passphrase) {
      process.env.IDLEHANDS_SECRETS_PASSPHRASE = passphrase;
    }
  } catch (err) {
    if ((err as Error).message.includes('Passphrase required')) {
      throw new Error('Passphrase required. Set IDLEHANDS_SECRETS_PASSPHRASE or provide via --passphrase.');
    }
    throw new Error(`Failed to unlock secrets: ${(err as Error).message}`);
  }
}

export async function runSecretsLock(): Promise<void> {
  if (process.env.IDLEHANDS_SECRETS_PASSPHRASE) {
    delete process.env.IDLEHANDS_SECRETS_PASSPHRASE;
    console.log('Secrets store locked (passphrase removed from environment).');
  } else {
    console.log('Secrets store was not unlocked.');
  }
}

export async function runSecretsSet(id: string, value?: string): Promise<void> {
  const passphrase = process.env.IDLEHANDS_SECRETS_PASSPHRASE;
  if (!passphrase) {
    throw new Error('Secrets store must be unlocked first. Use "idlehands secrets unlock".');
  }

  const store = new SecretsStore(passphrase);
  await store.load();

  if (!value) {
    if (!isTTY()) {
      throw new Error('Secret value required in non-TTY mode. Provide as argument or use TTY mode.');
    }
    value = await askSecretValue(`Enter secret value for "${id}" (will be hidden)`);
  }

  store.set(id, value);
  await store.save();
  console.log(`Secret "${id}" stored successfully.`);
}

export async function runSecretsGet(id: string): Promise<void> {
  const passphrase = process.env.IDLEHANDS_SECRETS_PASSPHRASE;
  if (!passphrase) {
    throw new Error('Secrets store must be unlocked first. Use "idlehands secrets unlock".');
  }

  const store = new SecretsStore(passphrase);
  await store.load();

  const value = store.get(id);
  if (value === undefined) {
    throw new Error(`Secret not found: ${id}`);
  }

  // Output the secret value (for programmatic use)
  console.log(value);
}

export async function runSecretsDelete(id: string): Promise<void> {
  const passphrase = process.env.IDLEHANDS_SECRETS_PASSPHRASE;
  if (!passphrase) {
    throw new Error('Secrets store must be unlocked first. Use "idlehands secrets unlock".');
  }

  const store = new SecretsStore(passphrase);
  await store.load();

  if (!store.has(id)) {
    throw new Error(`Secret not found: ${id}`);
  }

  store.delete(id);
  await store.save();
  console.log(`Secret "${id}" deleted successfully.`);
}

export async function runSecretsList(): Promise<void> {
  const passphrase = process.env.IDLEHANDS_SECRETS_PASSPHRASE;
  if (!passphrase) {
    throw new Error('Secrets store must be unlocked first. Use "idlehands secrets unlock".');
  }

  const store = new SecretsStore(passphrase);
  await store.load();

  const ids = [...store.store.keys()];
  if (ids.length === 0) {
    console.log('No secrets stored.');
    return;
  }

  if (process.stdout.isTTY) {
    console.table(ids.map((id) => ({ id })));
  } else {
    console.log(JSON.stringify(ids, null, 2));
  }
}

export async function runSecretsVerify(): Promise<void> {
  const passphrase = process.env.IDLEHANDS_SECRETS_PASSPHRASE;
  if (!passphrase) {
    throw new Error('Secrets store must be unlocked first. Use "idlehands secrets unlock".');
  }

  const store = new SecretsStore(passphrase);
  const isValid = await store.verify();
  
  if (isValid) {
    console.log('Secrets store integrity verified.');
  } else {
    throw new Error('Secrets store verification failed. May be corrupted or tampered.');
  }
}

export async function runSecretsRotatePassphrase(oldPassphrase?: string, newPassphrase?: string): Promise<void> {
  const currentPassphrase = oldPassphrase ?? process.env.IDLEHANDS_SECRETS_PASSPHRASE;
  if (!currentPassphrase) {
    throw new Error('Current passphrase required. Set IDLEHANDS_SECRETS_PASSPHRASE or provide via --passphrase.');
  }

  const store = new SecretsStore(currentPassphrase);
  await store.load();

  let finalNewPassphrase = newPassphrase;
  if (!finalNewPassphrase) {
    if (!isTTY()) {
      throw new Error('New passphrase required in non-TTY mode. Provide via --new-passphrase flag.');
    }
    finalNewPassphrase = await askPassphrase('Enter new passphrase');
    const confirm = await askPassphrase('Confirm new passphrase');
    if (finalNewPassphrase !== confirm) {
      throw new Error('New passphrases do not match');
    }
  }

  // Create new store with new passphrase and copy all secrets
  const newStore = new SecretsStore(finalNewPassphrase);
  for (const [key, value] of store.store) {
    newStore.set(key, value);
  }
  await newStore.save();
  
  console.log('Passphrase rotated successfully.');
  console.log('Note: Old passphrase is no longer valid. Update IDLEHANDS_SECRETS_PASSPHRASE if needed.');
}

export const secretsCommands = [
  {
    name: '/secrets',
    description: 'Manage encrypted secrets store',
    async execute(_ctx: any, args: string, line: string) {
      const parts = line.trim().split(/\s+/);
      const cmd = parts[1]?.toLowerCase();

      switch (cmd) {
        case 'init': {
          const passphrase = args.match(/--passphrase\s+["']?([^"'\s]+)["']?/)?.[1];
          await runSecretsInit(passphrase);
          break;
        }
        case 'unlock': {
          const passphrase = args.match(/--passphrase\s+["']?([^"'\s]+)["']?/)?.[1];
          await runSecretsUnlock(passphrase);
          break;
        }
        case 'lock':
          await runSecretsLock();
          break;
        case 'set': {
          const match = args.match(/^["']?([^"'\s]+)["']?\s+(.+)?$/);
          if (!match) {
            console.log('Usage: /secrets set <id> [value]');
            return true;
          }
          const id = match[1];
          const value = match[2];
          await runSecretsSet(id, value);
          break;
        }
        case 'get': {
          const id = args.trim();
          if (!id) {
            console.log('Usage: /secrets get <id>');
            return true;
          }
          await runSecretsGet(id);
          break;
        }
        case 'delete': {
          const id = args.trim();
          if (!id) {
            console.log('Usage: /secrets delete <id>');
            return true;
          }
          await runSecretsDelete(id);
          break;
        }
        case 'list':
          await runSecretsList();
          break;
        case 'verify':
          await runSecretsVerify();
          break;
        case 'rotate-passphrase': {
          const oldPassphrase = args.match(/--passphrase\s+["']?([^"'\s]+)["']?/)?.[1];
          const newPassphrase = args.match(/--new-passphrase\s+["']?([^"'\s]+)["']?/)?.[1];
          await runSecretsRotatePassphrase(oldPassphrase, newPassphrase);
          break;
        }
        default:
          console.log(`Usage:
  /secrets init [--passphrase <passphrase>]     Initialize secrets store
  /secrets unlock [--passphrase <passphrase>]   Unlock secrets store
  /secrets lock                                 Lock secrets store
  /secrets set <id> [value]                     Store a secret
  /secrets get <id>                             Retrieve a secret
  /secrets delete <id>                          Delete a secret
  /secrets list                                 List all secret IDs
  /secrets verify                               Verify store integrity
  /secrets rotate-passphrase                    Change encryption passphrase
`);
          break;
      }
      return true;
    },
  },
];