import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { encodeJsonRpcFrame, extractMessages } from './jsonrpc.js';
import { PKG_VERSION, shellEscape } from './utils.js';

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };

export type LspDiagnostic = {
  range: LspRange;
  severity?: number;
  code?: number | string;
  source?: string;
  message: string;
};

export type PublishDiagnosticsParams = {
  uri: string;
  diagnostics: LspDiagnostic[];
  version?: number;
};

export type LspClientOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  rootPath?: string;
  rootUri?: string;
  capabilities?: Record<string, unknown>;
  requestTimeoutMs?: number;
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

function asErr(e: any): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export type LspServerCandidate = {
  language: string;
  command: string;
  args?: string[];
};

export type DetectedLspServer = {
  language: string;
  command: string;
  args: string[];
  found: boolean;
};

export const DEFAULT_LSP_CANDIDATES: LspServerCandidate[] = [
  { language: 'typescript', command: 'typescript-language-server', args: ['--stdio'] },
  { language: 'typescript', command: 'tsserver', args: [] },
  { language: 'python', command: 'pyright-langserver', args: ['--stdio'] },
  { language: 'python', command: 'pylsp', args: [] },
  { language: 'go', command: 'gopls', args: [] },
  { language: 'rust', command: 'rust-analyzer', args: [] },
  { language: 'c', command: 'clangd', args: [] },
  { language: 'cpp', command: 'clangd', args: [] },
];

