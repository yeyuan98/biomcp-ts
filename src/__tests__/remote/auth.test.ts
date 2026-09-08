import { describe, expect, it } from '@jest/globals';
import { handleCorsPreflight, parseAuthTokens, setCorsHeaders, verifyBearerToken } from '../../remote/auth.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

describe('remote auth & CORS', () => {
  describe('parseAuthTokens', () => {
    it('returns empty map for undefined/empty input', () => {
      expect(parseAuthTokens().size).toBe(0);
      expect(parseAuthTokens('').size).toBe(0);
      expect(parseAuthTokens([]).size).toBe(0);
    });

    it('parses single token with default label', () => {
      const map = parseAuthTokens('secret123');
      expect(map.size).toBe(1);
      expect(map.get('secret123')).toBe('default');
    });

    it('parses comma-separated tokens with custom labels', () => {
      const map = parseAuthTokens('tok_a:alice,tok_b:bob,tok_c');
      expect(map.size).toBe(3);
      expect(map.get('tok_a')).toBe('alice');
      expect(map.get('tok_b')).toBe('bob');
      expect(map.get('tok_c')).toBe('default');
    });

    it('parses array of tokens', () => {
      const map = parseAuthTokens(['key1:lab', 'key2']);
      expect(map.size).toBe(2);
      expect(map.get('key1')).toBe('lab');
      expect(map.get('key2')).toBe('default');
    });

    it('handles Map input', () => {
      const input = new Map([['t1', 'l1']]);
      const map = parseAuthTokens(input);
      expect(map.size).toBe(1);
      expect(map.get('t1')).toBe('l1');
    });
  });

  describe('verifyBearerToken', () => {
    const tokens = parseAuthTokens('secret_alpha:team-a,secret_beta:team-b');

    it('rejects missing or non-Bearer authorization header', () => {
      expect(verifyBearerToken(undefined, tokens)).toEqual({ authorized: false });
      expect(verifyBearerToken('', tokens)).toEqual({ authorized: false });
      expect(verifyBearerToken('Basic dXNlcjpwYXNz', tokens)).toEqual({ authorized: false });
      expect(verifyBearerToken('Bearer ', tokens)).toEqual({ authorized: false });
    });

    it('authorizes valid token and extracts client label', () => {
      expect(verifyBearerToken('Bearer secret_alpha', tokens)).toEqual({
        authorized: true,
        clientLabel: 'team-a',
      });
      expect(verifyBearerToken('Bearer secret_beta', tokens)).toEqual({
        authorized: true,
        clientLabel: 'team-b',
      });
    });

    it('rejects invalid or mismatched token without throwing RangeError', () => {
      expect(verifyBearerToken('Bearer wrong', tokens)).toEqual({ authorized: false });
      expect(verifyBearerToken('Bearer shorter', tokens)).toEqual({ authorized: false });
      expect(verifyBearerToken('Bearer much_much_longer_token_that_would_mismatch_length', tokens)).toEqual({
        authorized: false,
      });
    });

    it('rejects when validTokens is empty', () => {
      expect(verifyBearerToken('Bearer secret_alpha', new Map())).toEqual({ authorized: false });
    });
  });

  describe('CORS handling', () => {
    it('sets CORS headers on response', () => {
      const headers: Record<string, string> = {};
      const res = {
        setHeader: (k: string, v: string) => {
          headers[k] = v;
        },
      } as unknown as ServerResponse;

      setCorsHeaders(res);
      expect(headers['Access-Control-Allow-Origin']).toBe('*');
      expect(headers['Access-Control-Allow-Methods']).toContain('POST');
      expect(headers['Access-Control-Expose-Headers']).toContain('Mcp-Session-Id');
    });

    it('handles OPTIONS preflight with 204', () => {
      let statusCode = 0;
      let ended = false;
      const headers: Record<string, string> = {};

      const req = { method: 'OPTIONS' } as IncomingMessage;
      const res = {
        setHeader: (k: string, v: string) => {
          headers[k] = v;
        },
        end: () => {
          ended = true;
        },
        set statusCode(code: number) {
          statusCode = code;
        },
        get statusCode() {
          return statusCode;
        },
      } as unknown as ServerResponse;

      const handled = handleCorsPreflight(req, res);
      expect(handled).toBe(true);
      expect(statusCode).toBe(204);
      expect(ended).toBe(true);
      expect(headers['Access-Control-Allow-Origin']).toBe('*');
    });

    it('ignores non-OPTIONS request', () => {
      const req = { method: 'POST' } as IncomingMessage;
      const res = {} as ServerResponse;
      expect(handleCorsPreflight(req, res)).toBe(false);
    });
  });
});
