import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type LensOptions = {
  maxSkeletonItems?: number;
  maxRawPreviewChars?: number;
};

export type LensSkeletonLine = {
  kind: string;
  name: string;
  line?: number;
  signature?: string;
};

export type LensDiffSummary = {
  before: number;
  after: number;
  added: string[];
  removed: string[];
};

const CODE_NODE_KINDS = [
  ['function_declaration', 'function'],
  ['method_definition', 'method'],
  ['class_declaration', 'class'],
  ['class', 'class'],
  ['interface_declaration', 'interface'],
  ['struct_specifier', 'struct'],
  ['type_alias_declaration', 'type'],
  ['namespace_declaration', 'namespace'],
  ['enum_declaration', 'enum'],
  ['variable_declaration', 'variable'],
  ['lexical_declaration', 'variable'],
  ['const_declaration', 'variable'],
  ['struct_item', 'struct'],
  ['module_declaration', 'module'],
  ['impl_item', 'impl'],
  ['impl_definition', 'impl']
];

const CODE_NAME_NODE_HINTS = new Set([
  'identifier',
  'type_identifier',
  'field_identifier',
  'property_identifier',
  'name',
  'constant_identifier',
  'label'
]);

const JSON_YAML_EXTS = new Set(['.json', '.yml', '.yaml']);
const MARKDOWN_EXTS = new Set(['.md', '.markdown']);

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'tsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cxx': 'cpp',
  '.c': 'c',
  '.cs': 'c_sharp',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.kt': 'kotlin',
  '.kts': 'kotlin'
};

export class LensStore {
  private readonly maxSkeletonItems: number;
  private readonly maxRawPreviewChars: number;
  private readonly languageCache = new Map<string, unknown>();
  private parserReady: Promise<boolean> | null = null;
  private ParserCtor: any = null;
  private Language: any = null;
  private initFailed = false;

  constructor(opts: LensOptions = {}) {
    this.maxSkeletonItems = opts.maxSkeletonItems ?? 120;
    this.maxRawPreviewChars = opts.maxRawPreviewChars ?? 12_000;
  }

  /** Release cached tree-sitter Language objects and reset parser state. Safe to call multiple times. */
  close(): void {
    for (const lang of this.languageCache.values()) {
      try { (lang as any)?.delete?.(); } catch { /* ignore */ }
    }
    this.languageCache.clear();
    this.ParserCtor = null;
    this.Language = null;
    this.parserReady = null;
    this.initFailed = false;
  }

  async init() {
    await this.ensureParser();
  }

  get enabled() {
    return !this.initFailed;
  }

  async projectFile(filePath: string, content: string): Promise<string> {
    const p = path.resolve(filePath);
    const text = String(content ?? '');
    const ext = path.extname(p).toLowerCase();

    const ts = await this.tryTreeSitterSkeleton(p, text);
    if (ts) {
      return this.formatSkeleton(p, 'tree-sitter', ts);
    }

    const jsonFallback = this.tryJsonSkeleton(text);
    if (jsonFallback && JSON_YAML_EXTS.has(ext)) {
      return this.formatSkeleton(p, 'json', jsonFallback);
    }

    const yamlFallback = this.tryYamlSkeleton(text);
    if (yamlFallback && (ext === '.yml' || ext === '.yaml')) {
      return this.formatSkeleton(p, 'yaml', yamlFallback);
    }

    const mdFallback = this.tryMarkdownSkeleton(text);
    if (mdFallback && MARKDOWN_EXTS.has(ext)) {
      return this.formatSkeleton(p, 'markdown', mdFallback);
    }

    // Last resort: reduce noise but stay deterministic.
    const compact = this.compactRaw(text);
    return `# ${p}\n${compact}`;
  }

  async summarizeFailureMessage(message: string): Promise<string> {
    const text = String(message || '').trim();
    if (!text) return '[empty message]';
    if (text.length <= 1200) return text;
    return `${text.slice(0, 1190)}…`;
  }

  async summarizeToolOutput(content: string, toolName?: string, filePathHint?: string): Promise<string> {
    const raw = String(content ?? '');

    if (toolName && toolName !== 'read_file') {
      return this.compactRaw(raw);
    }

    if (!raw.trim()) return raw;

    const lines = raw.split(/\r?\n/);
    const header = lines[0]?.trim();

    const readPath = this.extractHeaderPath(header, filePathHint);
    if (!readPath) {
      return this.compactRaw(raw);
    }

    const body = lines.slice(1).map((l) => this.stripLineNumberPrefix(l)).join('\n');
    if (body.length <= this.maxRawPreviewChars) {
      return raw;
    }

    try {
      const projected = await this.projectFile(readPath, body);
      if (projected && projected !== `# ${readPath}\n${body}`) {
        return projected;
      }
    } catch {
      // no-op, fallback below
    }

    return this.compactRaw(raw);
  }

