import readline from 'node:readline/promises';
import type { FSWatcher } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { makeStyler } from '../term.js';
import type { UserContent, TurnEndEvent } from '../types.js';
import type { StatusBar, ServerHealthSnapshot, PerfTurnSample } from './status.js';
import type { AntonRunResult, AntonProgress } from '../anton/types.js';

export interface ReplContext {
  session: any;
  config: any;
  rl: readline.Interface;
  S: ReturnType<typeof makeStyler>;
  version: string;

  shellMode: boolean;
  activeShellProc: ChildProcessWithoutNullStreams | null;
  statusBarEnabled: boolean;
  statusBar: StatusBar;
  lastStatusLine: string;
  lastAutoCommitOfferStat: string;
  sessionStartedMs: number;
  changesBaselineMs: number;
  lastRunnableInput: UserContent;
  perfSamples: PerfTurnSample[];
  healthUnsupported: boolean;
  lastHealthWarning: string;
  lastHealthSnapshot: ServerHealthSnapshot | null;
  lastHealthSnapshotAt: number;
  pendingTemplate: string | null;
  customCommands: Map<string, any>;
  vimState: any;
  enabled: boolean;

  watchPaths: string[];
  watchMaxIterationsPerTrigger: number;
  watchActive: boolean;
  watchWatchers: FSWatcher[];
  watchDebounceTimer: NodeJS.Timeout | null;
  watchPendingChanges: Set<string>;
  watchRunInFlight: boolean;
  watchRunQueued: boolean;

  indexRunning: boolean;
  indexStartedAt: number;
  indexProgress: { scanned: number; indexed: number; skipped: number; current?: string };
  indexLastResult: any;
  indexLastError: string;

  antonActive: boolean;
  antonAbortSignal: { aborted: boolean } | null;
  antonLastResult: AntonRunResult | null;
  antonProgress: AntonProgress | null;

  shutdown(code: number): Promise<void>;
  readServerHealth(force?: boolean): Promise<ServerHealthSnapshot | null>;
  maybePrintTurnMetrics(stats: TurnEndEvent): Promise<void>;
  maybeOfferAutoCommit(taskHint: string): Promise<void>;
  saveCurrentSession(): Promise<void>;
  startWatchMode(paths: string[], maxIter: number): Promise<void>;
  stopWatchMode(announce?: boolean): void;
  runWatchPrompt(changeSummary: string): Promise<void>;
  startIndexInBackground(): Promise<void>;
  printIndexStats(): Promise<void>;
  clearIndex(): Promise<void>;
  confirm: (prompt: string) => Promise<boolean>;
}
