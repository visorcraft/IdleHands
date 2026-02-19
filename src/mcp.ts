import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ToolSchema, McpServerConfig } from './types.js';
import { encodeJsonRpcFrame, extractMessages } from './jsonrpc.js';
import { PKG_VERSION } from './utils.js';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc?: '2.0';
  id?: number;
  result?: any;
  error?: {
    code?: number;
    message?: string;
    data?: any;
  };
  method?: string;
  params?: Record<string, unknown>;
};

interface RpcTransport {
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

function normalizeSchema(schema: any): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {},
    required: [],
  };
}

function estimateSchemaTokens(schema: ToolSchema): number {
  const json = JSON.stringify(schema);
  return Math.max(1, Math.ceil(json.length / 4));
}

function clampToolResult(raw: string, maxBytes = 4096): string {
  const buf = Buffer.from(raw ?? '', 'utf8');
  if (buf.length <= maxBytes) return raw;
  const cut = buf.subarray(0, maxBytes).toString('utf8');
  return `${cut}\n[truncated, ${buf.length} bytes total]`;
}

function parseToolCallResult(result: any): string {
  if (result == null) return '';

  // MCP tool result often looks like:
  // { content: [{ type: 'text', text: '...' }], isError?: boolean }
  if (Array.isArray(result?.content)) {
    const parts: string[] = [];
    for (const item of result.content) {
      if (!item) continue;
      if (typeof item.text === 'string') {
        parts.push(item.text);
      } else if (typeof item.data === 'string') {
        parts.push(item.data);
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    return parts.join('\n').trim() || JSON.stringify(result);
  }

  if (typeof result?.content === 'string') {
    return result.content;
  }

  if (typeof result?.text === 'string') {
    return result.text;
  }

  return JSON.stringify(result);
}

function asArray<T = any>(v: any): T[] {
  if (Array.isArray(v)) return v as T[];
  return [];
}

function toErrorMessage(e: any): string {
  return e?.message ?? String(e);
}

class StdioRpcTransport implements RpcTransport {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private stderrTail = '';

  constructor(command: string, args: string[], env?: Record<string, string>) {
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(env ?? {}) },
    });

    this.child.stdout.on('data', (chunk: Buffer | string) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffer = Buffer.concat([this.buffer, b]);
      this.parseBuffer();
    });

    this.child.stderr.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.stderrTail = (this.stderrTail + text).slice(-2000);
    });

    this.child.on('error', (err) => {
      this.failAll(new Error(`MCP stdio transport error: ${err.message}`));
    });

    this.child.on('close', (code, signal) => {
      this.closed = true;
      const reason = `MCP stdio transport closed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      const tail = this.stderrTail.trim();
      const msg = tail ? `${reason}; stderr: ${tail}` : reason;
      this.failAll(new Error(msg));
    });
  }

  private failAll(err: Error) {
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private writeFrame(message: JsonRpcRequest): void {
    if (this.closed) throw new Error('MCP stdio transport is closed');
    this.child.stdin.write(encodeJsonRpcFrame(message as unknown as Record<string, unknown>));
  }

  private parseBuffer() {
    const { messages, remaining } = extractMessages(this.buffer);
    this.buffer = remaining;
    for (const msg of messages) {
      this.handleParsedMessage(msg as JsonRpcResponse);
    }

    // Fallback: newline-delimited JSON for non-standard test servers
    while (this.buffer.length > 0) {
      const prefix = this.buffer.subarray(0, Math.min(32, this.buffer.length)).toString('utf8').toLowerCase();
      if (prefix.startsWith('content-length')) return; // incomplete header, wait

      const nl = this.buffer.indexOf(0x0a);
      if (nl < 0) return;
      const line = this.buffer.subarray(0, nl).toString('utf8').trim();
      this.buffer = Buffer.from(this.buffer.subarray(nl + 1));
      if (!line) continue;
      try {
        this.handleParsedMessage(JSON.parse(line) as JsonRpcResponse);
      } catch { /* skip malformed lines */ }
    }
  }

  private handleParsedMessage(msg: JsonRpcResponse) {

    if (typeof msg.id !== 'number') {
      // Notification / event, ignore for now.
      return;
    }

    const pending = this.pending.get(msg.id);
    if (!pending) return;

    this.pending.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error) {
      pending.reject(new Error(msg.error.message || `MCP error code ${msg.error.code ?? 'unknown'}`));
      return;
    }

    pending.resolve(msg.result ?? null);
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const id = this.nextId++;

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method} after ${timeoutMs}ms`));
      }, Math.max(1, timeoutMs));

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });

      try {
        this.writeFrame({
          jsonrpc: '2.0',
          id,
          method,
          params,
        });
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    this.writeFrame({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.kill('SIGTERM');
    } catch {}
  }
}

