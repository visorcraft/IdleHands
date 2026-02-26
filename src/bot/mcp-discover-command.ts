import type { CmdResult, ManagedLike } from './command-logic.js';
import { discoverMcpServers, formatDiscoveredServers } from '../mcp-discovery.js';

/**
 * /mcp_discover — Scan project for MCP server configurations.
 */
export async function mcpDiscoverCommand(managed: ManagedLike): Promise<CmdResult> {
  const projectDir = managed.workingDir;
  
  try {
    const servers = await discoverMcpServers(projectDir);
    const lines = formatDiscoveredServers(servers);
    
    if (!servers.length) {
      return {
        title: 'MCP Discovery',
        lines: [
          'No MCP server configurations found in:',
          `  ${projectDir}`,
          '',
          'Checked:',
          '  .mcp.json, mcp.json, .cursor/mcp.json, .vscode/mcp.json, package.json#mcp',
        ],
      };
    }
    
    return {
      title: `MCP Discovery (${servers.length} found)`,
      lines: [
        `Project: ${projectDir}`,
        '',
        ...lines,
      ],
    };
  } catch (e: any) {
    return { error: `Discovery failed: ${e?.message ?? e}` };
  }
}
