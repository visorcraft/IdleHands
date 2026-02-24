import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Bench harness tests — validates:
 *   1. Runner produces valid JSONL with expected BenchResult fields
 *   2. Compare protocol works (runs both engines sequentially)
 *
 * Uses a mock OpenAI server so no real LLM is needed.
 */

function mkSse(chunks: any[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function createMockServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = req.url || '';

    if (req.method === 'GET' && url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-bench-model' }] }));
      return;
    }

    if (req.method === 'POST' && url === '/v1/chat/completions') {
      // Consume body
      await new Promise<void>((resolve) => {
        req.resume();
        req.on('end', resolve);
      });

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      const sse = mkSse([
        {
          id: 'mock-bench-1',
          choices: [
            {
              index: 0,
              delta: { content: 'OK' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        },
      ]);
      res.end(sse);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });
}

async function startServer(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('bench harness', () => {
  it('runner produces valid JSONL with expected BenchResult fields', async () => {
    const server = createMockServer();
    const port = await startServer(server);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-bench-test-'));

    // Write a minimal bench case
    const benchCase = {
      name: 'bench_test_smoke',
      engine: 'idlehands',
      workspace: { kind: 'temp', prefix: 'bench-test-' },
      instruction: 'Respond with exactly: OK',
      success: { type: 'equals', value: 'OK' },
      repetitions: 2,
      max_tokens: 64,
      model: 'mock-bench-model',
    };
    const casePath = path.join(tmpDir, 'case.json');
    await fs.writeFile(casePath, JSON.stringify(benchCase), 'utf8');

    // Ensure bench/results dir exists
    const resultsDir = path.join(process.cwd(), 'bench', 'results');
    await fs.mkdir(resultsDir, { recursive: true });
    const beforeFiles = new Set(await fs.readdir(resultsDir));

    try {
      // Run the bench runner via node
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve, _reject) => {
          execFile(
            process.execPath,
            ['./dist/bench/runner.js', casePath],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                IDLEHANDS_ENDPOINT: `http://127.0.0.1:${port}/v1`,
                IDLEHANDS_MODEL: 'mock-bench-model',
              },
              timeout: 30_000,
            },
            (err, stdout, stderr) => {
              resolve({
                code: err && 'code' in err ? (err as any).code : 0,
                stdout: stdout ?? '',
                stderr: stderr ?? '',
              });
            }
          );
        }
      );

      assert.equal(result.code, 0, `runner exited non-zero: ${result.stderr}`);
      assert.ok(result.stdout.includes('Wrote:'), 'runner should print output path');

      // Find the new JSONL file
      const afterFiles = await fs.readdir(resultsDir);
      const newFiles = afterFiles.filter(
        (f) => !beforeFiles.has(f) && f.startsWith('bench_test_smoke')
      );
      assert.ok(newFiles.length >= 1, 'should produce at least one JSONL file');

      const jsonlPath = path.join(resultsDir, newFiles[0]);
      const raw = await fs.readFile(jsonlPath, 'utf8');
      const lines = raw.trim().split('\n');
      assert.equal(lines.length, 2, 'should have 2 result lines (repetitions=2)');

      for (const line of lines) {
        const row = JSON.parse(line);
        // Validate BenchResult schema
        assert.equal(typeof row.case, 'string');
        assert.equal(row.case, 'bench_test_smoke');
        assert.equal(row.engine, 'idlehands');
        assert.equal(typeof row.iter, 'number');
        assert.equal(typeof row.ok, 'boolean');
        assert.equal(row.ok, true, `expected ok=true, got reason=${row.reason}`);
        assert.equal(typeof row.reason, 'string');
        assert.equal(typeof row.ttc_ms, 'number');
        assert.ok(row.ttc_ms > 0, 'ttc_ms should be positive');
        // init_ms, ttfr_ms, ttft_ms can be null or number
        assert.ok(row.init_ms === null || typeof row.init_ms === 'number');
      }

      // Cleanup test JSONL
      await fs.rm(jsonlPath, { force: true });
    } finally {
      await stopServer(server);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('compare protocol runs idlehands engine and produces valid compare JSONL', async () => {
    const server = createMockServer();
    const port = await startServer(server);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idlehands-bench-cmp-'));

    // Compare case — idlehands only (skip openclaw to avoid external deps in test)
    const benchCase = {
      name: 'bench_test_compare',
      engine: 'idlehands',
      workspace: { kind: 'temp', prefix: 'bench-cmp-' },
      instruction: 'Respond with exactly: OK',
      success: { type: 'equals', value: 'OK' },
      repetitions: 1,
      max_tokens: 64,
      model: 'mock-bench-model',
    };
    const casePath = path.join(tmpDir, 'case.json');
    await fs.writeFile(casePath, JSON.stringify(benchCase), 'utf8');

    const resultsDir = path.join(process.cwd(), 'bench', 'results');
    const beforeFiles = new Set(await fs.readdir(resultsDir));

    try {
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve, _reject) => {
          execFile(
            process.execPath,
            ['./dist/bench/compare.js', casePath],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                IDLEHANDS_ENDPOINT: `http://127.0.0.1:${port}/v1`,
                IDLEHANDS_MODEL: 'mock-bench-model',
              },
              timeout: 30_000,
            },
            (err, stdout, stderr) => {
              resolve({
                code: err && 'code' in err ? (err as any).code : 0,
                stdout: stdout ?? '',
                stderr: stderr ?? '',
              });
            }
          );
        }
      );

      assert.equal(result.code, 0, `compare exited non-zero: ${result.stderr}`);
      assert.ok(result.stdout.includes('Wrote:'), 'compare should print output path');

      // Find the new compare JSONL
      const afterFiles = await fs.readdir(resultsDir);
      const newFiles = afterFiles.filter((f) => !beforeFiles.has(f) && f.includes('compare'));
      assert.ok(newFiles.length >= 1, 'should produce a compare JSONL file');

      const jsonlPath = path.join(resultsDir, newFiles[0]);
      const raw = await fs.readFile(jsonlPath, 'utf8');
      const lines = raw.trim().split('\n');
      assert.ok(lines.length >= 1);

      for (const line of lines) {
        const row = JSON.parse(line);
        assert.equal(row.case, 'bench_test_compare');
        assert.equal(row.engine, 'idlehands');
        assert.equal(row.ok, true);
        assert.equal(typeof row.ttc_ms, 'number');
      }

      await fs.rm(jsonlPath, { force: true });
    } finally {
      await stopServer(server);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
