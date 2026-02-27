/**
 * Tool Schema Optimizer
 * 
 * Provides additional schema optimization beyond the basic caching:
 * - Description truncation for token savings
 * - Lazy tool loading based on context
 * - Schema deduplication across sessions
 * - Dynamic slim mode based on turn context
 */

import type { ToolSchema } from '../types.js';
import crypto from 'node:crypto';

/**
 * Hash a schema for deduplication.
 */
function hashSchema(schema: ToolSchema): string {
  const content = JSON.stringify(schema);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Estimate token count for a schema (rough approximation).
 */
function estimateSchemaTokens(schema: ToolSchema): number {
  const json = JSON.stringify(schema);
  // Rough estimate: ~4 chars per token for JSON
  return Math.ceil(json.length / 4);
}

export interface SchemaOptimizerStats {
  originalTokens: number;
  optimizedTokens: number;
  savings: number;
  savingsPercent: number;
}

export interface SlimSchemaOptions {
  /** Remove verbose descriptions */
  truncateDescriptions?: boolean;
  /** Max description length (default: 100) */
  maxDescriptionLength?: number;
  /** Remove examples from descriptions */
  removeExamples?: boolean;
  /** Remove optional parameters */
  removeOptionalParams?: boolean;
  /** Only include essential tools for the context */
  contextAware?: boolean;
}

/**
 * Truncate a description string, preserving the first sentence.
 */
function truncateDescription(desc: string, maxLen: number): string {
  if (!desc || desc.length <= maxLen) return desc;
  
  // Try to end at a sentence boundary
  const firstSentence = desc.match(/^[^.!?]+[.!?]/)?.[0];
  if (firstSentence && firstSentence.length <= maxLen) {
    return firstSentence;
  }
  
  // Otherwise truncate at word boundary
  const truncated = desc.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.7) {
    return truncated.slice(0, lastSpace) + '...';
  }
  return truncated + '...';
}

/**
 * Create a slim version of a tool schema for token efficiency.
 */
export function slimSchema(schema: ToolSchema, opts?: SlimSchemaOptions): ToolSchema {
  const options: Required<SlimSchemaOptions> = {
    truncateDescriptions: opts?.truncateDescriptions ?? true,
    maxDescriptionLength: opts?.maxDescriptionLength ?? 100,
    removeExamples: opts?.removeExamples ?? true,
    removeOptionalParams: opts?.removeOptionalParams ?? false,
    contextAware: opts?.contextAware ?? false,
  };

  const slim: ToolSchema = {
    type: schema.type,
    function: {
      name: schema.function.name,
      description: schema.function.description,
      parameters: JSON.parse(JSON.stringify(schema.function.parameters)),
    },
  };

  // Truncate function description
  if (options.truncateDescriptions && slim.function.description) {
    let desc = slim.function.description;
    
    // Remove examples (text after "Example:" or "Examples:")
    if (options.removeExamples) {
      desc = desc.replace(/\s*Examples?:[\s\S]*$/i, '');
    }
    
    slim.function.description = truncateDescription(desc, options.maxDescriptionLength);
  }

  // Truncate parameter descriptions
  if (options.truncateDescriptions && slim.function.parameters?.properties) {
    for (const [key, prop] of Object.entries(slim.function.parameters.properties)) {
      if (typeof prop === 'object' && prop !== null && 'description' in prop) {
        (prop as any).description = truncateDescription(
          (prop as any).description,
          options.maxDescriptionLength / 2
        );
      }
    }
  }

  // Remove optional parameters
  if (options.removeOptionalParams && slim.function.parameters) {
    const params = slim.function.parameters as { required?: string[]; properties?: Record<string, unknown> };
    const required = new Set<string>(params.required || []);
    const properties = params.properties || {};
    
    for (const key of Object.keys(properties)) {
      if (!required.has(key)) {
        delete (properties as Record<string, unknown>)[key];
      }
    }
  }

  return slim;
}

/**
 * Tools that are essential and should never be slimmed aggressively.
 */
const ESSENTIAL_TOOLS = new Set([
  'read_file',
  'edit_file',
  'write_file',
  'exec',
  'list_dir',
  'search_files',
]);

/**
 * Tools that can be deferred until explicitly needed.
 */
