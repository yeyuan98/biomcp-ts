import { jest } from '@jest/globals';
import { RestConnection } from '../../connections/rest.js';
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
  sourceId: 'test_source',
  baseUrl: 'https://example.org/api',
  protocol: 'rest',
  rateLimit: { intervalMs: 100 },
};

/**
 * Real undici Response: exercises the production clone-then-parse path in
 * RestConnection.parseJsonBody (plain-object mocks lack clone()/text(), so
 * they take the pass-through json() branch and cannot reach the fallback).
 */
function jsonResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'application/json' } });
}

describe('RestConnection control-character hardening', () => {
  mockGlobalFetch();

  test('request() resolves a payload with a raw \\x0B inside a string field (NCBI-style defect)', async () => {
    // Raw control characters in string literals are invalid JSON (RFC 8259)
    // and V8 rejects them with "Bad control character in string literal" —
    // previously an opaque tool error. The fallback removes the byte and
    // the request still resolves with the field value.
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
      jsonResponse('{"title":"Line one\x0BLine two","count":2}')
    ) as any;

    const conn = new RestConnection(baseOptions);
    await expect(conn.request('/records')).resolves.toEqual({
      title: 'Line oneLine two',
      count: 2,
    });
  });

  test('request() resolves a payload with a raw \\x01 inside a string field', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
      jsonResponse('{"title":"A\x01B","count":1}')
    ) as any;

    const conn = new RestConnection(baseOptions);
    await expect(conn.request('/records')).resolves.toEqual({
      title: 'AB',
      count: 1,
    });
  });

  test('post() applies the same hardening to response bodies', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
      jsonResponse('{"a":"x\x01y"}')
    ) as any;

    const conn = new RestConnection(baseOptions);
    await expect(conn.post('/submit', { b: 1 })).resolves.toEqual({ a: 'xy' });
  });

  test('a control-char-free payload parses identically with and without the fallback', async () => {
    // The fallback only engages after a strict-parse failure, so a clean
    // payload must come out byte-identical to a direct strict parse.
    const clean = '{"title":"Line oneLine two","count":2}';
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
      jsonResponse(clean)
    ) as any;

    const conn = new RestConnection(baseOptions);
    const viaRest = await conn.request('/records');

    expect(viaRest).toEqual(JSON.parse(clean));
    expect(viaRest).toEqual({ title: 'Line oneLine two', count: 2 });
  });

  test('a payload broken beyond control characters propagates the ORIGINAL SyntaxError', async () => {
    // Control char AND truncation: after sanitization the document is still
    // invalid ("Unexpected end of JSON input"), but the caller must see the
    // original "Bad control character" error, keeping the real defect visible.
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
      jsonResponse('{"a":"x\x01y')
    ) as any;

    const conn = new RestConnection(baseOptions);
    await expect(conn.request('/records')).rejects.toThrow(/Bad control character/);
  });
});
