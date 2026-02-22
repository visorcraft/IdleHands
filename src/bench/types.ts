export type BenchSuccess =
  | { type: 'equals'; value: string }
  | {
      type: 'exec';
      command: string;
      exitCode?: number;
      stdoutEquals?: string;
      stdoutIncludes?: string;
    };

export type BenchWorkspace = { kind: 'fixed'; dir: string } | { kind: 'temp'; prefix?: string };

export type BenchEngine = 'idlehands' | 'openclaw';

export type BenchCase = {
  name: string;
  engine?: BenchEngine | 'both'; // default idlehands
  workspace: BenchWorkspace;
  setup?: string[];
  instruction: string;
  success?: BenchSuccess;
  repetitions?: number;
  max_tokens?: number;
  model?: string; // optional explicit model id to avoid /v1/models probe cost
  reuse_session?: boolean; // if true, create one session and run ask() N times
};

export type BenchResult = {
  case: string;
  engine: BenchEngine;
  iter: number;
  ok: boolean;
  reason: string;
  init_ms: number; // session init time (model pick + warmup)
  ttfr_ms: number | null; // time to first response delta (content or tool_call)
  ttft_ms: number | null; // time to first content token
  ttc_ms: number; // time to completion for the main ask()
  exitCode: number | null;
  turns?: number;
  toolCalls?: number;
};
