// Side-effect import: proxy-aware global fetch for any code path that uses
// fetchWithTimeout without going through connections/manager.js.
import './proxy.js';
import { monotonicNowMs } from './time.js';

/**
 * Shared per-provider timeout for citation lookups layered on top of the
 * connection-level `handling.timeoutMs` (15s) aborts.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 10000;

/**
 * Race work against a timer, ABORTING the work when it loses.
 *
 * - `work` may be a function receiving an AbortSignal that fires when the
 *   timer expires (or when `opts.signal` aborts) — thread it into the
 *   underlying request so the losing fetch stops consuming its connection
 *   slot instead of running to its own connection-level timeout. A bare
 *   Promise is still accepted (nothing to abort) for call sites that cannot
 *   hand out a signal.
 * - `opts.signal` is an additional external abort source (best-effort: it
 *   aborts the controller handed to `work`; it does not by itself settle
 *   the race).
 * - `onTimeout: 'null'` resolves `null` on timeout (optional-data lookups,
 *   e.g. citation providers).
 * - `onTimeout: 'throw'` rejects with `<label> timed out after <ms>ms`
 *   (federated search relies on the rejection landing in Promise.allSettled
 *   as an error result — never a silent null).
 */
export function withTimeout<T>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number,
  opts: { onTimeout: 'null'; label?: string; signal?: AbortSignal }): Promise<T | null>;
export function withTimeout<T>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number,
  opts: { onTimeout: 'throw'; label?: string; signal?: AbortSignal }): Promise<T>;
export function withTimeout<T>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number,
  opts: { onTimeout: 'null' | 'throw'; label?: string; signal?: AbortSignal }
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const external = opts.signal;
  const onExternalAbort = (): void => controller.abort(external!.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  let workPromise: Promise<T>;
  if (typeof work === 'function') {
    // Invoke synchronously so the work attaches its abort listeners before
    // this tick ends — an external signal aborting right after withTimeout
    // returns must not slip in ahead of the work's own setup.
    try {
      workPromise = work(controller.signal);
    } catch (e) {
      workPromise = Promise.reject(e);
    }
  } else {
    workPromise = work;
  }
  const timeoutPromise = new Promise<T | null>((resolve, reject) => {
    if (opts.onTimeout === 'null') {
      timer = setTimeout(() => {
        // Settle the race first (documented error shape), then stop the
        // loser — abort() fires the work's listeners synchronously, so
        // aborting first would let the work's own AbortError win the race.
        resolve(null);
        controller.abort();
      }, timeoutMs);
    } else {
      timer = setTimeout(() => {
        reject(new Error(`${opts.label ?? 'Operation'} timed out after ${timeoutMs}ms`));
        controller.abort();
      }, timeoutMs);
    }
  });
  return Promise.race([workPromise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  });
}

