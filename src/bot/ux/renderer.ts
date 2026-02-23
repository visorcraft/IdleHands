/**
 * Platform-agnostic UX event renderer.
 *
 * Converts the canonical event model into text blocks suitable for
 * Discord, Telegram, and other platforms without duplicating formatting logic.
 */

import type {
  UXEvent,
  UXEventACK,
  UXEventPROGRESS,
  UXEventWARNING,
  UXEventERROR,
  UXEventRESULT,
  UXEventACTIONS,
  UXEventCategory,
  UXAction,
} from './events.js';

// ---------------------------------------------------------------------------
// Text Block Types
// ---------------------------------------------------------------------------

/**
 * A canonical text block that can be rendered by different platforms.
 */
export type TextBlock = {
  type: 'text';
  content: string;
  /** Optional formatting hints for platforms */
  format?: {
    bold?: boolean;
    italic?: boolean;
    monospace?: boolean;
    code?: boolean;
    color?: string;
  };
};

/**
 * A block with a title/label and content.
 */
export type SectionBlock = {
  type: 'section';
  title?: string;
  content: TextBlock | TextBlock[];
  /** Optional divider after this section */
  divider?: boolean;
};

/**
 * A block containing action buttons.
 */
export type ActionBlock = {
  type: 'actions';
  actions: UXAction[];
  /** Optional message to display above actions */
  message?: string;
};

/**
 * A block containing a progress bar.
 */
export type ProgressBlock = {
  type: 'progress';
  progress: number; // 0.0 - 1.0
  message?: string;
  phase?: string;
};

/**
 * A block containing a formatted message with optional metadata.
 */
export type MessageBlock = {
  type: 'message';
  category: UXEventCategory;
  content: TextBlock | TextBlock[];
  metadata?: {
    timestamp?: number;
    sequence?: number;
    sessionId?: string;
    userId?: string;
  };
  /** Platform-specific formatting hints */
  format?: {
    prefix?: string;
    suffix?: string;
    color?: string;
    icon?: string;
  };
};

/**
 * A divider/horizontal rule.
 */
export type DividerBlock = {
  type: 'divider';
};

/**
 * A block containing a code snippet.
 */
export type CodeBlock = {
  type: 'code';
  language?: string;
  content: string;
};

/**
 * All possible block types.
 */
export type UXBlock =
  | TextBlock
  | SectionBlock
  | ActionBlock
  | ProgressBlock
  | MessageBlock
  | DividerBlock
  | CodeBlock;

// ---------------------------------------------------------------------------
// Renderer Functions
// ---------------------------------------------------------------------------

/**
 * Render an ACK event into text blocks.
 */
export function renderACK(event: UXEventACK): UXBlock[] {
  const blocks: UXBlock[] = [];

  // Main message
  blocks.push({
    type: 'message',
    category: 'ACK',
    content: {
      type: 'text',
      content: event.message,
      format: { bold: true },
    },
    format: {
      prefix: '✅',
      icon: 'ack',
    },
  });

  // Optional metadata
  if (event.estimatedDurationSec !== undefined) {
    blocks.push({
      type: 'section',
      content: {
        type: 'text',
        content: `⏱️ Estimated duration: ${event.estimatedDurationSec}s`,
      },
    });
  }

  if (event.model !== undefined) {
    blocks.push({
      type: 'section',
      content: {
        type: 'text',
        content: `🤖 Model: ${event.model}`,
      },
    });
  }

  return blocks;
}

/**
 * Render a PROGRESS event into text blocks.
 */
export function renderPROGRESS(event: UXEventPROGRESS): UXBlock[] {
  const blocks: UXBlock[] = [];

  // Progress bar if progress is available
  if (event.progress !== undefined) {
    blocks.push({
      type: 'progress',
      progress: event.progress,
      message: event.message,
      phase: event.phase,
    });
  }

  // Status message
  blocks.push({
    type: 'message',
    category: 'PROGRESS',
    content: {
      type: 'text',
      content: event.message,
    },
    format: {
      prefix: '⏳',
      icon: 'progress',
    },
  });

  // Optional metadata
  if (event.phase !== undefined) {
    blocks.push({
      type: 'section',
      title: 'Phase',
      content: {
        type: 'text',
        content: event.phase,
        format: { italic: true },
      },
    });
  }

  if (event.toolName !== undefined) {
    blocks.push({
      type: 'section',
      title: 'Tool',
      content: {
        type: 'text',
        content: event.toolName,
        format: { monospace: true },
      },
    });
  }

  if (event.toolId !== undefined) {
    blocks.push({
      type: 'section',
      title: 'Tool ID',
      content: {
        type: 'text',
        content: event.toolId,
        format: { monospace: true },
      },
    });
  }

  return blocks;
}

/**
 * Render a WARNING event into text blocks.
 */
export function renderWARNING(event: UXEventWARNING): UXBlock[] {
  const blocks: UXBlock[] = [];

  blocks.push({
    type: 'message',
    category: 'WARNING',
    content: {
      type: 'text',
      content: event.message,
      format: { italic: true },
    },
    format: {
      prefix: '⚠️',
      icon: 'warning',
      color: 'yellow',
    },
  });

  if (event.code !== undefined) {
    blocks.push({
      type: 'section',
      title: 'Code',
      content: {
        type: 'text',
        content: event.code,
        format: { monospace: true },
      },
    });
  }

  if (event.hint !== undefined) {
    blocks.push({
      type: 'section',
      title: 'Hint',
      content: {
        type: 'text',
        content: event.hint,
      },
    });
  }

  return blocks;
}

