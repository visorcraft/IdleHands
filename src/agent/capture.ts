/**
 * CaptureManager — Records API request/response exchanges to JSONL files
 * with optional redaction of sensitive headers (API keys, tokens).
 *
 * Extracted from agent.ts to reduce file size and isolate capture concerns.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export class CaptureManager {
  private enabled = false;
  private redactEnabled = true;
  private filePath: string | undefined;
  private lastRecord: any | null = null;
  private readonly capturesDir: string;

  constructor(stateDir: string) {
    this.capturesDir = path.join(stateDir, 'captures');
  }

  // ── Public API (matches previous closures) ──────────────────────────

  async on(filePath?: string): Promise<string> {
    const target = filePath?.trim() ? path.resolve(filePath) : this.defaultPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, '', 'utf8');
    this.enabled = true;
    this.filePath = target;
    return target;
  }

  off(): void {
    this.enabled = false;
  }

  async last(filePath?: string): Promise<string> {
    if (!this.lastRecord) {
      throw new Error('No captured request/response pair is available yet.');
    }
    const target = filePath?.trim()
      ? path.resolve(filePath)
      : this.filePath || this.defaultPath();
    await this.appendRecord(this.lastRecord, target);
    return target;
  }

  setRedact(enabled: boolean): void {
    this.redactEnabled = enabled;
  }

  getRedact(): boolean {
    return this.redactEnabled;
  }

  open(): string | null {
    return this.filePath || null;
  }

  get path(): string | undefined {
    return this.filePath;
  }

  // ── Exchange hook (attach to OpenAIClient) ──────────────────────────

  /**
   * Returns a hook function suitable for `client.setExchangeHook()`.
   * The hook stores the last record and, if capture is enabled, appends it.
   */
  createExchangeHook(): (record: any) => Promise<void> {
    return async (record: any) => {
      this.lastRecord = record;
      if (!this.enabled) return;
      const outFile = this.filePath || this.defaultPath();
      this.filePath = outFile;
      await this.appendRecord(record, outFile);
    };
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private defaultPath(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(this.capturesDir, `${stamp}.jsonl`);
  }

  private redactRecord(record: any): any {
    if (!this.redactEnabled) return record;
    const redacted = JSON.parse(JSON.stringify(record));
    const walk = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      for (const key of Object.keys(obj)) {
        const lower = key.toLowerCase();
        if (lower === 'authorization' || lower === 'api-key' || lower === 'x-api-key') {
          obj[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object') {
          walk(obj[key]);
        }
      }
    };
    walk(redacted);
    return redacted;
  }

  private async appendRecord(record: any, outPath: string): Promise<void> {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const safe = this.redactRecord(record);
    await fs.appendFile(outPath, JSON.stringify(safe) + '\n', 'utf8');
  }
}
