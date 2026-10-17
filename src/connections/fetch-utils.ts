// Side-effect import: proxy-aware global fetch for any code path that uses
// fetchWithTimeout without going through connections/manager.js.
import './proxy.js';

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
