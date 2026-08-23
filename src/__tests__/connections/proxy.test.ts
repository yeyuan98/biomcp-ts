import { jest } from '@jest/globals';
// Real undici fns captured before any ESM mock is registered, so afterEach
// can restore the true global dispatcher no matter what the tests installed.
import {
  setGlobalDispatcher as realSetGlobalDispatcher,
  getGlobalDispatcher as realGetGlobalDispatcher,
} from 'undici';

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

let mockConstructShouldThrow = false;
let mockConstructorCalls = 0;

class MockEnvHttpProxyAgent {
  constructor() {
    mockConstructorCalls++;
    if (mockConstructShouldThrow) {
      throw new Error('EnvHttpProxyAgent construction failed (test)');
    }
  }
}

let mockSetGlobalDispatcher: jest.Mock;

describe('proxy dispatcher self-initialization', () => {
  let savedDispatcher: unknown;
  let savedEnv: Record<string, string | undefined>;
  let consoleErrorSpy: jest.Spied<typeof console.error>;

  async function importProxyWithMockedUndici() {
    mockSetGlobalDispatcher = jest.fn();
    await jest.unstable_mockModule('undici', () => ({
      EnvHttpProxyAgent: MockEnvHttpProxyAgent,
      setGlobalDispatcher: mockSetGlobalDispatcher,
    }));
    return import('../../connections/proxy.js');
  }

  beforeEach(() => {
    savedDispatcher = realGetGlobalDispatcher();
    savedEnv = {};
    for (const key of PROXY_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockConstructShouldThrow = false;
    mockConstructorCalls = 0;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.resetModules();
  });

  afterEach(async () => {
    for (const key of PROXY_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key]!;
    }
    consoleErrorSpy.mockRestore();
    realSetGlobalDispatcher(savedDispatcher as any);
    jest.resetModules();
  });

  test('installs EnvHttpProxyAgent as global dispatcher when proxy env is set', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.example:3128';

    const proxy = await importProxyWithMockedUndici();

    expect(mockConstructorCalls).toBe(1);
    expect(mockSetGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(mockSetGlobalDispatcher.mock.calls[0][0]).toBeInstanceOf(MockEnvHttpProxyAgent);
    expect(proxy.proxyStatus.configured).toBe(true);
    expect(proxy.proxyStatus.detail).toContain('proxy.example:3128');
  });

  test('does not touch the dispatcher and reports direct fetch when no proxy env', async () => {
    const proxy = await importProxyWithMockedUndici();

    expect(mockConstructorCalls).toBe(0);
    expect(mockSetGlobalDispatcher).not.toHaveBeenCalled();
    expect(proxy.proxyStatus.configured).toBe(false);
    expect(proxy.proxyStatus.detail).toContain('no proxy environment variables');
  });

  test('surfaces init failure on stderr and keeps direct fetch when construction throws', async () => {
    process.env.HTTP_PROXY = 'http://proxy.example:3128';
    mockConstructShouldThrow = true;

    const proxy = await importProxyWithMockedUndici();

    expect(mockSetGlobalDispatcher).not.toHaveBeenCalled();
    expect(proxy.proxyStatus.configured).toBe(false);
    expect(proxy.proxyStatus.detail).toContain('fetch remains direct');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[biomcp] proxy init failed:',
      expect.stringContaining('construction failed'),
    );
  });
});
