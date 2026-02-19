import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { loadCustomCommands, expandArgs } from '../dist/commands.js';

describe('custom commands', () => {
  let tmpHome: string;
  let projectDir: string;
  let prevHome: string | undefined;

  before(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-cmd-home-'));
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-cmd-project-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  after(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;

    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
  });

  it('loads global command metadata and supports positional args expansion', async () => {
    const globalDir = path.join(tmpHome, '.config', 'idlehands', 'commands');
    await fs.mkdir(globalDir, { recursive: true });

    await fs.writeFile(
      path.join(globalDir, 'deploy.md'),
      [
        '---',
        'name: deploy',
        'description: Deploy current build',
        'args:',
        '  - environment',
        '  - region',
        '---',
        'Run `npm run build` then deploy to $1 in $2.',
        'All args: $*',
      ].join('\n'),
      'utf8'
    );

    const commands = await loadCustomCommands(projectDir);
    const cmd = commands.get('/deploy');

    assert.ok(cmd, 'expected /deploy command to load');
    assert.equal(cmd?.name, 'deploy');
    assert.equal(cmd?.description, 'Deploy current build');
    assert.deepEqual(cmd?.args, ['environment', 'region']);
    assert.equal(cmd?.source, 'global');

    const expanded = expandArgs(cmd!.template, ['staging', 'us-central']);
    assert.ok(expanded.includes('deploy to staging in us-central'));
    assert.ok(expanded.includes('All args: staging us-central'));
  });

  it('project command overrides global command by key', async () => {
    const globalDir = path.join(tmpHome, '.config', 'idlehands', 'commands');
    const projectCmdDir = path.join(projectDir, '.idlehands', 'commands');
    await fs.mkdir(globalDir, { recursive: true });
    await fs.mkdir(projectCmdDir, { recursive: true });

    await fs.writeFile(
      path.join(globalDir, 'review.md'),
      ['---', 'description: global', '---', 'global review template'].join('\n'),
      'utf8'
    );

    await fs.writeFile(
      path.join(projectCmdDir, 'review.md'),
      ['---', 'description: project', '---', 'project review template'].join('\n'),
      'utf8'
    );

    const commands = await loadCustomCommands(projectDir);
    const cmd = commands.get('/review');
    assert.ok(cmd);
    assert.equal(cmd?.source, 'project');
    assert.ok(cmd?.template.includes('project review template'));
  });

  it('parses inline args lists and normalizes key from frontmatter name', async () => {
    const globalDir = path.join(tmpHome, '.config', 'idlehands', 'commands');
    await fs.mkdir(globalDir, { recursive: true });

    await fs.writeFile(
      path.join(globalDir, 'release.md'),
      [
        '---',
        'name: Release Candidate',
        'description: prep release',
        'args: [target, tag]',
        '---',
        'Cut release for $1 with tag $2 and optional $3.',
      ].join('\n'),
      'utf8'
    );

    const commands = await loadCustomCommands(projectDir);
    const cmd = commands.get('/release-candidate');

    assert.ok(cmd, 'expected key normalized from frontmatter name');
    assert.deepEqual(cmd?.args, ['target', 'tag']);

    const expanded = expandArgs(cmd!.template, ['production', 'v1.2.3']);
    assert.ok(expanded.includes('production'));
    assert.ok(expanded.includes('v1.2.3'));
    assert.ok(!expanded.includes('$3'), 'unbound placeholders should be removed');
  });
});
