import { existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync, writeSync, closeSync, ftruncateSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerHost, WorkerRpcError } from '../wasmcore/worker-host.js';
import { SerializationQueue } from '../wasmcore/queue.js';
import { assertWithinMemoryLimit } from '../wasmcore/memwatch.js';
import { runWithWatchdog } from '../wasmcore/watchdog.js';
import { PROGRESS_MSG_TYPE } from '../wasmcore/progress.js';
import { cacheDir, sha256File } from '../wasmcore/assets.js';
import { BIOWASM_TOOLS_ORDER, biowasmCacheDirPath, provisionBiowasmAssets } from './registry.js';
import type {
  BiowasmCaptureSummary,
  BiowasmCountSummary,
  BiowasmIoStat,
  BiowasmStdoutSummary,
  BiowasmWorkerOutput,
  BiowasmWorkerRunResponse,
} from './worker.js';

const TIMEOUT_ENV_VAR = 'ANALYSIS_BIOWASM_TIMEOUT_MS';
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_RUN_ENV_VAR = 'ANALYSIS_BIOWASM_MAX_RUN_MS';
const DEFAULT_MAX_RUN_MS = 3_600_000;
const MEM_LIMIT_ENV_VAR = 'ANALYSIS_BIOWASM_MEM_LIMIT_MB';
const DEFAULT_MEM_LIMIT_MB = 2048;
const WORKER_PATH_ENV_VAR = 'ANALYSIS_BIOWASM_WORKER_PATH';
const WORKERS_ENV_VAR = 'ANALYSIS_BIOWASM_WORKERS';
const DEFAULT_WORKERS = 1;
const INIT_TIMEOUT_MS = 120_000;
const DEFAULT_INPUT_CHARS = 20 * 1024 * 1024;

export class BiowasmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BiowasmTimeoutError';
  }
}

export class BiowasmCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BiowasmCancelledError';
  }
}

export class BiowasmNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BiowasmNotAvailableError';
  }
}

export class BiowasmRuntimeUnresponsiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BiowasmRuntimeUnresponsiveError';
  }
}

export type BiowasmToolName = (typeof BIOWASM_TOOLS_ORDER)[number];

export interface BiowasmInputFile {
  name: string;
  content: string;
}

export interface BiowasmMount {
  hostPath: string;
  vfsPath: string;
}

export interface BiowasmOutputRequest {
  vfsPath: string;
  maxBytes?: number;
}

export interface BiowasmArtifact {
  vfsPath: string;
  hostPath: string | null;
  size: number;
  sha256: string | null;
  missing?: boolean;
}

export interface BiowasmRunProgress {
  bytes: number;
  elapsedMs: number;
  message?: string;
}

export interface BiowasmRunRequest {
  tool: BiowasmToolName;
  args: string[];
  inputs?: BiowasmInputFile[];
  mounts?: BiowasmMount[];
  outputs?: BiowasmOutputRequest[];
  stdout?: 'count' | 'capture';
  timeoutMs?: number;
  /**
   * Client cancellation. Aborting while queued rejects the run before it
   * starts; aborting mid-run kills the worker (a fresh one respawns on the
   * next call) and rejects with BiowasmCancelledError.
   */
  signal?: AbortSignal;
  /** Per-run progress sink (bytes read so far); never sent to the worker. */
  onProgress?: (p: BiowasmRunProgress) => void;
}

export interface BiowasmRunResult {
  exitCode: number | null;
  stdout: BiowasmStdoutSummary;
  stderr: string;
  outputs: BiowasmArtifact[];
  ioStats: Record<string, BiowasmIoStat>;
  heapBytes: number;
  ms: number;
}

export type { BiowasmCountSummary, BiowasmCaptureSummary, BiowasmStdoutSummary, BiowasmIoStat };

export interface BiowasmPoolStatus {
  configured: number;
  alive: number;
  busy: number;
}