export class LspClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private running = false;
  private closed = false;
  private stderrTail = '';

  private serverCapabilities: Record<string, unknown> = {};
  private diagnosticsByUri = new Map<string, LspDiagnostic[]>();

  onDiagnostics?: (params: PublishDiagnosticsParams) => void;

  constructor(private readonly opts: LspClientOptions) {}

  static filePathToUri(filePath: string): string {
    return pathToFileURL(path.resolve(filePath)).toString();
  }

  isRunning(): boolean {
    return this.running;
  }

  getCapabilities(): Record<string, unknown> {
    return { ...this.serverCapabilities };
  }

  getDiagnostics(uriOrPath: string): LspDiagnostic[] {
    const uri = uriOrPath.startsWith('file:') ? uriOrPath : LspClient.filePathToUri(uriOrPath);
    return [...(this.diagnosticsByUri.get(uri) ?? [])];
  }

  /** Return all URIs that have published diagnostics. */
  getDiagnosticUris(): string[] {
    return [...this.diagnosticsByUri.keys()];
  }

  /** Return all diagnostics across all files, keyed by URI. */
  getAllDiagnostics(): Map<string, LspDiagnostic[]> {
    const out = new Map<string, LspDiagnostic[]>();
    for (const [uri, diags] of this.diagnosticsByUri) {
      if (diags.length > 0) out.set(uri, [...diags]);
    }
    return out;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const command = String(this.opts.command ?? '').trim();
    if (!command) throw new Error('lsp: missing command');

    const args = Array.isArray(this.opts.args) ? this.opts.args.map((a) => String(a)) : [];

    const child = spawn(command, args, {
      cwd: this.opts.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...(this.opts.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;
    this.running = true;
    this.closed = false;
    this.stderrTail = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffer = Buffer.concat([this.buffer, b]);
      this.parseBuffer();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const txt = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.stderrTail = (this.stderrTail + txt).slice(-4000);
    });

    child.on('error', (err) => {
      this.failAll(new Error(`lsp: process error: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      this.running = false;
      this.closed = true;
      const tail = this.stderrTail.trim();
      const base = `lsp: process closed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      const msg = tail ? `${base}; stderr: ${tail}` : base;
      this.failAll(new Error(msg));
    });

    const rootPath = this.opts.rootPath ?? this.opts.cwd ?? process.cwd();
    const rootUri = this.opts.rootUri ?? LspClient.filePathToUri(rootPath);

    const initializeResult = await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: {
          name: 'idlehands',
          version: PKG_VERSION,
        },
        rootUri,
        capabilities: this.opts.capabilities ?? {},
        workspaceFolders: [{ uri: rootUri, name: path.basename(rootPath) || 'workspace' }],
      },
      this.opts.requestTimeoutMs ?? 15000
    );

    this.serverCapabilities =
      initializeResult?.capabilities && typeof initializeResult.capabilities === 'object'
        ? initializeResult.capabilities
        : {};

    await this.notify('initialized', {});
  }

  async stop(): Promise<void> {
    if (!this.child) return;

    const child = this.child;
    this.child = null;

    try {
      await this.request('shutdown', {}, Math.min(this.opts.requestTimeoutMs ?? 10000, 5000));
    } catch {
      // Best-effort.
    }

    try {
      await this.notify('exit', {});
    } catch {
      // Best-effort.
    }

    try {
      child.kill('SIGTERM');
    } catch {
      // ignored
    }

    this.running = false;
    this.closed = true;
    this.failAll(new Error('lsp: client stopped'));
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<any> {
    if (!this.child || this.closed) throw new Error('lsp: client is not running');

    const id = this.nextId++;
    const timeout = Math.max(1, timeoutMs ?? this.opts.requestTimeoutMs ?? 10000);

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`lsp: request timed out (${method}, ${timeout}ms)`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.writeMessage({ jsonrpc: '2.0', id, method, params });
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asErr(e));
      }
    });
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    if (!this.child || this.closed) throw new Error('lsp: client is not running');
    this.writeMessage({ jsonrpc: '2.0', method, params });
  }

  async didOpen(
    filePath: string,
    text: string,
    languageId = 'plaintext',
    version = 1
  ): Promise<void> {
    const uri = LspClient.filePathToUri(filePath);
    await this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version,
        text,
      },
    });
  }

  async didChange(filePath: string, text: string, version: number): Promise<void> {
    const uri = LspClient.filePathToUri(filePath);
    await this.notify('textDocument/didChange', {
      textDocument: {
        uri,
        version,
      },
      contentChanges: [{ text }],
    });
  }

  async didSave(filePath: string, text?: string): Promise<void> {
    const uri = LspClient.filePathToUri(filePath);
    await this.notify('textDocument/didSave', {
      textDocument: { uri },
      text,
    });
  }

  async didClose(filePath: string): Promise<void> {
    const uri = LspClient.filePathToUri(filePath);
    await this.notify('textDocument/didClose', {
      textDocument: { uri },
    });
  }

  private writeMessage(msg: any): void {
    if (!this.child) throw new Error('lsp: no process');
    this.child.stdin.write(encodeJsonRpcFrame(msg));
  }

  private failAll(err: Error) {
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private parseBuffer() {
    const { messages, remaining } = extractMessages(this.buffer);
    this.buffer = remaining;
    for (const msg of messages) {
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: any) {
    if (typeof msg?.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;

      this.pending.delete(msg.id);
      clearTimeout(p.timer);

      if (msg.error) {
        p.reject(new Error(`lsp: ${msg.error.message || 'request failed'}`));
        return;
      }

      p.resolve(msg.result ?? null);
      return;
    }

    if (msg?.method === 'textDocument/publishDiagnostics') {
      const params = msg.params as PublishDiagnosticsParams;
      if (params?.uri) {
        this.diagnosticsByUri.set(
          params.uri,
          Array.isArray(params.diagnostics) ? params.diagnostics : []
        );
      }
      this.onDiagnostics?.({
        uri: String(params?.uri ?? ''),
        diagnostics: Array.isArray(params?.diagnostics) ? params.diagnostics : [],
        version: typeof params?.version === 'number' ? params.version : undefined,
      });
      return;
    }
  }
}

function commandExists(command: string): boolean {
  const child = spawnSync('bash', ['-lc', `command -v ${shellEscape(command)} >/dev/null 2>&1`], {
    stdio: 'ignore',
  });

  return child.status === 0;
}

export function detectInstalledLspServers(opts?: {
  candidates?: LspServerCandidate[];
  hasCommand?: (command: string) => boolean;
}): DetectedLspServer[] {
  const candidates =
    Array.isArray(opts?.candidates) && opts!.candidates.length
      ? opts!.candidates
      : DEFAULT_LSP_CANDIDATES;
  const hasCommand = opts?.hasCommand ?? commandExists;

  const byLanguage = new Map<string, DetectedLspServer>();
  for (const c of candidates) {
    if (!c || !c.language || !c.command) continue;
    if (byLanguage.has(c.language)) continue;

    if (hasCommand(c.command)) {
      byLanguage.set(c.language, {
        language: c.language,
        command: c.command,
        args: Array.isArray(c.args) ? c.args.map((a) => String(a)) : [],
        found: true,
      });
    }
  }

  return [...byLanguage.values()].sort((a, b) => a.language.localeCompare(b.language));
}

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.java': 'java',
  '.rb': 'ruby',
  '.lua': 'lua',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.zsh': 'shellscript',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.sql': 'sql',
  '.zig': 'zig',
  '.svelte': 'svelte',
  '.vue': 'vue',
};

