import { createError, formatError, withErrorHandling, ErrorCodes } from '../../server/errors.js';

describe('createError', () => {
  it('creates basic error with code and message', () => {
    const err = createError('TEST_CODE', 'test message');
    expect(err).toEqual({ code: 'TEST_CODE', message: 'test message' });
  });

  it('includes suggestion when provided', () => {
    const err = createError('TEST_CODE', 'test message', 'try again');
    expect(err.suggestion).toBe('try again');
  });

  it('includes details when provided', () => {
    const err = createError('TEST_CODE', 'test message', undefined, { key: 'val' });
    expect(err.details).toEqual({ key: 'val' });
  });
});

describe('formatError', () => {
  it('maps "not found" to ENTITY_NOT_FOUND', () => {
    const err = formatError(new Error('gene not found'));
    expect(err.code).toBe(ErrorCodes.ENTITY_NOT_FOUND);
  });

  it('maps "does not exist" to ENTITY_NOT_FOUND', () => {
    const err = formatError(new Error('ID does not exist'));
    expect(err.code).toBe(ErrorCodes.ENTITY_NOT_FOUND);
  });

  it('maps "timeout" to TIMEOUT', () => {
    const err = formatError(new Error('request timeout'));
    expect(err.code).toBe(ErrorCodes.TIMEOUT);
  });

  it('maps "abort" to TIMEOUT', () => {
    const err = formatError(new Error('abort'));
    expect(err.code).toBe(ErrorCodes.TIMEOUT);
  });

  it('maps "401" to AUTH_REQUIRED', () => {
    const err = formatError(new Error('401 unauthorized'));
    expect(err.code).toBe(ErrorCodes.AUTH_REQUIRED);
  });

  it('maps "403" to AUTH_REQUIRED', () => {
    const err = formatError(new Error('403 forbidden'));
    expect(err.code).toBe(ErrorCodes.AUTH_REQUIRED);
  });

  it('maps "429" to RATE_LIMIT', () => {
    const err = formatError(new Error('429 rate limit'));
    expect(err.code).toBe(ErrorCodes.RATE_LIMIT);
  });

  it('maps "rate limit" to RATE_LIMIT', () => {
    const err = formatError(new Error('rate limit exceeded'));
    expect(err.code).toBe(ErrorCodes.RATE_LIMIT);
  });

  it('maps "network" to NETWORK_ERROR', () => {
    const err = formatError(new Error('network error'));
    expect(err.code).toBe(ErrorCodes.NETWORK_ERROR);
  });

  it('maps "fetch" to NETWORK_ERROR', () => {
    const err = formatError(new Error('fetch failed'));
    expect(err.code).toBe(ErrorCodes.NETWORK_ERROR);
  });

  it('maps "connect" to NETWORK_ERROR', () => {
    const err = formatError(new Error('connect ECONNREFUSED'));
    expect(err.code).toBe(ErrorCodes.NETWORK_ERROR);
  });

  it('maps generic Error to API_ERROR', () => {
    const err = formatError(new Error('something else'));
    expect(err.code).toBe(ErrorCodes.API_ERROR);
  });

  it('maps string input to INVALID_INPUT', () => {
    const err = formatError('bad input');
    expect(err.code).toBe(ErrorCodes.INVALID_INPUT);
  });

  it('maps unknown type (number) to API_ERROR', () => {
    const err = formatError(42);
    expect(err.code).toBe(ErrorCodes.API_ERROR);
  });
});

describe('withErrorHandling', () => {
  it('returns { data } on success', async () => {
    const result = await withErrorHandling(async () => 42);
    expect(result).toEqual({ data: 42 });
  });

  it('returns { error } on failure', async () => {
    const result = await withErrorHandling(async () => {
      throw new Error('not found');
    });
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(ErrorCodes.ENTITY_NOT_FOUND);
    expect(result.data).toBeUndefined();
  });
});
