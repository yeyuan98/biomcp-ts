import { jest } from '@jest/globals';
import { GraphQLConnection } from '../../connections/graphql.js';
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
  sourceId: 'gnomad',
  baseUrl: 'https://gnomad.broadinstitute.org/api',
  protocol: 'graphql',
  rateLimit: { intervalMs: 100 },
};

describe('GraphQLConnection', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('request() sends POST with GraphQL query in body', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: {} }),
    }) as any;

    const conn = new GraphQLConnection(baseOptions);
    await conn.request('{ gene { name } }');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const callArgs = (global.fetch as any).mock.calls[0];
    expect(callArgs[0]).toBe('https://gnomad.broadinstitute.org/api');
    expect(callArgs[1].method).toBe('POST');

    const body = JSON.parse(callArgs[1].body);
    expect(body.query).toBe('{ gene { name } }');
  });

  test('request() includes Bearer auth header', async () => {
    process.env.GNOMAD_TOKEN = 'bearer-secret';
    const authConfig = {
      envVar: 'GNOMAD_TOKEN',
      required: false,
      delivery: { type: 'bearer' as const },
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: {} }),
    }) as any;

    const conn = new GraphQLConnection(baseOptions, authConfig);
    await conn.request('{ gene { name } }');

    const callHeaders = (global.fetch as any).mock.calls[0][1].headers;
    expect(callHeaders.get('Authorization')).toBe('Bearer bearer-secret');

    delete process.env.GNOMAD_TOKEN;
  });

  test('request() includes a timeout signal in fetch', async () => {
    global.fetch = jest.fn().mockImplementation(async (_url: string, init: any) => {
      expect(init.signal).toBeDefined();
      return { ok: true, json: () => Promise.resolve({ data: {} }) };
    }) as any;

    const conn = new GraphQLConnection(baseOptions);
    await conn.request('{ gene { name } }');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('request() accepts external signal and combines with timeout', async () => {
    const externalCtrl = new AbortController();

    global.fetch = jest.fn().mockImplementation(async (_url: string, init: any) => {
      expect(init.signal).toBeDefined();
      return { ok: true, json: () => Promise.resolve({ data: {} }) };
    }) as any;

    const conn = new GraphQLConnection(baseOptions);
    await conn.request('{ gene { name } }', undefined, { signal: externalCtrl.signal });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('healthCheck() includes a timeout signal', async () => {
    global.fetch = jest.fn().mockImplementation(async (_url: string, init: any) => {
      expect(init.signal).toBeDefined();
      return { ok: false, status: 500 };
    }) as any;

    const conn = new GraphQLConnection(baseOptions);
    await conn.healthCheck();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('healthCheck() returns true on HTTP 200 and on 400 (GraphQL endpoints reject bare POSTs with 400)', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 400 }) as any;

    const conn = new GraphQLConnection(baseOptions);
    expect(await conn.healthCheck()).toBe(true);
    expect(await conn.healthCheck()).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('healthCheck() returns false on non-400 HTTP errors and network errors', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockRejectedValueOnce(new Error('Network error')) as any;

    const conn = new GraphQLConnection(baseOptions);
    expect(await conn.healthCheck()).toBe(false);
    expect(await conn.healthCheck()).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('request() passes through partial data despite errors[]', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { gene: { name: 'BRCA1' }, otherRoot: { ok: true } },
        errors: [{ message: 'field unavailable' }],
      }),
    }) as any;

    const conn = new GraphQLConnection(baseOptions);
    const result = await conn.request('{ gene { name } }') as any;

    expect(result.data.gene.name).toBe('BRCA1');
    expect(result.errors).toHaveLength(1);
  });

  test('request() throws typed error when errors[] accompany null data', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: null,
        errors: [{ message: 'internal server error' }],
      }),
    }) as any;

    const conn = new GraphQLConnection(baseOptions);
    const promise = conn.request('{ gene { name } }');
    await expect(promise).rejects.toBeInstanceOf(HttpConnectionError);
    await expect(promise).rejects.toThrow('GraphQL error from gnomad: internal server error');
  });

  test('request() throws when rootField is null alongside errors[]', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { gene: null, otherRoot: { ok: true } },
        errors: [{ message: 'could not resolve gene' }],
      }),
    }) as any;

    const conn = new GraphQLConnection(baseOptions);
    await expect(
      conn.request('{ gene { name } }', undefined, { rootField: 'gene' })
    ).rejects.toThrow("root field 'gene' is null/missing: could not resolve gene");

    const result = await conn.request('{ gene { name } otherRoot { ok } }', undefined, {
      rootField: 'otherRoot',
    }) as any;
    expect(result.data.gene).toBeNull();
  });

  test('request() returns data unchanged when no errors[]', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { gene: null } }),
    }) as any;

    const conn = new GraphQLConnection(baseOptions);
    const result = await conn.request('{ gene { name } }', undefined, { rootField: 'gene' }) as any;

    expect(result).toEqual({ data: { gene: null } });
  });

  describe('transport-level fetch rejections', () => {
    test('fetch rejection with a cause code wraps into a status-less retryable HttpConnectionError', async () => {
      const original = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      global.fetch = jest.fn().mockRejectedValue(original) as any;

      const conn = new GraphQLConnection(baseOptions);
      try {
        await conn.request('{ gene { name } }');
        fail('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpConnectionError);
        const err = error as HttpConnectionError;
        expect(err.status).toBeUndefined();
        expect(err.retryable).toBe(true);
        expect(err.message).toBe('fetch failed (ECONNREFUSED)');
        expect(err.cause).toBe(original);
      }
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('fetch rejection without cause keeps the raw message verbatim (never "(undefined)")', async () => {
      global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed')) as any;

      const conn = new GraphQLConnection(baseOptions);
      try {
        await conn.request('{ gene { name } }');
        fail('Expected an error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpConnectionError);
        const err = error as HttpConnectionError;
        expect(err.status).toBeUndefined();
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
      global.fetch = jest.fn().mockRejectedValue(timeoutError) as any;

      const conn = new GraphQLConnection(baseOptions);
      try {
        await conn.request('{ gene { name } }');
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
      global.fetch = jest.fn().mockRejectedValue(abortError) as any;

      const conn = new GraphQLConnection(baseOptions);
      await expect(conn.request('{ gene { name } }')).rejects.toBe(abortError);
    });

    test('rejections without a network signature pass through raw (retry classification unchanged)', async () => {
      const original = new Error('PPR citation endpoints exploded');
      global.fetch = jest.fn().mockRejectedValue(original) as any;

      const conn = new GraphQLConnection({ ...baseOptions, retry: { attempts: 3, backoffMs: 1 } });
      await expect(conn.request('{ gene { name } }')).rejects.toBe(original);
      expect(global.fetch).toHaveBeenCalledTimes(1); // non-retryable: no retry fired
    });

    test('transport rejection inside a retried source still retries and then succeeds', async () => {
      global.fetch = jest.fn()
        .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
        .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }))
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: { gene: { name: 'BRCA1' } } }) }) as any;

      const conn = new GraphQLConnection({ ...baseOptions, retry: { attempts: 3, backoffMs: 1 } });
      const result = await conn.request('{ gene { name } }') as any;

      expect(result.data.gene.name).toBe('BRCA1');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    test('all-attempt transport rejections surface the wrapped error after exhausting retries', async () => {
      global.fetch = jest.fn().mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } })
      ) as any;

      const conn = new GraphQLConnection({ ...baseOptions, retry: { attempts: 3, backoffMs: 1 } });
      await expect(conn.request('{ gene { name } }')).rejects.toThrow('fetch failed (ETIMEDOUT)');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('registry-driven retry', () => {
    const retryOptions: ConnectionOptions = {
      ...baseOptions,
      retry: { attempts: 3, backoffMs: 1 },
    };

    test('request() retries a retryable failure (503) and succeeds', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: { gene: { name: 'BRCA1' } } }) }) as any;

      const conn = new GraphQLConnection(retryOptions);
      const result = await conn.request('{ gene { name } }') as any;

      expect(result.data.gene.name).toBe('BRCA1');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('request() does not retry a non-retryable failure (400)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      }) as any;

      const conn = new GraphQLConnection(retryOptions);
      await expect(conn.request('{ gene { name } }')).rejects.toBeInstanceOf(HttpConnectionError);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('source without retry config makes a single attempt', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      }) as any;

      const conn = new GraphQLConnection(baseOptions);
      await expect(conn.request('{ gene { name } }')).rejects.toThrow('HTTP 503');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
