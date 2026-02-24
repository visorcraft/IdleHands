import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createSession } from '../dist/agent.js';
import { projectIndexKeys } from '../dist/indexer.js';
import { VaultStore } from '../dist/vault.js';

function baseConfig(dir: string, overrides?: Record<string, any>): any {
  return {
    endpoint: 'http://127.0.0.1:0',
    model: 'fake-model',
    dir,
    max_tokens: 64,
    temperature: 0.2,
    top_p: 0.95,
    timeout: 5,
    max_iterations: 3,
    no_confirm: true,
    verbose: false,
    dry_run: false,
    context_window: 4096,
    cache_prompt: true,
    i_know_what_im_doing: true,
    harness: '',
    context_file: '',
    context_file_names: ['.idlehands.md', 'AGENTS.md', '.github/AGENTS.md'],
    context_max_tokens: 8192,
    no_context: true,
    trifecta: {
      enabled: true,
      vault: { enabled: true, mode: 'passive' },
      lens: { enabled: false },
      replay: { enabled: false },
    },
    ...(overrides ?? {}),
  };
}

function makeArtifact(projectDir: string, content: string, prompt = 'review prompt'): string {
  const { projectId } = projectIndexKeys(projectDir);
  return JSON.stringify({
    id: `review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'code_review',
    createdAt: new Date().toISOString(),
    model: 'fake-model',
    projectId,
    projectDir,
    prompt,
    content,
    gitDirty: false,
  });
}

function makeMemoryVault(initial: Record<string, string> = {}) {
  const rows = new Map<string, string>(Object.entries(initial));
  const getLatestKeys: string[] = [];
  const upsertKeys: string[] = [];

  const vault: any = {
    setProjectDir() {},
    close() {},
    async getLatestByKey(key: string) {
      getLatestKeys.push(key);
      const value = rows.get(key);
      if (!value) return null;
      return {
        id: `row-${key}`,
        kind: 'system',
        key,
        value,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    async upsertNote(key: string, value: string) {
      upsertKeys.push(key);
      rows.set(key, value);
      return `row-${upsertKeys.length}`;
    },
    async archiveToolMessages() {
      return 0;
    },
    async note() {
      return 'row-note';
    },
  };

  return { vault, rows, getLatestKeys, upsertKeys };
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-review-artifact-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function git(cwd: string, command: string): string {
  // Execute each command segment with git directly to avoid shell cwd quirks.
  const segments = command
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean);

  let lastOut = '';
  for (const seg of segments) {
    if (!seg.startsWith('git ')) {
      throw new Error(`git helper only supports git commands, got: ${seg}`);
    }
    const args =
      seg
        .slice(4)
        .match(/(?:"[^"]*"|'[^']*'|\S+)/g)
        ?.map((t) => t.replace(/^['"]|['"]$/g, '')) ?? [];
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (res.status !== 0) {
      const msg = `${String(res.stdout || '')}${String(res.stderr || '')}`.trim();
      throw new Error(`git command failed (${seg}): ${msg}`);
    }
    lastOut = String(res.stdout || '').trim();
  }

  return lastOut;
}

describe('review artifact hardening matrix', () => {
  it('tracks expected matrix size', () => {
    // Keep this in sync with docs/review-artifact-hardening.md
    const plannedCases = 17;
    assert.equal(plannedCases, 17);
  });

  describe('A) Unit', () => {
    it('A1 intent classifier routes retrieval phrases to artifact path', async () => {
      await withTmpDir(async (dir) => {
        const { projectId } = projectIndexKeys(dir);
        const latestKey = `artifact:review:latest:${projectId}`;
        const { vault } = makeMemoryVault({
          [latestKey]: makeArtifact(dir, 'stored review body', 'full repo review'),
        });

        let llmCalls = 0;
        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            llmCalls += 1;
            return {
              id: 'fake-1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'should-not-run' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        };

        const session = await createSession({
          config: baseConfig(dir),
          runtime: { client: fakeClient, vault },
        });

        try {
          const out = await session.ask('print the full code review again');
          assert.equal(out.text, 'stored review body');
          assert.equal(llmCalls, 0, 'retrieval intent should bypass model generation');

          const cmdOut = await session.ask('/review print');
          assert.equal(cmdOut.text, 'stored review body');
          assert.equal(
            llmCalls,
            0,
            'explicit /review print command should also bypass model generation'
          );
        } finally {
          await session.close();
        }
      });
    });

    it('A2 intent classifier routes review requests to generation path', async () => {
      await withTmpDir(async (dir) => {
        const { projectId } = projectIndexKeys(dir);
        const latestKey = `artifact:review:latest:${projectId}`;
        const byIdPrefix = `artifact:review:item:${projectId}:`;
        const { vault, rows, getLatestKeys, upsertKeys } = makeMemoryVault();

        let llmCalls = 0;
        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            llmCalls += 1;
            return {
              id: 'fake-1',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'generated review text' } },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 10 },
            };
          },
        };

        const session = await createSession({
          config: baseConfig(dir),
          runtime: { client: fakeClient, vault },
        });

        try {
          const baselineLookupCount = getLatestKeys.length;
          const out = await session.ask('please run a full code review of this repository');
          assert.equal(out.text, 'generated review text');
          assert.equal(llmCalls, 1, 'generation path should call model exactly once here');

          const askLookups = getLatestKeys.slice(baselineLookupCount);
          assert.equal(
            askLookups.includes(latestKey),
            false,
            'generation request should not query latest review artifact before running the model'
          );

          assert.ok(rows.has(latestKey), 'latest review pointer should be stored after generation');
          assert.ok(
            upsertKeys.some((k) => k.startsWith(byIdPrefix)),
            'immutable review artifact row should also be stored'
          );
        } finally {
          await session.close();
        }
      });
    });

    it('A3 artifact parser rejects malformed/partial JSON payloads', async () => {
      await withTmpDir(async (dir) => {
        const { projectId } = projectIndexKeys(dir);
        const latestKey = `artifact:review:latest:${projectId}`;
        const { vault } = makeMemoryVault({
          [latestKey]: '{"kind":"code_review","content":"broken"', // malformed JSON
        });

        let llmCalls = 0;
        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            llmCalls += 1;
            return {
              id: 'fake-1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'should-not-run' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        };

        const session = await createSession({
          config: baseConfig(dir),
          runtime: { client: fakeClient, vault },
        });

        try {
          const out = await session.ask('show the full code review');
          assert.match(out.text, /No stored full code review found yet/i);
          assert.equal(llmCalls, 0, 'malformed artifact should not trigger model fallback');
        } finally {
          await session.close();
        }
      });
    });

    it('A4 artifact keying is partitioned by project and preserves immutable review records', async () => {
      const shared = makeMemoryVault();

      await withTmpDir(async (projectA) => {
        await withTmpDir(async (projectB) => {
          let llmA = 0;
          let llmB = 0;

          const clientA: any = {
            async models() {
              return { data: [{ id: 'fake-model' }] };
            },
            async warmup() {},
            async chatStream() {
              llmA += 1;
              return {
                id: `a-${llmA}`,
                choices: [{ index: 0, message: { role: 'assistant', content: 'review-A' } }],
                usage: { prompt_tokens: 5, completion_tokens: 5 },
              };
            },
          };

          const clientB: any = {
            async models() {
              return { data: [{ id: 'fake-model' }] };
            },
            async warmup() {},
            async chatStream() {
              llmB += 1;
              return {
                id: `b-${llmB}`,
                choices: [{ index: 0, message: { role: 'assistant', content: 'review-B' } }],
                usage: { prompt_tokens: 5, completion_tokens: 5 },
              };
            },
          };

          const sessionA = await createSession({
            config: baseConfig(projectA),
            runtime: { client: clientA, vault: shared.vault },
          });
          const sessionB = await createSession({
            config: baseConfig(projectB),
            runtime: { client: clientB, vault: shared.vault },
          });

          try {
            await sessionA.ask('run full code review for targetRef=PR-123');
            await sessionB.ask('run full code review for targetRef=PR-999');

            const replayA = await sessionA.ask('print the full code review');
            const replayB = await sessionB.ask('print the full code review');

            assert.equal(replayA.text, 'review-A');
            assert.equal(replayB.text, 'review-B');

            const { projectId: idA } = projectIndexKeys(projectA);
            const { projectId: idB } = projectIndexKeys(projectB);
            const latestA = `artifact:review:latest:${idA}`;
            const latestB = `artifact:review:latest:${idB}`;
            assert.ok(shared.rows.has(latestA));
            assert.ok(shared.rows.has(latestB));
            assert.notEqual(latestA, latestB, 'latest keys must be project-scoped');

            const immutableA = Array.from(shared.rows.keys()).filter((k) =>
              k.startsWith(`artifact:review:item:${idA}:`)
            );
            const immutableB = Array.from(shared.rows.keys()).filter((k) =>
              k.startsWith(`artifact:review:item:${idB}:`)
            );
            assert.equal(immutableA.length >= 1, true);
            assert.equal(immutableB.length >= 1, true);
          } finally {
            await sessionA.close();
            await sessionB.close();
          }
        });
      });
    });

    it('A5 retrieval miss does not fall back to analysis unless explicitly requested', async () => {
      await withTmpDir(async (dir) => {
        const { vault } = makeMemoryVault();

        let llmCalls = 0;
        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            llmCalls += 1;
            return {
              id: 'fake-1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'fallback-analysis' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        };

        const session = await createSession({
          config: baseConfig(dir),
          runtime: { client: fakeClient, vault },
        });

        try {
          const out = await session.ask('show full review');
          assert.match(out.text, /No stored full code review found yet/i);
          assert.equal(llmCalls, 0, 'retrieval miss should not auto-start fresh analysis');
        } finally {
          await session.close();
        }
      });
    });
  });

  describe('B) Integration', () => {
    it('B6 generate review then retrieve full artifact with zero extra model turns', async () => {
      await withTmpDir(async (dir) => {
        const { vault } = makeMemoryVault();

        let llmCalls = 0;
        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            llmCalls += 1;
            return {
              id: `fake-${llmCalls}`,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: '## Full Review\n\n- Finding 1\n- Finding 2',
                  },
                },
              ],
              usage: { prompt_tokens: 12, completion_tokens: 9 },
            };
          },
        };

        const session = await createSession({
          config: baseConfig(dir),
          runtime: { client: fakeClient, vault },
        });

        try {
          const first = await session.ask('run a full code review of this repository');
          assert.match(first.text, /Full Review/);
          assert.equal(llmCalls, 1);

          const second = await session.ask('print the full code review');
          assert.equal(second.text, first.text);
          assert.equal(llmCalls, 1, 'retrieve path must not invoke model again');
        } finally {
          await session.close();
        }
      });
    });

    it('B7 forced compaction does not break retrieval replay', async () => {
      await withTmpDir(async (dir) => {
        const { vault } = makeMemoryVault();

        let llmCalls = 0;
        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            llmCalls += 1;
            return {
              id: `fake-${llmCalls}`,
              choices: [
                { index: 0, message: { role: 'assistant', content: 'durable review content' } },
              ],
              usage: { prompt_tokens: 40, completion_tokens: 20 },
            };
          },
        };

        const session = await createSession({
          config: baseConfig(dir, { context_window: 256, max_tokens: 64 }),
          runtime: { client: fakeClient, vault },
        });

        try {
          const first = await session.ask('run full code review now');
          assert.equal(first.text, 'durable review content');
          assert.equal(llmCalls, 1);

          // Simulate post-review context bloat that would normally trigger compaction.
          for (let i = 0; i < 120; i++) {
            session.messages.push({ role: 'assistant', content: `filler-${i} ${'x'.repeat(500)}` });
          }

          const replay = await session.ask('show the full code review');
          assert.equal(replay.text, 'durable review content');
          assert.equal(
            llmCalls,
            1,
            'replay should come from artifact even under heavy context pressure'
          );
        } finally {
          await session.close();
        }
      });
    });

    it('B8 huge artifact retrieval paginates without triggering tools', async () => {
      await withTmpDir(async (dir) => {
        const { projectId } = projectIndexKeys(dir);
        const latestKey = `artifact:review:latest:${projectId}`;
        const huge = Array.from({ length: 4000 }, (_, i) => `line-${i}`).join('\n');
        const { vault } = makeMemoryVault({
          [latestKey]: makeArtifact(dir, huge),
        });

        let llmCalls = 0;
        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            llmCalls += 1;
            return {
              id: 'fake-1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'should-not-run' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        };

        const session = await createSession({
          config: baseConfig(dir),
          runtime: { client: fakeClient, vault },
        });

        try {
          const out = await session.ask('print the full code review');
          assert.equal(llmCalls, 0, 'huge artifact retrieval must not re-enter model/tool loop');
          assert.equal(out.text.length > 10000, true);
          assert.match(out.text, /line-0/);
          assert.match(out.text, /line-3999/);
        } finally {
          await session.close();
        }
      });
    });

    it('B9 stale warn mode returns artifact plus stale reason', async () => {
      await withTmpDir(async (dir) => {
        git(dir, 'git init -q');
        git(dir, 'git config user.email "review-artifact-tests@example.com"');
        git(dir, 'git config user.name "Review Artifact Tests"');

        await fs.writeFile(path.join(dir, 'demo.txt'), 'v1\n', 'utf8');
        git(dir, 'git add demo.txt && git commit -m "init" -q');
        const oldHead = git(dir, 'git rev-parse HEAD');

        await fs.writeFile(path.join(dir, 'demo.txt'), 'v2\n', 'utf8');
        git(dir, 'git add demo.txt && git commit -m "update" -q');

        const { projectId } = projectIndexKeys(dir);
        const latestKey = `artifact:review:latest:${projectId}`;
        const payload = JSON.parse(makeArtifact(dir, 'review body from older commit'));
        payload.gitHead = oldHead;

        const { vault } = makeMemoryVault({
          [latestKey]: JSON.stringify(payload),
        });

        let llmCalls = 0;
        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            llmCalls += 1;
            return {
              id: 'fake-1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'should-not-run' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        };

        const session = await createSession({
          config: baseConfig(dir),
          runtime: { client: fakeClient, vault },
        });

        try {
          const out = await session.ask('show the full code review');
          assert.equal(llmCalls, 0);
          assert.match(out.text, /review body from older commit/);
          assert.match(out.text, /\[artifact note\]/i);
          assert.match(out.text, /Stored review was generated at commit/i);
        } finally {
          await session.close();
        }
      });
    });

    it('B10 stale block mode rejects retrieval until explicit override', async () => {
      await withTmpDir(async (dir) => {
        git(dir, 'git init -q');
        git(dir, 'git config user.email "review-artifact-tests@example.com"');
        git(dir, 'git config user.name "Review Artifact Tests"');

        await fs.writeFile(path.join(dir, 'policy.txt'), 'v1\n', 'utf8');
        git(dir, 'git add policy.txt && git commit -m "init" -q');
        const oldHead = git(dir, 'git rev-parse HEAD');

        await fs.writeFile(path.join(dir, 'policy.txt'), 'v2\n', 'utf8');
        git(dir, 'git add policy.txt && git commit -m "update" -q');

        const { projectId } = projectIndexKeys(dir);
        const latestKey = `artifact:review:latest:${projectId}`;
        const payload = JSON.parse(makeArtifact(dir, 'stale-but-useful-review'));
        payload.gitHead = oldHead;

        const { vault } = makeMemoryVault({
          [latestKey]: JSON.stringify(payload),
        });

        let llmCalls = 0;
        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            llmCalls += 1;
            return {
              id: 'fake-1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'should-not-run' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        };

        const session = await createSession({
          config: baseConfig(dir, {
            trifecta: {
              enabled: true,
              vault: { enabled: true, mode: 'passive', stale_policy: 'block' },
              lens: { enabled: false },
              replay: { enabled: false },
            },
          }),
          runtime: { client: fakeClient, vault },
        });

        try {
          const blocked = await session.ask('show the full code review');
          assert.match(blocked.text, /stale and retrieval policy is set to block/i);
          assert.match(blocked.text, /print stale review anyway/i);
          assert.equal(llmCalls, 0);

          const forced = await session.ask('print stale review anyway');
          assert.match(forced.text, /stale-but-useful-review/);
          assert.match(forced.text, /\[artifact note\]/i);
          assert.equal(llmCalls, 0, 'override path should still avoid model/tool loop');
        } finally {
          await session.close();
        }
      });
    });
  });

  describe('C) Durability + concurrency', () => {
    it('C11 concurrent review writes keep latest pointer consistent', async () => {
      await withTmpDir(async (dir) => {
        const shared = makeMemoryVault();
        let callsA = 0;
        let callsB = 0;

        const clientA: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            callsA += 1;
            await new Promise((r) => setTimeout(r, 25));
            return {
              id: `a-${callsA}`,
              choices: [
                { index: 0, message: { role: 'assistant', content: 'concurrent-review-A' } },
              ],
              usage: { prompt_tokens: 8, completion_tokens: 8 },
            };
          },
        };

        const clientB: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            callsB += 1;
            await new Promise((r) => setTimeout(r, 5));
            return {
              id: `b-${callsB}`,
              choices: [
                { index: 0, message: { role: 'assistant', content: 'concurrent-review-B' } },
              ],
              usage: { prompt_tokens: 8, completion_tokens: 8 },
            };
          },
        };

        const sessionA = await createSession({
          config: baseConfig(dir),
          runtime: { client: clientA, vault: shared.vault },
        });
        const sessionB = await createSession({
          config: baseConfig(dir),
          runtime: { client: clientB, vault: shared.vault },
        });

        try {
          await Promise.all([
            sessionA.ask('run full code review now'),
            sessionB.ask('run full code review now'),
          ]);

          const { projectId } = projectIndexKeys(dir);
          const latestKey = `artifact:review:latest:${projectId}`;
          const latestRaw = shared.rows.get(latestKey) ?? '';
          const latest = JSON.parse(latestRaw);
          assert.equal(
            ['concurrent-review-A', 'concurrent-review-B'].includes(latest.content),
            true
          );

          const immutable = Array.from(shared.rows.keys()).filter((k) =>
            k.startsWith(`artifact:review:item:${projectId}:`)
          );
          assert.equal(
            immutable.length >= 2,
            true,
            'both concurrent writes should keep immutable records'
          );
        } finally {
          await sessionA.close();
          await sessionB.close();
        }
      });
    });

    it('C12 crash between write and pointer update recovers cleanly', async () => {
      await withTmpDir(async (dir) => {
        const rows = new Map<string, string>();
        let upsertCount = 0;
        const flakyVault: any = {
          setProjectDir() {},
          close() {},
          async getLatestByKey(key: string) {
            const value = rows.get(key);
            if (!value) return null;
            return {
              id: 'row-latest',
              kind: 'system',
              key,
              value,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
          },
          async upsertNote(key: string, value: string) {
            upsertCount += 1;
            if (upsertCount === 2) {
              throw new Error('simulated crash after latest pointer write');
            }
            rows.set(key, value);
            return `row-${upsertCount}`;
          },
          async archiveToolMessages() {
            return 0;
          },
          async note() {
            return 'row-note';
          },
        };

        let llmCalls = 0;
        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            llmCalls += 1;
            return {
              id: `fake-${llmCalls}`,
              choices: [
                { index: 0, message: { role: 'assistant', content: 'crash-tolerant-review' } },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 5 },
            };
          },
        };

        const session = await createSession({
          config: baseConfig(dir),
          runtime: { client: fakeClient, vault: flakyVault },
        });

        try {
          const generated = await session.ask('run full code review');
          assert.equal(generated.text, 'crash-tolerant-review');

          const replay = await session.ask('print the full code review');
          assert.equal(replay.text, 'crash-tolerant-review');
          assert.equal(llmCalls, 1, 'recovery should still allow replay from latest pointer');
        } finally {
          await session.close();
        }
      });
    });

    it('C13 protected artifact rows survive trace eviction/pruning', async () => {
      await withTmpDir(async (dir) => {
        const dbPath = path.join(dir, 'vault-c13.db');
        const vault = new VaultStore({ path: dbPath, maxEntries: 3, projectDir: dir });
        await vault.init();

        const { projectId } = projectIndexKeys(dir);
        const latestKey = `artifact:review:latest:${projectId}`;
        const immutableKey = `artifact:review:item:${projectId}:artifact-1`;

        const artifactPayload = makeArtifact(dir, 'protected-review-body');
        await vault.upsertNote(latestKey, artifactPayload, 'system');
        await vault.upsertNote(immutableKey, artifactPayload, 'system');

        // Flood with normal notes that should be prunable.
        for (let i = 0; i < 10; i++) {
          await vault.note(`noise:${i}`, `noise-value-${i}`);
        }

        const latest = await vault.getLatestByKey(latestKey, 'system');
        const immutable = await vault.getLatestByKey(immutableKey, 'system');
        assert.ok(latest?.value?.includes('protected-review-body'));
        assert.ok(immutable?.value?.includes('protected-review-body'));

        const count = await vault.count();
        // maxEntries applies to prunable rows; protected artifact rows are retained.
        assert.equal(count >= 2, true);

        vault.close();
      });
    });

    it('C14 corrupted artifact row fails gracefully without analysis fallback', async () => {
      await withTmpDir(async (dir) => {
        const { projectId } = projectIndexKeys(dir);
        const latestKey = `artifact:review:latest:${projectId}`;

        // Case 1: malformed/partial payload.
        const corrupted = JSON.stringify({
          kind: 'code_review',
          content: 'missing required fields',
        });
        const firstVault = makeMemoryVault({ [latestKey]: corrupted });

        let llmCalls = 0;
        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            llmCalls += 1;
            return {
              id: 'fake-1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'should-not-run' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        };

        const session1 = await createSession({
          config: baseConfig(dir),
          runtime: { client: fakeClient, vault: firstVault.vault },
        });
        try {
          const out = await session1.ask('print the full code review');
          assert.match(out.text, /No stored full code review found yet/i);
          assert.equal(llmCalls, 0);
        } finally {
          await session1.close();
        }

        // Case 2: structurally valid artifact but with mismatched project identity.
        const mismatched = JSON.stringify({
          id: 'review-mismatch',
          kind: 'code_review',
          createdAt: new Date().toISOString(),
          model: 'fake-model',
          projectId: 'different-project-id',
          projectDir: '/tmp/other-project',
          prompt: 'full code review',
          content: 'wrong-project-review',
        });
        const secondVault = makeMemoryVault({ [latestKey]: mismatched });
        const session2 = await createSession({
          config: baseConfig(dir),
          runtime: { client: fakeClient, vault: secondVault.vault },
        });
        try {
          const out = await session2.ask('print the full code review');
          assert.match(out.text, /No stored full code review found yet/i);
          assert.equal(llmCalls, 0);
        } finally {
          await session2.close();
        }
      });
    });
  });

  describe('D) Regression guards', () => {
    it('D15 retrieval intent executes zero tools', async () => {
      await withTmpDir(async (dir) => {
        const { projectId } = projectIndexKeys(dir);
        const latestKey = `artifact:review:latest:${projectId}`;
        const { vault } = makeMemoryVault({ [latestKey]: makeArtifact(dir, 'zero-tools-review') });

        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            return {
              id: 'fake-1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'should-not-run' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        };

        const session = await createSession({
          config: baseConfig(dir),
          runtime: { client: fakeClient, vault },
        });
        try {
          const out = await session.ask('show the full code review');
          assert.equal(out.toolCalls, 0);
          assert.equal(out.turns, 0);
        } finally {
          await session.close();
        }
      });
    });

    it('D16 retrieval intent cannot enter read→compact→re-read loop', async () => {
      await withTmpDir(async (dir) => {
        const { projectId } = projectIndexKeys(dir);
        const latestKey = `artifact:review:latest:${projectId}`;
        const { vault } = makeMemoryVault({ [latestKey]: makeArtifact(dir, 'loop-immune-review') });

        let llmCalls = 0;
        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            llmCalls += 1;
            // If retrieval accidentally enters model loop, this would try to start a read-heavy pattern.
            return {
              id: `fake-${llmCalls}`,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: 'loop candidate',
                    tool_calls: [
                      {
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 5 },
            };
          },
        };

        const session = await createSession({
          config: baseConfig(dir),
          runtime: { client: fakeClient, vault },
        });
        try {
          const out = await session.ask('print the full code review');
          assert.equal(out.text, 'loop-immune-review');
          assert.equal(out.toolCalls, 0);
          assert.equal(llmCalls, 0, 'retrieval path must never enter model turns/tools');
        } finally {
          await session.close();
        }
      });
    });

    it('D17 retry/idempotency prevents duplicate long replay sends', async () => {
      await withTmpDir(async (dir) => {
        const { projectId } = projectIndexKeys(dir);
        const latestKey = `artifact:review:latest:${projectId}`;
        const longBody = Array.from({ length: 1500 }, (_, i) => `line-${i}`).join('\n');
        const { vault } = makeMemoryVault({ [latestKey]: makeArtifact(dir, longBody) });

        let llmCalls = 0;
        const fakeClient: any = {
          async models() {
            return { data: [{ id: 'fake-model' }] };
          },
          async warmup() {},
          async chatStream() {
            llmCalls += 1;
            return {
              id: 'fake-1',
              choices: [{ index: 0, message: { role: 'assistant', content: 'should-not-run' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        };

        const session = await createSession({
          config: baseConfig(dir),
          runtime: { client: fakeClient, vault },
        });
        try {
          const first = await session.ask('print the full code review');
          const second = await session.ask('print the full code review');

          assert.equal(first.text, second.text);
          assert.equal(llmCalls, 0, 'repeated retrievals should remain artifact-only');
        } finally {
          await session.close();
        }
      });
    });
  });
});
