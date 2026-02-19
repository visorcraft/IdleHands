/**
 * Shared JSON-RPC transport utilities for MCP and LSP.
 *
 * Both protocols use the same Content-Length framed JSON-RPC over stdio,
 * so the buffer parsing, header detection, and message framing is shared here.
 */

/**
 * Find the header/body delimiter in a buffer.
 * Supports both \r\n\r\n (standard) and \n\n (lenient).
 */
export function findHeaderDelimiter(buf: Buffer): { index: number; sepLen: number } | null {
  const crlf = buf.indexOf(Buffer.from('\r\n\r\n'));
  if (crlf >= 0) return { index: crlf, sepLen: 4 };
  const lf = buf.indexOf(Buffer.from('\n\n'));
  if (lf >= 0) return { index: lf, sepLen: 2 };
  return null;
}

/**
 * Extract Content-Length from a header string.
 * Returns null if not found or invalid.
 */
export function parseContentLength(headerText: string): number | null {
  const match = /content-length\s*:\s*(\d+)/i.exec(headerText);
  if (!match) return null;
  const len = Number(match[1]);
  if (!Number.isFinite(len) || len < 0) return null;
  return len;
}

/**
 * Encode a JSON-RPC message as a Content-Length framed buffer.
 */
export function encodeJsonRpcFrame(message: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, payload]);
}

/**
 * Parse complete JSON-RPC messages from a buffer.
 * Returns extracted messages and the remaining buffer.
 */
export function extractMessages(inputBuf: Buffer<ArrayBuffer>): { messages: unknown[]; remaining: Buffer<ArrayBuffer> } {
  const messages: unknown[] = [];
  let buf = inputBuf;

  while (buf.length > 0) {
    const header = findHeaderDelimiter(buf);
    if (!header) break;

    const headerText = buf.subarray(0, header.index).toString('utf8');
    const bodyStart = header.index + header.sepLen;
    const len = parseContentLength(headerText);

    if (len === null) {
      // Malformed header — skip past the delimiter and continue
      buf = Buffer.from(buf.subarray(bodyStart));
      continue;
    }

    if (buf.length < bodyStart + len) {
      // Incomplete message — wait for more data
      break;
    }

    const raw = buf.subarray(bodyStart, bodyStart + len).toString('utf8');
    buf = Buffer.from(buf.subarray(bodyStart + len));

    try {
      messages.push(JSON.parse(raw));
    } catch {
      // Malformed JSON — skip this message
      continue;
    }
  }

  return { messages, remaining: buf };
}
