import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach } from 'node:test';

import {
  checkExecSafety,
  checkPathSafety,
  checkPathTraversal,
  isProtectedDeleteTarget,
  classifyCommand,
  setLockdown,
  setSafetyLogging,
  loadSafetyConfig,
  resetSafetyState,
  FORBIDDEN_PATTERNS,
  CAUTIOUS_PATTERNS,
} from '../dist/safety.js';

// ──────────────────────────────────────────────────────
// Forbidden commands — ALWAYS blocked
// ──────────────────────────────────────────────────────

describe('FORBIDDEN patterns', () => {
  const mustBlock = [
    // rm targeting root
    'rm -rf /',
    'rm -rf  /',
    'rm -r -f /',
    // rm targeting system dirs
    'rm -rf /boot',
    'rm -rf /etc',
    'rm -rf /usr',
    'rm -rf /lib',
    'rm -rf /sbin',
    'rm -rf /bin',
    'rm -rf /var',
    'rm -rf /sys',
    'rm -rf /proc',
    'rm -rf /dev',
    // rm targeting home
    'rm -rf ~/',
    'rm -rf $HOME',
    // Block device operations
    'dd if=/dev/zero of=/dev/sda bs=1M',
    'dd if=image.iso of=/dev/nvme0n1',
    'mkfs.ext4 /dev/sda1',
    'mkfs -t xfs /dev/sdb',
    'fdisk /dev/sda',
    'parted /dev/sda mklabel gpt',
    // Boot/kernel
    'update-grub',
    'grub-install /dev/sda',
    // Permission nuke
    'chmod 777 /',
    'chmod -R 777 /',
    'chmod a+rwx /',
    'chown -R root:root /',
    // Fork bomb
    ':(){ :|:& };:',
    // passwd/shadow overwrite
    'echo "hacked" > /etc/passwd',
    'cat bad > /etc/shadow',
    // Firewall disable
    'ufw disable',
    'iptables -F',
    // System shutdown
    'shutdown -h now',
    'reboot',
    'poweroff',
    'init 0',
    'init 6',
    // Git mirror push
    'git push --mirror origin',
  ];

  for (const cmd of mustBlock) {
    it(`blocks: ${cmd}`, () => {
      const v = checkExecSafety(cmd);
      assert.equal(v.tier, 'forbidden', `Expected forbidden for: ${cmd}`);
    });
  }
});

// ──────────────────────────────────────────────────────
// Cautious commands — need confirmation
// ──────────────────────────────────────────────────────

describe('CAUTIOUS patterns', () => {
  const mustWarn = [
    // rm with flags (but not targeting system dirs)
    'rm -rf ./build',
    'rm -f temp.txt',
    'rm -rf node_modules',
    // sudo
    'sudo apt update',
    'sudo systemctl restart nginx',
    // curl/wget to shell
    'curl -fsSL https://example.com/install.sh | bash',
    'wget -O- https://example.com/setup.sh | sh',
    // git force
    'git push --force origin main',
    'git push -f origin dev',
    'git reset --hard HEAD~3',
    'git clean -fd',
    'git clean -dfx',
    // Package management
    'apt install nginx',
    'apt-get install curl',
    'npm install -g something',
    'pip install requests',
    'dnf remove httpd',
    'pacman install vim',
    // Service management
    'systemctl restart nginx',
    'systemctl stop docker',
    'systemctl enable sshd',
    'systemctl disable firewalld',
    // Firewall changes
    'ufw allow 80/tcp',
    'ufw deny 22',
    'iptables -A INPUT -p tcp --dport 80 -j ACCEPT',
    // Docker
    'docker rm my-container',
    'docker rmi old-image',
    'docker system prune',
    // Remote operations
    'ssh user@host "ls"',
    'scp file.txt user@host:~/',
    'rsync -avz ./data/ user@host:/backup/',
  ];

  for (const cmd of mustWarn) {
    it(`warns: ${cmd}`, () => {
      const v = checkExecSafety(cmd);
      assert.equal(v.tier, 'cautious', `Expected cautious for: ${cmd}`);
      assert.ok(v.reason, 'Should have a reason');
    });
  }
});

// ──────────────────────────────────────────────────────
// Free commands — no restrictions
// ──────────────────────────────────────────────────────

