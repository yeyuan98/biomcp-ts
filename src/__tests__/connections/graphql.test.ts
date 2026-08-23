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
