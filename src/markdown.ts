/**
 * Terminal markdown renderer — ANSI escape-based rendering for model output.
 * No external dependencies. ~200 lines.
 *
 * Supports: bold, italic, inline code, strikethrough, fenced code blocks,
 * headings (1-3), bullet/numbered lists, links, think block collapsing.
 * Degrades gracefully to plain text when piped (!isTTY).
 */

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const UNDERLINE = `${ESC}4m`;
const STRIKE = `${ESC}9m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const MAGENTA = `${ESC}35m`;
const BG_GRAY = `${ESC}48;5;236m`;

type RenderOptions = {
  color?: boolean;      // default: auto-detect from isTTY
  verbose?: boolean;    // show full think blocks
  width?: number;       // terminal width for wrapping
};

/**
 * Render markdown text with ANSI escape sequences for terminal display.
 */
export function renderMarkdown(text: string, opts: RenderOptions = {}): string {
  const color = opts.color ?? process.stdout.isTTY ?? false;
  if (!color) return stripMarkdown(text);

  const lines = text.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let inThink = false;
  let thinkTokens = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Think block handling
    if (line.includes('<think>')) {
      inThink = true;
      thinkTokens = 0;
      continue;
    }
    if (line.includes('</think>')) {
      inThink = false;
      if (!opts.verbose) {
        out.push(`${DIM}[thinking... ~${Math.round(thinkTokens / 4)} tokens]${RESET}`);
      }
      continue;
    }
    if (inThink) {
      thinkTokens += line.length + 1;
      if (opts.verbose) {
        out.push(`${DIM}${line}${RESET}`);
      }
      continue;
    }

    // Fenced code blocks
    const fenceMatch = line.match(/^```(\w*)$/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = fenceMatch[1] || '';
        codeLines = [];
      } else {
        // End of code block — render
        const langLabel = codeLang ? ` ${codeLang}` : '';
        out.push(`${DIM}┌──${langLabel}${'─'.repeat(Math.max(0, 40 - langLabel.length))}${RESET}`);
        for (const cl of codeLines) {
          const hl = highlightCodeLine(cl, codeLang);
          out.push(`${DIM}│${RESET} ${BG_GRAY}${hl}${RESET}`);
        }
        out.push(`${DIM}└${'─'.repeat(42)}${RESET}`);
        inCodeBlock = false;
        codeLang = '';
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Headings
    const h3 = line.match(/^### (.+)/);
    if (h3) { out.push(`${BOLD}${h3[1]}${RESET}`); continue; }
    const h2 = line.match(/^## (.+)/);
    if (h2) { out.push(`${BOLD}${UNDERLINE}${h2[1]}${RESET}`); continue; }
    const h1 = line.match(/^# (.+)/);
    if (h1) { out.push(`\n${BOLD}${UNDERLINE}${h1[1]}${RESET}\n`); continue; }

    // Horizontal rules
    if (/^---+$/.test(line.trim())) {
      out.push(`${DIM}${'─'.repeat(40)}${RESET}`);
      continue;
    }

    // Bullet lists
    const bullet = line.match(/^(\s*)[*-] (.+)/);
    if (bullet) {
      const indent = bullet[1];
      const content = renderInline(bullet[2]);
      out.push(`${indent}• ${content}`);
      continue;
    }

    // Numbered lists
    const numbered = line.match(/^(\s*)(\d+)\. (.+)/);
    if (numbered) {
      const indent = numbered[1];
      const num = numbered[2];
      const content = renderInline(numbered[3]);
      out.push(`${indent}${DIM}${num}.${RESET} ${content}`);
      continue;
    }

    // Markdown tables (best effort)
    if (isTableHeader(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const rows: string[] = [line];
      // skip separator line i+1
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(lines[i]);
        i += 1;
      }
      i -= 1; // compensate loop increment
      out.push(...renderTable(rows));
      continue;
    }

    // Regular paragraph lines — apply inline formatting
    out.push(renderInline(line));
  }

  // Handle unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    const langLabel = codeLang ? ` ${codeLang}` : '';
    out.push(`${DIM}┌──${langLabel}${'─'.repeat(Math.max(0, 40 - langLabel.length))}${RESET}`);
    for (const cl of codeLines) {
      const hl = highlightCodeLine(cl, codeLang);
      out.push(`${DIM}│${RESET} ${BG_GRAY}${hl}${RESET}`);
    }
    out.push(`${DIM}└${'─'.repeat(42)}${RESET}`);
  }

  return out.join('\n');
}

/**
 * Apply inline markdown formatting (bold, italic, code, strikethrough, links).
 */
function renderInline(text: string): string {
  // Process inline code first (preserve contents from other formatting)
  let result = '';
  let i = 0;
  while (i < text.length) {
    // Inline code: `...`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        const code = text.slice(i + 1, end);
        result += `${CYAN}${code}${RESET}`;
        i = end + 1;
        continue;
      }
    }
    result += text[i];
    i++;
  }

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
  result = result.replace(/__(.+?)__/g, `${BOLD}$1${RESET}`);

  // Italic: *text* or _text_ (but not inside words for _)
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, `${ITALIC}$1${RESET}`);
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, `${ITALIC}$1${RESET}`);

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, `${STRIKE}$1${RESET}`);

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `$1 ${DIM}($2)${RESET}`);

  return result;
}