describe('FREE commands', () => {
  const mustAllow = [
    'ls -la',
    'cat README.md',
    'grep -rn "TODO" src/',
    'npm test',
    'npm run build',
    'node index.js',
    'tsc --noEmit',
    'echo "hello world"',
    'pwd',
    'whoami',
    'date',
    'wc -l src/*.ts',
    'head -20 package.json',
    'tail -f /var/log/syslog',
    'git status',
    'git log --oneline -10',
    'git diff',
    'git add .',
    'git commit -m "update"',
    'git push origin main',
    'df -h',
    'free -h',
    'uptime',
    'lsblk',
    'ip addr',
  ];

  for (const cmd of mustAllow) {
    it(`allows: ${cmd}`, () => {
      const v = checkExecSafety(cmd);
      assert.equal(v.tier, 'free', `Expected free for: ${cmd}`);
    });
  }
});

// ──────────────────────────────────────────────────────
// Protected delete targets
// ──────────────────────────────────────────────────────

describe('isProtectedDeleteTarget', () => {
  it('catches rm targeting /', () => {
    assert.ok(isProtectedDeleteTarget('rm -rf /'));
  });

  it('catches rm targeting /home', () => {
    assert.ok(isProtectedDeleteTarget('rm -rf /home'));
  });

  it('catches rm targeting /home/username', () => {
    assert.ok(isProtectedDeleteTarget('rm -rf /home/user'));
  });

  it('catches rm targeting /var', () => {
    assert.ok(isProtectedDeleteTarget('rm -rf /var'));
  });

  it('does not flag rm on project dirs', () => {
    assert.ok(!isProtectedDeleteTarget('rm -rf /home/user/projects/test/build'));
  });

  it('does not flag rm without paths', () => {
    assert.ok(!isProtectedDeleteTarget('rm -f temp.txt'));
  });

  it('does not flag non-rm commands', () => {
    assert.ok(!isProtectedDeleteTarget('ls /'));
  });
});

// ──────────────────────────────────────────────────────
// Path safety (file operations)
// ──────────────────────────────────────────────────────

describe('checkPathSafety', () => {
  it('blocks writes to /boot', () => {
    const v = checkPathSafety('/boot/grub/grub.cfg');
    assert.equal(v.tier, 'forbidden');
  });

  it('blocks writes to /etc/passwd', () => {
    const v = checkPathSafety('/etc/passwd');
    assert.equal(v.tier, 'forbidden');
  });

  it('blocks writes to /etc/shadow', () => {
    const v = checkPathSafety('/etc/shadow');
    assert.equal(v.tier, 'forbidden');
  });

  it('blocks writes to /etc/sudoers', () => {
    const v = checkPathSafety('/etc/sudoers');
    assert.equal(v.tier, 'forbidden');
  });

  it('blocks writes to /etc/fstab', () => {
    const v = checkPathSafety('/etc/fstab');
    assert.equal(v.tier, 'forbidden');
  });

  it('blocks writes to /proc', () => {
    const v = checkPathSafety('/proc/sys/kernel/hostname');
    assert.equal(v.tier, 'forbidden');
  });

  it('blocks writes to /sys', () => {
    const v = checkPathSafety('/sys/class/gpio/export');
    assert.equal(v.tier, 'forbidden');
  });

  it('blocks writes to /dev', () => {
    const v = checkPathSafety('/dev/null');
    assert.equal(v.tier, 'forbidden');
  });

  it('warns on writes outside home', () => {
    const v = checkPathSafety('/opt/myapp/config.json');
    assert.equal(v.tier, 'cautious');
    assert.ok(v.reason?.includes('outside home'));
  });

  it('allows writes to /tmp', () => {
    const v = checkPathSafety('/tmp/scratch.txt');
    assert.equal(v.tier, 'free');
  });

  it('allows writes under home', () => {
    const home = process.env.HOME!;
    const v = checkPathSafety(`${home}/projects/test/foo.ts`);
    assert.equal(v.tier, 'free');
  });
});

// ──────────────────────────────────────────────────────
// Path traversal
// ──────────────────────────────────────────────────────

describe('checkPathTraversal', () => {
  it('allows paths within cwd', async () => {
    const result = await checkPathTraversal('/home/user/project/src/file.ts', '/home/user/project');
    assert.equal(result, null);
  });

  it('allows paths within home even if outside cwd', async () => {
    const home = process.env.HOME!;
    const result = await checkPathTraversal(`${home}/other-project/file.ts`, `${home}/project`);
    assert.equal(result, null);
  });

  it('flags paths outside cwd and home', async () => {
    const result = await checkPathTraversal('/opt/secret/file.txt', '/home/user/project');
    assert.ok(result !== null);
    assert.ok(result.includes('outside working directory'));
  });

  it('allows paths in allowedDirs', async () => {
    const result = await checkPathTraversal('/opt/allowed/file.txt', '/home/user/project', [
      '/opt/allowed',
    ]);
    assert.equal(result, null);
  });
});