export function languageIdForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? 'plaintext';
}

export type LspManagerEntry = {
  language: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  client: LspClient;
};

export type LspServerConfig = {
  language: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
};

const SEVERITY_LABEL: Record<number, string> = {
  1: 'Error',
  2: 'Warning',
  3: 'Info',
  4: 'Hint',
};

export class LspManager {
  private servers = new Map<string, LspManagerEntry>();
  private rootPath: string;
  private openDocVersions = new Map<string, number>();
  private severityThreshold: number;
  private quiet: boolean;

  onDiagnostics?: (params: PublishDiagnosticsParams) => void;

  constructor(opts: { rootPath: string; severityThreshold?: number; quiet?: boolean }) {
    this.rootPath = opts.rootPath;
    this.severityThreshold = opts.severityThreshold ?? 1;
    this.quiet = opts.quiet ?? false;
  }

  async addServer(cfg: LspServerConfig): Promise<void> {
    if (!cfg.language || !cfg.command) return;
    if (cfg.enabled === false) return;
    if (this.servers.has(cfg.language)) return;

    const client = new LspClient({
      command: cfg.command,
      args: cfg.args,
      cwd: this.rootPath,
      rootPath: this.rootPath,
      env: cfg.env,
      requestTimeoutMs: 10000,
    });

    client.onDiagnostics = (params) => {
      this.onDiagnostics?.(params);
    };

    try {
      await client.start();
      this.servers.set(cfg.language, {
        language: cfg.language,
        command: cfg.command,
        args: Array.isArray(cfg.args) ? cfg.args : [],
        env: cfg.env,
        client,
      });
    } catch (e: any) {
      if (!this.quiet) {
        console.warn(
          `[lsp] failed to start ${cfg.language} server (${cfg.command}): ${e?.message ?? e}`
        );
      }
    }
  }

  hasServers(): boolean {
    return this.servers.size > 0;
  }

  listServers(): { language: string; command: string; running: boolean }[] {
    return [...this.servers.values()].map((e) => ({
      language: e.language,
      command: e.command,
      running: e.client.isRunning(),
    }));
  }

  private clientForFile(filePath: string): LspClient | null {
    const lang = languageIdForFile(filePath);
    const entry = this.servers.get(lang);
    if (entry?.client.isRunning()) return entry.client;

    // Try broader matches (e.g. typescript server handles javascript too).
    for (const [, e] of this.servers) {
      if (!e.client.isRunning()) continue;
      if (lang === 'javascript' && e.language === 'typescript') return e.client;
      if (lang === 'jsx' && e.language === 'typescript') return e.client;
    }
    return null;
  }

