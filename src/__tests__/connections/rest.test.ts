import { jest } from '@jest/globals';
import { RestConnection } from '../../connections/rest.js';
import { HttpConnectionError } from '../../connections/errors.js';
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

  test('request() builds exact URL for normal paths (no double slash)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }) as any;

    const conn = new RestConnection(baseOptions);
    await conn.request('/query?q=brca1');

    expect((global.fetch as any).mock.calls[0][0]).toBe('https://mygene.info/v3/query?q=brca1');
  });

  test('request() attaches query-only paths directly (pmc_oa: no separator before ?id=)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/xml' }),
      text: () => Promise.resolve('<OA/>'),
    }) as any;

    const conn = new RestConnection({
      ...baseOptions,
      sourceId: 'pmc_oa',
      baseUrl: 'https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi',
    });
    await conn.request('?id=PMC1234567');

    expect((global.fetch as any).mock.calls[0][0]).toBe('https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC1234567');
  });

  test('request() strips trailing baseUrl slash for query-only paths (idconv)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }) as any;

    const conn = new RestConnection({
      ...baseOptions,
      sourceId: 'ncbi_idconv_slashed',
      baseUrl: 'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/',
    });
    await conn.request('?ids=12345&format=json');

    expect((global.fetch as any).mock.calls[0][0]).toBe('https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles?ids=12345&format=json');
  });

  test('request() attaches fragment-only paths directly', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }) as any;

    const conn = new RestConnection({
      ...baseOptions,
      sourceId: 'fragment_probe',
      baseUrl: 'https://example.org/api/endpoint',
    });
    await conn.request('#frag');

    expect((global.fetch as any).mock.calls[0][0]).toBe('https://example.org/api/endpoint#frag');
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

  test('request() appends handling.envQueryParams when the env var is set, omits them otherwise', async () => {
    process.env.NCBI_EMAIL = 'researcher@example.org';
    const optionsWithEnvParams: ConnectionOptions = {
      ...baseOptions,
      handling: {
        envQueryParams: [{ envVar: 'NCBI_EMAIL', params: { tool: 'biomcp-ts', email: '$NCBI_EMAIL' } }],
      },
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }) as any;

    const conn = new RestConnection(optionsWithEnvParams);
    await conn.request('/esearch.fcgi');
    let callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('tool=biomcp-ts');
    expect(callUrl).toContain('email=researcher%40example.org');

    delete process.env.NCBI_EMAIL;
    await conn.request('/esearch.fcgi');
    callUrl = (global.fetch as any).mock.calls[1][0] as string;
    expect(callUrl).not.toContain('tool=');
    expect(callUrl).not.toContain('email=');
  });

  test('request() includes custom headers from handling.headers', async () => {
    const optionsWithHeaders: ConnectionOptions = {
      ...baseOptions,
      handling: {
        headers: { 'User-Agent': 'biomcp-test-agent/1.0', 'X-Custom': 'abc' },
      },
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }) as any;

    const conn = new RestConnection(optionsWithHeaders);
    await conn.request('/test');

    const callHeaders = (global.fetch as any).mock.calls[0][1].headers;
    expect(callHeaders.get('User-Agent')).toBe('biomcp-test-agent/1.0');
    expect(callHeaders.get('X-Custom')).toBe('abc');
    expect(callHeaders.get('Accept')).toBe('application/json');
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
      expect(error).toBeInstanceOf(HttpConnectionError);
      const err = error as HttpConnectionError;
      expect(err.status).toBe(400);
      expect(err.retryable).toBe(false);
      const msg = err.message;
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
      expect(error).toBeInstanceOf(HttpConnectionError);
      const err = error as HttpConnectionError;
      expect(err.status).toBe(404);
      expect(err.retryable).toBe(false);
      const msg = err.message;
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
      expect(error).toBeInstanceOf(HttpConnectionError);
      const err = error as HttpConnectionError;
      expect(err.status).toBe(429);
      expect(err.retryable).toBe(true);
      const msg = err.message;
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
      expect(error).toBeInstanceOf(HttpConnectionError);
      const err = error as HttpConnectionError;
      expect(err.status).toBe(401);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('Authentication required or forbidden by mygene');
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
      expect(error).toBeInstanceOf(HttpConnectionError);
      const err = error as HttpConnectionError;
      expect(err.status).toBe(403);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('Authentication required or forbidden by mygene');
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
      expect(error).toBeInstanceOf(HttpConnectionError);
      const err = error as HttpConnectionError;
      expect(err.status).toBe(500);
      expect(err.retryable).toBe(true);
      const msg = err.message;
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
      expect(error).toBeInstanceOf(HttpConnectionError);
      const err = error as HttpConnectionError;
      expect(err.status).toBe(418);
      expect(err.retryable).toBe(false);
      const msg = err.message;
      expect(msg).toContain('HTTP 418');
      expect(msg).not.toContain('— The request');
      expect(msg).not.toContain('Rate limited');
      expect(msg).not.toContain('Server error');
    }
  });

  test('request() throws a typed error on 3xx when followRedirects is false', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 301,
      statusText: 'Moved Permanently',
      headers: new Headers({ location: 'https://dead-host.example/index/api/v1/metadata' }),
    }) as any;

    const conn = new RestConnection({ ...baseOptions, followRedirects: false });
    try {
      await conn.request('/metadata/10.1093/nar/gkl999');
      fail('Expected an error to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpConnectionError);
      const err = error as HttpConnectionError;
      expect(err.status).toBe(301);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('Unexpected redirect');
      expect(err.message).toContain('dead-host.example');
    }
    expect((global.fetch as any).mock.calls[0][1].redirect).toBe('manual');
  });

  test('request() follows redirects by default', async () => {
    // Simulates fetch's built-in redirect handling: with redirect:'follow'
    // the caller only ever sees the final 200; only a manual redirect mode
    // would surface the 301 (and then rest.ts would throw).
    global.fetch = jest.fn().mockImplementation(async (_url: any, init: any) => {
      if (init.redirect === 'manual') {
        return {
          ok: false,
          status: 301,
          statusText: 'Moved Permanently',
          headers: new Headers({ location: 'https://mygene.info/v3/test' }),
        };
      }
      return { ok: true, json: () => Promise.resolve({ data: 'followed' }) };
    }) as any;

    const conn = new RestConnection(baseOptions);
    const result = await conn.request('/test');

    expect(result).toEqual({ data: 'followed' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as any).mock.calls[0][1].redirect).toBe('follow');
  });

  test('post() with a string body sends text/plain verbatim (Reactome AnalysisService shape)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ pathways: [] }),
    }) as any;

    const conn = new RestConnection(baseOptions);
    const result = await conn.post('/identifiers/projection', 'TP53\nEGFR\nKRAS');

    const [, init] = (global.fetch as any).mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers.get('Content-Type')).toBe('text/plain');
    expect(init.body).toBe('TP53\nEGFR\nKRAS');
    expect(result).toEqual({ pathways: [] });
  });

  describe('registry-driven retry', () => {
    const retryOptions: ConnectionOptions = {
      ...baseOptions,
      retry: { attempts: 3, backoffMs: 1 },
    };

    test('request() retries a retryable failure (503) and succeeds', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: 'recovered' }) }) as any;

      const conn = new RestConnection(retryOptions);
      const result = await conn.request('/test');

      expect(result).toEqual({ data: 'recovered' });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('request() does not retry a non-retryable failure (400)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      }) as any;

      const conn = new RestConnection(retryOptions);
      await expect(conn.request('/test')).rejects.toBeInstanceOf(HttpConnectionError);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('request() exhausts attempts on persistent retryable failure', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      }) as any;

      const conn = new RestConnection(retryOptions);
      await expect(conn.request('/test')).rejects.toThrow('HTTP 503');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    test('source without retry config makes a single attempt', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      }) as any;

      const conn = new RestConnection(baseOptions);
      await expect(conn.request('/test')).rejects.toThrow('HTTP 503');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('post() retries a retryable failure and succeeds', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ data: 'recovered' }),
        }) as any;

      const conn = new RestConnection(retryOptions);
      const result = await conn.post('/test', { q: 'brca1' });

      expect(result).toEqual({ data: 'recovered' });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
