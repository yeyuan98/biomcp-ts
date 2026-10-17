import { jest } from '@jest/globals';
import { RestConnection } from '../../connections/rest.js';
import { HttpConnectionError } from '../../connections/errors.js';
import type { ConnectionOptions } from '../../connections/base.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

jest.mock('../../connections/rate-limiter.js', () => ({
  TokenBucketRateLimiter: jest.fn<(...args: any[]) => any>().mockImplementation(() => ({
    acquire: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
  })),
  RateLimiterFactory: {
    create: jest.fn<(...args: any[]) => any>().mockReturnValue({ acquire: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined) }),
    getEffectiveRate: jest.fn<(...args: any[]) => any>().mockReturnValue(100),
  },
}));

const baseOptions: ConnectionOptions = {
  sourceId: 'mygene',
  baseUrl: 'https://mygene.info/v3',
  protocol: 'rest',
  rateLimit: { intervalMs: 100 },
};

describe('RestConnection', () => {
  mockGlobalFetch();

  test('constructor sets sourceId and protocol from options', () => {
    const conn = new RestConnection(baseOptions);
    expect(conn.sourceId).toBe('mygene');
    expect(conn.protocol).toBe('rest');
  });

  test('request() calls fetch with correct URL (baseUrl + req path)', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }) as any;

    const conn = new RestConnection(baseOptions);
    await conn.request('/query?q=brca1');

    expect((global.fetch as any).mock.calls[0][0]).toBe('https://mygene.info/v3/query?q=brca1');
  });

  test('request() attaches query-only paths directly (no separator before ?id=)', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/xml' }),
      text: () => Promise.resolve('<ok/>'),
    }) as any;

    const conn = new RestConnection({
      ...baseOptions,
      sourceId: 'query_only_fcgi',
      baseUrl: 'https://example.org/tools/api/v1/lookup.fcgi',
    });
    await conn.request('?id=1234567');

    expect((global.fetch as any).mock.calls[0][0]).toBe('https://example.org/tools/api/v1/lookup.fcgi?id=1234567');
  });

  test('request() strips trailing baseUrl slash for query-only paths (idconv)', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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

    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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

    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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

    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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

    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(async () => {
      return { ok: true, json: () => Promise.resolve({}) };
    }) as any;

    const conn = new RestConnection(baseOptions);
    const rateLimiter = (conn as any).rateLimiter;
    const originalAcquire = rateLimiter.acquire.bind(rateLimiter);
    rateLimiter.acquire = jest.fn<(...args: any[]) => any>().mockImplementation(async () => {
      acquireCalled = true;
      return originalAcquire();
    });

    await conn.request('/test');

    expect(acquireCalled).toBe(true);
  });

  test('healthCheck() returns true on HTTP 200', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      status: 200,
    }) as any;

    const conn = new RestConnection(baseOptions);
    const result = await conn.healthCheck();
    expect(result).toBe(true);
  });

  // Pins CURRENT semantics: healthCheck only fails on network errors — any
  // resolved HTTP response (even 404/500) counts as "reachable". If this is
  // deemed a bug, change the implementation deliberately and update this test.
  test('healthCheck() returns true on any resolved HTTP response (pins 404/500 => true)', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 503 }) as any;

    const conn = new RestConnection(baseOptions);
    expect(await conn.healthCheck()).toBe(true);
    expect(await conn.healthCheck()).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('request() returns text for XML content-type', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: () => Promise.resolve('plain text response'),
    }) as any;

    const conn = new RestConnection(baseOptions);
    const result = await conn.request('/test');

    expect(result).toBe('plain text response');
  });

  test('healthCheck() returns false on network error', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(new Error('Network error')) as any;

    const conn = new RestConnection(baseOptions);
    const result = await conn.healthCheck();
    expect(result).toBe(false);
  });

  test('request() includes hint for HTTP 400 (bad request / not indexed)', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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

  describe('upstream error body extraction (non-OK responses)', () => {
    test('request() appends ` — Upstream: <msg>` for a JSON error body (400)', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve('{"error":"boom detail"}'),
      }) as any;

      const conn = new RestConnection(baseOptions);
      try {
        await conn.request('/test');
        fail('Expected an error to be thrown');
      } catch (error) {
        const err = error as HttpConnectionError;
        expect(err).toBeInstanceOf(HttpConnectionError);
        expect(err.status).toBe(400);
        // Prefix (status line, URL, source, hint) is preserved verbatim; the
        // upstream message is appended at the end.
        expect(err.message).toContain('HTTP 400: Bad Request');
        expect(err.message).toContain('The request was rejected by mygene');
        expect(err.message).toContain(' — Upstream: boom detail');
        expect(err.message.indexOf('Source: mygene')).toBeLessThan(err.message.indexOf('Upstream:'));
      }
    });

    test('request() keeps the exact pre-extraction message for bodyless mocks (no .text())', async () => {
      // Unit-test mocks across the suite stub non-OK responses without any
      // body methods; extraction must be a no-op there — never a crash.
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({}),
      }) as any;

      const conn = new RestConnection(baseOptions);
      try {
        await conn.request('/test');
        fail('Expected an error to be thrown');
      } catch (error) {
        const err = error as HttpConnectionError;
        expect(err.message).toBe(
          'HTTP 400: Bad Request — URL: https://mygene.info/v3/test — Source: mygene — The request was rejected by mygene. The record may not exist or may not be indexed yet. Verify the ID is correct and try an older/established record.'
        );
        expect(err.message).not.toContain('Upstream:');
      }
    });

    test('request() leaves the message unchanged for an HTML (non-JSON) error body', async () => {
      // Live Ensembl 500s answer with HTML error pages — no JSON parse attempt.
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve('<html><body><h1>502 Bad Gateway</h1></body></html>'),
      }) as any;

      const conn = new RestConnection(baseOptions);
      try {
        await conn.request('/test');
        fail('Expected an error to be thrown');
      } catch (error) {
        const err = error as HttpConnectionError;
        expect(err.message).toContain('Server error from mygene');
        expect(err.message).not.toContain('Upstream:');
        expect(err.message).not.toContain('<html>');
      }
    });

    test('request() swallows a throwing .text() and keeps the message unchanged', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: () => Promise.reject(new Error('Body is unusable')),
      }) as any;

      const conn = new RestConnection(baseOptions);
      await expect(conn.request('/test')).rejects.toThrow('HTTP 503: Service Unavailable');
    });

    test('post() appends nested error.message objects the same way', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve('{"error":{"code":"X","message":"nested detail"}}'),
      }) as any;

      const conn = new RestConnection(baseOptions);
      try {
        await conn.post('/test', { q: 'brca1' });
        fail('Expected an error to be thrown');
      } catch (error) {
        const err = error as HttpConnectionError;
        expect(err).toBeInstanceOf(HttpConnectionError);
        expect(err.status).toBe(400);
        expect(err.message).toContain(' — Upstream: nested detail');
      }
    });

    test('request() truncates oversized upstream messages (~300 chars)', async () => {
      const long = 'x'.repeat(500);
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve(JSON.stringify({ error: long })),
      }) as any;

      const conn = new RestConnection(baseOptions);
      try {
        await conn.request('/test');
        fail('Expected an error to be thrown');
      } catch (error) {
        const err = error as HttpConnectionError;
        const marker = ' — Upstream: ';
        const extracted = err.message.slice(err.message.indexOf(marker) + marker.length);
        expect(extracted.length).toBe(301); // 300 chars + ellipsis
        expect(extracted.endsWith('…')).toBe(true);
      }
    });
  });

  test('request() throws a typed error on 3xx when followRedirects is false', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(async (_url: any, init: any) => {
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
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
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

  describe('transport-level fetch rejections', () => {
    test('fetch rejection with a cause code wraps into a status-less retryable HttpConnectionError', async () => {
      const original = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
      global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(original) as any;

      const conn = new RestConnection(baseOptions);
      try {
        await conn.request('/test');
        fail('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpConnectionError);
        const err = error as HttpConnectionError;
        expect(err.status).toBeUndefined();
        expect(err.retryable).toBe(true);
        expect(err.message).toBe('fetch failed (ETIMEDOUT)');
        expect(err.cause).toBe(original);
      }
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('fetch rejection without cause keeps the raw message verbatim (never "(undefined)")', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(new TypeError('fetch failed')) as any;

      const conn = new RestConnection(baseOptions);
      try {
        await conn.request('/test');
        fail('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpConnectionError);
        const err = error as HttpConnectionError;
        expect(err.status).toBeUndefined();
        expect(err.retryable).toBe(true);
        expect(err.message).toBe('fetch failed');
        expect(err.cause).toBeInstanceOf(TypeError);
      }
    });

    test('timeout/abort rejection passes through untouched (callers pin name + /abort|timeout/ message)', async () => {
      // What AbortSignal.timeout + undici reject with today: a DOMException
      // whose name ('TimeoutError') and message downstream consumers pin
      // (geneGet matches `name === 'AbortError'`; cross-entity, server/errors
      // and fetch-utils string-match the message). The wrap must leave it
      // exactly as-is.
      const timeoutError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(timeoutError) as any;

      const conn = new RestConnection(baseOptions);
      try {
        await conn.request('/test');
        fail('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBe(timeoutError);
        expect((error as DOMException).name).toBe('TimeoutError');
        expect((error as DOMException).message).toBe('The operation was aborted due to timeout');
        expect(/abort|timeout/i.test((error as Error).message)).toBe(true);
      }
    });

    test('caller-cancelled AbortError also passes through untouched', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(abortError) as any;

      const conn = new RestConnection(baseOptions);
      await expect(conn.request('/test')).rejects.toBe(abortError);
    });

    test('rejections without a network signature pass through raw (retry classification unchanged)', async () => {
      // Pre-existing contract: only message/cause-code network signatures are
      // classified as transport failures. A rejection with an unrelated
      // message keeps today's raw escape and non-retryable classification, so
      // retry counts (and real-backoff timing budgets elsewhere) are stable.
      const original = new Error('PPR citation endpoints exploded');
      global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(original) as any;

      const conn = new RestConnection({ ...baseOptions, retry: { attempts: 3, backoffMs: 1 } });
      await expect(conn.request('/test')).rejects.toBe(original);
      expect(global.fetch).toHaveBeenCalledTimes(1); // non-retryable: no retry fired
    });

    test('post() wraps its transport rejections identically', async () => {
      const original = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(original) as any;

      const conn = new RestConnection(baseOptions);
      try {
        await conn.post('/test', { q: 'brca1' });
        fail('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpConnectionError);
        const err = error as HttpConnectionError;
        expect(err.status).toBeUndefined();
        expect(err.message).toBe('fetch failed (ECONNREFUSED)');
        expect(err.cause).toBe(original);
      }
    });

    describe('retry interplay', () => {
      const retryOptions: ConnectionOptions = {
        ...baseOptions,
        retry: { attempts: 3, backoffMs: 1 },
      };

      test('transport rejection inside a retried source still retries and then succeeds', async () => {
        global.fetch = jest.fn<(...args: any[]) => any>()
          .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
          .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }))
          .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: 'recovered' }) }) as any;

        const conn = new RestConnection(retryOptions);
        const result = await conn.request('/test');

        expect(result).toEqual({ data: 'recovered' });
        expect(global.fetch).toHaveBeenCalledTimes(3);
      });

      test('all-attempt transport rejections surface the wrapped error after exhausting retries', async () => {
        global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(
          Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } })
        ) as any;

        const conn = new RestConnection(retryOptions);
        await expect(conn.request('/test')).rejects.toThrow('fetch failed (ETIMEDOUT)');
        expect(global.fetch).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe('registry-driven retry', () => {
    const retryOptions: ConnectionOptions = {
      ...baseOptions,
      retry: { attempts: 3, backoffMs: 1 },
    };

    test('request() retries a retryable failure (503) and succeeds', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: 'recovered' }) }) as any;

      const conn = new RestConnection(retryOptions);
      const result = await conn.request('/test');

      expect(result).toEqual({ data: 'recovered' });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('request() does not retry a non-retryable failure (400)', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      }) as any;

      const conn = new RestConnection(retryOptions);
      await expect(conn.request('/test')).rejects.toBeInstanceOf(HttpConnectionError);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('request() exhausts attempts on persistent retryable failure', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      }) as any;

      const conn = new RestConnection(retryOptions);
      await expect(conn.request('/test')).rejects.toThrow('HTTP 503');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    test('source without retry config makes a single attempt', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      }) as any;

      const conn = new RestConnection(baseOptions);
      await expect(conn.request('/test')).rejects.toThrow('HTTP 503');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('post() retries a retryable failure and succeeds', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>()
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
