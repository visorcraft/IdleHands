/**
 * Credential Leak Detector
 *
 * Scans outbound content (tool outputs, model responses) for potential
 * credential leaks before they reach the chat channel.
 *
 * Detects: API keys (Stripe, OpenAI, Anthropic, Google, GitHub),
 * AWS credentials, private keys (PEM), JWT tokens, database URLs,
 * generic secrets/passwords/tokens.
 *
 * Inspired by ZeroClaw's leak_detector.rs.
 */

export interface LeakResult {
  clean: boolean;
  patterns: string[];
  redacted: string;
}

type PatternDef = { re: RegExp; name: string; replacement: string };

const API_KEY_PATTERNS: PatternDef[] = [
  // Stripe
  { re: /sk_(live|test)_[a-zA-Z0-9]{24,}/g, name: 'Stripe secret key', replacement: '[REDACTED_STRIPE_KEY]' },
  { re: /pk_(live|test)_[a-zA-Z0-9]{24,}/g, name: 'Stripe publishable key', replacement: '[REDACTED_STRIPE_KEY]' },
  // OpenAI
  { re: /sk-[a-zA-Z0-9]{20,}T3BlbkFJ[a-zA-Z0-9]{20,}/g, name: 'OpenAI API key', replacement: '[REDACTED_OPENAI_KEY]' },
  { re: /sk-[a-zA-Z0-9]{48,}/g, name: 'OpenAI-style API key', replacement: '[REDACTED_API_KEY]' },
  // Anthropic
  { re: /sk-ant-[a-zA-Z0-9\-_]{32,}/g, name: 'Anthropic API key', replacement: '[REDACTED_ANTHROPIC_KEY]' },
  // Google
  { re: /AIza[a-zA-Z0-9_-]{35}/g, name: 'Google API key', replacement: '[REDACTED_GOOGLE_KEY]' },
  // GitHub
  { re: /gh[pousr]_[a-zA-Z0-9]{36,}/g, name: 'GitHub token', replacement: '[REDACTED_GITHUB_TOKEN]' },
  { re: /github_pat_[a-zA-Z0-9_]{22,}/g, name: 'GitHub PAT', replacement: '[REDACTED_GITHUB_PAT]' },
  // Generic API key assignment
  { re: /api[_-]?key[=:]\s*['"]?[a-zA-Z0-9_-]{20,}/gi, name: 'Generic API key', replacement: '[REDACTED_API_KEY]' },
];

const AWS_PATTERNS: PatternDef[] = [
  { re: /AKIA[A-Z0-9]{16}/g, name: 'AWS Access Key ID', replacement: '[REDACTED_AWS_KEY]' },
  { re: /aws[_-]?secret[_-]?access[_-]?key[=:]\s*['"]?[a-zA-Z0-9/+=]{40}/gi, name: 'AWS Secret Access Key', replacement: '[REDACTED_AWS_SECRET]' },
];

const GENERIC_SECRET_PATTERNS: PatternDef[] = [
  { re: /(?:password|passwd|pwd)[=:]\s*['"]?[^\s'"]{8,}/gi, name: 'Password in config', replacement: '[REDACTED_PASSWORD]' },
  { re: /(?:secret)[=:]\s*['"]?[a-zA-Z0-9_-]{16,}/gi, name: 'Secret value', replacement: '[REDACTED_SECRET]' },
  { re: /(?:token)[=:]\s*['"]?[a-zA-Z0-9_.-]{20,}/gi, name: 'Token value', replacement: '[REDACTED_TOKEN]' },
];

const JWT_PATTERN: PatternDef = {
  re: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+/g,
  name: 'JWT token',
  replacement: '[REDACTED_JWT]',
};

const DB_URL_PATTERNS: PatternDef[] = [
  { re: /postgres(?:ql)?:\/\/[^:]+:[^@]+@[^\s]+/g, name: 'PostgreSQL connection URL', replacement: '[REDACTED_DATABASE_URL]' },
  { re: /mysql:\/\/[^:]+:[^@]+@[^\s]+/g, name: 'MySQL connection URL', replacement: '[REDACTED_DATABASE_URL]' },
  { re: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^\s]+/g, name: 'MongoDB connection URL', replacement: '[REDACTED_DATABASE_URL]' },
  { re: /redis:\/\/[^:]+:[^@]+@[^\s]+/g, name: 'Redis connection URL', replacement: '[REDACTED_DATABASE_URL]' },
];

const PEM_MARKERS = [
  { begin: '-----BEGIN RSA PRIVATE KEY-----', end: '-----END RSA PRIVATE KEY-----', name: 'RSA private key' },
  { begin: '-----BEGIN EC PRIVATE KEY-----', end: '-----END EC PRIVATE KEY-----', name: 'EC private key' },
  { begin: '-----BEGIN PRIVATE KEY-----', end: '-----END PRIVATE KEY-----', name: 'Private key' },
  { begin: '-----BEGIN OPENSSH PRIVATE KEY-----', end: '-----END OPENSSH PRIVATE KEY-----', name: 'OpenSSH private key' },
];

export class LeakDetector {
  private sensitivity: number;

  constructor(sensitivity = 0.7) {
    this.sensitivity = Math.max(0, Math.min(1, sensitivity));
  }

  /** Scan content for credential leaks. */
  scan(content: string): LeakResult {
    const patterns: string[] = [];
    let redacted = content;

    const apply = (defs: PatternDef[], sensitivityGate = 0) => {
      if (this.sensitivity < sensitivityGate) return;
      for (const def of defs) {
        // Reset lastIndex for global regexes
        def.re.lastIndex = 0;
        if (def.re.test(content)) {
          patterns.push(def.name);
          def.re.lastIndex = 0;
          redacted = redacted.replace(def.re, def.replacement);
        }
      }
    };

    apply(API_KEY_PATTERNS);
    apply(AWS_PATTERNS);
    apply(GENERIC_SECRET_PATTERNS, 0.5);
    apply([JWT_PATTERN]);
    apply(DB_URL_PATTERNS);

    // PEM private keys
    for (const marker of PEM_MARKERS) {
      if (content.includes(marker.begin) && content.includes(marker.end)) {
        patterns.push(marker.name);
        const startIdx = redacted.indexOf(marker.begin);
        const endIdx = redacted.indexOf(marker.end);
        if (startIdx >= 0 && endIdx > startIdx) {
          redacted = redacted.slice(0, startIdx) + '[REDACTED_PRIVATE_KEY]' + redacted.slice(endIdx + marker.end.length);
        }
      }
    }

    return {
      clean: patterns.length === 0,
      patterns,
      redacted,
    };
  }

  /**
   * Convenience: redact content in-place.
   * Returns original content if clean, redacted version if leaks detected.
   */
  redactIfNeeded(content: string): string {
    const result = this.scan(content);
    return result.clean ? content : result.redacted;
  }
}