function timeoutMs(): number {
  const v = Number(process.env[TIMEOUT_ENV_VAR]);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

function maxRunMs(): number {
  const v = Number(process.env[MAX_RUN_ENV_VAR]);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_RUN_MS;
}

/** ANALYSIS_BIOWASM_WORKERS: pool size (>= 1); default 1 = serial, as before. */
function workerCount(): number {
  const v = Number(process.env[WORKERS_ENV_VAR]);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_WORKERS;
}

/**
 * Worker bundle discovery: ANALYSIS_BIOWASM_WORKER_PATH override >
 * import.meta-URL-relative biowasm-worker.js > dist/biowasm-worker.js sibling
 * of the main bundle (plan §2.4). Dev mode (tsx from src/) has no dist/, so a
 * prior `npm run build` or the env override is required.
 */
function resolveWorkerPath(): string | null {
  const envPath = process.env[WORKER_PATH_ENV_VAR];
  if (envPath) {
    return existsSync(envPath) ? envPath : null;
  }
  const here = fileURLToPath(new URL('biowasm-worker.js', import.meta.url));
  if (existsSync(here)) {
    return here;
  }
  const dist = resolve(process.cwd(), 'dist', 'biowasm-worker.js');
  if (existsSync(dist)) {
    return dist;
  }
  return null;
}

interface ArtifactState {
  hostPath: string;
  size: number;
}

/** The run whose RPC is in flight; progress messages are routed to it. */
interface ActiveRun {
  runId: number;
  startedMs: number;
  onProgress?: (p: BiowasmRunProgress) => void;
  noteActivity(): void;
}

function extractMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * State shared by every worker slot. The artifact filename sequence is
 * engine-wide so names stay collision-free across slots (single-threaded
 * main thread, no locking); asset provisioning is memoized so concurrently
 * bootstrapping slots never double-download — with two honesty rules from
 * the pre-pool engine preserved: the public assetsDirectory() only turns
 * non-null once a worker bundle was actually found next to the provisioned
 * assets (markAssetsReady), and a failed worker init invalidates the memo so
 * the next respawn re-provisions (deleted/corrupted caches self-heal).
 */
interface EngineShared {
  readonly artifactsDir: string;
  nextArtifactSeq(): number;
  provisionAssets(): Promise<string>;
  markAssetsReady(dir: string): void;
  invalidateAssets(): void;
}

/**
 * One serialized worker: a WorkerHost, its single-flight queue, and
 * SLOT-SCOPED state that must never cross workers — the per-run artifacts map
 * (vfsPath → host backing file while a run streams output), progress routing
 * (currentRun keyed by this slot's runIds), and the flush-ack reply target
 * (an ack delivered to the wrong worker leaves its OutFileState.acked frozen
 * and later reads in [acked, flushed) fail with EIO).
 */
class BiowasmSlot {
  private host: WorkerHost | null = null;
  private readyPromise: Promise<void> | null = null;
  private poisoned = false;
  /** Set once the init RPC resolved — a mid-bootstrap host is not yet alive. */
  private booted = false;
  private readonly queue = new SerializationQueue();
  private readonly artifacts = new Map<string, ArtifactState>();
  private runSeq = 0;
  private currentRun: ActiveRun | null = null;
  /** Queued + running jobs; the router's idle/busy signal. */
  inFlight = 0;
  runsSettled = 0;

  constructor(readonly index: number, private readonly shared: EngineShared) {}

  async ensureReady(): Promise<void> {
    if (this.poisoned) {
      // Poison-pill: discard the dead worker so the next call respawns.
      this.poisoned = false;
      await this.teardown();
    }
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.bootstrap().catch((err) => {
      this.readyPromise = null;
      throw err;
    });
    return this.readyPromise;
  }

  isAlive(): boolean {
    return this.booted && this.host !== null && !this.poisoned && !this.host.isDead();
  }

  private async teardown(): Promise<void> {
    this.readyPromise = null;
    this.booted = false;
    this.closeArtifacts();
    const host = this.host;
    this.host = null;
    if (host) {
      await host.terminate();
    }
  }

  private poison(): void {
    this.poisoned = true;
    this.readyPromise = null;
    this.booted = false;
    const host = this.host;
    this.host = null;
    if (host) {
      void host.terminate();
    }
    this.closeArtifacts();
  }

  private closeArtifacts(): void {
    this.artifacts.clear();
  }

  private artifactFor(vfsPath: string): ArtifactState {
    let art = this.artifacts.get(vfsPath);
    if (!art) {
      const safe = basename(vfsPath).replace(/[^A-Za-z0-9._-]/g, '_') || 'output';
      const hostPath = join(this.shared.artifactsDir, `${Date.now().toString(36)}-${this.shared.nextArtifactSeq()}-${safe}`);
      writeFileSync(hostPath, '');
      art = { hostPath, size: 0 };
      this.artifacts.set(vfsPath, art);
    }
    return art;
  }

  private handleNotification(raw: unknown): void {
    if (this.handleProgressMessage(raw)) return;
    const msg = raw as { cmd?: string; vfsPath?: string; chunk?: Uint8Array; size?: number; from?: string; to?: string };
    if (!msg || typeof msg.cmd !== 'string' || typeof msg.vfsPath !== 'string') return;
    switch (msg.cmd) {
      case 'flush': {
        const chunk = msg.chunk;
        if (!chunk || chunk.byteLength === 0) return;
        const art = this.artifactFor(msg.vfsPath);
        const fd = openSync(art.hostPath, 'a');
        try {
          writeSync(fd, chunk);
        } finally {
          closeSync(fd);
        }
        art.size += chunk.byteLength;
        this.host?.notify({ cmd: 'flush-ack', vfsPath: msg.vfsPath, hostPath: art.hostPath, ackedBytes: art.size });
        return;
      }
      case 'truncate': {
        const art = this.artifacts.get(msg.vfsPath);
        if (art && typeof msg.size === 'number' && msg.size < art.size) {
          const fd = openSync(art.hostPath, 'r+');
          try {
            ftruncateSync(fd, msg.size);
          } finally {
            closeSync(fd);
          }
          art.size = msg.size;
        }
        return;
      }
      case 'rename': {
        const art = this.artifacts.get(msg.from ?? '');
        if (art && typeof msg.to === 'string') {
          this.artifacts.delete(msg.from ?? '');
          this.artifacts.set(msg.to, art);
        }
        return;
      }
      case 'unlink': {
        const art = this.artifacts.get(msg.vfsPath);
        if (art) {
          try {
            rmSync(art.hostPath, { force: true });
          } catch {
            void 0;
          }
          this.artifacts.delete(msg.vfsPath);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Routes worker progress messages (wasmcore 'progress' convention) to the
   * CURRENT run's onProgress, keyed by runId; stale messages from killed
   * workers (unknown runIds) are ignored. Any progress also resets the run's
   * inactivity deadline.
   */
  private handleProgressMessage(raw: unknown): boolean {
    const msg = raw as { type?: unknown; runId?: unknown; value?: unknown; message?: unknown };
    if (!msg || typeof msg !== 'object' || msg.type !== PROGRESS_MSG_TYPE) return false;
    const run = this.currentRun;
    if (!run || msg.runId !== run.runId) return true;
    run.noteActivity();
    if (run.onProgress && typeof msg.value === 'number') {
      try {
        run.onProgress({
          bytes: msg.value,
          elapsedMs: Date.now() - run.startedMs,
          message: typeof msg.message === 'string' ? msg.message : undefined,
        });
      } catch {
        void 0;
      }
    }
    return true;
  }

  private async bootstrap(): Promise<void> {
    // Worker-bundle check FIRST: fail fast without touching the asset cache
    // (and without flipping the engine's public assetsDirectory()).
    const workerPath = resolveWorkerPath();
    if (!workerPath) {
      throw new BiowasmNotAvailableError(
        'The biowasm worker bundle was not found. Run `npm run build` to produce dist/biowasm-worker.js, ' +
          `or set ${WORKER_PATH_ENV_VAR} to an existing worker bundle path.`,
      );
    }
    let assetsDir: string;
    try {
      assetsDir = await this.shared.provisionAssets();
    } catch (err) {
      throw new BiowasmNotAvailableError(
        `The biowasm wasm assets could not be provisioned: ${extractMessage(err)} ` +
          `Assets cache under: ${biowasmCacheDirPath()} (set BIOMCP_CACHE_DIR to relocate). ` +
          `Set ANALYSIS_BIOWASM_MIRROR_URL to a local directory, .tar.gz archive, or http(s) URL holding the pinned tool files to provision offline.`,
      );
    }
    mkdirSync(this.shared.artifactsDir, { recursive: true });
    const host = new WorkerHost(workerPath, {
      onNotification: (m) => this.handleNotification(m),
      workerData: { assetsDir, tools: [...BIOWASM_TOOLS_ORDER] },
      resourceLimits: { maxOldGenerationSizeMb: 2048, maxYoungGenerationSizeMb: 128 },
    });
    this.host = host;
    try {
      await Promise.race([
        host.request({ cmd: 'init' }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`worker init exceeded ${Math.round(INIT_TIMEOUT_MS / 1000)}s`)), INIT_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      await this.teardown();
      // A failed init may reflect a broken asset cache (the pre-pool engine
      // re-provisioned on every bootstrap): drop the memo so the next
      // respawn re-verifies instead of looping on the same dead assets.
      this.shared.invalidateAssets();
      throw new BiowasmNotAvailableError(
        `The biowasm worker failed to start from ${workerPath} (assets: ${assetsDir}): ${extractMessage(err)}.`,
      );
    }
    this.booted = true;
    this.shared.markAssetsReady(assetsDir);
  }

  async run(request: BiowasmRunRequest): Promise<BiowasmRunResult> {
    const signal = request.signal;
    this.inFlight += 1;
    try {
      return await this.queue.enqueue(async () => {
        if (signal?.aborted) {
          throw new BiowasmCancelledError('cancelled before start');
        }
        // Re-await readiness INSIDE the queued job: a slot poisoned by an
        // earlier cancellation/timeout respawns for its next queued job
        // instead of failing it (queued jobs never re-enter the pre-enqueue
        // readiness check).
        await this.ensureReady();
        const host = this.host;
        if (!host) {
          throw new BiowasmRuntimeUnresponsiveError('The biowasm worker is not running.');
        }
        // Once dequeued, any abort kills the worker even mid pre-flight: the
        // pending (or next) RPC then rejects with the kill error and is
        // reclassified below as a cancellation. While queued, the entry check
        // above already rejected the run.
        let aborting = false;
        const onAbort = () => {
          aborting = true;
          host.kill();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const started = Date.now();
        let response: BiowasmWorkerRunResponse;
        let cancelMessage = '';
        try {
          await assertWithinMemoryLimit(MEM_LIMIT_ENV_VAR, DEFAULT_MEM_LIMIT_MB);
          for (const out of request.outputs ?? []) {
            // Fresh host file per run: prior artifact ids keep pointing at their
            // original (now immutable) files instead of silently changing content.
            this.artifacts.delete(out.vfsPath);
          }
          const runId = ++this.runSeq;
          // ANALYSIS_BIOWASM_TIMEOUT_MS is an inactivity deadline (reset by
          // worker progress); ANALYSIS_BIOWASM_MAX_RUN_MS is the absolute
          // ceiling no activity can extend.
          const timeout = request.timeoutMs ?? timeoutMs();
          const maxRun = maxRunMs();
          cancelMessage =
            `Biowasm tool run exceeded its time limit (inactivity limit ${Math.round(timeout / 1000)}s, ` +
            `max run ${Math.round(maxRun / 1000)}s) and the worker was terminated. ` +
            `Raise ${TIMEOUT_ENV_VAR} (inactivity) or ${MAX_RUN_ENV_VAR} (absolute ceiling), or reduce the input size.`;
          response = await runWithWatchdog(
            (handle) => {
              this.currentRun = {
                runId,
                startedMs: started,
                onProgress: request.onProgress,
                noteActivity: () => handle.activity(),
              };
              return host.request<BiowasmWorkerRunResponse>({
                cmd: 'run',
                // Correlation token echoed by worker progress messages.
                // signal/onProgress stay here: functions and AbortSignals are
                // not structured-cloneable and are never sent to the worker.
                runId,
                tool: request.tool,
                args: request.args,
                inputs: request.inputs,
                mounts: request.mounts,
                outputs: request.outputs,
                stdoutSink: request.stdout ?? 'count',
              });
            },
            {
              timeoutMs: timeout,
              watchdogMs: 500,
              maxRunMs: maxRun,
              cancel: () => host.kill(),
              discard: () => this.poison(),
              isCancelError: () => false,
              cancelMessage,
              discardError: new BiowasmRuntimeUnresponsiveError(
                'The biowasm worker did not settle after termination; it was discarded and a fresh worker starts on the next call.',
              ),
            },
          );
          if (host.isDead()) {
            this.poison();
            if (aborting) {
              throw new BiowasmCancelledError('cancelled by client');
            }
            throw new BiowasmRuntimeUnresponsiveError(
              'The biowasm worker died while the run was finishing; a fresh worker starts on the next call.',
            );
          }
        } catch (err) {
          if (aborting) {
            this.poison();
            throw new BiowasmCancelledError('cancelled by client');
          }
          if (err instanceof WorkerRpcError) {
            // The worker answered with a run-level failure; it is still healthy.
            throw new Error(err.message);
          }
          if (err instanceof BiowasmRuntimeUnresponsiveError) {
            this.poison();
            throw err;
          }
          if (err instanceof Error && cancelMessage !== '' && err.message === cancelMessage) {
            this.poison();
            throw new BiowasmTimeoutError(cancelMessage);
          }
          // Worker death (crash / unexpected exit) without a timeout.
          this.poison();
          throw new BiowasmRuntimeUnresponsiveError(
            `The biowasm worker failed during the run: ${extractMessage(err)}. A fresh worker starts on the next call.`,
          );
        } finally {
          this.currentRun = null;
          signal?.removeEventListener('abort', onAbort);
        }
        const outputs = response.outputs.map((o: BiowasmWorkerOutput): BiowasmArtifact => {
          if (o.missing) {
            return { vfsPath: o.vfsPath, hostPath: null, size: 0, sha256: null, missing: true };
          }
          const art = this.artifactFor(o.vfsPath);
          let sha: string | null = null;
          try {
            sha = sha256File(art.hostPath);
          } catch {
            sha = null;
          }
          return { vfsPath: o.vfsPath, hostPath: art.hostPath, size: statSync(art.hostPath).size, sha256: sha };
        });
        return {
          exitCode: response.exitCode,
          stdout: response.stdout,
          stderr: response.stderr,
          outputs,
          ioStats: response.ioStats,
          heapBytes: response.heapBytes,
          ms: Date.now() - started,
        };
      });
    } finally {
      this.inFlight -= 1;
      this.runsSettled += 1;
    }
  }

  async shutdown(): Promise<void> {
    this.poisoned = false;
    this.queue.reset();
    await this.teardown();
  }
}

/**
 * Engine-level router over N serialized worker slots (ANALYSIS_BIOWASM_WORKERS,
 * default 1 = today's strictly serial behavior). Slot 0 is the primary and
 * eagerly ready; further slots spawn lazily under contention — a call that
 * would queue while every existing slot is busy synchronously reserves one
 * additional slot (up to the configured pool size) and awaits its bootstrap.
 * Spawn failures are memoized for the engine's lifetime: no retry storms, the
 * contending call simply queues on an existing slot.
 */
class BiowasmEngine {
  private slots: BiowasmSlot[] = [];
  private readonly maxWorkers = workerCount();
  /** Slots created + permanently failed lazy spawns; caps total attempts. */
  private attemptedSpawns = 0;
  /** Provisioning memo (dir of a verified asset set). */
  private provisionedDir: string | null = null;
  private assetsPromise: Promise<string> | null = null;
  /** Public readiness marker: set only after a worker bundle was found. */
  private assetsDir: string | null = null;
  private readonly artifactsDir = join(cacheDir(), 'biowasm-artifacts');
  private artifactSeq = 0;
  private rrSeq = 0;
  private readonly shared: EngineShared = {
    artifactsDir: this.artifactsDir,
    nextArtifactSeq: () => this.artifactSeq++,
    provisionAssets: () => this.provisionOnce(),
    markAssetsReady: (dir) => {
      this.assetsDir = dir;
    },
    invalidateAssets: () => {
      this.assetsPromise = null;
      this.provisionedDir = null;
      this.assetsDir = null;
    },
  };

  private provisionOnce(): Promise<string> {
    if (this.provisionedDir) return Promise.resolve(this.provisionedDir);
    if (!this.assetsPromise) {
      this.assetsPromise = provisionBiowasmAssets()
        .then((resolution) => {
          this.provisionedDir = resolution.dir;
          return resolution.dir;
        })
        .catch((err: unknown) => {
          this.assetsPromise = null;
          throw err;
        });
    }
    return this.assetsPromise;
  }

  private slot0(): BiowasmSlot {
    if (this.slots.length === 0) {
      this.slots.push(new BiowasmSlot(0, this.shared));
      this.attemptedSpawns = 1;
    }
    return this.slots[0]!;
  }

  async ensureReady(): Promise<void> {
    return this.slot0().ensureReady();
  }

  /** The configured (clamped, stable) pool size — not the live idle count. */
  workerSlots(): number {
    return this.maxWorkers;
  }

  poolStatus(): BiowasmPoolStatus {
    return {
      configured: this.maxWorkers,
      alive: this.slots.filter((s) => s.isAlive()).length,
      busy: this.slots.filter((s) => s.inFlight > 0).length,
    };
  }

  /**
   * Readiness guard for routing to a not-yet-booted slot: callers awaiting a
   * bootstrap-in-progress slot get the same degrade-to-queueing semantics as
   * the caller that reserved it. Slot 0 is fail-fast by design — its
   * readiness problems are the engine's problems and surface directly.
   */
  private spawnGuard(slot: BiowasmSlot): Promise<void> | null {
    if (slot.isAlive()) return null;
    if (slot.index === 0) return null;
    return slot.ensureReady().catch((err: unknown) => {
      // Memoized failure: never retry this capacity again; drop the slot.
      this.slots = this.slots.filter((s) => s !== slot);
      throw err;
    });
  }

  /**
   * Synchronous routing decision — check, reserve, and push happen before
   * any await so concurrent callers can never double-reserve the same
   * capacity. Returns the target slot plus the bootstrap promise when that
   * slot is not yet booted (null for live slots).
   */
  private route(): { slot: BiowasmSlot; spawn: Promise<void> | null } {
    const idle = this.slots.filter((s) => s.inFlight === 0);
    if (idle.length > 0) {
      const slot = idle[this.rrSeq++ % idle.length]!;
      return { slot, spawn: this.spawnGuard(slot) };
    }
    if (this.attemptedSpawns < this.maxWorkers) {
      const slot = new BiowasmSlot(this.slots.length, this.shared);
      this.slots.push(slot);
      this.attemptedSpawns += 1;
      return { slot, spawn: this.spawnGuard(slot) };
    }
    let fewest = this.slots[0]!;
    for (const slot of this.slots) {
      if (slot.inFlight < fewest.inFlight) fewest = slot;
    }
    return { slot: fewest, spawn: this.spawnGuard(fewest) };
  }

  async run(request: BiowasmRunRequest): Promise<BiowasmRunResult> {
    // Fail fast on the primary slot: provisioning and worker problems surface
    // here exactly as they did before the pool existed.
    await this.slot0().ensureReady();
    for (const input of request.inputs ?? []) {
      if (input.content.length > DEFAULT_INPUT_CHARS) {
        throw new Error(
          `input ${input.name} exceeds the in-band content cap (${DEFAULT_INPUT_CHARS} chars); use a host-file mount instead`,
        );
      }
    }
    // Every not-yet-booted target is awaited (shared, memoized bootstrap) and
    // every spawn failure re-routes — a degraded spawn promise is never
    // dropped, so systemic spawn failures can't surface as unhandled
    // rejections. Terminates: failed spawns consume attemptedSpawns capacity
    // and slot 0 / alive slots carry no spawn promise.
    let target = this.route();
    while (target.spawn !== null) {
      try {
        await target.spawn;
        break; // bootstrapped — run on it
      } catch {
        target = this.route(); // spawn failed — re-route
      }
    }
    return target.slot.run(request);
  }

  assetsDirectory(): string | null {
    return this.assetsDir;
  }

  async shutdown(): Promise<void> {
    // Parallel teardown: N graceful-terminate waits must not serialize.
    await Promise.all(this.slots.map((slot) => slot.shutdown()));
    this.slots = [];
    this.attemptedSpawns = 0;
    this.rrSeq = 0;
  }
}

export const biowasmEngine = new BiowasmEngine();

export async function shutdownBiowasmEngine(): Promise<void> {
  await biowasmEngine.shutdown();
}

export function resetBiowasmEngineForTests(): void {
  void biowasmEngine.shutdown();
}
