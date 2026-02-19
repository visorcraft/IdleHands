/**
 * Markdown → Telegram HTML converter + message splitting.
 * Lightweight, no external deps. Handles the subset Telegram supports.
 */


/**
 * Remove accidental tool-protocol leakage from model text before rendering to chat.
 * This catches pseudo-XML tool blocks some models emit when tool-calling fails.
 */
export function sanitizeBotOutputText(text: string): string {
  if (!text) return '';
  let out = text;

  // Remove full pseudo-XML tool-call blocks first.
  out = out.replace(/<\s*tool_call\b[^>]*>[\s\S]*?<\s*\/\s*tool_call\s*>/gi, '');

  // Remove stray opening/closing protocol tags and parameter wrappers.
  out = out.replace(/<\s*\/?\s*tool_call\b[^>]*>/gi, '');
  out = out.replace(/<\s*\/?\s*parameter\b[^>]*>/gi, '');

  // Remove broken closers seen in malformed model output.
  out = out.replace(/<\s*\/\s*tool_call\s*>>?/gi, '');
  out = out.replace(/<\s*\/\s*parameter\s*>>?/gi, '');

  // Remove common chain-of-thought/process narration leakage lines.
  out = out
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      return !/^(now let me|let me |i'll analyze|i need to |now i (have|understand))/i.test(t);
    })
    .join('\n');

  // Collapse excessive blank lines after redaction.
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  return out;
}

/** Escape HTML special characters for Telegram. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert markdown to Telegram HTML.
 * Handles: code blocks, inline code, bold, italic, strikethrough, links, headings, lists.
 * Passes everything else through as escaped plain text.
 */
export function markdownToTelegramHtml(md: string): string {
  if (!md) return '';
  md = sanitizeBotOutputText(md);

  const lines = md.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block open/close
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
        codeLines = [];
        continue;
      } else {
        // Close code block
        inCodeBlock = false;
        const langAttr = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : '';
        out.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLang = '';
        codeLines = [];
        continue;
      }
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Empty line → paragraph break
    if (line.trim() === '') {
      out.push('');
      continue;
    }

    // Headings → bold
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      out.push(`<b>${formatInline(headingMatch[1])}</b>`);
      continue;
    }

    // Bullet lists
    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bulletMatch) {
      const indent = bulletMatch[1].length > 0 ? '  ' : '';
      out.push(`${indent}• ${formatInline(bulletMatch[2])}`);
      continue;
    }

    // Numbered lists
    const numMatch = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
    if (numMatch) {
      const indent = numMatch[1].length > 0 ? '  ' : '';
      out.push(`${indent}${formatInline(numMatch[2])}`);
      continue;
    }

    // Regular line — apply inline formatting
    out.push(formatInline(line));
  }

  // Unclosed code block
  if (inCodeBlock && codeLines.length) {
    out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }

  return out.join('\n');
}

/** Apply inline formatting (bold, italic, code, strikethrough, links). */
function formatInline(text: string): string {
  // Process inline code FIRST (protect its contents from other formatting)
  const codeSegments: string[] = [];
  let processed = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    const idx = codeSegments.length;
    codeSegments.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00CODE${idx}\x00`;
  });

  // Escape HTML in the non-code portions
  processed = processed.replace(/\x00CODE(\d+)\x00/g, (_m, idx) => `\x00SAFE${idx}\x00`);
  processed = escapeHtml(processed);
  processed = processed.replace(/\x00SAFE(\d+)\x00/g, (_m, idx) => codeSegments[Number(idx)]);

  // Bold: **text** or __text__
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  processed = processed.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words with underscores)
  processed = processed.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '<i>$1</i>');
  processed = processed.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  processed = processed.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url)
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return processed;
}

/**
 * Split a message into chunks that fit Telegram's 4096-char limit.
 * Prefers splitting at paragraph boundaries, then code block boundaries, then lines.
 */
export function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitIdx = -1;

    // Try to split at a double newline (paragraph boundary)
    const searchRange = remaining.slice(0, maxLen);
    const paraIdx = searchRange.lastIndexOf('\n\n');
    if (paraIdx > maxLen * 0.3) {
      splitIdx = paraIdx + 2;
    }

    // Try code block boundary (</pre> or </code></pre>)
    if (splitIdx === -1) {
      const preIdx = searchRange.lastIndexOf('</pre>');
      if (preIdx > maxLen * 0.3) {
        splitIdx = preIdx + 6;
      }
    }

    // Try line boundary
    if (splitIdx === -1) {
      const lineIdx = searchRange.lastIndexOf('\n');
      if (lineIdx > maxLen * 0.2) {
        splitIdx = lineIdx + 1;
      }
    }

    // Hard split
    if (splitIdx === -1) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/** Format a tool call into a one-line summary for display. */
export function formatToolCallSummary(call: { name: string; args: Record<string, unknown> }): string {
  const { name, args } = call;
  switch (name) {
    case 'read_file':
      return `read_file ${args.path || '?'}${args.search ? ` (search: ${args.search})` : ''}`;
    case 'read_files':
      return `read_files (${Array.isArray(args.requests) ? args.requests.length : '?'} files)`;
    case 'write_file':
      return `write_file ${args.path || '?'}`;
    case 'edit_file':
      return `edit_file ${args.path || '?'}`;
    case 'insert_file':
      return `insert_file ${args.path || '?'} (line ${args.line ?? '?'})`;
    case 'list_dir':
      return `list_dir ${args.path || '.'}${args.recursive ? ' (recursive)' : ''}`;
    case 'search_files':
      return `search_files "${args.pattern || '?'}" in ${args.path || '.'}`;
    case 'exec': {
      const cmd = String(args.command || '?');
      return `exec: ${cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd}`;
    }
    case 'vault_search':
      return `vault_search "${args.query || '?'}"`;
    default:
      return name;
  }
}
