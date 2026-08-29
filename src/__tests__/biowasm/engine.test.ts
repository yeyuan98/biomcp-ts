import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Deterministic worker-bundle stand-in: ANALYSIS_BIOWASM_WORKER_PATH must point
// at an EXISTING file for bootstrap to proceed, regardless of whether a real
// dist/ build is present on the machine running the tests.
const FAKE_WORKER_FILE = join(mkdtempSync(join(tmpdir(), 'biowasm-engine-test-')), 'biowasm-worker.js');
writeFileSync(FAKE_WORKER_FILE, '');

// ---------------------------------------------------------------------------
// Fake WorkerHost: stands in for src/wasmcore/worker-host.js.
// ---------------------------------------------------------------------------

class FakeWorkerHost {
  static instances: FakeWorkerHost[] = [];
  readonly requests: Array<Record<string, unknown>> = [];
  readonly notifications: Array<unknown> = [];
  terminateCalls = 0;
  killCalls = 0;
  terminated = false;
  private static readonly GRACE_MS = 5_000;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private handlers: Array<{ tool: string; impl: () => Promise<Record<string, unknown>> }> = [];
  private defaultImpl: (() => Promise<Record<string, unknown>>) | null = null;

  constructor(readonly path: string, readonly options: unknown) {
    FakeWorkerHost.instances.push(this);
  }

  request<T = Record<string, unknown>>(payload: Record<string, unknown>): Promise<T> {
    this.requests.push(payload);
    const cmd = String(payload.cmd ?? '');
    const handler = this.handlers.find((h) => h.tool === cmd);
    const impl = handler ? handler.impl : this.defaultImpl;
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject });
      if (impl) {
        impl().then(
          (v) => this.settle(id, v, reject),
          (e) => {
            this.pending.delete(id);
            reject(e instanceof Error ? e : new Error(String(e)));
          },
        );
      }
      // With no impl configured the request hangs forever (a stuck worker).
      void resolve;
    });
  }

  private settle(id: number, v: Record<string, unknown>, reject: (e: Error) => void): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (v && v.ok === false) reject(new WorkerRpcError(String(v.error ?? 'worker error')));
    else p.resolve(v);
  }

  /** Test helper: reply to a currently-hanging request. */
  reply(cmd: string, value: Record<string, unknown>): void {
    const idx = this.requests.map((r) => String(r.cmd ?? '')).lastIndexOf(cmd);
    if (idx < 0) throw new Error(`no ${cmd} request to reply to`);
    // Reconstruct the id order: ids were assigned in request order.
    const id = idx + 1;
    this.settle(id, value, () => undefined);
  }

  onCmd(cmd: string, impl: () => Promise<Record<string, unknown>>): void {
    this.handlers.push({ tool: cmd, impl });
  }

  setDefault(impl: (() => Promise<Record<string, unknown>>) | null): void {
    this.defaultImpl = impl;
  }

  notify(message: unknown): void {
    this.notifications.push(message);
  }

  async terminate(): Promise<void> {
    this.terminateCalls++;
    const death = new Error('Worker was terminated by the host.');
    setTimeout(() => {
      this.terminated = true;
      for (const [, p] of this.pending) p.reject(death);
      this.pending.clear();
    }, FakeWorkerHost.GRACE_MS);
  }

  kill(): void {
    this.killCalls++;
    this.terminated = true;
    const death = new Error('Worker was killed by the host.');
    for (const [, p] of this.pending) p.reject(death);
    this.pending.clear();
  }

  isDead(): boolean {
    return this.terminated;
  }
}

/** Mirrors the real module's RPC-failure marker class. */
class WorkerRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerRpcError';
  }
}

const WorkerHostMock = jest.fn((path: string, options: unknown) => new FakeWorkerHost(path, options));

jest.unstable_mockModule('../../wasmcore/worker-host.js', () => ({ WorkerHost: WorkerHostMock, WorkerRpcError }));

// ---------------------------------------------------------------------------
// Mocked registry: provisioning never touches the network.
// ---------------------------------------------------------------------------

const provisionMock = jest.fn(async () => ({ dir: '/fake/biowasm-assets', origin: 'cache' as const }));

