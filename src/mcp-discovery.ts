/**
 * MCP Server Auto-Discovery
 *
 * Scans for common MCP configuration files in a project directory
 * and returns discovered server configurations.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export type DiscoveredMcpServer = {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  source: string; // which config file it was found in
};

/** Well-known MCP config file locations (relative to project root). */
const MCP_CONFIG_FILES = [
  '.mcp.json',
  '.mcp/config.json',
  'mcp.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
];

/**
 * Scan a project directory for MCP server configurations.
 */
export async function discoverMcpServers(projectDir: string): Promise<DiscoveredMcpServer[]> {
  const servers: DiscoveredMcpServer[] = [];

  for (const relPath of MCP_CONFIG_FILES) {
    const fullPath = path.join(projectDir, relPath);
    try {
      const raw = await fs.readFile(fullPath, 'utf8');
      const parsed = JSON.parse(raw);
      const found = extractServers(parsed, relPath);
      servers.push(...found);
    } catch {
      // File doesn't exist or isn't valid JSON — skip
    }
  }

  // Also check package.json for mcp field
  try {
    const pkgPath = path.join(projectDir, 'package.json');
    const raw = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg.mcp?.servers) {
      const found = extractServers(pkg.mcp, 'package.json#mcp');
      servers.push(...found);
    }
  } catch {
    // No package.json or no mcp field — skip
  }

  return servers;
}

function extractServers(config: any, source: string): DiscoveredMcpServer[] {
  const servers: DiscoveredMcpServer[] = [];

  // Format 1: { servers: { name: { command, args, ... } } }
  if (config?.servers && typeof config.servers === 'object') {
    for (const [name, def] of Object.entries(config.servers)) {
      const server = parseServerDef(name, def as any, source);
      if (server) servers.push(server);
    }
  }

  // Format 2: { mcpServers: { name: { ... } } } (Cursor/VSCode format)
  if (config?.mcpServers && typeof config.mcpServers === 'object') {
    for (const [name, def] of Object.entries(config.mcpServers)) {
      const server = parseServerDef(name, def as any, source);
      if (server) servers.push(server);
    }
  }

  return servers;
}

function parseServerDef(name: string, def: any, source: string): DiscoveredMcpServer | null {
  if (!def || typeof def !== 'object') return null;

  // SSE transport
  if (def.url || def.transport === 'sse') {
    return {
      name,
      transport: 'sse',
      url: def.url,
      source,
    };
  }

  // Stdio transport
  if (def.command) {
    return {
      name,
      transport: 'stdio',
      command: def.command,
      args: Array.isArray(def.args) ? def.args : [],
      source,
    };
  }

  return null;
}

/**
 * Format discovered servers for display.
 */
export function formatDiscoveredServers(servers: DiscoveredMcpServer[]): string[] {
  if (!servers.length) return ['No MCP servers discovered.'];

  return servers.map((s) => {
    const transport = s.transport === 'sse' ? `SSE ${s.url}` : `stdio: ${s.command} ${(s.args ?? []).join(' ')}`;
    return `  • ${s.name} (${transport}) [${s.source}]`;
  });
}