// ──────────────────────────────────────────────────────
// classifyCommand (testing/debug helper)
// ──────────────────────────────────────────────────────

describe('classifyCommand', () => {
  it('finds both forbidden and cautious matches', () => {
    // "sudo rm -rf /" hits both forbidden (rm -rf /) and cautious (sudo, rm -rf)
    const c = classifyCommand('sudo rm -rf /');
    assert.ok(c.forbidden.length > 0, 'Should have forbidden matches');
    assert.ok(c.cautious.length > 0, 'Should have cautious matches');
  });

  it('returns empty for safe commands', () => {
    const c = classifyCommand('ls -la');
    assert.equal(c.forbidden.length, 0);
    assert.equal(c.cautious.length, 0);
  });
});

// ──────────────────────────────────────────────────────
// Edge cases and bypass attempts
// ──────────────────────────────────────────────────────

describe('bypass attempts', () => {
  it('catches rm -rf / with extra spaces', () => {
    const v = checkExecSafety('rm  -rf   /');
    // checkExecSafety normalizes whitespace
    assert.equal(v.tier, 'forbidden');
  });

  it('catches rm with combined flags targeting system dir', () => {
    const v = checkExecSafety('rm -rfv /usr');
    assert.equal(v.tier, 'forbidden');
  });

  it('catches dd with spaces around =', () => {
    const v = checkExecSafety('dd if=/dev/zero of = /dev/sda');
    // The pattern uses \bof\s*=\s*\/dev\/ which handles spaces
    assert.equal(v.tier, 'forbidden');
  });

  it('flags rm -rf on project dir as cautious (not forbidden)', () => {
    const v = checkExecSafety('rm -rf /home/user/projects/test/node_modules');
    assert.equal(v.tier, 'cautious');
  });

  it('does not block normal git push', () => {
    const v = checkExecSafety('git push origin main');
    assert.equal(v.tier, 'free');
  });

  it('catches git push --force even with branch', () => {
    const v = checkExecSafety('git push --force origin feature-branch');
    assert.equal(v.tier, 'cautious');
  });
});

// ──────────────────────────────────────────────────────
// Pattern coverage (ensure all patterns are exercised)
// ──────────────────────────────────────────────────────

describe('pattern coverage', () => {
  it(`has ${FORBIDDEN_PATTERNS.length} forbidden patterns`, () => {
    assert.ok(FORBIDDEN_PATTERNS.length >= 15, 'Should have comprehensive forbidden patterns');
  });

  it(`has ${CAUTIOUS_PATTERNS.length} cautious patterns`, () => {
    assert.ok(CAUTIOUS_PATTERNS.length >= 15, 'Should have comprehensive cautious patterns');
  });

  it('every forbidden pattern has a reason', () => {
    for (const p of FORBIDDEN_PATTERNS) {
      assert.ok(p.reason, `Pattern ${p.re.source} missing reason`);
    }
  });

  it('every cautious pattern has a reason', () => {
    for (const p of CAUTIOUS_PATTERNS) {
      assert.ok(p.reason, `Pattern ${p.re.source} missing reason`);
    }
  });
});

// ──────────────────────────────────────────────────────
// Lockdown mode
// ──────────────────────────────────────────────────────

describe('lockdown mode', () => {
  beforeEach(() => resetSafetyState());

  it('promotes cautious exec commands to forbidden', () => {
    setLockdown(true);
    const v = checkExecSafety('sudo apt update');
    assert.equal(v.tier, 'forbidden');
    assert.ok(v.reason?.includes('lockdown'));
  });

  it('promotes cautious rm -rf to forbidden', () => {
    setLockdown(true);
    const v = checkExecSafety('rm -rf ./build');
    assert.equal(v.tier, 'forbidden');
  });

  it('promotes cautious git force push to forbidden', () => {
    setLockdown(true);
    const v = checkExecSafety('git push --force origin main');
    assert.equal(v.tier, 'forbidden');
  });

  it('does not affect free commands', () => {
    setLockdown(true);
    const v = checkExecSafety('ls -la');
    assert.equal(v.tier, 'free');
  });

  it('does not affect already-forbidden commands', () => {
    setLockdown(true);
    const v = checkExecSafety('rm -rf /');
    assert.equal(v.tier, 'forbidden');
  });

  it('promotes cautious path writes to forbidden', () => {
    setLockdown(true);
    const v = checkPathSafety('/opt/myapp/config.json');
    assert.equal(v.tier, 'forbidden');
    assert.ok(v.reason?.includes('lockdown'));
  });

  it('does not affect home directory writes in lockdown', () => {
    setLockdown(true);
    const home = process.env.HOME!;
    const v = checkPathSafety(`${home}/projects/test/foo.ts`);
    assert.equal(v.tier, 'free');
  });
});

