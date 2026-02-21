/**
 * Structured tool error taxonomy for reliable, machine-actionable failure handling.
 * Replaces flat string error messages with structured codes and metadata.
 */

export type ToolErrorCode =
  | 'invalid_args'      // Wrong types, missing params, unknown keys
  | 'not_found'        // File/directory doesn't exist
  | 'conflict'         // File already exists, edit conflict, etc.
  | 'blocked'          // Safety policy blocked the operation
  | 'permission'       // Permission denied (filesystem, network, etc.)
  | 'timeout'          // Operation timed out
  | 'transient'        // Network error, temporary failure - retryable
  | 'internal'         // Unexpected error in tool implementation
  | 'validation';      // Schema validation failed

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly retryable: boolean = false,
    public readonly hint?: string,
    public readonly details?: Record<string, any>
  ) {
    super(message);
    this.name = 'ToolError';
  }

  /**
   * Format as a concise tool result content string
   */
  toToolResult(): string {
    const lines = [
      `ERROR: code=${this.code} retryable=${this.retryable}`,
      `msg=${this.message}`
    ];
    
    if (this.hint) {
      lines.push(`hint=${this.hint}`);
    }
    
    if (this.details && Object.keys(this.details).length > 0) {
      const detailsStr = Object.entries(this.details)
        .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 200)}`)
        .join(' ');
      lines.push(`details=${detailsStr}`);
    }
    
    return lines.join('\n');
  }

  /**
   * Create from a generic error (with smart code inference)
   */
  static fromError(err: unknown, defaultCode: ToolErrorCode = 'internal'): ToolError {
    if (err instanceof ToolError) return err;
    
    const message = err instanceof Error ? err.message : String(err);
    
    // Infer error code from message patterns
    let code = defaultCode;
    let retryable = false;
    
    if (message.includes('ENOENT') || message.includes('not found')) {
      code = 'not_found';
    } else if (message.includes('EACCES') || message.includes('permission denied')) {
      code = 'permission';
    } else if (message.includes('ETIMEDOUT') || message.includes('timeout')) {
      code = 'timeout';
      retryable = true;
    } else if (message.includes('ECONNREFUSED') || message.includes('network')) {
      code = 'transient';
      retryable = true;
    } else if (message.includes('already exists')) {
      code = 'conflict';
    } else if (message.includes('blocked') || message.includes('safety')) {
      code = 'blocked';
    } else if (message.includes('invalid') || message.includes('required')) {
      code = 'invalid_args';
    }
    
    return new ToolError(code, message, retryable);
  }
}

/**
 * Validation error with field-level details
 */
export class ValidationError extends ToolError {
  constructor(
    public readonly errors: Array<{
      field: string;
      message: string;
      value?: any;
    }>
  ) {
    super(
      'invalid_args',
      `Validation failed: ${errors.map(e => e.message).join('; ')}`,
      false,
      undefined,
      { fields: errors.map(e => e.field) }
    );
    this.name = 'ValidationError';
  }

  toToolResult(): string {
    const lines = [`ERROR: code=invalid_args retryable=false`];
    
    for (const err of this.errors) {
      lines.push(`- ${err.field}: ${err.message}`);
    }
    
    if (this.errors.length > 0) {
      const first = this.errors[0];
      if (first.field.includes('line') || first.field.includes('offset')) {
        lines.push(`HINT: use read_file(format="numbered") to pick correct lines`);
      }
    }
    
    return lines.join('\n');
  }
}
