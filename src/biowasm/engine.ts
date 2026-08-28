import { existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync, writeSync, closeSync, ftruncateSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerHost, WorkerRpcError } from '../wasmcore/worker-host.js';
import { SerializationQueue } from '../wasmcore/queue.js';
import { assertWithinMemoryLimit } from '../wasmcore/memwatch.js';
import { runWithWatchdog } from '../wasmcore/watchdog.js';
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
const MEM_LIMIT_ENV_VAR = 'ANALYSIS_BIOWASM_MEM_LIMIT_MB';
const DEFAULT_MEM_LIMIT_MB = 2048;
const WORKER_PATH_ENV_VAR = 'ANALYSIS_BIOWASM_WORKER_PATH';
const INIT_TIMEOUT_MS = 120_000;
const DEFAULT_INPUT_CHARS = 20 * 1024 * 1024;

export class BiowasmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BiowasmTimeoutError';
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

export interface BiowasmRunRequest {
  tool: BiowasmToolName;
  args: string[];
  inputs?: BiowasmInputFile[];
  mounts?: BiowasmMount[];
  outputs?: BiowasmOutputRequest[];
  stdout?: 'count' | 'capture';
  timeoutMs?: number;
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

function timeoutMs(): number {
  const v = Number(process.env[TIMEOUT_ENV_VAR]);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
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

function extractMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class BiowasmEngine {
  private host: WorkerHost | null = null;
  private readyPromise: Promise<void> | null = null;
  private poisoned = false;
  private readonly queue = new SerializationQueue();
  private readonly artifacts = new Map<string, ArtifactState>();
  private readonly artifactsDir = join(cacheDir(), 'biowasm-artifacts');
  private artifactSeq = 0;
  private assetsDir: string | null = null;

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

  private async teardown(): Promise<void> {
    this.readyPromise = null;
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
      const hostPath = join(this.artifactsDir, `${Date.now().toString(36)}-${this.artifactSeq++}-${safe}`);
      writeFileSync(hostPath, '');
      art = { hostPath, size: 0 };
      this.artifacts.set(vfsPath, art);
    }
    return art;
  }

  private handleNotification(raw: unknown): void {
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

  private async bootstrap(): Promise<void> {
    let assetsDir: string;
    try {
      const resolution = await provisionBiowasmAssets();
      assetsDir = resolution.dir;
    } catch (err) {
      throw new BiowasmNotAvailableError(
        `The biowasm wasm assets could not be provisioned: ${extractMessage(err)} ` +
          `Assets cache under: ${biowasmCacheDirPath()} (set BIOMCP_CACHE_DIR to relocate). ` +
          `Set ANALYSIS_BIOWASM_MIRROR_URL to a local directory, .tar.gz archive, or http(s) URL holding the pinned tool files to provision offline.`,
      );
    }
    const workerPath = resolveWorkerPath();
    if (!workerPath) {
      throw new BiowasmNotAvailableError(
        'The biowasm worker bundle was not found. Run `npm run build` to produce dist/biowasm-worker.js, ' +
          `or set ${WORKER_PATH_ENV_VAR} to an existing worker bundle path.`,
      );
    }
    mkdirSync(this.artifactsDir, { recursive: true });
    this.assetsDir = assetsDir;
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
      throw new BiowasmNotAvailableError(
        `The biowasm worker failed to start from ${workerPath} (assets: ${assetsDir}): ${extractMessage(err)}.`,
      );
    }
  }

  async checkMemory(): Promise<void> {
    assertWithinMemoryLimit(MEM_LIMIT_ENV_VAR, DEFAULT_MEM_LIMIT_MB);
  }

  async run(request: BiowasmRunRequest): Promise<BiowasmRunResult> {
    await this.ensureReady();
    for (const input of request.inputs ?? []) {
      if (input.content.length > DEFAULT_INPUT_CHARS) {
        throw new Error(
          `input ${input.name} exceeds the in-band content cap (${DEFAULT_INPUT_CHARS} chars); use a host-file mount instead`,
        );
      }
    }
    return this.queue.enqueue(async () => {
      await this.checkMemory();
      const host = this.host;
      if (!host) {
        throw new BiowasmRuntimeUnresponsiveError('The biowasm worker is not running.');
      }
      for (const out of request.outputs ?? []) {
        // Fresh host file per run: prior artifact ids keep pointing at their
        // original (now immutable) files instead of silently changing content.
        this.artifacts.delete(out.vfsPath);
      }
      const started = Date.now();
      const timeout = request.timeoutMs ?? timeoutMs();
      const cancelMessage =
        `Biowasm tool run exceeded the time limit (${Math.round(timeout / 1000)}s) and the worker was terminated. ` +
        'Raise ANALYSIS_BIOWASM_TIMEOUT_MS or reduce the input size.';
      let response: BiowasmWorkerRunResponse;
      try {
        response = await runWithWatchdog(
          () =>
            host.request<BiowasmWorkerRunResponse>({
              cmd: 'run',
              tool: request.tool,
              args: request.args,
              inputs: request.inputs,
              mounts: request.mounts,
              outputs: request.outputs,
              stdoutSink: request.stdout ?? 'count',
            }),
          {
            timeoutMs: timeout,
            watchdogMs: 500,
            cancel: () => host.kill(),
            discard: () => this.poison(),
            isCancelError: () => false,
            cancelMessage,
            discardError: new BiowasmRuntimeUnresponsiveError(
              'The biowasm worker did not settle after termination; it was discarded and a fresh worker starts on the next call.',
            ),
          },
        );
      } catch (err) {
        if (err instanceof WorkerRpcError) {
          // The worker answered with a run-level failure; it is still healthy.
          throw new Error(err.message);
        }
        if (err instanceof BiowasmRuntimeUnresponsiveError) {
          this.poison();
          throw err;
        }
        if (err instanceof Error && err.message === cancelMessage) {
          this.poison();
          throw new BiowasmTimeoutError(cancelMessage);
        }
        // Worker death (crash / unexpected exit) without a timeout.
        this.poison();
        throw new BiowasmRuntimeUnresponsiveError(
          `The biowasm worker failed during the run: ${extractMessage(err)}. A fresh worker starts on the next call.`,
        );
      }
      if (host.isDead()) {
        this.poison();
        throw new BiowasmRuntimeUnresponsiveError(
          'The biowasm worker died while the run was finishing; a fresh worker starts on the next call.',
        );
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
  }

  assetsDirectory(): string | null {
    return this.assetsDir;
  }

  async shutdown(): Promise<void> {
    this.poisoned = false;
    this.queue.reset();
    await this.teardown();
  }
}

export const biowasmEngine = new BiowasmEngine();

export async function shutdownBiowasmEngine(): Promise<void> {
  await biowasmEngine.shutdown();
}

export function resetBiowasmEngineForTests(): void {
  void biowasmEngine.shutdown();
}
