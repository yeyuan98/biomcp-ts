import { HttpConnectionError } from '../../../connections/errors.js';
import type { Article } from '../types.js';

/**
 * Uniform `_error` row envelope for literature search backends (the
 * `[{ _error: ... }]` contract consumed by dedup.ts and the tools). The
 * generic branch logs `console.error('[<label>] Error:', error)` and keeps
 * the long-standing wording `<label> failed: <msg>. This may be a temporary
 * data source issue. Try again or use a different source.` — byte-identical
 * to the hand-rolled catch blocks it replaces. `statusMessages` lets a
 * backend substitute specialized wording for specific HTTP statuses
 * (arXiv's 403 per-IP-block and 429 rate-limit hints); those branches
 * return without logging, matching the original catch blocks.
 */
export function backendErrorRow(
  label: string,
  error: unknown,
  opts?: { statusMessages?: Record<number, string> }
): Article[] {
  const statusMessage =
    error instanceof HttpConnectionError && error.status !== undefined
      ? opts?.statusMessages?.[error.status]
      : undefined;
  if (statusMessage !== undefined) return [{ _error: statusMessage }];

  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[${label}] Error:`, error);
  return [{ _error: `${label} failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` }];
}
