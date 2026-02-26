/**
 * Surface-agnostic command logic shared by Telegram and Discord bots.
 *
 * This file now primarily defines shared types and re-exports concrete
 * command handlers from focused modules.
 */

import type { AgentPersona } from '../types.js';

export {
  approvalSetCommand,
  approvalShowCommand,
  dirSetFail,
  dirSetOk,
  dirShowCommand,
  modeSetCommand,
  modeShowCommand,
  modeStatusCommand,
  routingModeSetCommand,
  routingModeShowCommand,
  routingModeStatusCommand,
  pinFail,
  pinOk,
  subagentsSetCommand,
  subagentsShowCommand,
  unpinFail,
  unpinNotPinned,
  unpinOk,
} from './session-settings.js';
export { changesCommand, undoCommand, vaultCommand } from './session-history.js';
export {
  agentCommand,
  agentsCommand,
  deescalateCommand,
  escalateSetCommand,
  escalateShowCommand,
} from './escalation-commands.js';
export { gitStatusCommand } from './git-status-command.js';
export {
  compactCommand,
  helpCommand,
  modelCommand,
  startCommand,
  statusCommand,
  versionCommand,
  watchdogCommand,
} from './basic-commands.js';
export { captureSetCommand, captureShowCommand } from './capture-commands.js';
export { rollbackCommand, checkpointsCommand } from './rollback-command.js';
export { budgetCommand } from './budget-command.js';
export { diffCommand } from './diff-command.js';
export { costCommand } from './cost-command.js';
export {
  antonCommand,
  antonHelpCommand,
  antonLastCommand,
  antonStartCommand,
  antonStatusCommand,
  antonStopCommand,
} from './anton-commands.js';

// ── Structured result types ─────────────────────────────────────────

/** A key-value pair: [label, value, isCode?] */
export type KV = [label: string, value: string, code?: boolean];

/**
 * Structured command result. Formatters turn this into HTML or Markdown.
 */
export interface CmdResult {
  title?: string;
  lines?: string[];
  kv?: KV[];
  error?: string;
  success?: string;
  preformatted?: string;
}

// ── Minimal interfaces for decoupled access ─────────────────────────

export interface SessionLike {
  model: string;
  harness: string;
  currentContextTokens: number;
  contextWindow: number;
  usage: { prompt: number; completion: number };
  replay?: { list(n: number): Promise<{ filePath: string }[]> };
  vault?: { search(q: string, n: number): Promise<any[]> };
  lens?: any;
  lastEditedPath?: string;
  lastTurnDebug?: {
    requestedMode: string;
    selectedMode: string;
    selectedModeSource: string;
    classificationHint: string | null;
    provider: string;
    model: string;
    runtimeRoute: boolean;
    compactPrelude: boolean;
    fastLaneToolless: boolean;
    fastLaneSlimTools?: boolean;
    promptBytes?: number;
    toolSchemaBytes?: number;
    toolSchemaTokens?: number;
    toolCount?: number;
  };
  captureOn?: (filePath?: string) => Promise<string>;
  captureOff?: () => void;
  captureLast?: (filePath?: string) => Promise<string>;
  captureSetRedact?: (enabled: boolean) => void;
  captureGetRedact?: () => boolean;
  captureOpen?: () => string | null;
  capturePath?: string;
  rollback?: () => { preview: string; removedMessages: number } | null;
  listCheckpoints?: () => Array<{ messageCount: number; createdAt: number; preview: string }>;
  reset(): void;
}

export interface ManagedLike {
  session: SessionLike;
  config: any;
  workingDir: string;
  dirPinned: boolean;
  repoCandidates: string[];
  state: string;
  pendingQueue: any[];
  inFlight: boolean;
  agentPersona?: AgentPersona | null;
  agentId: string;
  antonActive: boolean;
  antonAbortSignal: { aborted: boolean } | null;
  antonProgress: any;
  antonLastResult: any;
  antonLastLoopEvent?: {
    kind: 'auto-recovered' | 'final-failure' | 'other';
    taskText: string;
    message: string;
    at: number;
  } | null;
  lastActivity: number;
  lastProgressAt: number;
  pendingEscalation?: string | null;
  pendingEscalationEndpoint?: string | null;
  currentModelIndex: number;
  escalationCount?: number;
  allowedDirs: string[];
  approvalMode?: string;
  watchdogCompactAttempts?: number;
}

export interface VersionInfo {
  version?: string;
  model?: string;
  endpoint?: string;
}

export interface AgentsConfig {
  agents?: Record<string, AgentPersona>;
  routing?: {
    default?: string;
    users?: Record<string, string>;
    chats?: Record<string, string>;
    channels?: Record<string, string>;
    guilds?: Record<string, string>;
  };
}

export interface StartInfo extends VersionInfo {
  defaultDir?: string;
  agentName?: string;
}