export async function fetchWithTimeout<T>(fn: (signal?: AbortSignal) => Promise<T>, timeoutMs: number): Promise<{ data?: T; error?: string }> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Race the deadline itself: fn may ignore the signal entirely (older call
  // sites, retry loops that only check between attempts) — the caller must
  // still get a settled { error } at the deadline, not hang forever.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`Section fetch timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const data = await Promise.race([fn(controller.signal), deadline]);
    return { data };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (timedOut || error.includes('Timeout') || error.includes('timeout') || error.includes('abort') || error.includes('ABORT')) {
      return { error: `Section fetch timed out after ${timeoutMs}ms. The upstream data source may be slow or unreachable. Try again or use a different section.` };
    }
    return { error: `Section fetch failed: ${error}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Human-readable byte count for download diagnostics (1 decimal on KB/MB). */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Human-readable duration for download diagnostics. */
function formatDurationMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

/**
 * Abort/timeout-shaped rejection: AbortSignal.timeout aborts with a
 * `TimeoutError` DOMException, fetch-initiated aborts with `AbortError`;
 * stream/errors from stubs may carry either signature only in `message`
 * (same heuristic as fetchWithTimeout above).
 */
function isAbortLike(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return (
    e.name === 'AbortError' ||
    e.name === 'TimeoutError' ||
    /\b(abort|aborted|timed out|timeout)\b/i.test(e.message)
  );
}

function capExceededError(url: string, byteCount: number, opts: { timeoutMs: number; maxBytes: number }): Error {
  return new Error(
    `Supplementary file ${url} is ${byteCount} bytes, exceeding the ${opts.maxBytes} byte cap. ` +
    `NCBI serves GEO files at throttled speeds (commonly <150 KB/s), so multi-MB files may exceed the ` +
    `${opts.timeoutMs / 1000} s download timeout even with a higher cap — prefer downloading manually: ${url}.`
  );
}

function downloadTimeoutError(
  url: string,
  opts: { timeoutMs: number },
  receivedBytes: number,
  totalBytes: number | undefined,
  elapsedMs: number,
): Error {
  const seconds = opts.timeoutMs / 1000;
  if (receivedBytes === 0) {
    return new Error(
      `Download of ${url} timed out after ${seconds} s: no data received — ` +
      `the connection is stalled or blocked rather than slow; download it manually: ${url}`
    );
  }
  const rateKbPerSec = elapsedMs > 0 ? receivedBytes / 1024 / (elapsedMs / 1000) : receivedBytes / 1024;
  const totalDesc = totalBytes !== undefined ? formatBytes(totalBytes) : 'unknown-size';
  let estimate = '';
  if (totalBytes !== undefined && totalBytes > receivedBytes && rateKbPerSec > 0) {
    const fullFileMs = (totalBytes / (rateKbPerSec * 1024)) * 1000;
    estimate = `; at this rate the full file needs ~${formatDurationMs(fullFileMs)}`;
  }
  return new Error(
    `Download of ${url} timed out after ${seconds} s: received ${formatBytes(receivedBytes)} of ${totalDesc} ` +
    `(${Math.round(rateKbPerSec)} KB/s) — the endpoint is slow (NCBI throttling is common), not necessarily down` +
    `${estimate}; download it manually: ${url}`
  );
}

/**
 * Buffered download with byte-count telemetry for timeout diagnostics.
 */
export async function downloadBufferWithTelemetry(
  url: string,
  opts: { timeoutMs: number; maxBytes: number },
): Promise<Buffer> {
  const fetchStartedMs = monotonicNowMs();
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (e) {
    if (isAbortLike(e)) {
      // Pre-headers abort: zero bytes received — same honest message as a
      // mid-stream stall, never a bare TimeoutError DOMException.
      throw downloadTimeoutError(url, opts, 0, undefined, monotonicNowMs() - fetchStartedMs);
    }
    throw e;
  }
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  }

  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader);
  const totalBytes = Number.isFinite(contentLength) ? contentLength : undefined;
  if (totalBytes !== undefined && totalBytes > opts.maxBytes) {
    throw capExceededError(url, totalBytes, opts);
  }

  if (response.body === null) {
    // Nonstandard server or test stub without a web stream body: one-shot
    // arrayBuffer with the plain timeout rewrap (nothing was received —
    // arrayBuffer settles all-or-nothing).
    const startedMs = monotonicNowMs();
    try {
      return Buffer.from(await response.arrayBuffer());
    } catch (e) {
      if (isAbortLike(e)) {
        throw downloadTimeoutError(url, opts, 0, totalBytes, monotonicNowMs() - startedMs);
      }
      throw e;
    }
  }

  const startedMs = monotonicNowMs();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  let overCap = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        chunks.push(value);
        receivedBytes += value.byteLength;
      }
      if (receivedBytes > opts.maxBytes) {
        overCap = true;
        break;
      }
    }
  } catch (e) {
    if (isAbortLike(e)) {
      throw downloadTimeoutError(url, opts, receivedBytes, totalBytes, monotonicNowMs() - startedMs);
    }
    throw e;
  } finally {
    if (overCap) void reader.cancel().catch(() => undefined);
  }
  if (overCap) throw capExceededError(url, receivedBytes, opts);
  return Buffer.concat(chunks, receivedBytes);
}
