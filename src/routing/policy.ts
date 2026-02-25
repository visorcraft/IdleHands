/**
 * Routing policy module for IdleHands.
 * 
 * Determines whether to use "fast" or "heavy" mode based on input characteristics.
 * Outputs: `fast | heavy | auto-selected-fast | auto-selected-heavy`.
 */

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

/**
 * Heuristic scores for prompt complexity analysis.
 */
export type ComplexityHeuristics = {
  /** Length of the prompt in characters */
  promptLength: number;
  /** Number of words in the prompt */
  wordCount: number;
  /** Estimated token count (rough approximation: 1 word ≈ 1.3 tokens) */
  estimatedTokens: number;
  /** Presence of code blocks or technical syntax */
  hasCodeBlocks: boolean;
  /** Presence of complex instructions or multi-step tasks */
  hasComplexInstructions: boolean;
  /** Presence of file paths or directory references */
  hasFileReferences: boolean;
  /** Presence of natural language vs technical commands */
  isTechnical: boolean;
};

/**
 * Command type classification.
 */
export type CommandCategory = 
  | 'code'           // Code generation, refactoring, debugging
  | 'analysis'       // Code analysis, review, documentation
  | 'query'          // General questions, explanations
  | 'file'           // File operations, content manipulation
  | 'system'         // System commands, configuration
  | 'other';

/**
 * Requested routing mode from user input.
 */
export type RequestedMode = 
  | 'auto'           // Let the system decide
  | 'fast'           // Prefer fast/cheap model
  | 'heavy'          // Prefer heavy/smart model
  | undefined;       // No explicit request

/**
 * Model health status.
 */
export type ModelHealth = {
  /** Is the fast model available? */
  fastAvailable: boolean;
  /** Is the heavy model available? */
  heavyAvailable: boolean;
  /** Current latency to fast model (ms) */
  fastLatency?: number;
  /** Current latency to heavy model (ms) */
  heavyLatency?: number;
  /** Is there a known issue with any model? */
  hasIssues: boolean;
};

// ---------------------------------------------------------------------------
// Output Types
// ---------------------------------------------------------------------------

/**
 * Final routing decision.
 */
export type RoutingDecision = 
  | 'fast'                    // Use fast model directly
  | 'heavy'                   // Use heavy model directly
  | 'auto-selected-fast'      // Auto mode selected fast model
  | 'auto-selected-heavy';    // Auto mode selected heavy model

// ---------------------------------------------------------------------------
// Routing Configuration
// ---------------------------------------------------------------------------

/**
 * Routing policy configuration.
 */
export type RoutingConfig = {
  /** Default routing mode when not specified */
  defaultMode: 'auto' | 'fast' | 'heavy';
  /** Model identifier for fast mode */
  fastModel: string;
  /** Model identifier for heavy mode */
  heavyModel: string;
  /** Thresholds for auto-selection */
  thresholds: {
    /** Maximum prompt length (chars) to use fast model in auto mode */
    maxPromptLength: number;
    /** Maximum estimated tokens to use fast model in auto mode */
    maxTokens: number;
    /** Maximum word count for fast model in auto mode */
    maxWords: number;
  };
  /** Auto-escalation rules */
  autoEscalationRules: {
    /** Escalate to heavy if code blocks detected */
    codeBlocksThreshold: number;
    /** Escalate to heavy if file references detected */
    fileReferencesThreshold: number;
    /** Escalate to heavy if complex instructions detected */
    complexInstructionsThreshold: number;
  };
};

// ---------------------------------------------------------------------------
// Core Routing Logic
// ---------------------------------------------------------------------------

/**
 * Analyze prompt and compute complexity heuristics.
 */