  async summarizeDiff(before: string, after: string, filePath: string): Promise<LensDiffSummary | undefined> {
    const p = path.resolve(filePath);
    const beforeEntries = await this.extractSkeletonEntries(p, before, { parseStructured: true });
    const afterEntries = await this.extractSkeletonEntries(p, after, { parseStructured: true });

    if (!beforeEntries.length && !afterEntries.length) {
      const beforeLines = this.safeLineCount(before);
      const afterLines = this.safeLineCount(after);
      return {
        before: beforeLines,
        after: afterLines,
        added: [`+${Math.max(0, afterLines - beforeLines)} lines`],
        removed: [`-${Math.max(0, beforeLines - afterLines)} lines`]
      };
    }

    const beforeKeys = new Set(beforeEntries.map((e) => `${e.kind}:${e.name}`));
    const afterKeys = new Set(afterEntries.map((e) => `${e.kind}:${e.name}`));

    const added: string[] = [];
    const removed: string[] = [];

    for (const k of afterKeys) {
      if (!beforeKeys.has(k)) {
        added.push(k);
      }
    }

    for (const k of beforeKeys) {
      if (!afterKeys.has(k)) {
        removed.push(k);
      }
    }

    return {
      before: beforeEntries.length,
      after: afterEntries.length,
      added,
      removed
    };
  }

  async summarizeDiffToText(before: string, after: string, filePath: string): Promise<string | undefined> {
    const summary = await this.summarizeDiff(before, after, filePath).catch(() => undefined);
    if (!summary) return undefined;

    if (!summary.added.length && !summary.removed.length) {
      return `diff: no structural signature change (${summary.before} -> ${summary.after})`;
    }

    const added = summary.added.slice(0, 4).map((x) => `+${x}`).join(', ');
    const removed = summary.removed.slice(0, 4).map((x) => `-${x}`).join(', ');

    return [
      `diff: signatures ${summary.before} -> ${summary.after}`,
      added ? ` added {${added}${summary.added.length > 4 ? `, +${summary.added.length - 4} more` : ''}` : null,
      removed ? ` removed {${removed}${summary.removed.length > 4 ? `, ${summary.removed.length - 4} more` : ''}` : null
    ]
      .filter(Boolean)
      .join(' ; ');
  }

  private async ensureParser(): Promise<boolean> {
    if (this.parserReady) {
      return this.parserReady;
    }

    this.parserReady = (async () => {
      try {
        const mod = await import('web-tree-sitter');
        const ParserMod = (mod as any).Parser ?? (mod as any).default?.Parser;
        const LanguageMod = (mod as any).Language ?? (mod as any).default?.Language;
        if (!ParserMod || !LanguageMod) return false;
        await (ParserMod.init?.() ?? Promise.resolve());
        this.ParserCtor = ParserMod;
        this.Language = LanguageMod;
        return true;
      } catch {
        this.initFailed = true;
        return false;
      }
    })();

    const ok = await this.parserReady;
    return ok;
  }

  private async tryTreeSitterSkeleton(filePath: string, content: string): Promise<string | undefined> {
    const ext = path.extname(filePath).toLowerCase();
    const language = LANGUAGE_BY_EXT[ext];
    if (!language) return;

    if (!this.ParserCtor || !this.Language) {
      await this.ensureParser();
      if (!this.ParserCtor || !this.Language) {
        return this.tryRegexSkeleton(filePath, content);
      }
    }

    const lang = await this.loadLanguage(language);
    if (!lang) {
      return this.tryRegexSkeleton(filePath, content);
    }

    let parser: any = null;
    let tree: any = null;
    try {
      parser = new this.ParserCtor();
      parser.setLanguage(lang);
      tree = parser.parse(content);
      const root = tree?.rootNode;
      if (!root) {
        return;
      }

      const lines: LensSkeletonLine[] = [];
      for (const [nodeType, kind] of CODE_NODE_KINDS) {
        const nodes = root.descendantsOfType(nodeType) as any[];
        for (const n of nodes) {
          if (!n || typeof n !== 'object' || n.isMissing) continue;
          if (lines.length >= this.maxSkeletonItems) break;
          const text = String(n.text ?? '');
          if (!text.trim()) continue;

          const nameNode =
            n.childForFieldName?.('name') ??
            n.children?.find((c: any) => c?.isNamed && CODE_NAME_NODE_HINTS.has(c.type)) ??
            null;

          const name = nameNode?.text?.trim() || this.extractNamedTokenFromText(text) || `<${kind}>`;
          const signature = this.formatNodeSignature(text);
          lines.push({
            kind,
            name,
            line: this.nodeToLine(n),
            signature
          });
        }
      }

      if (lines.length) {
        const compact = lines
          .slice(0, this.maxSkeletonItems)
          .map((line) =>
            `${line.kind} ${line.name}${line.line ? ` @${line.line}` : ''}${line.signature ? `: ${line.signature}` : ''}`
          );
        if (compact.length) {
          return compact.join('\n');
        }
      }
    } catch {
      // parser crashed; fallback to regex heuristics below
    } finally {
      // Clean up tree-sitter resources to prevent memory leaks
      try { tree?.delete?.(); } catch { /* ignore */ }
      try { parser?.delete?.(); } catch { /* ignore */ }
    }

    return this.tryRegexSkeleton(filePath, content);
  }