jest.unstable_mockModule('../../biowasm/registry.js', () => ({
  BIOWASM_TOOLS: {
    samtools: { version: '1.21', files: ['samtools.js', 'samtools.wasm', 'samtools.data'] },
    bedtools: { version: '2.31.0', files: ['bedtools.js', 'bedtools.wasm', 'bedtools.data'] },
    bcftools: { version: '1.10', files: ['bcftools.js', 'bcftools.wasm', 'bcftools.data'] },
  },
  BIOWASM_CDN: 'https://biowasm.example/cdn',
  PINNED_SHA256: {},
  BIOWASM_TOOLS_ORDER: ['samtools', 'bedtools', 'bcftools'],
  provisionBiowasmAssets: provisionMock,
  biowasmCacheDirName: () => 'biowasm-testhash',
  biowasmCacheDirPath: () => '/fake/cache/biowasm-testhash',
  biowasmCacheStatePath: () => '/fake/cache/biowasm-testhash/biowasm-state.json',
  BiowasmAssetError: class BiowasmAssetError extends Error {},
}));

const ENV_KEYS = ['ANALYSIS_BIOWASM_TIMEOUT_MS', 'ANALYSIS_BIOWASM_MAX_RUN_MS', 'ANALYSIS_BIOWASM_MEM_LIMIT_MB', 'ANALYSIS_BIOWASM_WORKER_PATH', 'ANALYSIS_BIOWASM_WORKERS', 'BIOMCP_CACHE_DIR'] as const;
const SAVED_ENV: Record<string, string | undefined> = {};

const OK_RUN = {
  ok: true,
  exitCode: 0,
  stdout: { mode: 'count', chars: 3, lines: 1, head: 'hi', tail: 'hi', truncated: false },
  stderr: '',
  outputs: [{ vfsPath: '/shared/out/x.txt', size: 2 }],
  ioStats: { '/host/a.bam': { bytes: 10, reads: 2 } },
  heapBytes: 16 * 1024 * 1024,
};

async function importEngine() {
  const mod = await import('../../biowasm/engine.js');
  mod.resetBiowasmEngineForTests();
  return mod;
}

function currentHost(): FakeWorkerHost {
  return FakeWorkerHost.instances[FakeWorkerHost.instances.length - 1];
}

