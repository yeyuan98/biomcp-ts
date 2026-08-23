import { jest } from '@jest/globals';
import { TokenBucketRateLimiter, RateLimiterFactory } from '../../connections/rate-limiter.js';
import type { RateLimitConfig } from '../../connections/base.js';

jest.useFakeTimers();

const makeConfig = (intervalMs: number, extra?: Partial<RateLimitConfig>): RateLimitConfig => ({
  intervalMs,
  ...extra,
});

describe('TokenBucketRateLimiter', () => {
  it('acquire() succeeds immediately on fresh limiter', async () => {
    const limiter = new TokenBucketRateLimiter(makeConfig(1000));
    const promise = limiter.acquire();
    await jest.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBeUndefined();
  });

  it('acquire() blocks when bucket is empty', async () => {
    const limiter = new TokenBucketRateLimiter(makeConfig(1000));
    await limiter.acquire();
    const promise = limiter.acquire();
    let resolved = false;
    promise.then(() => { resolved = true; });
    await jest.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false);
  });

  it('acquire() refills after interval', async () => {
    const limiter = new TokenBucketRateLimiter(makeConfig(100));
    await limiter.acquire();
    const promise = limiter.acquire();
    let resolved = false;
    promise.then(() => { resolved = true; });
    await jest.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(true);
  });

  it('updateRateLimit changes refill rate', async () => {
    const limiter = new TokenBucketRateLimiter(makeConfig(1000));
    await limiter.acquire();
    limiter.updateRateLimit(makeConfig(50), false);
    const promise = limiter.acquire();
    let resolved = false;
    promise.then(() => { resolved = true; });
    await jest.advanceTimersByTimeAsync(50);
    expect(resolved).toBe(true);
  });
});

describe('RateLimiterFactory.getEffectiveRate', () => {
  it('returns baseRate for non-conditional config', () => {
    const result = RateLimiterFactory.getEffectiveRate(500, makeConfig(1000), false);
    expect(result).toBe(500);
  });

  it('returns keyedRateLimitMs for conditional config with key', () => {
    const result = RateLimiterFactory.getEffectiveRate(500, makeConfig(1000, {
      conditional: true,
      keyedRateLimitMs: 100,
    }), true);
    expect(result).toBe(100);
  });

  it('returns fallbackRateLimitMs for conditional config without key', () => {
    const result = RateLimiterFactory.getEffectiveRate(500, makeConfig(1000, {
      conditional: true,
      fallbackRateLimitMs: 2000,
      keyedRateLimitMs: 100,
    }), false);
    expect(result).toBe(2000);
  });
});