// ──────────────────────────────────────────────────────
// User safety config (safety.json)
// ──────────────────────────────────────────────────────

describe('safety config loading', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetSafetyState();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'safety-test-'));
  });

  it('loads user forbidden patterns from file', async () => {
    const cfgPath = path.join(tmpDir, 'safety.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        forbidden_patterns: ['\\bmy-dangerous-cmd\\b'],
      })
    );
    await loadSafetyConfig(cfgPath);

    const v = checkExecSafety('my-dangerous-cmd --flag');
    assert.equal(v.tier, 'forbidden');
    assert.ok(v.reason?.includes('user forbidden'));
  });

  it('loads user cautious patterns from file', async () => {
    const cfgPath = path.join(tmpDir, 'safety.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        cautious_patterns: ['\\bmy-risky-cmd\\b'],
      })
    );
    await loadSafetyConfig(cfgPath);

    const v = checkExecSafety('my-risky-cmd --flag');
    assert.equal(v.tier, 'cautious');
    assert.ok(v.reason?.includes('user cautious'));
  });

  it('loads allow patterns that bypass cautious', async () => {
    const cfgPath = path.join(tmpDir, 'safety.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        allow_patterns: ['^npm install\\b'],
      })
    );
    await loadSafetyConfig(cfgPath);

    // npm install is normally cautious
    const v = checkExecSafety('npm install lodash');
    assert.equal(v.tier, 'free');
  });

  it('allow patterns do not bypass forbidden', async () => {
    const cfgPath = path.join(tmpDir, 'safety.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        allow_patterns: ['rm -rf /'],
      })
    );
    await loadSafetyConfig(cfgPath);

    const v = checkExecSafety('rm -rf /');
    assert.equal(v.tier, 'forbidden');
  });

  it('loads user protected paths', async () => {
    const cfgPath = path.join(tmpDir, 'safety.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        protected_paths: ['/my/secret/dir'],
      })
    );
    await loadSafetyConfig(cfgPath);

    const v = checkPathSafety('/my/secret/dir/file.txt');
    assert.equal(v.tier, 'forbidden');
    assert.ok(v.reason?.includes('user-protected'));
  });

  it('loads user protected delete roots', async () => {
    const cfgPath = path.join(tmpDir, 'safety.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        protected_delete_roots: ['/data'],
      })
    );
    await loadSafetyConfig(cfgPath);

    assert.ok(isProtectedDeleteTarget('rm -rf /data'));
  });

  it('handles missing config file gracefully', async () => {
    const cfgPath = path.join(tmpDir, 'nonexistent.json');
    const result = await loadSafetyConfig(cfgPath);
    assert.deepEqual(result, {});

    // Should still work with defaults
    const v = checkExecSafety('rm -rf /');
    assert.equal(v.tier, 'forbidden');
  });

  it('handles invalid JSON gracefully', async () => {
    const cfgPath = path.join(tmpDir, 'safety.json');
    await fs.writeFile(cfgPath, '{not valid json!!!}');
    const result = await loadSafetyConfig(cfgPath);
    assert.deepEqual(result, {});
  });

  it('skips invalid regex patterns with warning', async () => {
    const cfgPath = path.join(tmpDir, 'safety.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        forbidden_patterns: ['[invalid regex', '\\bvalid\\b'],
      })
    );
    await loadSafetyConfig(cfgPath);

    // Valid pattern still works
    const v = checkExecSafety('valid command');
    assert.equal(v.tier, 'forbidden');
  });

  it('resetSafetyState clears all overrides', async () => {
    const cfgPath = path.join(tmpDir, 'safety.json');
    await fs.writeFile(
      cfgPath,
      JSON.stringify({
        forbidden_patterns: ['\\bmy-cmd\\b'],
      })
    );
    await loadSafetyConfig(cfgPath);
    setLockdown(true);

    // Before reset
    assert.equal(checkExecSafety('my-cmd').tier, 'forbidden');
    assert.equal(checkExecSafety('sudo ls').tier, 'forbidden'); // lockdown

    resetSafetyState();

    // After reset — user pattern gone, lockdown off
    assert.equal(checkExecSafety('my-cmd').tier, 'free');
    assert.equal(checkExecSafety('sudo ls').tier, 'cautious');
  });
});