/**
 * Render an ERROR event into text blocks.
 */
export function renderERROR(event: UXEventERROR): UXBlock[] {
  const blocks: UXBlock[] = [];

  blocks.push({
    type: 'message',
    category: 'ERROR',
    content: {
      type: 'text',
      content: event.message,
      format: { bold: true, color: 'red' },
    },
    format: {
      prefix: '❌',
      icon: 'error',
      color: 'red',
    },
  });

  if (event.code !== undefined) {
    blocks.push({
      type: 'section',
      title: 'Code',
      content: {
        type: 'text',
        content: event.code,
        format: { monospace: true },
      },
    });
  }

  if (event.details !== undefined) {
    blocks.push({
      type: 'code',
      content: event.details,
    });
  }

  if (event.retryable === true) {
    blocks.push({
      type: 'section',
      content: {
        type: 'text',
        content: 'This error is retryable.',
        format: { italic: true },
      },
    });
  }

  if (event.guidance !== undefined) {
    blocks.push({
      type: 'section',
      title: 'Guidance',
      content: {
        type: 'text',
        content: event.guidance,
      },
    });
  }

  return blocks;
}

/**
 * Render a RESULT event into text blocks.
 */
export function renderRESULT(event: UXEventRESULT): UXBlock[] {
  const blocks: UXBlock[] = [];

  blocks.push({
    type: 'message',
    category: 'RESULT',
    content: {
      type: 'text',
      content: event.summary,
      format: { bold: true },
    },
    format: {
      prefix: event.success !== false ? '✅' : '❌',
      icon: 'result',
      color: event.success !== false ? 'green' : 'red',
    },
  });

  if (event.data !== undefined) {
    blocks.push({
      type: 'code',
      content: JSON.stringify(event.data, null, 2),
    });
  }

  if (event.stats !== undefined) {
    const statsLines: string[] = [];

    if (event.stats.durationMs !== undefined) {
      statsLines.push(`Duration: ${event.stats.durationMs}ms`);
    }

    if (event.stats.tokensUsed !== undefined) {
      statsLines.push(`Tokens: ${event.stats.tokensUsed}`);
    }

    if (event.stats.toolsCalled !== undefined) {
      statsLines.push(`Tools: ${event.stats.toolsCalled}`);
    }

    if (statsLines.length > 0) {
      blocks.push({
        type: 'section',
        title: 'Stats',
        content: {
          type: 'text',
          content: statsLines.join(', '),
        },
      });
    }
  }

  return blocks;
}

/**
 * Render an ACTIONS event into text blocks.
 */
export function renderACTIONS(event: UXEventACTIONS): UXBlock[] {
  const blocks: UXBlock[] = [];

  if (event.message !== undefined) {
    blocks.push({
      type: 'message',
      category: 'ACTIONS',
      content: {
        type: 'text',
        content: event.message,
      },
      format: {
        prefix: '🔧',
        icon: 'actions',
      },
    });
  }

  blocks.push({
    type: 'actions',
    actions: event.actions,
    message: event.message,
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Main Renderer
// ---------------------------------------------------------------------------

/**
 * Render any UX event into canonical text blocks.
 */
export function renderEvent(event: UXEvent): UXBlock[] {
  switch (event.category) {
    case 'ACK':
      return renderACK(event);
    case 'PROGRESS':
      return renderPROGRESS(event);
    case 'WARNING':
      return renderWARNING(event);
    case 'ERROR':
      return renderERROR(event);
    case 'RESULT':
      return renderRESULT(event);
    case 'ACTIONS':
      return renderACTIONS(event);
    default:
      // Fallback for unknown categories - this should never happen
      return [
        {
          type: 'message',
          category: 'ACK',
          content: {
            type: 'text',
            content: `Unknown event category: ${(event as { category: string }).category}`,
            format: { color: 'orange' },
          },
        },
      ];
  }
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Format a progress bar string.
 */
export function formatProgressBar(progress: number, width: number = 20): string {
  const filled = Math.round(progress * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${Math.round(progress * 100)}%`;
}

/**
 * Format a timestamp into a human-readable string.
 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

/**
 * Format a duration in milliseconds into a human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

/**
 * Extract plain text from a block (for platforms that don't support rich formatting).
 */
export function blockToPlainText(block: UXBlock): string {
  switch (block.type) {
    case 'text':
      return block.content;
    case 'section':
      const content = Array.isArray(block.content)
        ? block.content.map(blockToPlainText).join('\n')
        : blockToPlainText(block.content);
      return block.title ? `${block.title}:\n${content}` : content;
    case 'message':
      const msgContent = Array.isArray(block.content)
        ? block.content.map(blockToPlainText).join('\n')
        : blockToPlainText(block.content);
      return msgContent;
    case 'actions':
      return block.actions
        .map((a) => `${a.label}${a.payload ? `: ${JSON.stringify(a.payload)}` : ''}`)
        .filter(Boolean)
        .join('\n');
    case 'progress':
      return `${block.message || ''} ${formatProgressBar(block.progress)}`;
    case 'divider':
      return '---';
    case 'code':
      return `\`\`\`\n${block.content}\n\`\`\``;
    default:
      return '';
  }
}

/**
 * Convert all blocks to plain text.
 */
export function blocksToPlainText(blocks: UXBlock[]): string {
  return blocks.map(blockToPlainText).join('\n\n');
}
