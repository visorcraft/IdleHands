import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeakDetector } from '../dist/security/leak-detector.js';

describe('LeakDetector', () => {
  const detector = new LeakDetector();

  it('passes clean content', () => {
    const result = detector.scan('This is just normal text about coding');
    assert.strictEqual(result.clean, true);
    assert.strictEqual((result.patterns).length, 0);
  });

  it('detects Stripe secret keys', () => {
    const result = detector.scan('My key is sk_test_1234567890abcdefghijklmnop');
    assert.strictEqual(result.clean, false);
    assert.ok((result.patterns).includes('Stripe secret key'));
    assert.ok((result.redacted).includes('[REDACTED_STRIPE_KEY]'));
    assert.ok(!((result.redacted).includes('sk_test_')));
  });

  it('detects OpenAI-style keys', () => {
    const result = detector.scan('sk-' + 'a'.repeat(50));
    assert.strictEqual(result.clean, false);
    assert.strictEqual(result.patterns.some((p) => p.includes('API key')), true);
  });

  it('detects Anthropic keys', () => {
    const result = detector.scan('sk-ant-' + 'a'.repeat(40));
    assert.strictEqual(result.clean, false);
    assert.ok((result.patterns).includes('Anthropic API key'));
  });

  it('detects GitHub tokens', () => {
    const result = detector.scan('ghp_' + 'a'.repeat(40));
    assert.strictEqual(result.clean, false);
    assert.ok((result.patterns).includes('GitHub token'));
  });

  it('detects AWS Access Key IDs', () => {
    const result = detector.scan('AWS key: AKIAIOSFODNN7EXAMPLE');
    assert.strictEqual(result.clean, false);
    assert.ok((result.patterns).includes('AWS Access Key ID'));
  });

  it('detects private keys (PEM)', () => {
    const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----';
    const result = detector.scan(content);
    assert.strictEqual(result.clean, false);
    assert.ok((result.patterns).includes('RSA private key'));
    assert.ok((result.redacted).includes('[REDACTED_PRIVATE_KEY]'));
  });

  it('detects JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = detector.scan(`Bearer ${jwt}`);
    assert.strictEqual(result.clean, false);
    assert.ok((result.patterns).includes('JWT token'));
    assert.ok((result.redacted).includes('[REDACTED_JWT]'));
  });

  it('detects PostgreSQL connection URLs', () => {
    const result = detector.scan('DATABASE_URL=postgres://user:secretpassword@localhost:5432/mydb');
    assert.strictEqual(result.clean, false);
    assert.ok((result.patterns).includes('PostgreSQL connection URL'));
  });

  it('detects MongoDB connection URLs', () => {
    const result = detector.scan('mongodb+srv://admin:pass123@cluster.example.com/db');
    assert.strictEqual(result.clean, false);
    assert.ok((result.patterns).includes('MongoDB connection URL'));
  });

  it('detects generic password assignments', () => {
    const result = detector.scan('password=mysuperpassword123');
    assert.strictEqual(result.clean, false);
    assert.ok((result.patterns).includes('Password in config'));
  });

  it('redactIfNeeded returns original for clean content', () => {
    const text = 'Normal code here';
    assert.strictEqual(detector.redactIfNeeded(text), text);
  });

  it('redactIfNeeded returns redacted for leaky content', () => {
    const text = 'key: sk_test_' + 'a'.repeat(30);
    const redacted = detector.redactIfNeeded(text);
    assert.ok(!((redacted).includes('sk_test_')));
    assert.ok((redacted).includes('[REDACTED'));
  });

  it('low sensitivity skips generic secrets', () => {
    const lowSens = new LeakDetector(0.3);
    const result = lowSens.scan('secret=mygenericvalue123456');
    assert.strictEqual(result.clean, true);
  });
});
