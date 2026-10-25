import { jest } from '@jest/globals';
import http from 'node:http';
// Real undici fns/classes captured before any ESM mock is registered, so
// afterEach can restore the true global dispatcher no matter what the tests
// installed — and the hermetic end-to-end suite below can exercise the REAL
// setGlobalDispatcher ↔ built-in-fetch interop without touching the mocks.
import {
  Agent as RealAgent,
  setGlobalDispatcher as realSetGlobalDispatcher,
  getGlobalDispatcher as realGetGlobalDispatcher,
} from 'undici';

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;
const TIMEOUT_ENV = 'BIOMCP_CONNECT_ATTEMPT_TIMEOUT_MS';
const TUNED_CONNECT = (attemptTimeoutMs: number) => ({
  connect: { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: attemptTimeoutMs },
});

let mockAgentShouldThrow = false;
let mockEnvAgentShouldThrow = false;
const mockAgentOpts: unknown[] = [];
const mockEnvAgentOpts: unknown[] = [];

class MockAgent {
  constructor(opts: unknown) {
    mockAgentOpts.push(opts);
    if (mockAgentShouldThrow) {
      throw new Error('Agent construction failed (test)');
    }
  }
}

class MockEnvHttpProxyAgent {
  constructor(opts: unknown) {
    mockEnvAgentOpts.push(opts);
    if (mockEnvAgentShouldThrow) {
      throw new Error('EnvHttpProxyAgent construction failed (test)');
    }
  }
}

let mockSetGlobalDispatcher: jest.Mock;

describe('global dispatcher self-initialization', () => {
  let savedDispatcher: unknown;
  let savedEnv: Record<string, string | undefined>;
  let consoleErrorSpy: jest.Spied<typeof console.error>;

  async function importProxyWithMockedUndici() {
    mockSetGlobalDispatcher = jest.fn();
    await jest.unstable_mockModule('undici', () => ({
      Agent: MockAgent,
      EnvHttpProxyAgent: MockEnvHttpProxyAgent,
      setGlobalDispatcher: mockSetGlobalDispatcher,
    }));
    return import('../../connections/proxy.js');
  }

  beforeEach(() => {
    savedDispatcher = realGetGlobalDispatcher();
    savedEnv = {};
    for (const key of [...PROXY_ENV_KEYS, TIMEOUT_ENV] as const) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockAgentShouldThrow = false;
    mockEnvAgentShouldThrow = false;
    mockAgentOpts.length = 0;
    mockEnvAgentOpts.length = 0;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.resetModules();
  });

  afterEach(async () => {
    for (const key of [...PROXY_ENV_KEYS, TIMEOUT_ENV] as const) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key]!;
    }
    consoleErrorSpy.mockRestore();
    realSetGlobalDispatcher(savedDispatcher as any);
    jest.resetModules();
  });

  test('installs a tuned Agent as global dispatcher when no proxy env is set', async () => {
    const proxy = await importProxyWithMockedUndici();

    expect(mockEnvAgentOpts).toHaveLength(0);
    expect(mockAgentOpts).toEqual([TUNED_CONNECT(2000)]);
    expect(mockSetGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(mockSetGlobalDispatcher.mock.calls[0][0]).toBeInstanceOf(MockAgent);
    expect(proxy.proxyStatus.configured).toBe(false);
    expect(proxy.proxyStatus.detail).toContain('no proxy environment variables');
  });

  test('routes EnvHttpProxyAgent through setGlobalDispatcher with the SAME connect opts when proxy env is set', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.example:3128';

    const proxy = await importProxyWithMockedUndici();

    expect(mockAgentOpts).toHaveLength(0);
    expect(mockEnvAgentOpts).toEqual([TUNED_CONNECT(2000)]);
    expect(mockSetGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(mockSetGlobalDispatcher.mock.calls[0][0]).toBeInstanceOf(MockEnvHttpProxyAgent);
    expect(proxy.proxyStatus.configured).toBe(true);
    expect(proxy.proxyStatus.detail).toContain('proxy.example:3128');
  });

  test('BIOMCP_CONNECT_ATTEMPT_TIMEOUT_MS is honored verbatim, clamped to [250, 10000], and garbage falls back to 2000', async () => {
    const proxy = await importProxyWithMockedUndici();
    expect(mockAgentOpts).toEqual([TUNED_CONNECT(2000)]); // unset → default

    // configureGlobalDispatcher re-reads the env, so one import covers every case.
    for (const [raw, expected] of [
      ['3500', 3500],
      ['50', 250],
      ['99999', 10000],
      ['not-a-number', 2000],
    ] as const) {
      process.env[TIMEOUT_ENV] = raw;
      proxy.configureGlobalDispatcher();
      expect(mockAgentOpts.at(-1)).toEqual(TUNED_CONNECT(expected));
    }
  });

  test('surfaces init failure on stderr and keeps undici defaults when EnvHttpProxyAgent construction throws', async () => {
    process.env.HTTP_PROXY = 'http://proxy.example:3128';
    mockEnvAgentShouldThrow = true;

    const proxy = await importProxyWithMockedUndici();

    expect(mockSetGlobalDispatcher).not.toHaveBeenCalled();
    expect(proxy.proxyStatus.configured).toBe(false);
    expect(proxy.proxyStatus.detail).toContain('fetch remains direct');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[biomcp] proxy init failed:',
      expect.stringContaining('construction failed'),
    );
  });

  test('surfaces init failure on stderr and keeps undici defaults when Agent construction throws without proxy env', async () => {
    mockAgentShouldThrow = true;

    const proxy = await importProxyWithMockedUndici();

    expect(mockSetGlobalDispatcher).not.toHaveBeenCalled();
    expect(proxy.proxyStatus.configured).toBe(false);
    expect(proxy.proxyStatus.detail).toContain('fetch remains on undici defaults');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[biomcp] dispatcher init failed:',
      expect.stringContaining('construction failed'),
    );
  });

  test('legacy alias configureProxyDispatcher still re-tunes without throwing', async () => {
    const proxy = await importProxyWithMockedUndici();
    expect(() => proxy.configureProxyDispatcher()).not.toThrow();
    expect(mockSetGlobalDispatcher).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// Hermetic end-to-end pin: the npm-undici setGlobalDispatcher that
// proxy.ts calls really governs Node's BUILT-IN global fetch (the
// interop the whole module depends on — Node's fetch reads the global
// dispatcher symbol, and only the wrapper setGlobalDispatcher installs
// is compatible with it). Uses the real undici bindings captured in the
// static top-level import, unaffected by the mocks above. Localhost
// only — no external network.
// ============================================================
describe('installed global dispatcher governs built-in fetch (localhost interop pin)', () => {
  test('fetch succeeds through a tuned Agent installed via setGlobalDispatcher', async () => {
    const previousDispatcher = realGetGlobalDispatcher();
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('dispatched');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      realSetGlobalDispatcher(
        new RealAgent({ connect: { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 2000 } }),
      );
      const res = await fetch(`http://127.0.0.1:${port}/interop`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('dispatched');
      expect(hits).toBe(1);
    } finally {
      realSetGlobalDispatcher(previousDispatcher as any);
      server.close();
      server.closeAllConnections(); // undici keep-alive sockets would hold close() open
    }
  });
});