describe('biowasm engine (worker boundary mocked)', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      SAVED_ENV[k] = process.env[k];
      delete process.env[k];
    }
    process.env.BIOMCP_CACHE_DIR = `/tmp/biomcp-engine-test-${Date.now()}`;
    process.env.ANALYSIS_BIOWASM_WORKER_PATH = FAKE_WORKER_FILE;
    jest.clearAllMocks();
    jest.resetModules();
    FakeWorkerHost.instances = [];
    provisionMock.mockClear();
    provisionMock.mockResolvedValue({ dir: '/fake/biowasm-assets', origin: 'cache' as const });
    // By default, answer every request immediately.
    WorkerHostMock.mockImplementation((path: string, options: unknown) => {
      const host = new FakeWorkerHost(path, options);
      host.setDefault(async () => ({ ...OK_RUN }));
      return host;
    });
  });

  afterEach(async () => {
    const mod = await import('../../biowasm/engine.js');
    await mod.shutdownBiowasmEngine();
    for (const k of ENV_KEYS) {
      if (SAVED_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED_ENV[k]!;
    }
  });

  it('bootstraps once: provision + spawn + one init RPC with assets and tools', async () => {
    const { biowasmEngine } = await importEngine();
    await biowasmEngine.ensureReady();
    await biowasmEngine.ensureReady();
    expect(provisionMock).toHaveBeenCalledTimes(1);
    expect(WorkerHostMock).toHaveBeenCalledTimes(1);
    const spawnArgs = WorkerHostMock.mock.calls[0];
    expect(typeof spawnArgs[0]).toBe('string');
    expect(spawnArgs[1]).toMatchObject({
      workerData: { assetsDir: '/fake/biowasm-assets', tools: ['samtools', 'bedtools', 'bcftools'] },
    });
    const host = currentHost();
    expect(host.requests[0]).toMatchObject({ cmd: 'init' });
  });

  it('maps provisioning failures to BiowasmNotAvailableError with mirror hint', async () => {
    provisionMock.mockRejectedValue(new Error('boom: network down'));
    const { biowasmEngine, BiowasmNotAvailableError } = await importEngine();
    await expect(biowasmEngine.ensureReady()).rejects.toBeInstanceOf(BiowasmNotAvailableError);
    await expect(biowasmEngine.ensureReady()).rejects.toThrow(/ANALYSIS_BIOWASM_MIRROR_URL/);
    await expect(biowasmEngine.ensureReady()).rejects.toThrow(/biowasm-testhash|BIOMCP_CACHE_DIR/);
  });

  it('maps a missing worker bundle to BiowasmNotAvailableError with build hint', async () => {
    const { biowasmEngine, BiowasmNotAvailableError } = await importEngine();
    // A set-but-nonexistent worker path resolves to null deterministically,
    // independent of whether the machine running the tests has a dist/ build.
    process.env.ANALYSIS_BIOWASM_WORKER_PATH = join(tmpdir(), 'biowasm-engine-test-no-such', 'biowasm-worker.js');
    const err = await biowasmEngine.ensureReady().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BiowasmNotAvailableError);
    expect(String(err.message)).toMatch(/npm run build|ANALYSIS_BIOWASM_WORKER_PATH/);
  });

  it('runs a tool and maps the worker response', async () => {
    const { biowasmEngine } = await importEngine();
    const result = await biowasmEngine.run({ tool: 'samtools', args: ['view', '-c', '/shared/data/a.bam'] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchObject({ mode: 'count', chars: 3, lines: 1 });
    expect(result.ioStats['/host/a.bam']).toEqual({ bytes: 10, reads: 2 });
    expect(result.heapBytes).toBe(16 * 1024 * 1024);
    expect(result.ms).toBeGreaterThanOrEqual(0);
    const host = currentHost();
    expect(host.requests[1]).toMatchObject({ cmd: 'run', tool: 'samtools', stdoutSink: 'count' });
  });

  it('appends flush chunks to artifacts and acks them', async () => {
    const { biowasmEngine } = await importEngine();
    await biowasmEngine.ensureReady();
    const host = currentHost();
    host.setDefault(
      () =>
        new Promise((resolve) => {
          // Simulate the worker posting a flush notification before the response.
          const opts = host.options as { onNotification?: (m: unknown) => void };
          opts.onNotification?.({ cmd: 'flush', vfsPath: '/shared/out/x.txt', chunk: new Uint8Array([1, 2, 3]) });
          resolve({ ...OK_RUN, outputs: [{ vfsPath: '/shared/out/x.txt', size: 3 }] });
        }),
    );
    const result = await biowasmEngine.run({
      tool: 'samtools',
      args: ['view', '-b', '-o', '/shared/out/x.txt'],
      outputs: [{ vfsPath: '/shared/out/x.txt' }],
    });
    const art = result.outputs[0];
    expect(art.missing).toBeUndefined();
    expect(art.size).toBe(3);
    expect(art.sha256).toMatch(/^[0-9a-f]{64}$/);
    const ack = host.notifications.find((n) => (n as { cmd?: string }).cmd === 'flush-ack') as
      | { vfsPath: string; hostPath: string; ackedBytes: number }
      | undefined;
    expect(ack).toMatchObject({ vfsPath: '/shared/out/x.txt', ackedBytes: 3 });
    expect(ack?.hostPath).toContain('biowasm-artifacts');
  });

  it('timeout terminates the worker, rejects with BiowasmTimeoutError, and respawns on the next call', async () => {
    process.env.ANALYSIS_BIOWASM_TIMEOUT_MS = '60';
    const { biowasmEngine, BiowasmTimeoutError } = await importEngine();
    await biowasmEngine.ensureReady();
    const stuck = currentHost();
    stuck.setDefault(null); // hang every request
    await expect(biowasmEngine.run({ tool: 'samtools', args: ['view'] })).rejects.toBeInstanceOf(BiowasmTimeoutError);
    expect(stuck.killCalls).toBeGreaterThanOrEqual(1);
    // Poison-pill: the next call respawns a fresh worker and succeeds.
    const result = await biowasmEngine.run({ tool: 'samtools', args: ['view'] });
    expect(result.exitCode).toBe(0);
    expect(WorkerHostMock).toHaveBeenCalledTimes(2);
    expect(currentHost()).not.toBe(stuck);
  });

  it('worker crash rejects with BiowasmRuntimeUnresponsiveError and poisons for respawn', async () => {
    const { biowasmEngine, BiowasmRuntimeUnresponsiveError } = await importEngine();
    await biowasmEngine.ensureReady();
    const crashed = currentHost();
    crashed.setDefault(() => Promise.reject(new Error('worker exited unexpectedly (exit code 1).')));
    await expect(biowasmEngine.run({ tool: 'bedtools', args: ['merge'] })).rejects.toBeInstanceOf(
      BiowasmRuntimeUnresponsiveError,
    );
    expect(crashed.terminateCalls).toBeGreaterThanOrEqual(1);
    const result = await biowasmEngine.run({ tool: 'bedtools', args: ['merge'] });
    expect(result.exitCode).toBe(0);
    expect(WorkerHostMock).toHaveBeenCalledTimes(2);
  });

  it('serializes runs through the single-flight queue', async () => {
    const { biowasmEngine } = await importEngine();
    await biowasmEngine.ensureReady();
    const host = currentHost();
    const order: string[] = [];
    host.setDefault(
      () =>
        new Promise((resolve) => {
          order.push('start');
          setTimeout(() => {
            order.push('end');
            resolve({ ...OK_RUN });
          }, 30);
        }),
    );
    await Promise.all([
      biowasmEngine.run({ tool: 'samtools', args: ['a'] }),
      biowasmEngine.run({ tool: 'samtools', args: ['b'] }),
    ]);
    expect(order).toEqual(['start', 'end', 'start', 'end']);
  });

  it('refuses to dequeue a run when memory exceeds the watermark', async () => {
    process.env.ANALYSIS_BIOWASM_MEM_LIMIT_MB = '1';
    const { biowasmEngine } = await importEngine();
    await biowasmEngine.ensureReady();
    await expect(biowasmEngine.run({ tool: 'samtools', args: ['view'] })).rejects.toThrow(/ANALYSIS_BIOWASM_MEM_LIMIT_MB/);
  });

  it('surfaces worker error payloads as run failures', async () => {
    const { biowasmEngine } = await importEngine();
    await biowasmEngine.ensureReady();
    currentHost().setDefault(async () => ({ ok: false, error: 'output /shared/out/x exceeded its maxBytes budget (16 bytes)' }));
    await expect(
      biowasmEngine.run({ tool: 'samtools', args: ['view'], outputs: [{ vfsPath: '/shared/out/x', maxBytes: 16 }] }),
    ).rejects.toThrow(/maxBytes budget/);
  });

  it('marks declared outputs that the tool never created as missing', async () => {
    const { biowasmEngine } = await importEngine();
    await biowasmEngine.ensureReady();
    currentHost().setDefault(async () => ({ ...OK_RUN, outputs: [{ vfsPath: '/shared/out/never.txt', size: 0, missing: true }] }));
    const result = await biowasmEngine.run({ tool: 'samtools', args: ['view'], outputs: [{ vfsPath: '/shared/out/never.txt' }] });
    expect(result.outputs[0]).toMatchObject({ vfsPath: '/shared/out/never.txt', missing: true, hostPath: null });
  });

  it('rejects oversized in-band inputs before enqueueing', async () => {
    const { biowasmEngine } = await importEngine();
    await expect(
      biowasmEngine.run({ tool: 'samtools', args: ['view'], inputs: [{ name: 'big.txt', content: 'x'.repeat(21 * 1024 * 1024) }] }),
    ).rejects.toThrow(/in-band content cap/);
  });

  it('shutdown terminates the worker and clears state', async () => {
    const { biowasmEngine } = await importEngine();
    await biowasmEngine.ensureReady();
    const host = currentHost();
    await biowasmEngine.shutdown();
    expect(host.terminateCalls).toBe(1);
    expect(WorkerHostMock).toHaveBeenCalledTimes(1);
    // Engine is usable again after shutdown.
    const result = await biowasmEngine.run({ tool: 'samtools', args: ['view'] });
    expect(result.exitCode).toBe(0);
    expect(WorkerHostMock).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Cancellation (Fix B) + progress routing (Fix A), worker boundary mocked.
  // -------------------------------------------------------------------------

  it('rejects a queued run whose signal aborted before dequeue, without spawning it', async () => {
    const { biowasmEngine, BiowasmCancelledError } = await importEngine();
    await biowasmEngine.ensureReady();
    const host = currentHost();
    host.setDefault(() => new Promise((resolve) => setTimeout(() => resolve({ ...OK_RUN }), 80)));
    const controller = new AbortController();
    const first = biowasmEngine.run({ tool: 'samtools', args: ['a'] });
    const second = biowasmEngine.run({ tool: 'samtools', args: ['b'], signal: controller.signal });
    setTimeout(() => controller.abort(), 20); // abort while `second` is still queued
    await expect(first).resolves.toMatchObject({ exitCode: 0 });
    await expect(second).rejects.toBeInstanceOf(BiowasmCancelledError);
    await expect(second).rejects.toThrow('cancelled before start');
    const runCmds = host.requests.filter((r) => r.cmd === 'run');
    expect(runCmds).toHaveLength(1);
    expect(runCmds[0]).toMatchObject({ args: ['a'] });
  });

  it('aborts a running run: host.kill called, kill rejection reclassified as BiowasmCancelledError', async () => {
    const { biowasmEngine, BiowasmCancelledError, BiowasmRuntimeUnresponsiveError } = await importEngine();
    await biowasmEngine.ensureReady();
    const host = currentHost();
    host.setDefault(null); // hang; kill() rejects the pending RPC with the generic message
    const controller = new AbortController();
    const pending = biowasmEngine.run({ tool: 'samtools', args: ['view'], signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    const err = (await pending.catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(BiowasmCancelledError);
    expect(err).not.toBeInstanceOf(BiowasmRuntimeUnresponsiveError);
    expect(err.message).toBe('cancelled by client');
    expect(host.killCalls).toBeGreaterThanOrEqual(1);
  });

  it('routes worker progress messages to the current run and ignores unknown runIds', async () => {
    const { biowasmEngine } = await importEngine();
    await biowasmEngine.ensureReady();
    const host = currentHost();
    const events: Array<{ bytes: number; elapsedMs: number; message?: string }> = [];
    host.setDefault(
      () =>
        new Promise((resolve) => {
          const opts = host.options as { onNotification?: (m: unknown) => void };
          const runId = host.requests[host.requests.length - 1]!.runId;
          opts.onNotification?.({ type: 'progress', runId: 999_999, value: 7 }); // unknown → ignored
          opts.onNotification?.({ type: 'progress', runId, value: 42, message: 'streaming' });
          opts.onNotification?.({ type: 'progress', runId, value: 50 });
          resolve({ ...OK_RUN });
        }),
    );
    const result = await biowasmEngine.run({
      tool: 'samtools',
      args: ['view'],
      stdout: 'capture',
      onProgress: (p) => events.push(p),
    });
    expect(result.exitCode).toBe(0);
    expect(events.map((e) => e.bytes)).toEqual([42, 50]);
    expect(events[0]!.message).toBe('streaming');
    expect(events[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('ignores stale progress messages emitted after the run was killed', async () => {
    const { biowasmEngine, BiowasmCancelledError } = await importEngine();
    await biowasmEngine.ensureReady();
    const host = currentHost();
    host.setDefault(null);
    const events: unknown[] = [];
    const controller = new AbortController();
    const pending = biowasmEngine.run({
      tool: 'samtools',
      args: ['view'],
      signal: controller.signal,
      onProgress: () => events.push('late'),
    });
    setTimeout(() => controller.abort(), 25);
    await expect(pending).rejects.toBeInstanceOf(BiowasmCancelledError);
    const opts = host.options as { onNotification?: (m: unknown) => void };
    expect(() => opts.onNotification?.({ type: 'progress', runId: 1, value: 99, message: 'from the killed worker' })).not.toThrow();
    expect(events).toHaveLength(0);
  });

  it('progress activity resets the inactivity deadline but not the max-run ceiling', async () => {
    process.env.ANALYSIS_BIOWASM_TIMEOUT_MS = '120';
    process.env.ANALYSIS_BIOWASM_MAX_RUN_MS = '420';
    const { biowasmEngine, BiowasmTimeoutError } = await importEngine();
    await biowasmEngine.ensureReady();
    const host = currentHost();
    let bytes = 0;
    host.setDefault(
      () =>
        new Promise((resolve) => {
          const opts = host.options as { onNotification?: (m: unknown) => void };
          const runId = host.requests[host.requests.length - 1]!.runId;
          const iv = setInterval(() => {
            bytes += 10;
            opts.onNotification?.({ type: 'progress', runId, value: bytes });
          }, 50);
          setTimeout(() => {
            clearInterval(iv);
            resolve({ ...OK_RUN }); // would finish at 600 ms — beyond the 420 ms ceiling
          }, 600);
        }),
    );
    const started = Date.now();
    await expect(biowasmEngine.run({ tool: 'samtools', args: ['view'] })).rejects.toBeInstanceOf(BiowasmTimeoutError);
    const elapsed = Date.now() - started;
    // Steady progress kept the run alive past the 120 ms inactivity deadline…
    expect(elapsed).toBeGreaterThanOrEqual(380);
    // …but the 420 ms absolute ceiling still fired.
    expect(elapsed).toBeLessThan(2_000);
    expect(host.killCalls).toBeGreaterThanOrEqual(1);
  });

  it('a run with steady progress outlives the inactivity deadline when under the ceiling', async () => {
    process.env.ANALYSIS_BIOWASM_TIMEOUT_MS = '120';
    process.env.ANALYSIS_BIOWASM_MAX_RUN_MS = '5000';
    const { biowasmEngine } = await importEngine();
    await biowasmEngine.ensureReady();
    const host = currentHost();
    host.setDefault(
      () =>
        new Promise((resolve) => {
          const opts = host.options as { onNotification?: (m: unknown) => void };
          const runId = host.requests[host.requests.length - 1]!.runId;
          const iv = setInterval(() => opts.onNotification?.({ type: 'progress', runId, value: 1 }), 50);
          setTimeout(() => {
            clearInterval(iv);
            resolve({ ...OK_RUN }); // 350 ms > the 120 ms inactivity deadline
          }, 350);
        }),
    );
    const result = await biowasmEngine.run({ tool: 'samtools', args: ['view'] });
    expect(result.exitCode).toBe(0);
    expect(host.killCalls).toBe(0);
  });


  // -------------------------------------------------------------------------
  // Worker pool (ANALYSIS_BIOWASM_WORKERS > 1).
  // -----------------------------------------------------------------

  /** Per-instance default-impl override with restore; index = spawn order. */
  function installImpl(
    implFor: (host: FakeWorkerHost, index: number) => () => Promise<Record<string, unknown>>,
    opts: { failInitFor?: (index: number) => boolean } = {},
  ): () => void {
    const orig = WorkerHostMock.getMockImplementation();
    WorkerHostMock.mockImplementation((path: string, options: unknown) => {
      const host = new FakeWorkerHost(path, options);
      const index = FakeWorkerHost.instances.length - 1;
      // init must always answer (even when the default impl blocks) unless
      // the test deliberately fails a slot's bootstrap.
      host.onCmd('init', async () =>
        opts.failInitFor?.(index) ? ({ ok: false, error: 'second worker cannot start' } as Record<string, unknown>) : { ok: true },
      );
      host.setDefault(implFor(host, index));
      return host;
    });
    return () => WorkerHostMock.mockImplementation(orig!);
  }

  function gate(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => (resolve = res));
    return { promise, resolve };
  }

  it('pool=2: two concurrent runs execute on two workers concurrently', async () => {
    process.env.ANALYSIS_BIOWASM_WORKERS = '2';
    const { biowasmEngine } = await importEngine();
    const release = gate();
    const restore = installImpl((_host, index) =>
      index === 0 ? () => release.promise.then(() => ({ ...OK_RUN })) : async () => ({ ...OK_RUN }),
    );
    try {
      await biowasmEngine.ensureReady();
      const host0 = FakeWorkerHost.instances[0]!;
      const first = biowasmEngine.run({ tool: 'samtools', args: ['a'] });
      await new Promise((resolve) => setTimeout(resolve, 20)); // first is in flight
      const second = biowasmEngine.run({ tool: 'samtools', args: ['b'] });
      await new Promise((resolve) => setTimeout(resolve, 60)); // contention spawns slot 1
      expect(FakeWorkerHost.instances).toHaveLength(2);
      const host1 = FakeWorkerHost.instances[1]!;
      expect(host1.requests.some((r) => r.cmd === 'run' && (r.args as string[])?.[0] === 'b')).toBe(true);
      expect(host0.requests.some((r) => r.cmd === 'run' && (r.args as string[])?.[0] === 'a')).toBe(true);
      release.resolve();
      await expect(first).resolves.toMatchObject({ exitCode: 0 });
      await expect(second).resolves.toMatchObject({ exitCode: 0 });
      expect(biowasmEngine.poolStatus()).toMatchObject({ configured: 2, alive: 2 });
    } finally {
      restore();
    }
  });

  it('pool default 1: sequential calls never spawn a second worker', async () => {
    const { biowasmEngine } = await importEngine();
    expect(biowasmEngine.workerSlots()).toBe(1);
    await biowasmEngine.ensureReady();
    await biowasmEngine.run({ tool: 'samtools', args: ['a'] });
    await biowasmEngine.run({ tool: 'samtools', args: ['b'] });
    expect(FakeWorkerHost.instances).toHaveLength(1);
  });

  it('pool=2: cancelling one run kills only that slot; a concurrent run on the other slot survives', async () => {
    process.env.ANALYSIS_BIOWASM_WORKERS = '2';
    const { biowasmEngine, BiowasmCancelledError } = await importEngine();
    const release = gate();
    const restore = installImpl((_host, index) =>
      index === 0 ? () => release.promise.then(() => ({ ...OK_RUN })) : async () => ({ ...OK_RUN }),
    );
    try {
      await biowasmEngine.ensureReady();
      const host0 = FakeWorkerHost.instances[0]!;
      const controller = new AbortController();
      const cancelled = biowasmEngine.run({ tool: 'samtools', args: ['a'], signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const survivor = biowasmEngine.run({ tool: 'samtools', args: ['b'] });
      await new Promise((resolve) => setTimeout(resolve, 60));
      const host1 = FakeWorkerHost.instances[1]!;
      controller.abort(); // kill slot 0's worker mid-run
      await expect(cancelled).rejects.toBeInstanceOf(BiowasmCancelledError);
      expect(host0.killCalls).toBeGreaterThanOrEqual(1);
      expect(host1.killCalls).toBe(0);
      await expect(survivor).resolves.toMatchObject({ exitCode: 0 });
      expect(host1.requests.some((r) => r.cmd === 'run' && (r.args as string[])?.[0] === 'b')).toBe(true);
      release.resolve();
    } finally {
      restore();
    }
  });

  it('pool=1: a run queued behind a cancelled run survives via respawn instead of failing', async () => {
    const { biowasmEngine, BiowasmCancelledError } = await importEngine();
    await biowasmEngine.ensureReady();
    const host0 = currentHost();
    host0.setDefault(null); // hang every request on this worker
    const controller = new AbortController();
    const first = biowasmEngine.run({ tool: 'samtools', args: ['a'], signal: controller.signal });
    const second = biowasmEngine.run({ tool: 'samtools', args: ['b'] }); // queued behind first
    setTimeout(() => controller.abort(), 25);
    await expect(first).rejects.toBeInstanceOf(BiowasmCancelledError);
    // The queued run must NOT fail with BiowasmRuntimeUnresponsiveError: the
    // slot respawns (a fresh worker) and the run completes.
    await expect(second).resolves.toMatchObject({ exitCode: 0 });
    expect(FakeWorkerHost.instances.length).toBeGreaterThanOrEqual(2);
    const respawned = FakeWorkerHost.instances[FakeWorkerHost.instances.length - 1]!;
    expect(respawned.requests.some((r) => r.cmd === 'run' && (r.args as string[])?.[0] === 'b')).toBe(true);
  });

  it('pool=2: concurrent same-vfsPath outputs get slot-scoped flush acks', async () => {
    process.env.ANALYSIS_BIOWASM_WORKERS = '2';
    const { biowasmEngine } = await importEngine();
    const release = gate();
    const flusher = (host: FakeWorkerHost) => () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const opts = host.options as { onNotification?: (m: unknown) => void };
        opts.onNotification?.({ cmd: 'flush', vfsPath: '/shared/out/same.txt', chunk: new Uint8Array(7) });
        resolve({ ...OK_RUN, outputs: [{ vfsPath: '/shared/out/same.txt', size: 7 }] });
      });
    const restore = installImpl((host, _index) => () => release.promise.then(flusher(host)));
    try {
      await biowasmEngine.ensureReady();
      const first = biowasmEngine.run({ tool: 'samtools', args: ['a'], outputs: [{ vfsPath: '/shared/out/same.txt' }] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = biowasmEngine.run({ tool: 'samtools', args: ['b'], outputs: [{ vfsPath: '/shared/out/same.txt' }] });
      await new Promise((resolve) => setTimeout(resolve, 60));
      const host0 = FakeWorkerHost.instances[0]!;
      const host1 = FakeWorkerHost.instances[1]!;
      release.resolve();
      const [r1, r2] = await Promise.all([first, second]);
      // Each run got its own artifact file (slot-scoped state)…
      expect(r1.outputs[0]!.hostPath).not.toBe(r2.outputs[0]!.hostPath);
      // …and each ack landed on the worker that flushed.
      const ack0 = host0.notifications.find((n) => (n as { cmd?: string }).cmd === 'flush-ack');
      const ack1 = host1.notifications.find((n) => (n as { cmd?: string }).cmd === 'flush-ack');
      expect(ack0).toMatchObject({ vfsPath: '/shared/out/same.txt', ackedBytes: 7, hostPath: r1.outputs[0]!.hostPath });
      expect(ack1).toMatchObject({ vfsPath: '/shared/out/same.txt', ackedBytes: 7, hostPath: r2.outputs[0]!.hostPath });
    } finally {
      restore();
    }
  });

  it('pool=2: runId reuse across slots — progress stays slot-local', async () => {
    process.env.ANALYSIS_BIOWASM_WORKERS = '2';
    const { biowasmEngine } = await importEngine();
    const release = gate();
    const restore = installImpl((host, index) =>
      index === 0
        ? () =>
            release.promise.then(() => {
              const opts = host.options as { onNotification?: (m: unknown) => void };
              opts.onNotification?.({ type: 'progress', runId: 1, value: 111 });
              return { ...OK_RUN };
            })
        : () =>
            new Promise((resolve) => {
              // Slot 1 mints its own runId 1 with a DIFFERENT value: slot 0's
              // run (also runId 1) must not receive it.
              const opts = host.options as { onNotification?: (m: unknown) => void };
              opts.onNotification?.({ type: 'progress', runId: 1, value: 222 });
              resolve({ ...OK_RUN });
            }),
    );
    try {
      await biowasmEngine.ensureReady();
      const eventsA: number[] = [];
      const eventsB: number[] = [];
      const first = biowasmEngine.run({ tool: 'samtools', args: ['a'], onProgress: (p) => eventsA.push(p.bytes) });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = biowasmEngine.run({ tool: 'samtools', args: ['b'], onProgress: (p) => eventsB.push(p.bytes) });
      await new Promise((resolve) => setTimeout(resolve, 60)); // second ran on slot 1
      release.resolve(); // slot 0's run reports and settles
      await Promise.all([first, second]);
      expect(eventsA).toEqual([111]);
      expect(eventsB).toEqual([222]);
    } finally {
      restore();
    }
  });

  it('pool=2: a failed lazy spawn degrades to queueing and is memoized (no retry storm)', async () => {
    process.env.ANALYSIS_BIOWASM_WORKERS = '2';
    const { biowasmEngine } = await importEngine();
    const release = gate();
    // The second spawn's init RPC fails permanently; slot 0's runs block on
    // the gate so the second call contends.
    const restore = installImpl(
      (_host, index) => (index === 0 ? () => release.promise.then(() => ({ ...OK_RUN })) : async () => ({ ...OK_RUN })),
      { failInitFor: (index) => index > 0 },
    );
    try {
      await biowasmEngine.ensureReady();
      const first = biowasmEngine.run({ tool: 'samtools', args: ['a'] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = biowasmEngine.run({ tool: 'samtools', args: ['b'] });
      await new Promise((resolve) => setTimeout(resolve, 80));
      release.resolve();
      await expect(first).resolves.toMatchObject({ exitCode: 0 });
      await expect(second).resolves.toMatchObject({ exitCode: 0 }); // degraded: queued on slot 0
      // Further runs must not retry the failed capacity.
      await biowasmEngine.run({ tool: 'samtools', args: ['c'] });
      expect(FakeWorkerHost.instances).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it('clamps invalid ANALYSIS_BIOWASM_WORKERS values to the default 1', async () => {
    process.env.ANALYSIS_BIOWASM_WORKERS = '0';
    const { biowasmEngine } = await importEngine();
    expect(biowasmEngine.workerSlots()).toBe(1);
  });

  it('shutdown with a live pool terminates every worker', async () => {
    process.env.ANALYSIS_BIOWASM_WORKERS = '2';
    const { biowasmEngine } = await importEngine();
    const release = gate();
    const restore = installImpl((_host, index) =>
      index === 0 ? () => release.promise.then(() => ({ ...OK_RUN })) : async () => ({ ...OK_RUN }),
    );
    try {
      await biowasmEngine.ensureReady();
      const run = biowasmEngine.run({ tool: 'samtools', args: ['a'] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      void biowasmEngine.run({ tool: 'samtools', args: ['b'] });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(FakeWorkerHost.instances).toHaveLength(2);
      release.resolve();
      await run;
      await biowasmEngine.shutdown();
      for (const host of FakeWorkerHost.instances.slice(0, 2)) {
        expect(host.terminateCalls).toBe(1);
      }
    } finally {
      restore();
    }
  });
});
