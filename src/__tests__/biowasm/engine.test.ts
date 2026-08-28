import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Fake WorkerHost: stands in for src/wasmcore/worker-host.js.
// ---------------------------------------------------------------------------

class FakeWorkerHost {
  static instances: FakeWorkerHost[] = [];
  readonly requests: Array<Record<string, unknown>> = [];
  readonly notifications: Array<unknown> = [];
  terminateCalls = 0;
  terminated = false;
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
    this.terminated = true;
    const death = new Error('Worker exited unexpectedly (exit code 1).');
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

const ENV_KEYS = ['ANALYSIS_BIOWASM_TIMEOUT_MS', 'ANALYSIS_BIOWASM_MEM_LIMIT_MB', 'ANALYSIS_BIOWASM_WORKER_PATH', 'BIOMCP_CACHE_DIR'] as const;
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
    // No ANALYSIS_BIOWASM_WORKER_PATH, no dist bundle next to src/… in jest.
    const err = await biowasmEngine.ensureReady().catch((e: unknown) => e);
    if (err instanceof BiowasmNotAvailableError) {
      expect(String(err.message)).toMatch(/npm run build|ANALYSIS_BIOWASM_WORKER_PATH/);
    } else {
      // dist/biowasm-worker.js exists from a prior build — the spawn is then
      // mocked, so just verify bootstrap completed.
      expect(WorkerHostMock).toHaveBeenCalled();
    }
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
    expect(stuck.terminateCalls).toBeGreaterThanOrEqual(1);
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
});
