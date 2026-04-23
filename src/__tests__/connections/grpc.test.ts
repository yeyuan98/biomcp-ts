import { jest } from '@jest/globals';
import { GrpcConnection } from '../../connections/grpc.js';
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
  sourceId: 'alphagenome',
  baseUrl: 'gdmscience.googleapis.com:443',
  protocol: 'grpc',
  auth: {
    envVar: 'ALPHAGENOME_API_KEY',
    required: true,
    delivery: { type: 'grpc-metadata', name: 'x-goog-api-key' },
  },
  rateLimit: { intervalMs: 0 },
};

describe('GrpcConnection', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('request() sends request to correct host:port', async () => {
    process.env.ALPHAGENOME_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ scores: {} }),
    }) as any;

    const conn = new GrpcConnection(baseOptions);
    await conn.request({ variant: '7-140453136-A-T' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('gdmscience.googleapis.com');
    expect(callUrl).toContain('scoreVariant');

    delete process.env.ALPHAGENOME_API_KEY;
  });

  test('healthCheck() returns boolean', async () => {
    process.env.ALPHAGENOME_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    }) as any;

    const conn = new GrpcConnection(baseOptions);
    const result = await conn.healthCheck();
    expect(typeof result).toBe('boolean');
    expect(result).toBe(true);

    delete process.env.ALPHAGENOME_API_KEY;
  });
});
