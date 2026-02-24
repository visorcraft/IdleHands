import type { LensStore } from './lens.js';
import type { ReplayStore } from './replay.js';
import { sys_context as sysContextTool } from './sys/context.js';
import { execTool } from './tools/exec-core.js';
import { listDirTool, searchFilesTool } from './tools/file-discovery.js';
import {
  editFileTool,
  editRangeTool,
  insertFileTool,
  writeFileTool,
} from './tools/file-mutations.js';
import { readFileTool, readFilesTool } from './tools/file-read.js';
import { applyPatchTool } from './tools/patch-apply.js';
import { vaultNoteTool, vaultSearchTool } from './tools/vault-tools.js';
import type { ToolStreamEvent, ApprovalMode } from './types.js';
import type { VaultStore } from './vault.js';

// Re-export from extracted modules so existing imports don't break
export { atomicWrite, undo_path } from './tools/undo.js';
export { snapshotBeforeEdit } from './tools/sys-notes.js';

// Backup/undo system imported from tools/undo.ts (atomicWrite, backupFile, undo_path)

export type ToolContext = {
  cwd: string;
  noConfirm: boolean;
  dryRun: boolean;
  mode?: 'code' | 'sys';
  approvalMode?: ApprovalMode;
  allowedWriteRoots?: string[];
  requireDirPinForMutations?: boolean;
  dirPinned?: boolean;
  repoCandidates?: string[];
  backupDir?: string; // defaults to ~/.local/state/idlehands/backups
  maxExecBytes?: number; // max bytes returned per stream (after processing)
  maxExecCaptureBytes?: number; // max bytes buffered per stream before processing (to prevent OOM)
  maxBackupsPerFile?: number; // FIFO retention (defaults to 5)
  confirm?: (
    prompt: string,
    ctx?: { tool?: string; args?: Record<string, unknown>; diff?: string }
  ) => Promise<boolean>; // interactive confirmation hook
  replay?: ReplayStore;
  vault?: VaultStore;
  lens?: LensStore;
  signal?: AbortSignal; // propagated to exec child processes
  lastEditedPath?: string; // most recently touched file for undo fallback
  onMutation?: (absPath: string) => void; // optional hook for tracking last edited file

  /** Cap for read_file limit (Anton sessions). */
  maxReadLines?: number;

  /** Assigned per tool-call by the agent. */
  toolCallId?: string;
  toolName?: string;

  /** Optional streaming hook for long-running tool output. */
  onToolStream?: (ev: ToolStreamEvent) => void | Promise<void>;

  /** Optional throttling knobs for tool-stream output. */
  toolStreamIntervalMs?: number;
  toolStreamMaxChunkChars?: number;
  toolStreamMaxBufferChars?: number;
};

export async function read_file(ctx: ToolContext, args: any) {
  return readFileTool(ctx, args);
}

export async function read_files(ctx: ToolContext, args: any) {
  return readFilesTool(ctx, args);
}

export async function write_file(ctx: ToolContext, args: any) {
  return writeFileTool(ctx, args);
}

export async function insert_file(ctx: ToolContext, args: any) {
  return insertFileTool(ctx, args);
}

export async function edit_file(ctx: ToolContext, args: any) {
  return editFileTool(ctx, args);
}

export async function edit_range(ctx: ToolContext, args: any) {
  return editRangeTool(ctx, args);
}

export async function apply_patch(ctx: ToolContext, args: any) {
  return applyPatchTool(ctx, args);
}

export async function list_dir(ctx: ToolContext, args: any) {
  return listDirTool(ctx, args);
}
export async function search_files(ctx: ToolContext, args: any) {
  return searchFilesTool(ctx, args, exec);
}

export async function exec(ctx: ToolContext, args: any) {
  return execTool(ctx, args);
}

export async function vault_note(ctx: ToolContext, args: any) {
  return vaultNoteTool(ctx, args);
}

export async function vault_search(ctx: ToolContext, args: any) {
  return vaultSearchTool(ctx, args);
}

/** Phase 9: sys_context tool (mode-gated in agent schema). */
export async function sys_context(ctx: ToolContext, args: any) {
  return sysContextTool(ctx, args);
}

// Path safety helpers imported from tools/path-safety.ts:
// isWithinDir, resolvePath, redactPath, checkCwdWarning, enforceMutationWithinCwd
