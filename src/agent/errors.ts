/** Errors that should break the outer agent loop, not be caught by per-tool handlers. */
export class AgentLoopBreak extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentLoopBreak';
  }
}