  private tryRegexSkeleton(filePath: string, content: string): string | undefined {
    const lines: string[] = [];
    const ext = path.extname(filePath).toLowerCase();
    const addIf = (kind: string, line: number, m: RegExpExecArray | null) => {
      if (!m) return;
      const name = (m[1] || m[2] || m[3] || '').trim();
      if (!name) return;
      const sig = m[0].slice(0, 140).trim();
      lines.push(`${kind} ${name}:${line} ${sig}`);
    };

    for (const [i, raw] of content.split(/\r?\n/).entries()) {
      if (lines.length >= this.maxSkeletonItems) break;
      const lineNo = i + 1;
      addIf('export function', lineNo, /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(raw));
      addIf('class', lineNo, /^(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(raw));
      addIf('const', lineNo, /^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(raw));
      addIf('let', lineNo, /^(?:export\s+)?let\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(raw));
      addIf('var', lineNo, /^(?:export\s+)?var\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(raw));
      addIf('def', lineNo, /^\s*def\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(raw));

      if (ext === '.rs') {
        addIf('impl', lineNo, /^\s*impl\s+([A-Za-z0-9_]+)/.exec(raw));
        addIf('fn', lineNo, /^\s*(?:pub\s+)?fn\s+([A-Za-z0-9_]+)/.exec(raw));
        addIf('struct', lineNo, /^\s*(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/.exec(raw));
      }

      if (ext === '.go') {
        addIf('func', lineNo, /^\s*func(?:\s+\([^)]+\))?\s+([A-Za-z0-9_]+)/.exec(raw));
        addIf('type', lineNo, /^\s*type\s+([A-Za-z0-9_]+)/.exec(raw));
      }
    }

    if (!lines.length) return;
    return lines.join('\n');
  }

  private tryJsonSkeleton(content: string): string | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return;
    }

    const lines: string[] = [];

    const summarize = (value: unknown, prefix = '') => {
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        lines.push(`${prefix} = ${String(value).slice(0, 120)}`);
        return;
      }

      if (Array.isArray(value)) {
        lines.push(`${prefix}: array[${value.length}]`);
        const sample = value.slice(0, 3);
        sample.forEach((item, i) => summarize(item, `${prefix}[${i}]`));
        return;
      }

