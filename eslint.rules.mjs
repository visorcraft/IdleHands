/**
 * Custom ESLint rules for IdleHands project.
 */

/**
 * Rule: no-duplicate-formatter-logic
 *
 * Prevents duplicate platform formatter logic for identical event types.
 *
 * The shared formatter module (src/bot/ux/shared-formatter.ts) contains
 * common truncation logic that should be reused by all platform renderers.
 * This rule detects when a platform renderer implements its own truncation
 * instead of importing from the shared module.
 */
export const noDuplicateFormatterLogic = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Prevent duplicate platform formatter logic for identical event types',
      category: 'Best Practices',
      recommended: true,
    },
    schema: [],
    messages: {
      noDuplicateFormatter:
        'Use shared formatter logic from shared-formatter.ts instead of implementing duplicate truncation logic. Import truncateBlocks or renderDiscordMarkdown/renderTelegramHtml from the shared module.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const filePath = context.filename;

    // Skip the shared formatter module itself
    if (filePath.includes('shared-formatter.ts')) {
      return {};
    }

    // Only check platform renderer files (discord-renderer.ts, telegram-renderer.ts, etc.)
    // but NOT shared-formatter.ts
    const isPlatformRenderer = /-(renderer)\.ts$/.test(filePath);
    if (!isPlatformRenderer) {
      return {};
    }

    return {
      // Look for function declarations that match common formatter patterns
      FunctionDeclaration(node) {
        // Check if this is a formatter function with truncation logic
        if (isTruncationFunction(node)) {
          context.report({
            node,
            messageId: 'noDuplicateFormatter',
          });
        }
      },

      // Look for variable declarations of arrow functions with truncation logic
      VariableDeclarator(node) {
        if (node.init && isTruncationFunction(node.init)) {
          context.report({
            node,
            messageId: 'noDuplicateFormatter',
          });
        }
      },
    };

    /**
     * Check if a function node contains truncation logic pattern
     */
    function isTruncationFunction(node) {
      // Must be a function with 'render' or 'format' in the name
      const name = node.id?.name || '';
      if (!name.includes('render') && !name.includes('format')) {
        return false;
      }

      // Must have parameters for blocks and options
      const params = node.params;
      if (params.length < 2) {
        return false;
      }

      // Check for truncation pattern in function body
      const hasTruncationPattern = hasTruncationLogic(node.body);

      return hasTruncationPattern;
    }

    /**
     * Check if function body contains truncation logic
     */
    function hasTruncationLogic(body) {
      if (!body || !body.body) return false;

      const bodyText = sourceCode.getText(body);

      // Look for truncation patterns
      const patterns = [
        // Pattern 1: parts array with used/truncated tracking
        /const\s+parts\s*=\s*\[\]/,
        /let\s+used\s*=/,
        /truncated\s*=/,
        // Pattern 2: maxLen calculation
        /maxLen\s*=/,
        // Pattern 3: length checking and truncation
        /used\s*\+\s*add\.length\s*>/,
        /truncated\s*=\s*true/,
        // Pattern 4: ellipsis handling
        /\.\.\./,
        // Pattern 5: fallback handling
        /Thinking\.\.\./,
      ];

      let matches = 0;
      for (const pattern of patterns) {
        if (pattern.test(bodyText)) {
          matches++;
        }
      }

      // Require at least 4 patterns to match (indicates intentional truncation logic)
      return matches >= 4;
    }
  },
};
