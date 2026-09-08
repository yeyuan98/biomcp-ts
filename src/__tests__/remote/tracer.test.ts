import { describe, expect, it } from '@jest/globals';
import { sanitizeValue, Tracer } from '../../remote/tracer.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Tracer & Sanitizer', () => {
  describe('sanitizeValue', () => {
    it('truncates strings longer than 512 characters', () => {
      const longStr = 'A'.repeat(600);
      const sanitized = sanitizeValue(longStr);
      expect(sanitized).toBe('[Truncated: 600 chars]');
    });

    it('leaves short strings untouched', () => {
      expect(sanitizeValue('short string')).toBe('short string');
    });

    it('redacts sensitive keys', () => {
      const input = {
        tool: 'db_query',
        api_key: 'secret_key_123',
        userPassword: 'password123',
        auth_token: 'tok_abc',
        normalField: 'ok',
      };
      const sanitized = sanitizeValue(input) as Record<string, unknown>;
      expect(sanitized.api_key).toBe('[REDACTED]');
      expect(sanitized.userPassword).toBe('[REDACTED]');
      expect(sanitized.auth_token).toBe('[REDACTED]');
      expect(sanitized.normalField).toBe('ok');
    });

    it('handles nested objects and arrays', () => {
      const input = {
        nested: {
          secretToken: 'shh',
          data: ['item1', 'A'.repeat(1000)],
        },
      };
      const sanitized = sanitizeValue(input) as any;
      expect(sanitized.nested.secretToken).toBe('[REDACTED]');
      expect(sanitized.nested.data[0]).toBe('item1');
      expect(sanitized.nested.data[1]).toContain('[Truncated:');
    });
  });

  describe('Tracer logging', () => {
    it('writes records to file when enabled', async () => {
      const logFile = join(tmpdir(), `test-tracer-${Date.now()}.jsonl`);
      const tracer = new Tracer({ enabled: true, filePath: logFile });

      tracer.recordHttp('POST', '/mcp', 200, 15.2, 'client-alice', '127.0.0.1', 'sess-1');
      tracer.recordTool('gene_search', 25.4, 'success', 'client-alice', 'sess-1', { query: 'BRAF' });

      // Wait a tick for async appendFile
      await new Promise((r) => setTimeout(r, 100));

      expect(existsSync(logFile)).toBe(true);
      const lines = readFileSync(logFile, 'utf8').trim().split('\n');
      expect(lines.length).toBe(2);

      const rec1 = JSON.parse(lines[0]);
      expect(rec1.type).toBe('http_request');
      expect(rec1.method).toBe('POST');
      expect(rec1.clientLabel).toBe('client-alice');

      const rec2 = JSON.parse(lines[1]);
      expect(rec2.type).toBe('tool_call');
      expect(rec2.tool).toBe('gene_search');
      expect(rec2.status).toBe('success');

      rmSync(logFile, { force: true });
    });

    it('does nothing when disabled', async () => {
      const logFile = join(tmpdir(), `test-tracer-disabled-${Date.now()}.jsonl`);
      const tracer = new Tracer({ enabled: false, filePath: logFile });

      tracer.recordHttp('GET', '/health', 200, 1, 'anonymous');
      await new Promise((r) => setTimeout(r, 50));

      expect(existsSync(logFile)).toBe(false);
    });
  });
});