      if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj);
        lines.push(`${prefix || '<root>'} {${keys.length} keys}`);
        for (const k of keys.slice(0, 20)) {
          const v = obj[k];
          const nextPrefix = prefix ? `${prefix}.${k}` : k;
          if (v === null || typeof v !== 'object' || Array.isArray(v)) {
            lines.push(`${nextPrefix}: ${Array.isArray(v) ? `array[${v.length}]` : typeof v}`);
          } else {
            lines.push(`${nextPrefix}: object`);
          }
        }
      }
    };

    summarize(parsed);
    return lines.length ? lines.slice(0, this.maxSkeletonItems).join('\n') : undefined;
  }

  private tryYamlSkeleton(content: string): string | undefined {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const line of content.split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      if (line.startsWith(' ') || line.startsWith('\t')) continue;
      const key = m[1].trim();
      if (seen.has(key)) continue;
      seen.add(key);
      const rawVal = (m[2] ?? '').trim();
      const val = rawVal ? `: ${rawVal.slice(0, 80)}` : '';
      lines.push(`${key}${val}`);
      if (lines.length >= this.maxSkeletonItems) break;
    }
    return lines.length ? lines.join('\n') : undefined;
  }

  private tryMarkdownSkeleton(content: string): string | undefined {
    const lines: string[] = [];
    for (const line of content.split(/\r?\n/)) {
      const m = /^(#{1,6})\s+(.+)$/.exec(line);
      if (!m) continue;
      const level = m[1].length;
      const title = m[2].trim();
      lines.push(`${' '.repeat(level - 1)}# ${title}`);
      if (lines.length >= this.maxSkeletonItems) break;
    }
    return lines.length ? lines.join('\n') : undefined;
  }

  private compactRaw(raw: string): string {
    const t = String(raw ?? '');
    if (t.length <= this.maxRawPreviewChars) return t;
    return t.slice(0, this.maxRawPreviewChars) + `\n[truncated, ${t.length} chars total]`;
  }

  private formatSkeleton(filePath: string, kind: string, body: string): string {
    const preview = body.trim().split(/\r?\n/).slice(0, this.maxSkeletonItems).join('\n');
    const clipped = body.length > preview.length ? preview + '\n[truncated]' : preview;
    return `# ${filePath}\n# lens:${kind}\n${clipped}`;
  }

  private extractHeaderPath(firstLine?: string, hint?: string): string | undefined {
    if (firstLine) {
      const m = /^#\s*(.+)$/.exec(firstLine.trim());
      if (m && m[1]) return m[1].trim();
    }
    if (hint) return hint;
    return undefined;
  }

  private stripLineNumberPrefix(line: string): string {
    return line.replace(/^\s*\d+\|\s?/, '');
  }

  private nodeToLine(node: any): number | undefined {
    if (!node || !node.startPosition) return undefined;
    return typeof node.startPosition.row === 'number' ? node.startPosition.row + 1 : undefined;
  }

  private extractNamedTokenFromText(text: string): string | undefined {
    const m = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(text);
    return m?.[1];
  }

  private formatNodeSignature(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length <= 90) return flat;
    return `${flat.slice(0, 90)}…`;
  }

  private async extractSkeletonEntries(filePath: string, content: string, opts: { parseStructured: boolean }): Promise<LensSkeletonLine[]> {
    const text = String(content ?? '');
    const ts = await this.tryTreeSitterSkeleton(filePath, text);
    if (ts && opts.parseStructured) {
      const lines = ts.split(/\r?\n/);
      return lines.map((l) => ({ kind: 'sig', name: l.slice(0, 260) }));
    }

    const ext = path.extname(filePath).toLowerCase();
    const regex = this.tryRegexSkeleton(filePath, text);
    if (regex) {
      return regex
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          const m = l.match(/^([a-zA-Z_]+)\s+([^:]+):?(\d+)?/);
          if (m) {
            return { kind: m[1], name: m[2].trim() };
          }
          return { kind: 'line', name: l.slice(0, 120) };
        })
        .slice(0, this.maxSkeletonItems);
    }

    if (JSON_YAML_EXTS.has(ext) && (this.tryJsonSkeleton(text) || this.tryYamlSkeleton(text))) {
      const flat = this.tryJsonSkeleton(text) ?? this.tryYamlSkeleton(text) ?? '';
      return flat
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, this.maxSkeletonItems)
        .map((line) => ({ kind: 'data', name: line.slice(0, 80) }));
    }

    if (MARKDOWN_EXTS.has(ext) && this.tryMarkdownSkeleton(text)) {
      return this.tryMarkdownSkeleton(text)!
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, this.maxSkeletonItems)
        .map((line) => ({ kind: 'heading', name: line.trim() }));
    }

    return [];
  }

  private safeLineCount(content: string): number {
    if (!content) return 0;
    return content.split(/\r?\n/).length;
  }

  private async loadLanguage(lang: string): Promise<unknown | undefined> {
    if (this.languageCache.has(lang)) {
      return this.languageCache.get(lang);
    }

    const maybeCache = this.languageCache.get(`err:${lang}`);
    if (maybeCache === null) return undefined;

    try {
      const wasms = this.resolveTreeSitterWasm(lang);
      if (!wasms) {
        this.languageCache.set(`err:${lang}`, null as any);
        return undefined;
      }
      const loaded = await this.Language!.load(wasms);
      this.languageCache.set(lang, loaded);
      return loaded;
    } catch {
      this.languageCache.set(`err:${lang}`, null as any);
      return undefined;
    }
  }

  private resolveTreeSitterWasm(lang: string): string | null {
    try {
      const baseDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));
      const file = `tree-sitter-${lang}.wasm`;
      const full = path.join(baseDir, 'out', file);
      return full;
    } catch {
      return null;
    }
  }
}