class HttpRpcTransport implements RpcTransport {
  private nextId = 1;
  constructor(private readonly url: string) {}

  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutMs));

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: ac.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const json: any = await res.json().catch(() => ({}));
      if (json?.error) {
        throw new Error(json.error.message || `MCP error code ${json.error.code ?? 'unknown'}`);
      }
      return json?.result ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: ac.signal,
      }).catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    // nothing to close
  }
}

export type McpServerStatus = {
  name: string;
  transport: 'stdio' | 'http';
  connected: boolean;
  toolsTotal: number;
  toolsEnabled: number;
  error?: string;
};

export type McpToolStatus = {
  name: string;
  server: string;
  description?: string;
  readOnly: boolean;
  enabled: boolean;
  estimatedTokens: number;
};

type ManagedTool = {
  name: string;
  server: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  estimatedTokens: number;
  enabled: boolean;
  rank: number;
};

type ManagedServer = {
  config: McpServerConfig;
  transport?: RpcTransport;
  connected: boolean;
  tools: string[];
  error?: string;
};

export class MCPManager {
  private servers = new Map<string, ManagedServer>();
  private tools = new Map<string, ManagedTool>();
  private warnings: string[] = [];
  private nextRank = 0;

  private readonly toolBudgetTokens: number;
  private readonly callTimeoutMs: number;
  private readonly builtInToolNames: Set<string>;
  private readonly globalEnabledTools: Set<string> | null;

  constructor(private readonly opts: {
    servers: McpServerConfig[];
    toolBudgetTokens?: number;
    callTimeoutMs?: number;
    offline?: boolean;
    builtInToolNames?: Iterable<string>;
    enabledTools?: string[];
  }) {
    this.toolBudgetTokens = Number.isFinite(opts.toolBudgetTokens)
      ? Math.max(0, Math.floor(opts.toolBudgetTokens as number))
      : 1000;
    this.callTimeoutMs = Number.isFinite(opts.callTimeoutMs)
      ? Math.max(1000, Math.floor(opts.callTimeoutMs as number))
      : 30_000;
    this.builtInToolNames = new Set(opts.builtInToolNames ?? []);
    this.globalEnabledTools = Array.isArray(opts.enabledTools) && opts.enabledTools.length
      ? new Set(opts.enabledTools)
      : null;
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  private pushWarn(msg: string) {
    this.warnings.push(msg);
  }

  async init(): Promise<void> {
    this.warnings = [];
    this.servers.clear();
    this.tools.clear();

    for (const rawCfg of this.opts.servers) {
      if (!rawCfg || typeof rawCfg !== 'object') continue;
      const name = String(rawCfg.name ?? '').trim();
      if (!name) continue;
      if (this.servers.has(name)) {
        this.pushWarn(`[mcp] duplicate server name '${name}' ignored`);
        continue;
      }

      const transport: 'stdio' | 'http' = rawCfg.transport === 'http' ? 'http' : 'stdio';
      const cfg: McpServerConfig = {
        ...rawCfg,
        name,
        transport,
        args: asArray<string>(rawCfg.args).map((a) => String(a)),
      };

      if (cfg.enabled === false) {
        this.servers.set(name, { config: cfg, connected: false, tools: [], error: 'disabled' });
        continue;
      }

      if (this.opts.offline && cfg.transport === 'http') {
        this.servers.set(name, {
          config: cfg,
          connected: false,
          tools: [],
          error: 'offline mode: HTTP MCP transport disabled',
        });
        this.pushWarn(`[mcp] ${name}: skipped HTTP server in offline mode`);
        continue;
      }

      const server = await this.connectServer(cfg);
      this.servers.set(name, server);
    }

    this.recomputeBudget();
  }

  private async connectServer(cfg: McpServerConfig): Promise<ManagedServer> {
    const name = cfg.name;
    const server: ManagedServer = {
      config: cfg,
      connected: false,
      tools: [],
    };

    try {
      let transport: RpcTransport;
      if (cfg.transport === 'http') {
        const url = String(cfg.url ?? '').trim();
        if (!url) throw new Error('missing url');
        transport = new HttpRpcTransport(url);
      } else {
        const command = String(cfg.command ?? '').trim();
        if (!command) throw new Error('missing command');
        transport = new StdioRpcTransport(command, cfg.args ?? [], cfg.env);
      }

      server.transport = transport;

      // Best-effort initialize handshake.
      try {
        await transport.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'idlehands',
            version: PKG_VERSION,
          },
        }, this.callTimeoutMs);

        await transport.notify('notifications/initialized', {});
      } catch {
        // Not all servers require/implement initialize exactly; continue.
      }

