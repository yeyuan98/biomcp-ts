/**
 * Shared helpers for NCBI E-utilities (esearch/esummary/efetch/elink)
 * accessed through the single 'eutils' connection in the source registry.
 *
 * E-utilities reports most request errors with HTTP 200 status codes:
 * JSON endpoints embed {"error": "..."} while text endpoints (efetch,
 * elink XML) return bodies starting with "Error:". The connection layer
 * only throws on non-2xx responses, so every eutils caller MUST pass its
 * payload through these guards.
 */

/** E-utilities hard cap on ids per esummary/efetch/elink request. */
export const EUTILS_MAX_IDS_PER_REQUEST = 200;

interface EutilsEnvelope {
  error?: unknown;
  esearchresult?: { error?: unknown };
  result?: { error?: unknown; uids?: string[] };
}

function describeEutilsError(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const anyValue = value as Record<string, unknown>;
    if (typeof anyValue.message === 'string') return anyValue.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Validate and return a parsed E-utilities JSON payload, throwing when the
 * body carries an application-level error (HTTP 200 + {"error": ...}).
 */
export function parseEutilsJson<T extends EutilsEnvelope>(raw: string, context: string): T {
  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `${context}: E-utilities returned a non-JSON response${raw.startsWith('Error:') ? ` (${raw.slice(0, 200)})` : ''}`
    );
  }
  assertEutilsPayload(parsed, context);
  return parsed;
}

/**
 * Canonical guard for E-utilities JSON calls made through RestConnection,
 * which already JSON-parses application/json bodies and returns strings
 * for everything else. Accepts either shape, re-stringifying objects so
 * the shared envelope check (plus non-JSON/HTML-block detection) always
 * runs.
 */
export function parseEutilsResponse<T extends EutilsEnvelope>(response: unknown, context: string): T {
  return parseEutilsJson<T>(typeof response === 'string' ? response : JSON.stringify(response), context);
}

function assertEutilsPayload(parsed: EutilsEnvelope, context: string): void {
  const error =
    parsed.error ?? parsed.esearchresult?.error ?? parsed.result?.error;
  if (error !== undefined && error !== null && error !== '') {
    throw new Error(`${context}: E-utilities error: ${describeEutilsError(error)}`);
  }
}

/**
 * Validate a plain-text E-utilities body (efetch retmode=text, SOFT-like
 * output), throwing when NCBI replied with an inline error document.
 */
export function assertEutilsText(raw: string, context: string): string {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('Error:')) {
    throw new Error(`${context}: E-utilities error: ${trimmed.slice(0, 300)}`);
  }
  return raw;
}

/** Split a UID list into batches safe for GET requests. */
export function chunkUids(ids: string[], size: number = EUTILS_MAX_IDS_PER_REQUEST): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/** Join ids for a query parameter, enforcing the per-request cap. */
export function joinUidParam(ids: string[], size: number = EUTILS_MAX_IDS_PER_REQUEST): string {
  return ids.slice(0, size).join(',');
}
