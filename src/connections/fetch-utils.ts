// Side-effect import: proxy-aware global fetch for any code path that uses
// fetchWithTimeout without going through connections/manager.js.
import './proxy.js';

/**
 * Shared per-provider timeout for citation lookups layered on top of the
 * connection-level `handling.timeoutMs` (15s) aborts.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 10000;

/**
 * Race a promise against a timer.
 *
 * - `onTimeout: 'null'` resolves `null` on timeout (optional-data lookups,
 *   e.g. citation providers).
 * - `onTimeout: 'throw'` rejects with `<label> timed out after <ms>ms`
 *   (federated search relies on the rejection landing in Promise.allSettled
 *   as an error result — never a silent null).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  opts: { onTimeout: 'null'; label?: string }): Promise<T | null>;
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  opts: { onTimeout: 'throw'; label?: string }): Promise<T>;
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  opts: { onTimeout: 'null' | 'throw'; label?: string }
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T | null>((resolve, reject) => {
    if (opts.onTimeout === 'null') {
      timer = setTimeout(() => resolve(null), timeoutMs);
    } else {
      timer = setTimeout(
        () => reject(new Error(`${opts.label ?? 'Operation'} timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    }
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function fetchWithTimeout<T>(fn: (signal?: AbortSignal) => Promise<T>, timeoutMs: number): Promise<{ data?: T; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const data = await fn(controller.signal);
    return { data };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (error.includes('Timeout') || error.includes('timeout') || error.includes('abort') || error.includes('ABORT')) {
      return { error: `Section fetch timed out after ${timeoutMs}ms. The upstream data source may be slow or unreachable. Try again or use a different section.` };
    }
    return { error: `Section fetch failed: ${error}` };
  } finally {
    clearTimeout(timeoutId);
  }
}
