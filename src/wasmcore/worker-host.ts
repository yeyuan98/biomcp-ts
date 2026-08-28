import { Worker } from 'node:worker_threads';

/**
 * Minimal structural type satisfied by node:worker_threads Worker, kept narrow
 * so tests can inject a fake implementation.
 */
export interface WorkerLike {
  postMessage(message: unknown): void;
  unref(): void;
  terminate(): Promise<number>;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (exitCode: number) => void): unknown;
}

export type WorkerFactory = (path: string, options: Record<string, unknown>) => WorkerLike;

/** The worker answered an RPC with ok:false — a run-level failure, not death. */
export class WorkerRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerRpcError';
  }
}

export const defaultWorkerFactory: WorkerFactory = (path, options) =>
  // WorkerOptions in @types/node lacks the `type` field; runtime accepts it.
  new (Worker as unknown as new (path: string, options: Record<string, unknown>) => WorkerLike)(path, options);

export interface WorkerHostOptions {
  factory?: WorkerFactory;
  /** Receives worker messages that are not RPC responses (notifications). */
  onNotification?: (message: unknown) => void;
  /** Grace period for a cooperative shutdown before terminate(). */
  gracefulShutdownMs?: number;
  /** Passed to the worker as workerData. */
  workerData?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Generic worker_thread lifecycle host: spawn (unref'd), request/response RPC
 * with incrementing ids, and a poisoned state surfaced from 'error'/'exit'
 * events so all pending requests reject deterministically.
 */
export class WorkerHost {
  private readonly factory: WorkerFactory;
  private readonly onNotification: (message: unknown) => void;
  private readonly gracefulShutdownMs: number;
  private readonly workerData: unknown;
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private death: Error | null = null;
  private terminating = false;

  private workerPath = '';

  constructor(path: string, options: WorkerHostOptions = {}) {
    this.factory = options.factory ?? defaultWorkerFactory;
    this.onNotification = options.onNotification ?? (() => undefined);
    this.gracefulShutdownMs = options.gracefulShutdownMs ?? 1_500;
    this.workerData = options.workerData;
    this.workerPath = path;
    this.spawn(path);
  }

  private createWorkerOptions(): Record<string, unknown> {
    const opts: Record<string, unknown> = { type: 'module' };
    if (this.workerData !== undefined) {
      opts.workerData = this.workerData;
    }
    return opts;
  }

  private spawn(path: string): void {
    const worker = this.factory(path, this.createWorkerOptions());
    worker.unref();
    worker.on('message', (message) => this.handleMessage(message));
    worker.on('error', (error) => this.markDead(error));
    worker.on('exit', (code) => {
      if (this.death || this.terminating) return;
      this.markDead(new Error(`Worker exited unexpectedly (exit code ${code}).`));
    });
    this.worker = worker;
  }

  private handleMessage(message: unknown): void {
    if (message !== null && typeof message === 'object' && 'id' in message) {
      const id = (message as { id?: unknown }).id;
      if (typeof id === 'number') {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          const { ok, error, ...rest } = message as { ok?: boolean; error?: string };
          if (ok === false) {
            pending.reject(new WorkerRpcError(typeof error === 'string' && error ? error : 'Worker request failed.'));
          } else {
            pending.resolve(rest);
          }
          return;
        }
      }
    }
    this.onNotification(message);
  }

  private markDead(error: Error): void {
    if (this.death) return;
    this.death = error;
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  isDead(): boolean {
    return this.death !== null;
  }

  deathError(): Error | null {
    return this.death;
  }

  /** True when at least one request is in flight. */
  isBusy(): boolean {
    return this.pending.size > 0;
  }

  request<T = Record<string, unknown>>(payload: Record<string, unknown>): Promise<T> {
    if (this.death) {
      return Promise.reject(this.death);
    }
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(new Error('Worker was never spawned.'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, ...payload });
    });
  }

  /** Post a message that is not part of the request/response protocol. */
  notify(message: unknown): void {
    if (!this.worker || this.death) return;
    this.worker.postMessage(message);
  }

  /**
   * Cooperative shutdown: ask the worker to exit, then hard-terminate after a
   * grace period. Any pending requests are rejected.
   */
  async terminate(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.terminating = true;
    if (!this.death) {
      try {
        await new Promise<void>((resolvePromise) => {
          const timer = setTimeout(resolvePromise, this.gracefulShutdownMs);
          timer.unref?.();
          this.request({ cmd: 'shutdown' }).then(
            () => {
              clearTimeout(timer);
              resolvePromise();
            },
            () => {
              clearTimeout(timer);
              resolvePromise();
            },
          );
        });
      } catch {
        void 0;
      }
    }
    try {
      await worker.terminate();
    } catch {
      void 0;
    }
    this.markDead(new Error('Worker was terminated by the host.'));
  }
}
