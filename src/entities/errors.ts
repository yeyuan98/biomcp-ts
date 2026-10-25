/**
 * Cause-aware error-message helpers for entity-layer catch blocks.
 *
 * Node's fetch (undici) rejections are often uninformative at the top level —
 * a bare `TypeError: fetch failed` — with the real signal (`ETIMEDOUT`,
 * `ECONNREFUSED`, `ENOTFOUND`, ...) buried one or more levels down the
 * `.cause` chain. Since the connection layer preserves `.cause` verbatim
 * (PR #69), entity catches can surface that signal to users instead of
 * guessing at causes.
 */

/** Maximum nodes walked on the `.cause` chain (the error itself + causes) — real chains are 1-2 deep; the bound also makes cyclic chains terminate. */
const MAX_CAUSE_DEPTH = 4;

function firstCodeOnNode(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const carrier = node as { code?: unknown; errno?: unknown };
  for (const key of ['code', 'errno'] as const) {
    const value = carrier[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Extract the network errno code carried anywhere on the error or its
 * `.cause` chain (Node socket/DNS errors attach `code`/`errno` there, e.g.
 * `ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`; undici's
 * ConnectTimeoutError carries `UND_ERR_CONNECT_TIMEOUT`). The walk is
 * bounded and therefore cycle-safe. Depth matters: the connection layer
 * wraps raw fetch rejections one level deeper than a bare Node error, so
 * `HttpConnectionError → TypeError('fetch failed') → ConnectTimeoutError`
 * hides the code at depth 2.
 *
 * @param error - Anything thrown; non-objects and cause-less errors yield `undefined`.
 * @returns The first non-empty code/errno string found, else `undefined`.
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
  // The top-level error is checked too: a raw undici error passed through
  // unwrapped (e.g. ConnectTimeoutError) carries its code directly.
  let node: unknown = error;
  for (let depth = 0; node && typeof node === 'object' && depth < MAX_CAUSE_DEPTH; depth++) {
    const code = firstCodeOnNode(node);
    if (code) return code;
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Best-effort human-readable message for an error, enriched with the signal
 * carried on `error.cause` when the top-level message lacks it.
 *
 * Returns `error.message` (or `String(error)` for non-Errors). When a code
 * exists on the error or its cause chain (raw fetch rejections) — or
 * `error.cause.message` for wrapped errors without a code — and that text is
 * NOT already present in the message, it is appended in parentheses.
 * Already-informative messages
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
