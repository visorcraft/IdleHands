import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { shellEscape } from '../utils.js';
import { SecretsStore, resolveSecretRef } from './secrets.js';

import type { RuntimeHost } from './types.js';

export interface HostCommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export class HostCommandRunner {
  private readonly secretsPassphrase: string | null;

  constructor(secretsPassphrase?: string | null) {
    this.secretsPassphrase = secretsPassphrase ?? process.env.IDLEHANDS_SECRETS_PASSPHRASE ?? null;
  }

  /**
   * Run a command locally (no SSH)
   */
  runLocal(command: string, timeoutSec = 5): HostCommandResult {
    const p = spawnSync('bash', ['-c', command], {
      encoding: 'utf8',
      timeout: timeoutSec * 1000,
    });
    return {
      ok: p.status === 0,
      code: p.status,
      stdout: p.stdout ?? '',
      stderr: p.stderr ?? '',
    };
  }

  /**
   * Run a command on a remote host via SSH
   * Uses spawn with arg arrays (not string concatenation) for safety
   */
  async runOnHost(host: RuntimeHost, command: string, timeoutSec = 5): Promise<HostCommandResult> {
    if (host.transport === 'local') {
      return this.runLocal(command, timeoutSec);
    }

    // Resolve secret references for key_path at use-time
    let resolvedKeyPath: string | undefined;
    if (host.connection.key_path) {
      const store = new SecretsStore(this.secretsPassphrase);
      try {
        await store.load();
        resolvedKeyPath = resolveSecretRef(host.connection.key_path, store);
      } catch {
        resolvedKeyPath = host.connection.key_path;
      }
    }

    const target = `${host.connection.user ? `${host.connection.user}@` : ''}${host.connection.host ?? ''}`;
    const sshArgs: string[] = [
      '-o',
      'BatchMode=yes',
      '-o',
      `ConnectTimeout=${Math.max(1, Math.ceil(timeoutSec))}`,
    ];
    if (resolvedKeyPath) sshArgs.push('-i', resolvedKeyPath);
    if (host.connection.port && host.connection.port !== 22) {
      sshArgs.push('-p', String(host.connection.port));
    }
    // Use login-shell behavior for parity with manual SSH sessions
    sshArgs.push(target, 'bash', '-lc', shellEscape(command));

    const p = spawnSync('ssh', sshArgs, {
      encoding: 'utf8',
      timeout: (timeoutSec + 1) * 1000,
    });

    return {
      ok: p.status === 0,
      code: p.status,
      stdout: p.stdout ?? '',
      stderr: p.stderr ?? '',
    };
  }

  /**
   * Run a command on a remote host with sudo
   * Uses sudo -S to read password from stdin (never command line)
   */
  async runSudoOnHost(host: RuntimeHost, command: string, timeoutSec = 5): Promise<HostCommandResult> {
    if (host.transport === 'local') {
      // For local, use sudo -S
      const sudoCmd = `echo "$SUDO_PASSWORD" | sudo -S ${shellEscape(command)}`;
      return this.runLocal(sudoCmd, timeoutSec);
    }

    // For SSH, we need to run sudo on the remote host
    // First resolve any secret references for password
    let passwordRef = host.connection.password;
    if (passwordRef && passwordRef.startsWith('secret://')) {
      const store = new SecretsStore(this.secretsPassphrase);
      try {
        await store.load();
        passwordRef = resolveSecretRef(passwordRef, store);
      } catch {
        // Keep original ref if resolution fails
      }
    }

    // Create a script that handles sudo password input
    const sudoScript = `#!/bin/bash
if [ -n "$SUDO_PASSWORD" ]; then
  echo "$SUDO_PASSWORD" | sudo -S ${shellEscape(command)}
else
  sudo ${shellEscape(command)}
fi
`;
    return this.runOnHost(host, sudoScript, timeoutSec);
  }
}