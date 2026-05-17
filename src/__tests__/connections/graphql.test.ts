import { jest } from '@jest/globals';
import { GraphQLConnection } from '../../connections/graphql.js';
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
});
