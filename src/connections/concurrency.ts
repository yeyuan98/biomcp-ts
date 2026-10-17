/**
 * Bounded, FIFO-fair semaphore generalizing the citation RequestQueue idea
 * (src/entities/article/semantic-scholar-queue.ts) to N concurrent slots.
 *
 * Registry `concurrency` entries wrap each fetch ATTEMPT in `run()` so a
 * burst of parallel tool calls cannot pile unbounded in-flight requests onto
 * one upstream (#107 fan-out pileup). Slots are held for a single attempt
 * only — retry backoff sleeps happen outside the semaphore, so a zombie
 * retry chain never occupies a slot while waiting.
 */
export class BoundedSemaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`BoundedSemaphore limit must be a positive integer, got ${limit}`);
    }
  }

  /**
   * Run `fn` in a slot. Resolves/rejects with `fn`'s outcome; the slot is
   * released (handed to the longest-waiting caller) once `fn`'s promise
   * settles, so thrown errors can never leak a slot and poison the queue.
   *
   * Fast path: when a permit is free, `fn` is invoked SYNCHRONOUSLY — no
   * extra microtask hop before the fetch launch. Sources mix
   * semaphore'd and non-semaphore'd traffic launched in parallel, and
   * callers (plus the article federated-search tests) observe fetch call
   * order; an extra await here would reorder them. The queued path resolves
   * a waiter's admission asynchronously, which is inherent to queueing.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) {
      return this.start(fn);
    }
    return new Promise<T>((resolve, reject) => {
      this.waiters.push(() => {
        resolve(this.start(fn));
      });
    });
  }

  /** Claim a permit and run `fn`; release on settle (or on a synchronous
   *  throw from a non-async `fn`). */
  private start<T>(fn: () => Promise<T>): Promise<T> {
    this.active++;
    let promise: Promise<T>;
    try {
      promise = fn();
    } catch (error) {
      this.release();
      return Promise.reject(error);
    }
    return promise.then(
      value => {
        this.release();
        return value;
      },
      error => {
        this.release();
        throw error;
      }
    );
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift(); // FIFO: longest-waiting caller first
    if (next) next();
  }
}

const sourceSemaphores = new Map<string, BoundedSemaphore>();

/**
 * The per-source semaphore, shared across every connection instance for that
 * sourceId (the cap is per-upstream, not per-object — matches how
 * ConnectionManager hands out one cached connection per source). The first
 * caller's limit creates the semaphore; later lookups reuse it.
 */
export function getSourceSemaphore(sourceId: string, limit: number): BoundedSemaphore {
  let semaphore = sourceSemaphores.get(sourceId);
  if (!semaphore) {
    semaphore = new BoundedSemaphore(limit);
    sourceSemaphores.set(sourceId, semaphore);
  }
  return semaphore;
}
