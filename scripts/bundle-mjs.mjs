#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const entry = path.join(repoRoot, 'src', 'index.ts');
const outFile = path.join(repoRoot, 'idlehands.mjs');

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node24'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  banner: {
    js: '#!/usr/bin/env node',
  },
  // Keep optional/native deps external where bundling can be brittle.
  external: [
    'node-pty',
    'tree-sitter-wasms',
    'web-tree-sitter',
  ],
});

await fs.chmod(outFile, 0o755).catch(() => {});
console.log(`Wrote ${outFile}`);
