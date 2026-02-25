import { describe, it, expect } from 'vitest';
import { LeakDetector } from '../src/security/leak-detector.js';

describe('LeakDetector', () => {
  const detector = new LeakDetector();

  it('passes clean content', () => {
    const result = detector.scan('This is just normal text about coding');
    expect(result.clean).toBe(true);
    expect(result.patterns).toHaveLength(0);
  });

  it('detects Stripe secret keys', () => {
    const result = detector.scan('My key is sk_test_1234567890abcdefghijklmnop');
    expect(result.clean).toBe(false);
    expect(result.patterns).toContain('Stripe secret key');
    expect(result.redacted).toContain('[REDACTED_STRIPE_KEY]');
    expect(result.redacted).not.toContain('sk_test_');
  });

  it('detects OpenAI-style keys', () => {
    const result = detector.scan('sk-' + 'a'.repeat(50));
    expect(result.clean).toBe(false);
    expect(result.patterns.some((p) => p.includes('API key'))).toBe(true);
  });

  it('detects Anthropic keys', () => {
    const result = detector.scan('sk-ant-' + 'a'.repeat(40));
    expect(result.clean).toBe(false);
    expect(result.patterns).toContain('Anthropic API key');
  });

  it('detects GitHub tokens', () => {
    const result = detector.scan('ghp_' + 'a'.repeat(40));
    expect(result.clean).toBe(false);
    expect(result.patterns).toContain('GitHub token');
  });

  it('detects AWS Access Key IDs', () => {
    const result = detector.scan('AWS key: AKIAIOSFODNN7EXAMPLE');
    expect(result.clean).toBe(false);
    expect(result.patterns).toContain('AWS Access Key ID');
  });

  it('detects private keys (PEM)', () => {
    const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----';
    const result = detector.scan(content);
    expect(result.clean).toBe(false);
    expect(result.patterns).toContain('RSA private key');
    expect(result.redacted).toContain('[REDACTED_PRIVATE_KEY]');
  });

  it('detects JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = detector.scan(`Bearer ${jwt}`);
    expect(result.clean).toBe(false);
    expect(result.patterns).toContain('JWT token');
    expect(result.redacted).toContain('[REDACTED_JWT]');
  });

  it('detects PostgreSQL connection URLs', () => {
    const result = detector.scan('DATABASE_URL=postgres://user:secretpassword@localhost:5432/mydb');
    expect(result.clean).toBe(false);
    expect(result.patterns).toContain('PostgreSQL connection URL');
  });

  it('detects MongoDB connection URLs', () => {
    const result = detector.scan('mongodb+srv://admin:pass123@cluster.example.com/db');
    expect(result.clean).toBe(false);
    expect(result.patterns).toContain('MongoDB connection URL');
  });

  it('detects generic password assignments', () => {
    const result = detector.scan('password=mysuperpassword123');
    expect(result.clean).toBe(false);
    expect(result.patterns).toContain('Password in config');
  });

  it('redactIfNeeded returns original for clean content', () => {
    const text = 'Normal code here';
    expect(detector.redactIfNeeded(text)).toBe(text);
  });

  it('redactIfNeeded returns redacted for leaky content', () => {
    const text = 'key: sk_test_' + 'a'.repeat(30);
    const redacted = detector.redactIfNeeded(text);
    expect(redacted).not.toContain('sk_test_');
    expect(redacted).toContain('[REDACTED');
  });

  it('low sensitivity skips generic secrets', () => {
    const lowSens = new LeakDetector(0.3);
    const result = lowSens.scan('secret=mygenericvalue123456');
    expect(result.clean).toBe(true);
  });
});
