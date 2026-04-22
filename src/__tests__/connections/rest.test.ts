import { jest } from '@jest/globals';
import { RestConnection } from '../../connections/rest.js';
import type { ConnectionOptions } from '../../connections/base.js';

jest.mock('../../connections/rate-limiter.js', () => ({
  TokenBucketRateLimiter: jest.fn().mockImplementation(() => ({
    acquire: jest.fn().mockResolvedValue(undefined),
  })),
  RateLimiterFactory: {
    create: jest.fn().mockReturnValue({ acquire: jest.fn().mockResolvedValue(undefined) }),
    getEffectiveRate: jest.fn().mockReturnValue(100),
  },
}));

const baseOptions: ConnectionOptions = {
  sourceId: 'mygene',
  baseUrl: 'https://mygene.info/v3',
  protocol: 'rest',
  rateLimit: { intervalMs: 100 },
};

describe('RestConnection', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('constructor sets sourceId and protocol from options', () => {
    const conn = new RestConnection(baseOptions);
    expect(conn.sourceId).toBe('mygene');
    expect(conn.protocol).toBe('rest');
  });

  test('request() calls fetch with correct URL (baseUrl + req path)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    }) as any;

    const conn = new RestConnection(baseOptions);
    await conn.request('/query?q=brca1');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('mygene.info');
    expect(callUrl).toContain('/query?q=brca1');
  });

  test('request() includes auth header from env var', async () => {
    process.env.TEST_API_KEY = 'secret123';
    const optionsWithAuth: ConnectionOptions = {
      ...baseOptions,
      auth: {
        envVar: 'TEST_API_KEY',
        required: false,
        delivery: { type: 'header', name: 'X-API-KEY' },
      },
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }) as any;

    const conn = new RestConnection(optionsWithAuth);
    await conn.request('/test');

    const callHeaders = (global.fetch as any).mock.calls[0][1].headers;
    expect(callHeaders.get('X-API-KEY')).toBe('secret123');

    delete process.env.TEST_API_KEY;
  });

  test('request() calls rateLimiter.acquire() before fetch', async () => {
    let acquireCalled = false;

    global.fetch = jest.fn().mockImplementation(async () => {
      return { ok: true, json: () => Promise.resolve({}) };
    }) as any;

    const conn = new RestConnection(baseOptions);
    const rateLimiter = (conn as any).rateLimiter;
    const originalAcquire = rateLimiter.acquire.bind(rateLimiter);
    rateLimiter.acquire = jest.fn().mockImplementation(async () => {
      acquireCalled = true;
      return originalAcquire();
    });

    await conn.request('/test');

    expect(acquireCalled).toBe(true);
  });

  test('healthCheck() returns true on HTTP 200', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    }) as any;

    const conn = new RestConnection(baseOptions);
    const result = await conn.healthCheck();
    expect(result).toBe(true);
  });

  test('healthCheck() returns false on network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error')) as any;

    const conn = new RestConnection(baseOptions);
    const result = await conn.healthCheck();
    expect(result).toBe(false);
  });
});
