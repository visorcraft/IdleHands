/**
 * Watch mode argument parsing and change summarization.
 */

type WatchConfig = {
  paths: string[];
  maxIterationsPerTrigger: number;
};

export function parseWatchArgs(raw: string): WatchConfig {
  const tokens = raw.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  const paths: string[] = [];
  let maxIterationsPerTrigger = 3;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--max' || t === '--max-iterations') {
      const n = Number(tokens[i + 1]);
      if (Number.isFinite(n) && n > 0) {
        maxIterationsPerTrigger = Math.floor(n);
        i++;
        continue;
      }
      throw new Error('Invalid /watch --max value. Expected a positive integer.');
    }
    paths.push(t);
  }

  return { paths, maxIterationsPerTrigger };
}

export function summarizeWatchChange(changed: Set<string>): string {
  const files = [...changed].filter(Boolean);
  if (!files.length) return 'changes detected';
  if (files.length === 1) return `${files[0]} modified`;
  if (files.length === 2) return `${files[0]}, ${files[1]} modified`;
  return `${files[0]}, ${files[1]} (+${files.length - 2} more) modified`;
}
