import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Parses raw auth token input into a normalized Map<token, label>.
 * Supports comma-separated strings or arrays of `token` or `token:label`.
 */
export function parseAuthTokens(raw?: string | string[] | Map<string, string>): Map<string, string> {
  const result = new Map<string, string>();
  if (!raw) return result;

  if (raw instanceof Map) {
    for (const [k, v] of raw.entries()) {
      const trimmedKey = k.trim();
      if (trimmedKey) result.set(trimmedKey, v.trim() || 'default');
    }
    return result;
  }

  const entries = Array.isArray(raw) ? raw : raw.split(',');
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const token = trimmed.slice(0, colonIdx).trim();
      const label = trimmed.slice(colonIdx + 1).trim() || 'default';
      if (token) result.set(token, label);
    } else {
      result.set(trimmed, 'default');
    }
  }
  return result;
}

export interface AuthVerificationResult {
  authorized: boolean;
  clientLabel?: string;
}

/**
 * Constant-time bearer token verification.
 * Pre-hashes incoming and candidate tokens with SHA-256 so buffers compared
 * by `timingSafeEqual` are guaranteed to be 32 bytes, preventing both
 * timing leakage and RangeError length-mismatch exceptions.
 */
export function verifyBearerToken(
  authHeader: string | undefined,
  validTokens: Map<string, string>,
): AuthVerificationResult {
  if (validTokens.size === 0) {
    return { authorized: false };
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authorized: false };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return { authorized: false };
  }

  const incomingHash = createHash('sha256').update(token).digest();

  for (const [validToken, label] of validTokens.entries()) {
    const validHash = createHash('sha256').update(validToken).digest();
    if (timingSafeEqual(incomingHash, validHash)) {
      return { authorized: true, clientLabel: label };
    }
  }

  return { authorized: false };
}

/**
 * Sets standard CORS headers for MCP Streamable HTTP clients (including browser/web clients).
 */
export function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Handles CORS OPTIONS preflight request.
 * Returns true if handled (response ended with 204), false otherwise.
 */
export function handleCorsPreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}