      const listResult = await transport.request('tools/list', {}, this.callTimeoutMs);
      const list = asArray<any>(listResult?.tools);

      const serverAllowed = Array.isArray(cfg.enabled_tools) && cfg.enabled_tools.length
        ? new Set(cfg.enabled_tools)
        : null;

      for (const rawTool of list) {
        const toolName = String(rawTool?.name ?? '').trim();
        if (!toolName) continue;

        if (this.builtInToolNames.has(toolName)) {
          this.pushWarn(`[mcp] ${name}: skipped '${toolName}' (conflicts with built-in tool)`);
          continue;
        }

        if (this.tools.has(toolName)) {
          this.pushWarn(`[mcp] ${name}: skipped '${toolName}' (duplicate MCP tool name)`);
          continue;
        }

        const schema: ToolSchema = {
          type: 'function',
          function: {
            name: toolName,
            description: `[mcp:${name}] ${String(rawTool?.description ?? 'MCP tool').trim()}`,
            parameters: normalizeSchema(rawTool?.inputSchema),
          },
        };

        const enabledByAllowList =
          (!this.globalEnabledTools || this.globalEnabledTools.has(toolName)) &&
          (!serverAllowed || serverAllowed.has(toolName));

        const readOnly = Boolean(
          rawTool?.readOnly ??
          rawTool?.annotations?.readOnlyHint ??
          rawTool?.annotations?.readOnly ??
          false
        );

        this.tools.set(toolName, {
          name: toolName,
          server: name,
          description: typeof rawTool?.description === 'string' ? rawTool.description : undefined,
          inputSchema: normalizeSchema(rawTool?.inputSchema),
          readOnly,
          estimatedTokens: estimateSchemaTokens(schema),
          enabled: enabledByAllowList,
          rank: this.nextRank++,
        });
        server.tools.push(toolName);
      }

