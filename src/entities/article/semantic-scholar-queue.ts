/**
 * Global single-flight queue owning ALL Semantic Scholar traffic (citation
 * lookups and article search). Serializing requests avoids the 429s the
 * unauthenticated API serves under concurrency.
 *
 * Each slot must be a BOUNDED call: call sites race their request with
 * withTimeout INSIDE the enqueued closure so a hung fetch releases the queue
 * instead of poisoning it for every later request. Registry retry runs inside
 * the slot too — a slot only outlives its fetches if the per-provider timeout
 * already abandoned them. There is no deadlock: the queue is only held by
 * in-flight S2 calls, never by unrelated sources.
 */
class RequestQueue {
  private queue: Array<() => Promise<unknown>> = [];
  private active = false;

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.process();
    });
  }

  private async process(): Promise<void> {
    if (this.active || this.queue.length === 0) return;

    this.active = true;
    const fn = this.queue.shift();
    if (fn) {
      try {
        await fn();
      } finally {
        this.active = false;
        if (this.queue.length > 0) {
          this.process();
        }
      }
    }
  }
}

export const s2RequestQueue = new RequestQueue();