/**
 * Strip markdown for plain text output (non-TTY).
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '[thinking...]')
    .replace(/```\w*\n/g, '')
    .replace(/```/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.includes('|') && t.split('|').length >= 3;
}

function isTableHeader(line: string): boolean {
  return isTableRow(line);
}

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(t);
}

function splitTableRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map(c => c.trim());
}

function renderTable(rows: string[]): string[] {
  const cells = rows.map(splitTableRow);
  const cols = Math.max(...cells.map(r => r.length));
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(...cells.map(r => (r[i] ?? '').length))
  );

  const renderRow = (row: string[]) => {
    const padded = widths.map((w, i) => {
      const cell = renderInline(row[i] ?? '');
      // Visible width is approximate because ANSI codes count as chars; acceptable best effort.
      const plain = String(row[i] ?? '');
      const pad = ' '.repeat(Math.max(0, w - plain.length));
      return ` ${cell}${pad} `;
    });
    return `${DIM}│${RESET}${padded.join(`${DIM}│${RESET}`)}${DIM}│${RESET}`;
  };

  const border = `${DIM}├${widths.map(w => '─'.repeat(w + 2)).join('┼')}┤${RESET}`;
  const top = `${DIM}┌${widths.map(w => '─'.repeat(w + 2)).join('┬')}┐${RESET}`;
  const bottom = `${DIM}└${widths.map(w => '─'.repeat(w + 2)).join('┴')}┘${RESET}`;

  const out: string[] = [top];
  if (cells.length > 0) out.push(renderRow(cells[0]));
  out.push(border);
  for (let i = 1; i < cells.length; i++) out.push(renderRow(cells[i]));
  out.push(bottom);
  return out;
}

function highlightCodeLine(line: string, lang: string): string {
  const l = (lang || '').toLowerCase();
  let s = line;

  // Strings
  s = s.replace(/("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')/g, `${GREEN}$1${RESET}${BG_GRAY}`);
  // Numbers
  s = s.replace(/\b(\d+(?:\.\d+)?)\b/g, `${YELLOW}$1${RESET}${BG_GRAY}`);

  const applyKeywords = (re: RegExp) => {
    s = s.replace(re, `${MAGENTA}$1${RESET}${BG_GRAY}`);
  };

  if (['js', 'ts', 'javascript', 'typescript'].includes(l)) {
    applyKeywords(/\b(const|let|var|function|return|if|else|for|while|class|import|export|async|await|try|catch|throw|new)\b/g);
  } else if (['py', 'python'].includes(l)) {
    applyKeywords(/\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|raise|with|yield|async|await|lambda)\b/g);
  } else if (['bash', 'sh', 'zsh'].includes(l)) {
    applyKeywords(/\b(if|then|else|fi|for|do|done|while|case|esac|function|export|local)\b/g);
  } else if (['rust', 'rs'].includes(l)) {
    applyKeywords(/\b(fn|let|mut|pub|impl|struct|enum|trait|use|mod|match|if|else|for|while|loop|return|async|await)\b/g);
  } else if (['go', 'golang'].includes(l)) {
    applyKeywords(/\b(func|var|const|type|struct|interface|package|import|return|if|else|for|range|go|defer|switch|case)\b/g);
  } else if (['c', 'cpp', 'c++', 'h', 'hpp'].includes(l)) {
    applyKeywords(/\b(int|char|void|float|double|struct|class|if|else|for|while|return|include|typedef|static|const)\b/g);
  } else if (['json', 'yaml', 'yml'].includes(l)) {
    // keys before ':'
    s = s.replace(/^\s*([\w"'-]+)\s*:/g, `${CYAN}$1${RESET}${BG_GRAY}:`);
  }

  return s;
}