      server.connected = true;
      return server;
    } catch (e: any) {
      server.connected = false;
      server.error = toErrorMessage(e);
      if (server.transport) {
        await server.transport.close().catch(() => {});
      }
      this.pushWarn(`[mcp] ${name}: ${server.error}`);
      return server;
    }
  }

  private recomputeBudget() {
    const budget = this.toolBudgetTokens;
    let used = 0;

    const ordered = [...this.tools.values()].sort((a, b) => a.rank - b.rank);
    for (const tool of ordered) {
      if (!tool.enabled) continue;
      const next = used + tool.estimatedTokens;
      if (next > budget) {
        tool.enabled = false;
      } else {
        used = next;
      }
    }

    const disabledByBudget = ordered.filter((t) => !t.enabled).length;
    if (disabledByBudget > 0) {
      this.pushWarn(`[mcp] tool schema budget exceeded (${budget} tokens): ${disabledByBudget} tool(s) disabled`);
    }
  }

  listServers(): McpServerStatus[] {
    const out: McpServerStatus[] = [];
    for (const s of this.servers.values()) {
      const enabled = s.tools.filter((n) => this.tools.get(n)?.enabled).length;
      out.push({
        name: s.config.name,
        transport: s.config.transport,
        connected: s.connected,
        toolsTotal: s.tools.length,
        toolsEnabled: enabled,
        error: s.error,
      });
    }
    return out;
  }

  listTools(opts?: { includeDisabled?: boolean }): McpToolStatus[] {
    const includeDisabled = opts?.includeDisabled === true;
    const out: McpToolStatus[] = [];
    for (const t of [...this.tools.values()].sort((a, b) => a.rank - b.rank)) {
      if (!includeDisabled && !t.enabled) continue;
      out.push({
        name: t.name,
        server: t.server,
        description: t.description,
        readOnly: t.readOnly,
        enabled: t.enabled,
        estimatedTokens: t.estimatedTokens,
      });
    }
    return out;
  }

  getEnabledToolSchemas(): ToolSchema[] {
    const schemas: ToolSchema[] = [];
    for (const t of [...this.tools.values()].sort((a, b) => a.rank - b.rank)) {
      if (!t.enabled) continue;
      schemas.push({
        type: 'function',
        function: {
          name: t.name,
          description: `[mcp:${t.server}] ${t.description || 'MCP tool'}`,
          parameters: normalizeSchema(t.inputSchema),
        },
      });
    }
    return schemas;
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  isToolReadOnly(name: string): boolean {
    return Boolean(this.tools.get(name)?.readOnly);
  }

  enableTool(name: string): boolean {
    const t = this.tools.get(name);
    if (!t) return false;
    if (t.enabled) return true;

    const used = this.listTools().reduce((acc, cur) => acc + cur.estimatedTokens, 0);
    if (used + t.estimatedTokens > this.toolBudgetTokens) {
      return false;
    }

    t.enabled = true;
    return true;
  }

  disableTool(name: string): boolean {
    const t = this.tools.get(name);
    if (!t) return false;
    t.enabled = false;
    return true;
  }

  async restartServer(name: string): Promise<{ ok: boolean; message: string }> {
    const existing = this.servers.get(name);
    if (!existing) return { ok: false, message: `unknown MCP server: ${name}` };

    if (existing.transport) {
      await existing.transport.close().catch(() => {});
    }

    // Drop old tools for this server first.
    for (const toolName of existing.tools) {
      this.tools.delete(toolName);
    }

    const next = await this.connectServer(existing.config);
    this.servers.set(name, next);
    this.recomputeBudget();

    if (!next.connected) {
      return { ok: false, message: `MCP server ${name} restart failed: ${next.error || 'unknown error'}` };
    }

    return { ok: true, message: `MCP server ${name} reconnected (${next.tools.length} tools)` };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown MCP tool: ${name}`);
    if (!tool.enabled) throw new Error(`MCP tool disabled: ${name}`);

    const server = this.servers.get(tool.server);
    if (!server?.transport || !server.connected) {
      throw new Error(`MCP server unavailable: ${tool.server}`);
    }

    const result = await server.transport.request('tools/call', {
      name,
      arguments: args ?? {},
    }, this.callTimeoutMs);

    if (result?.isError) {
      const msg = parseToolCallResult(result) || `MCP tool error: ${name}`;
      throw new Error(msg);
    }

    const text = parseToolCallResult(result);
    return clampToolResult(text, 4096);
  }

  async close(): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const s of this.servers.values()) {
      if (s.transport) closes.push(s.transport.close().catch(() => {}));
    }
    await Promise.all(closes);
  }
}
