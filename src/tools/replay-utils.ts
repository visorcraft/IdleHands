import type { LensStore } from '../lens.js';
import type { ReplayStore } from '../replay.js';

export type ReplayCheckpointContext = {
  replay?: ReplayStore;
  lens?: LensStore;
};

/**
 * Best-effort replay checkpoint with optional Lens-generated diff note.
 * Returns empty string on success, or a short replay_skipped suffix on failure.
 */
export async function checkpointReplay(
  ctx: ReplayCheckpointContext,
  payload: Parameters<ReplayStore['checkpoint']>[0]
): Promise<string> {
  if (!ctx.replay) return '';

  let note: string | undefined;
  if (ctx.lens && payload.before && payload.after) {
    try {
      note = await ctx.lens.summarizeDiffToText(
        payload.before.toString('utf8'),
        payload.after.toString('utf8'),
        payload.filePath
      );
    } catch {
      // ignore and fallback to raw checkpoint
    }
  }

  try {
    await ctx.replay.checkpoint({ ...payload, note });
    return '';
  } catch (e: any) {
    return ` replay_skipped: ${e?.message ?? String(e)}`;
  }
}
