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

  test('request() returns text for XML content-type', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/xml; charset=utf-8' }),
      text: () => Promise.resolve('<root><item>data</item></root>'),
    }) as any;

    const conn = new RestConnection(baseOptions);
    const result = await conn.request('/test');

    expect(typeof result).toBe('string');
    expect(result).toContain('<root>');
  });

  test('request() returns text for application/xml content-type', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/xml' }),
      text: () => Promise.resolve('<response>ok</response>'),
    }) as any;

    const conn = new RestConnection(baseOptions);
    const result = await conn.request('/test');

    expect(typeof result).toBe('string');
    expect(result).toContain('<response>');
  });

  test('request() returns text for text/plain content-type', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: () => Promise.resolve('plain text response'),
    }) as any;

    const conn = new RestConnection(baseOptions);
    const result = await conn.request('/test');

    expect(result).toBe('plain text response');
  });

  test('healthCheck() returns false on network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error')) as any;

    const conn = new RestConnection(baseOptions);
    const result = await conn.healthCheck();
    expect(result).toBe(false);
  });

  test('request() includes hint for HTTP 400 (bad request / not indexed)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
    }) as any;

    const conn = new RestConnection(baseOptions);
    try {
      await conn.request('/test');
      fail('Expected an error to be thrown');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('The request was rejected by mygene');
      expect(msg).toContain('may not be indexed yet');
    }
  });

  test('request() includes hint for HTTP 404 (not found)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    }) as any;

    const conn = new RestConnection(baseOptions);
    try {
      await conn.request('/test');
      fail('Expected an error to be thrown');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('Resource not found at mygene');
      expect(msg).toContain('Verify the ID');
    }
  });

  test('request() includes hint for HTTP 429 (rate limited)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    }) as any;

    const conn = new RestConnection(baseOptions);
    try {
      await conn.request('/test');
      fail('Expected an error to be thrown');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('Rate limited by mygene');
      expect(msg).toContain('Wait a few seconds and retry');
      expect(msg).toContain('API key in environment variables');
    }
  });

  test('request() includes hint for HTTP 401 (auth required)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }) as any;

    const conn = new RestConnection(baseOptions);
    try {
      await conn.request('/test');
      fail('Expected an error to be thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Authentication required or forbidden by mygene');
    }
  });

  test('request() includes hint for HTTP 403 (forbidden)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    }) as any;

    const conn = new RestConnection(baseOptions);
    try {
      await conn.request('/test');
      fail('Expected an error to be thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Authentication required or forbidden by mygene');
    }
  });

  test('request() includes hint for HTTP 500 (server error)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }) as any;

    const conn = new RestConnection(baseOptions);
    try {
      await conn.request('/test');
      fail('Expected an error to be thrown');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('Server error from mygene');
      expect(msg).toContain('temporarily unavailable');
    }
  });

  test('request() includes no hint for other HTTP errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 418,
      statusText: "I'm a Teapot",
    }) as any;

    const conn = new RestConnection(baseOptions);
    try {
      await conn.request('/test');
      fail('Expected an error to be thrown');
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain('HTTP 418');
      expect(msg).not.toContain('— The request');
      expect(msg).not.toContain('Rate limited');
      expect(msg).not.toContain('Server error');
    }
  });
});
