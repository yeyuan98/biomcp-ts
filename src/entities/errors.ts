/**
 * Cause-aware error-message helpers for entity-layer catch blocks.
 *
 * Node's fetch (undici) rejections are often uninformative at the top level —
 * a bare `TypeError: fetch failed` — with the real signal (`ETIMEDOUT`,
 * `ECONNREFUSED`, `ENOTFOUND`, ...) buried one level down in `error.cause`.
 * Since the connection layer preserves `.cause` verbatim (PR #69), entity
 * catches can surface that signal to users instead of guessing at causes.
 */

/**
 * Extract the network errno code carried on `error.cause` (Node socket/DNS
 * errors attach it there, e.g. `ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`,
 * `EAI_AGAIN`). Only one level of unwrapping is performed: errors already
 * wrapped by the connection layer carry the code in their message instead.
 *
 * @param error - Anything thrown; non-objects and cause-less errors yield `undefined`.
 * @returns The cause code string when present, else `undefined`.
 *
 * @example
 * ```ts
 * networkCauseCode(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } })); // 'ETIMEDOUT'
 * networkCauseCode(new Error('plain')); // undefined
 * ```
 */
// ADOPTION NOTE: other entity catches (~36 candidate sites across src/entities)
// may adopt errorMessageWithCause/networkCauseCode incrementally — do NOT
// mass-adopt; take one catch at a time with its own pinning tests.
export function networkCauseCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/**
 * Best-effort human-readable message for an error, enriched with the signal
 * carried on `error.cause` when the top-level message lacks it.
 *
 * Returns `error.message` (or `String(error)` for non-Errors). When
 * `error.cause.code` exists (raw fetch rejections) — or `error.cause.message`
 * for wrapped errors without a code — and that text is NOT already present in
 * the message, it is appended in parentheses. Already-informative messages
 * pass through unchanged: `fetch failed (ETIMEDOUT)` stays as-is, while a raw
 * `fetch failed` whose cause carries `{ code: 'ETIMEDOUT' }` becomes
 * `fetch failed (ETIMEDOUT)`.
 *
 * @param error - Anything thrown.
 * @returns The (possibly enriched) message string; never throws.
 */
export function errorMessageWithCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== 'object') return message;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return message;

  const code = networkCauseCode(error);
  const extra = code ?? nonEmptyString((cause as { message?: unknown }).message);
  if (!extra) return message;
  // Case-insensitive containment: wrapped messages already embed the code
  // (connection layer appends ` (CODE)`), so never duplicate it.
  if (message.toLowerCase().includes(extra.toLowerCase())) return message;
  return `${message} (${extra})`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
