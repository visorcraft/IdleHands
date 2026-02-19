import fs from 'node:fs/promises';
import path from 'node:path';

// Intentionally noisy build to stress exec output capture/truncation.
// Writes a sentinel output file on success.

const outDir = path.join(process.cwd(), 'build');
await fs.mkdir(outDir, { recursive: true });

// ~200KB to stdout
process.stdout.write('x'.repeat(200_000) + '\n');
process.stdout.write('BUILD_DONE\n');

await fs.writeFile(path.join(outDir, 'output.txt'), 'ok', 'utf8');
