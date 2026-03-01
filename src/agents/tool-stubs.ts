// Tool stub schema utilities for IdleHands
// This file will be copied to ~/repos/idlehands/src/agents/tool-stubs.ts

import type { ToolStubModeConfig } from "../config/types.tools.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

/**
 * Strips a tool's parameter schema to a minimal stub.
 * The tool retains its name, description, and execute function,
 * but parameters become an empty object schema.
 */
export function stripToStubSchema(tool: AnyAgentTool): AnyAgentTool {
  return {
    ...tool,
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  };
}

/**
 * Apply stub mode to a list of tools based on configuration.
 * Tools in fullSchemaTools retain their full schemas.
 */
export function applyStubMode(
  tools: AnyAgentTool[],
  config: ToolStubModeConfig | undefined,
): AnyAgentTool[] {
  if (!config?.enabled) {
    return tools;
  }

  const fullSchemaSet = new Set((config.fullSchemaTools ?? []).map((name) => name.toLowerCase()));

  let stubbedCount = 0,
    fullCount = 0;
  const result = tools.map((tool) => {
    const normalizedName = tool.name.toLowerCase();
    if (fullSchemaSet.has(normalizedName)) {
      fullCount++;
      return tool;
    }
    stubbedCount++;
    return stripToStubSchema(tool);
  });
  console.log(`[tool-stubs] Applied: ${stubbedCount} stubbed, ${fullCount} full`);
  return result;
}

/**
 * Generate tool usage guidance for the system prompt.
 * This provides the model with parameter information that was stripped from schemas.
 */
export function generateToolStubGuidance(tools: AnyAgentTool[]): string {
  const lines: string[] = [
    "## Tool Usage (Stub Mode)",
    "",
    "Tool schemas are minimal. Use these parameter guides:",
    "",
  ];

  for (const tool of tools) {
    const params = extractParameterSummary(tool);
    if (params.length === 0) {
      lines.push(`- **${tool.name}**: ${tool.description || "(no description)"}`);
    } else {
      lines.push(`- **${tool.name}**: ${tool.description || ""}`);
      for (const param of params) {
        const req = param.required ? " (required)" : "";
        lines.push(`  - \`${param.name}\`: ${param.description}${req}`);
      }
    }
  }

  return lines.join("\n");
}

type ParamSummary = {
  name: string;
  description: string;
  required: boolean;
};

function extractParameterSummary(tool: AnyAgentTool): ParamSummary[] {
  const schema = tool.parameters;
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (!properties || typeof properties !== "object") {
    return [];
  }

  const required = new Set(
    Array.isArray(record.required)
      ? (record.required as string[]).filter((r) => typeof r === "string")
      : [],
  );

  const summaries: ParamSummary[] = [];
  for (const [name, prop] of Object.entries(properties as Record<string, unknown>)) {
    if (!prop || typeof prop !== "object") {
      continue;
    }
    const propRecord = prop as Record<string, unknown>;
    const description =
      typeof propRecord.description === "string"
        ? propRecord.description
        : typeof propRecord.type === "string"
          ? propRecord.type
          : "any";

    summaries.push({
      name,
      description,
      required: required.has(name),
    });
  }

  return summaries;
}

/**
 * Build compact tool guidance for common coding tools.
 * This is optimized for local models with limited context.
 */
export function buildCompactToolGuidance(): string {
  return `## Tools

Call tools with JSON: {"tool": "name", "params": {...}}

**exec** - Run shell commands
  command (required): Shell command to execute
  workdir: Working directory
  timeout: Timeout in seconds
  background: Run in background (true/false)

**read** - Read file contents  
  path (required): File path to read
  offset: Start line (1-indexed)
  limit: Max lines to read

**write** - Create/overwrite files
  path (required): File path to write
  content (required): Content to write

**edit** - Precise text replacement
  path (required): File path to edit
  old_string (required): Exact text to find
  new_string (required): Replacement text

**process** - Manage background processes
  action (required): list|poll|kill|log
  sessionId: Session ID for poll/kill/log
  timeout: Poll timeout in ms`;
}