  async ensureOpen(filePath: string, text: string): Promise<void> {
    const client = this.clientForFile(filePath);
    if (!client) return;
    const lang = languageIdForFile(filePath);
    const uri = LspClient.filePathToUri(filePath);

    const version = (this.openDocVersions.get(uri) ?? 0) + 1;
    this.openDocVersions.set(uri, version);

    if (version === 1) {
      await client.didOpen(filePath, text, lang, version);
    } else {
      await client.didChange(filePath, text, version);
    }
  }

  async notifyDidSave(filePath: string, text?: string): Promise<void> {
    const client = this.clientForFile(filePath);
    if (!client) return;
    await client.didSave(filePath, text).catch(() => {});
  }

  async getDiagnostics(filePath?: string, severity?: number): Promise<string> {
    const threshold = severity ?? this.severityThreshold;
    if (filePath) {
      const client = this.clientForFile(filePath);
      if (!client) return `[lsp] no language server available for ${filePath}`;
      const diags = client.getDiagnostics(filePath).filter((d) => (d.severity ?? 1) <= threshold);
      if (!diags.length) return `No diagnostics for ${path.basename(filePath)}`;
      return formatDiagnostics(filePath, diags, 20);
    }

    // Project-wide: aggregate all servers.
    const lines: string[] = [];
    let totalCount = 0;
    const cap = 50;
    for (const [, entry] of this.servers) {
      if (!entry.client.isRunning()) continue;
      const allDiags = entry.client.getAllDiagnostics();
      for (const [uri, diags] of allDiags) {
        const filtered = diags.filter((d) => (d.severity ?? 1) <= threshold);
        if (!filtered.length) continue;
        const relPath = uriToRelPath(uri, this.rootPath);
        const remaining = cap - totalCount;
        if (remaining <= 0) break;
        lines.push(formatDiagnostics(relPath, filtered, remaining));
        totalCount += Math.min(filtered.length, remaining);
      }
      if (totalCount >= cap) break;
    }
    if (!lines.length) return 'No project diagnostics available (open files first)';
    if (totalCount >= cap) lines.push(`[+more diagnostics — filter by file for details]`);
    return lines.join('\n');
  }

  async getSymbols(filePath: string): Promise<string> {
    const client = this.clientForFile(filePath);
    if (!client) return `[lsp] no language server available for ${filePath}`;

    try {
      const uri = LspClient.filePathToUri(filePath);
      const result = await client.request('textDocument/documentSymbol', {
        textDocument: { uri },
      });

      if (!Array.isArray(result) || !result.length)
        return `No symbols found in ${path.basename(filePath)}`;

      return result
        .slice(0, 100)
        .map((s: any) => {
          const kind = symbolKindName(s.kind);
          const line = s.range?.start?.line ?? s.location?.range?.start?.line ?? '?';
          const detail = s.detail ? ` — ${s.detail}` : '';
          return `  L${typeof line === 'number' ? line + 1 : line}: ${kind} ${s.name}${detail}`;
        })
        .join('\n');
    } catch (e: any) {
      return `[lsp] symbols request failed: ${e?.message ?? e}`;
    }
  }

  async getHover(filePath: string, line: number, character: number): Promise<string> {
    const client = this.clientForFile(filePath);
    if (!client) return `[lsp] no language server available for ${filePath}`;

    try {
      const uri = LspClient.filePathToUri(filePath);
      const result = await client.request('textDocument/hover', {
        textDocument: { uri },
        position: { line, character },
      });

      if (!result?.contents) return 'No hover info available at this position';

      return extractHoverText(result.contents);
    } catch (e: any) {
      return `[lsp] hover failed: ${e?.message ?? e}`;
    }
  }