export function analyzeComplexity(prompt: string): ComplexityHeuristics {
  const promptLength = prompt.length;
  const words = prompt.trim().split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  const estimatedTokens = Math.ceil(wordCount * 1.3);
  
  // Detect code blocks (``` or inline `code`)
  const codeBlockCount = (prompt.match(/```[\s\S]*?```/g) || []).length;
  const inlineCodeCount = (prompt.match(/`[^`]+`/g) || []).length;
  const hasCodeBlocks = codeBlockCount > 0 || inlineCodeCount > 5;
  
  // Detect complex instructions (numbered lists, bullet points, multi-step)
  const hasComplexInstructions = /(?:^|\n)(?:\d+\.|\-|\*|\+)\s+/m.test(prompt) && 
                                  prompt.split(/\n/).filter(l => l.trim().length > 0).length >= 3;
  
  // Detect file references (paths like src/, /home/, .ts, etc.) - more specific regex
  const hasFileReferences = /(?:^|\/)[\w\-]+(?:\/[\w\-]+)*(?:\.[a-zA-Z]{2,})|https?:\/\/[^\s]+/i.test(prompt);
  
  // Detect technical terms
  const technicalTerms = ['import', 'export', 'function', 'const', 'let', 'var', 'class', 'interface', 
                          'type', 'interface', 'async', 'await', 'return', 'if', 'else', 'for', 'while',
                          'try', 'catch', 'throw', 'new', 'this', 'public', 'private', 'protected',
                          'static', 'async', 'interface', 'implements', 'extends', 'abstract',
                          'namespace', 'module', 'import', 'export', 'from', 'require'];
  const promptLower = prompt.toLowerCase();
  const technicalCount = technicalTerms.reduce((count, term) => 
    count + (promptLower.split(new RegExp(`\\b${term}\\b`, 'g')).length - 1), 0);
  const isTechnical = technicalCount >= 3;
  
  return {
    promptLength,
    wordCount,
    estimatedTokens,
    hasCodeBlocks,
    hasComplexInstructions,
    hasFileReferences,
    isTechnical
  };
}

/**
 * Classify command category from prompt.
 */
export function classifyCommand(prompt: string): CommandCategory {
  const promptLower = prompt.toLowerCase();
  
  // Check for analysis-related keywords first (more specific)
  const analysisKeywords = ['analyze', 'review', 'explain', 'document', 'describe', 'summarize',
                            'evaluate', 'compare', 'discuss', 'interpret'];
  if (analysisKeywords.some(k => promptLower.includes(k))) {
    return 'analysis';
  }
  
  // Check for code-related keywords
  const codeKeywords = ['implement', 'create', 'build', 'write', 'fix', 'debug', 'refactor', 
                        'modify', 'add', 'remove', 'update', 'change', 'function', 'class'];
  if (codeKeywords.some(k => promptLower.includes(k))) {
    return 'code';
  }
  
  // Check for file-related keywords
  const fileKeywords = ['read', 'delete', 'move', 'copy', 'list', 'directory', 'folder', 'path'];
  if (fileKeywords.some(k => promptLower.includes(k))) {
    return 'file';
  }
  
  // Check for system-related keywords
  const systemKeywords = ['config', 'setup', 'install', 'run', 'build', 'test', 'deploy',
                          'server', 'docker', 'kubernetes', 'k8s'];
  if (systemKeywords.some(k => promptLower.includes(k))) {
    return 'system';
  }
  
  // Default to query for general questions
  return 'query';
}

/**
 * Determine routing decision based on inputs.
 * 
 * @param prompt - The user's input prompt
 * @param complexity - Pre-computed complexity heuristics (optional, will be computed if not provided)
 * @param commandCategory - Command category (optional, will be classified if not provided)
 * @param requestedMode - User-requested mode (auto/fast/heavy)
 * @param modelHealth - Current model availability and health
 * @param config - Routing configuration
 * @returns Routing decision
 */
export function determineRouting(
  prompt: string,
  complexity?: ComplexityHeuristics,
  commandCategory?: CommandCategory,
  requestedMode?: RequestedMode,
  modelHealth?: ModelHealth,
  config?: Partial<RoutingConfig>
): RoutingDecision {
  // Compute defaults if not provided
  const computedComplexity = complexity ?? analyzeComplexity(prompt);
  const computedCommandCategory = commandCategory ?? classifyCommand(prompt);
  const effectiveMode = requestedMode ?? 'auto';
  
  // Default configuration
  const defaultConfig: RoutingConfig = {
    defaultMode: 'auto',
    fastModel: 'default-fast',
    heavyModel: 'default-heavy',
    thresholds: {
      maxPromptLength: 500,
      maxTokens: 100,
      maxWords: 80
    },
    autoEscalationRules: {
      codeBlocksThreshold: 1,
      fileReferencesThreshold: 3,
      complexInstructionsThreshold: 1
    }
  };
  
  const finalConfig = { ...defaultConfig, ...config };
  
  // Check model health
  const fastAvailable = modelHealth?.fastAvailable ?? true;
  const heavyAvailable = modelHealth?.heavyAvailable ?? true;
  
  // If only one model is available, use it
  if (!fastAvailable && heavyAvailable) {
    return 'heavy';
  }
  if (fastAvailable && !heavyAvailable) {
    return 'fast';
  }
  if (!fastAvailable && !heavyAvailable) {
    // Both unavailable - this is an error case, default to heavy
    return 'heavy';
  }
  
  // Handle explicit mode requests
  if (effectiveMode === 'fast') {
    return 'fast';
  }
  if (effectiveMode === 'heavy') {
    return 'heavy';
  }
  
  // Auto mode - use heuristics
  const { thresholds, autoEscalationRules } = finalConfig;
  
  // Check for auto-escalation triggers
  let shouldEscalate = false;
  
  if (computedComplexity.hasCodeBlocks) {
    shouldEscalate = true;
  }
  
  if (computedComplexity.hasFileReferences) {
    shouldEscalate = true;
  }
  
  if (computedComplexity.hasComplexInstructions) {
    shouldEscalate = true;
  }
  
  // Check thresholds
  if (computedComplexity.promptLength > thresholds.maxPromptLength ||
      computedComplexity.estimatedTokens > thresholds.maxTokens ||
      computedComplexity.wordCount > thresholds.maxWords) {
    shouldEscalate = true;
  }
  
  // Command category-based escalation
  if (computedCommandCategory === 'code' || computedCommandCategory === 'analysis') {
    shouldEscalate = true;
  }
  
  return shouldEscalate ? 'auto-selected-heavy' : 'auto-selected-fast';
}

/**
 * Get model identifier for a routing decision.
 */
export function getModelForDecision(
  decision: RoutingDecision,
  config: RoutingConfig
): string {
  switch (decision) {
    case 'fast':
    case 'auto-selected-fast':
      return config.fastModel;
    case 'heavy':
    case 'auto-selected-heavy':
      return config.heavyModel;
  }
}