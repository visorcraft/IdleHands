/**
 * ConversationBranch — Lightweight conversation checkpointing and rollback.
 *
 * Snapshots the messages array at each user turn boundary, allowing
 * `/rollback` to restore the conversation to a previous state.
 */

export type Checkpoint = {
  /** Index into the messages array (exclusive end — messages[0..index) form the snapshot). */
  messageCount: number;
  /** Timestamp when the checkpoint was created. */
  createdAt: number;
  /** First ~100 chars of the user instruction that triggered this turn. */
  preview: string;
};

export class ConversationBranch {
  private checkpoints: Checkpoint[] = [];
  private readonly maxCheckpoints: number;

  constructor(maxCheckpoints = 20) {
    this.maxCheckpoints = maxCheckpoints;
  }

  /**
   * Save a checkpoint before a new user turn starts.
   * Call this at the beginning of `ask()`, before the user message is appended.
   */
  checkpoint(messageCount: number, instructionPreview: string): void {
    this.checkpoints.push({
      messageCount,
      createdAt: Date.now(),
      preview: instructionPreview.slice(0, 100),
    });

    // Keep bounded
    if (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints.shift();
    }
  }

  /**
   * Pop the most recent checkpoint and return the target message count.
   * Returns null if no checkpoints exist.
   */
  rollback(): Checkpoint | null {
    return this.checkpoints.pop() ?? null;
  }

  /**
   * List available checkpoints (most recent first).
   */
  list(): Checkpoint[] {
    return [...this.checkpoints].reverse();
  }

  /** Number of available rollback points. */
  get depth(): number {
    return this.checkpoints.length;
  }

  /** Clear all checkpoints (e.g. on session reset). */
  reset(): void {
    this.checkpoints = [];
  }
}
