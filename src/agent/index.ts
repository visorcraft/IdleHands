/**
 * Agent module barrel file - re-exports all agent submodules.
 * 
 * Organization:
 * - capture.ts: Session capture/logging
 * - client-pool.ts: Provider connection pooling
 * - compaction-scoring.ts: Message compaction heuristics
 * - context-budget.ts: Context window management
 * - conversation-branch.ts: Conversation threading
 * - exec-helpers.ts: Shell command parsing/normalization
 * - formatting.ts: Output formatting utilities
 * - prompt-builder.ts: System prompt construction
 * - query-classifier.ts: Query type classification
 * - resilient-provider.ts: Provider failover
 * - response-cache.ts: Response caching
 * - review-artifact.ts: Code review utilities
 * - semantic-search.ts: Embedding-based search
 * - session-utils.ts: Session state utilities
 * - subagent-context.ts: Sub-agent management
 * - tool-calls.ts: Tool call parsing/validation
 * - tool-loop-detection.ts: Loop detection algorithms
 * - tool-loop-guard.ts: Loop prevention guardrails
 * - tool-name-alias.ts: Tool name normalization
 * - tool-policy.ts: Tool permission policies
 * - tools-schema.ts: Tool schema generation
 */

export * from "./capture.js";
export * from "./client-pool.js";
export * from "./compaction-scoring.js";
export * from "./context-budget.js";
export * from "./conversation-branch.js";
export * from "./exec-helpers.js";
export * from "./formatting.js";
export * from "./prompt-builder.js";
export * from "./query-classifier.js";
export * from "./resilient-provider.js";
export * from "./response-cache.js";
export * from "./review-artifact.js";
export * from "./semantic-search.js";
export * from "./session-utils.js";
export * from "./subagent-context.js";
export * from "./tool-calls.js";
export * from "./tool-loop-detection.js";
export * from "./tool-loop-guard.js";
export * from "./tool-name-alias.js";
export * from "./tool-policy.js";
export * from "./tools-schema.js";

// Speed optimization modules
export * from "./file-prefetch.js";
export * from "./query-classifier-fast.js";
export * from "./predictive-compaction.js";
export * from "./schema-optimizer.js";
export * from "./read-ahead-buffer.js";