const DEFERRABLE_TOOLS = new Set([
  'spawn_task',
  'undo_file',
  'vault_store',
  'vault_search',
  'vault_delete',
  'lsp_diagnostics',
  'lsp_hover',
  'lsp_definition',
  'lsp_references',
]);

/**
 * Select tools based on context and turn history.
 */
export function selectToolsForContext(
  allTools: ToolSchema[],
  context: {
    /** Previous tool names used in this session */
    usedTools?: Set<string>;
    /** Current message content (for heuristics) */
    message?: string;
    /** Is this the first turn? */
    firstTurn?: boolean;
    /** Fast-lane mode? */
    fastLane?: boolean;
  }
): ToolSchema[] {
  const { usedTools, message, firstTurn, fastLane } = context;
  
  // Fast lane: minimal tool set
  if (fastLane) {
    return allTools.filter(t => 
      ESSENTIAL_TOOLS.has(t.function.name) && 
      !DEFERRABLE_TOOLS.has(t.function.name)
    );
  }

  // First turn: include everything except deferrable
  if (firstTurn) {
    return allTools.filter(t => !DEFERRABLE_TOOLS.has(t.function.name));
  }

  // Message hints: include tools that might be needed
  const includedNames = new Set<string>();
  
  // Always include essential tools
  for (const name of ESSENTIAL_TOOLS) {
    includedNames.add(name);
  }
  
  // Include previously used tools (likely to be used again)
  if (usedTools) {
    for (const name of usedTools) {
      includedNames.add(name);
    }
  }

  // Message-based hints
  if (message) {
    const lower = message.toLowerCase();
    
    if (lower.includes('undo') || lower.includes('revert')) {
      includedNames.add('undo_file');
    }
    if (lower.includes('spawn') || lower.includes('background') || lower.includes('parallel')) {
      includedNames.add('spawn_task');
    }
    if (lower.includes('vault') || lower.includes('secret') || lower.includes('credential')) {
      includedNames.add('vault_store');
      includedNames.add('vault_search');
    }
    if (lower.includes('diagnostic') || lower.includes('error') || lower.includes('lint')) {
      includedNames.add('lsp_diagnostics');
    }
    if (lower.includes('definition') || lower.includes('go to')) {
      includedNames.add('lsp_definition');
    }
  }

  return allTools.filter(t => includedNames.has(t.function.name));
}

/**
 * Optimize a list of schemas and return stats.
 */
export function optimizeSchemas(
  schemas: ToolSchema[],
  opts?: SlimSchemaOptions
): { schemas: ToolSchema[]; stats: SchemaOptimizerStats } {
  const originalTokens = schemas.reduce((sum, s) => sum + estimateSchemaTokens(s), 0);
  
  const optimized = schemas.map(s => slimSchema(s, opts));
  const optimizedTokens = optimized.reduce((sum, s) => sum + estimateSchemaTokens(s), 0);
  
  const savings = originalTokens - optimizedTokens;
  
  return {
    schemas: optimized,
    stats: {
      originalTokens,
      optimizedTokens,
      savings,
      savingsPercent: originalTokens > 0 ? (savings / originalTokens) * 100 : 0,
    },
  };
}

/**
 * Schema cache with deduplication across sessions.
 */
export class SchemaCache {
  private cache = new Map<string, { schema: ToolSchema; hash: string }>();
  private hashToSchema = new Map<string, ToolSchema>();

  /**
   * Get or create an optimized schema.
   */
  getOrCreate(original: ToolSchema, opts?: SlimSchemaOptions): ToolSchema {
    const key = `${original.function.name}:${JSON.stringify(opts || {})}`;
    
    const cached = this.cache.get(key);
    if (cached) return cached.schema;
    
    const optimized = slimSchema(original, opts);
    const hash = hashSchema(optimized);
    
    // Check if we already have this exact schema
    const existing = this.hashToSchema.get(hash);
    if (existing) {
      this.cache.set(key, { schema: existing, hash });
      return existing;
    }
    
    this.hashToSchema.set(hash, optimized);
    this.cache.set(key, { schema: optimized, hash });
    return optimized;
  }

  /**
   * Clear the cache.
   */
  clear(): void {
    this.cache.clear();
    this.hashToSchema.clear();
  }

  /**
   * Get cache stats.
   */
  stats(): { entries: number; uniqueSchemas: number } {
    return {
      entries: this.cache.size,
      uniqueSchemas: this.hashToSchema.size,
    };
  }
}