  async getDefinition(filePath: string, line: number, character: number): Promise<string> {
    const client = this.clientForFile(filePath);
    if (!client) return `[lsp] no language server available for ${filePath}`;

    try {
      const uri = LspClient.filePathToUri(filePath);
      const result = await client.request('textDocument/definition', {
        textDocument: { uri },
        position: { line, character },
      });

      if (!result) return 'No definition found';

      const locations = Array.isArray(result) ? result : [result];
      if (!locations.length) return 'No definition found';

      return locations
        .slice(0, 10)
        .map((loc: any) => {
          const locUri = loc.uri ?? loc.targetUri ?? '';
          const range = loc.range ?? loc.targetRange ?? {};
          const locPath = uriToRelPath(locUri, this.rootPath);
          const startLine = range?.start?.line ?? 0;
          return `${locPath}:${startLine + 1}`;
        })
        .join('\n');
    } catch (e: any) {
      return `[lsp] definition failed: ${e?.message ?? e}`;
    }
  }

  async getReferences(
    filePath: string,
    line: number,
    character: number,
    maxResults = 50
  ): Promise<string> {
    const client = this.clientForFile(filePath);
    if (!client) return `[lsp] no language server available for ${filePath}`;

    try {
      const uri = LspClient.filePathToUri(filePath);
      const result = await client.request('textDocument/references', {
        textDocument: { uri },
        position: { line, character },
        context: { includeDeclaration: true },
      });

      if (!Array.isArray(result) || !result.length) return 'No references found';

      const cap = Math.max(1, maxResults);
      const capped = result.slice(0, cap);
      const lines = capped.map((loc: any) => {
        const locUri = loc.uri ?? '';
        const locPath = uriToRelPath(locUri, this.rootPath);
        const startLine = loc.range?.start?.line ?? 0;
        return `${locPath}:${startLine + 1}`;
      });

      if (result.length > cap) {
        lines.push(`[+${result.length - cap} more — use search_files for full list]`);
      }

      return lines.join('\n');
    } catch (e: any) {
      return `[lsp] references failed: ${e?.message ?? e}`;
    }
  }

  async close(): Promise<void> {
    const entries = [...this.servers.values()];
    this.servers.clear();
    this.openDocVersions.clear();
    await Promise.allSettled(entries.map((e) => e.client.stop()));
  }
}

function formatDiagnostics(filePath: string, diags: LspDiagnostic[], cap: number): string {
  const name = path.basename(filePath);
  const capped = diags.slice(0, cap);
  const lines = capped.map((d) => {
    const line = (d.range?.start?.line ?? 0) + 1;
    const sev = SEVERITY_LABEL[d.severity ?? 1] ?? 'Error';
    const code = d.code ? ` [${d.code}]` : '';
    return `  ${name}:${line} ${sev}${code}: ${d.message}`;
  });
  if (diags.length > cap) {
    lines.push(`  [+${diags.length - cap} more diagnostics]`);
  }
  return lines.join('\n');
}

function symbolKindName(kind: number): string {
  const names: Record<number, string> = {
    1: 'File',
    2: 'Module',
    3: 'Namespace',
    4: 'Package',
    5: 'Class',
    6: 'Method',
    7: 'Property',
    8: 'Field',
    9: 'Constructor',
    10: 'Enum',
    11: 'Interface',
    12: 'Function',
    13: 'Variable',
    14: 'Constant',
    15: 'String',
    16: 'Number',
    17: 'Boolean',
    18: 'Array',
    19: 'Object',
    20: 'Key',
    21: 'Null',
    22: 'EnumMember',
    23: 'Struct',
    24: 'Event',
    25: 'Operator',
    26: 'TypeParameter',
  };
  return names[kind] ?? `Kind(${kind})`;
}

function extractHoverText(contents: any): string {
  if (typeof contents === 'string') return contents;
  if (typeof contents?.value === 'string') return contents.value;
  if (Array.isArray(contents)) {
    return contents
      .map((c: any) => (typeof c === 'string' ? c : (c?.value ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(contents);
}

function uriToRelPath(uri: string, rootPath: string): string {
  try {
    if (uri.startsWith('file://')) {
      const abs = new URL(uri).pathname;
      const rel = path.relative(rootPath, abs);
      return rel.startsWith('..') ? abs : rel;
    }
  } catch {}
  return uri;
}
