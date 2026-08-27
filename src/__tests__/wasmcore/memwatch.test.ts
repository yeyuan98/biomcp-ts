import { describe, it, expect, afterEach } from '@jest/globals';
import { memLimitBytes, assertWithinMemoryLimit } from '../../wasmcore/memwatch.js';

const ENV_VAR = 'TEST_WASMCORE_MEM_LIMIT_MB';
const DEFAULT_MB = 2048;

describe('memwatch', () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it('returns the default when the env var is unset or invalid', () => {
    delete process.env[ENV_VAR];
    expect(memLimitBytes(ENV_VAR, DEFAULT_MB)).toBe(DEFAULT_MB * 1024 * 1024);
    for (const v of ['not-a-number', '', '0', '-5', 'NaN', 'Infinity']) {
      process.env[ENV_VAR] = v;
      expect(memLimitBytes(ENV_VAR, DEFAULT_MB)).toBe(DEFAULT_MB * 1024 * 1024);
    }
  });

  it('honors a positive env limit', () => {
    process.env[ENV_VAR] = '512';
    expect(memLimitBytes(ENV_VAR, DEFAULT_MB)).toBe(512 * 1024 * 1024);
    process.env[ENV_VAR] = '0.5';
    expect(memLimitBytes(ENV_VAR, DEFAULT_MB)).toBe(0.5 * 1024 * 1024);
  });

  it('passes when RSS is below the limit', () => {
    process.env[ENV_VAR] = String(Math.ceil(process.memoryUsage().rss / 1024 / 1024) + 1);
    expect(() => assertWithinMemoryLimit(ENV_VAR, DEFAULT_MB)).not.toThrow();
  });

  it('throws a watermark error naming the configured env var', () => {
    process.env[ENV_VAR] = '1';
    expect(() => assertWithinMemoryLimit(ENV_VAR, DEFAULT_MB)).toThrow(
      new RegExp(`Memory usage \\(\\d+ MB\\) exceeds ${ENV_VAR} \\(1 MB\\); refusing a new analysis\\.`)
    );
  });

  it('uses the configured default when the env var is unset', () => {
    delete process.env[ENV_VAR];
    const tinyDefault = Math.ceil(process.memoryUsage().rss / 1024 / 1024) + 1;
    expect(() => assertWithinMemoryLimit(ENV_VAR, tinyDefault)).not.toThrow();
    expect(() => assertWithinMemoryLimit(ENV_VAR, 1)).toThrow(
      new RegExp(`exceeds ${ENV_VAR} \\(1 MB\\)`)
    );
  });
});
