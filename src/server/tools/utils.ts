import { z } from 'zod';

export function sliceArraysRecursive(obj: unknown, limit: number): unknown {
  if (Array.isArray(obj)) return obj.slice(0, limit);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = sliceArraysRecursive(v, limit);
    }
    return result;
  }
  return obj;
}

/**
 * Builds the error used when an externally supplied signal (the MCP
 * request's `extra.signal`) aborts the tool call before the deadline.
 */
function toolAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const detail =
    reason instanceof Error ? `: ${reason.message}` :
    reason !== undefined ? `: ${String(reason)}` :
    '';
  return new Error(`Tool execution aborted by the client${detail}`);
}

/**
 * Race tool work against a deadline, ABORTING the work when it loses.
 *
 * The legacy version raced a bare timer: on timeout the tool call rejected
 * but the underlying fetches kept running (and retrying) in the background,
 * holding connection semaphore slots for minutes (#107 phase 2).
 *
 * - `work` may be a function receiving an AbortSignal that fires on deadline
 *   OR on external cancellation — thread it into entity calls so the loser
 *   actually stops. A bare Promise is still accepted (nothing to abort, the
 *   deadline race alone applies) for call sites whose entity does not take
 *   a signal yet.
 * - `opts.signal` (e.g. the MCP request's `extra.signal`) aborts the work
 *   immediately and rejects with a distinct "aborted by the client" error;
 *   an already-aborted signal rejects without starting the work at all.
 * - The timeout error message matches the pre-existing shape
 *   (`Tool execution timed out after <ms>ms`).
 */
export function withToolTimeout<T>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  const external = opts.signal;
  if (external?.aborted) {
    return Promise.reject(toolAbortError(external));
  }

  const controller = new AbortController();
  let workPromise: Promise<T>;
  if (typeof work === 'function') {
    // Invoke synchronously so the work attaches its abort listeners before
    // this tick ends — an external signal aborting right after the wrapper
    // returns must not slip in ahead of the work's own setup.
    try {
      workPromise = work(controller.signal);
    } catch (e) {
      workPromise = Promise.reject(e);
    }
  } else {
    workPromise = work;
  }

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      // Settle the race FIRST so the deadline error (the documented shape)
      // wins; then stop the loser: fetches reject, retries bail, semaphore
      // slots free. (abort() fires the work's listeners synchronously, so
      // aborting first would let the work's own AbortError win the race.)
      reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
      controller.abort();
    }, timeoutMs);
  });

  let abortPromise: Promise<never> | undefined;
  let onExternalAbort: (() => void) | undefined;
  if (external) {
    abortPromise = new Promise<never>((_, reject) => {
      onExternalAbort = () => {
        reject(toolAbortError(external));
        controller.abort(external.reason);
      };
      external.addEventListener('abort', onExternalAbort, { once: true });
    });
  }

  return Promise.race(
    abortPromise ? [workPromise, timeoutPromise, abortPromise] : [workPromise, timeoutPromise],
  ).finally(() => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (external && onExternalAbort) {
      external.removeEventListener('abort', onExternalAbort);
    }
  });
}

/**
 * Structural slice of the SDK request-handler `extra` for cancellation: the
 * SDK passes `extra.signal` (an AbortSignal the transport aborts when the
 * client cancels the request, e.g. an MCP progress-cancel) to every
 * registered tool callback — accepting it and handing it to
 * withToolTimeout's `opts.signal` makes client cancellation actually stop
 * the entity's in-flight requests.
 */
export interface CancellationCapableExtra {
  signal?: AbortSignal;
}

/**
 * Limits top-level arrays in the requested sections and returns the limited
 * sections object WITHOUT mutating the input (copy-on-write: only section
 * entries that actually get an array sliced are replaced on a shallow copy of
 * `sections`; untouched sections keep their identity). Mutating in place
 * previously truncated arrays inside cached results — the federated citation
 * result is shared with the article_get citation-section cache, so in-place
 * slicing permanently corrupted what later callers received.
 */
export function applyLimit(
  sections: Record<string, unknown>,
  requestedNames: string[],
  storageKeyMap: Record<string, string>,
  arrayKeyMap: Record<string, string[]>,
  limit: number,
): Record<string, unknown> {
  let result = sections;
  for (const name of requestedNames) {
    const storedKey = storageKeyMap[name] ?? name;
    const data = sections[storedKey];
    if (!data || typeof data !== 'object') continue;

    const keys = arrayKeyMap[name];
    let replacement: unknown;
    if (Array.isArray(data)) {
      replacement = data.slice(0, limit);
    } else if (keys) {
      const obj = data as Record<string, unknown>;
      let copied: Record<string, unknown> | undefined;
      for (const k of keys) {
        if (Array.isArray(obj[k])) {
          copied ??= { ...obj };
          copied[k] = (obj[k] as unknown[]).slice(0, limit);
        }
      }
      replacement = copied;
    }
    if (replacement !== undefined) {
      result = result === sections ? { ...sections } : result;
      result[storedKey] = replacement;
    }
  }
  return result;
}

/**
 * Required non-empty string parameter: trims, then rejects an empty result
 * with a uniform message so empty/whitespace-only selector params (ids,
 * symbols, accessions, …) fail zod schema validation — an MCP -32602-class
 * InvalidParams error — before any handler logic or network call runs
 * (issue #128). The 10 free-text search `query` params use the identical
 * inline pattern (issue #79); this helper extends it to required selectors.
 *
 * Format/regex tightening is deliberately out of scope: only emptiness is
 * rejected here.
 */
export const requiredString = (label: string) =>
  z.string().trim().min(1, `${label} must be a non-empty string after trimming`);

/**
 * Optional filter-style string: ABSENCE still passes schema, but an
 * explicitly supplied empty/whitespace-only value is rejected. An empty
 * filter value would otherwise silently broaden the query — e.g.
 * variant_search's empty `query` used to match everything upstream.
 */
export const optionalNonEmptyString = (label: string) => requiredString(label).optional();

/** One upstream/backend failure inside a list envelope (article_search parity). */
export interface ListEnvelopeError {
  source: string;
  message: string;
  retryable?: boolean;
}

/**
 * Standard list-tool reply shape (issue #130): `results` plus optional
 * `warnings`/`errors` channels. Emission logic mirrors searchArticles
 * (src/entities/article/search/index.ts): the optional channels are
 * attached ONLY when non-empty, so a clean happy path serializes as exactly
 * `{"results":[...]}`.
 */
export interface ListEnvelope<T> {
  results: T[];
  warnings?: string[];
  errors?: ListEnvelopeError[];
}

/**
 * Wrap a list-tool result in the standard `{ results, warnings?, errors? }`
 * envelope (issue #130). Attach `warnings`/`errors` only when non-empty —
 * byte-identical emission logic to searchArticles' envelope construction.
 */
export function listEnvelope<T>(
  results: T[],
  warnings?: string[],
  errors?: ListEnvelopeError[],
): ListEnvelope<T> {
  const envelope: ListEnvelope<T> = { results };
  if (warnings !== undefined && warnings.length > 0) envelope.warnings = warnings;
  if (errors !== undefined && errors.length > 0) envelope.errors = errors;
  return envelope;
}
