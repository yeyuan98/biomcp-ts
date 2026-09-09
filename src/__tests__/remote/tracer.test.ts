import { describe, expect, it } from '@jest/globals';
import { sanitizeValue, Tracer, readTraceDatabaseMetrics, formatCompactUtc } from '../../remote/tracer.js';
import { existsSync, rmSync } from 'node:fs';
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

    it('handles circular references without stack overflow', () => {
      const circ: any = { name: 'circular-test' };
      circ.self = circ;
      const sanitized = sanitizeValue(circ) as any;
      expect(sanitized.name).toBe('circular-test');
      expect(sanitized.self).toBe('[Circular]');
    });
  });

  describe('formatCompactUtc', () => {
    it('formats ISO dates into compact UTC strings without colons or hyphens', () => {
      const d = new Date('2026-09-01T12:30:45.123Z');
      expect(formatCompactUtc(d)).toBe('20260901T123045Z');
    });
  });

  describe('SQLite Tracer logging and lifecycle', () => {
    it('writes records to SQLite database when enabled and drains on close', async () => {
      const logFile = join(tmpdir(), `test-tracer-${Date.now()}.db`);
      const tracer = new Tracer({ enabled: true, filePath: logFile, flushIntervalMs: 50 });

      tracer.recordHttp('POST', '/mcp?secret=123', 200, 15.2, 'client-alice', '127.0.0.1', 'sess-1', 'req-001');
      tracer.recordTool('gene_search', 25.4, 'success', 'client-alice', 'sess-1', { query: 'BRAF' }, undefined, 'req-001');

      tracer.flush();

      expect(existsSync(logFile)).toBe(true);

      const metrics = tracer.getMetrics();
      expect(metrics.totalHttpRecords).toBe(1);
      expect(metrics.totalToolRecords).toBe(1);
      expect(metrics.periodStart).toBeTruthy();
      expect(metrics.periodEnd).toBeTruthy();

      // Test standalone reader function
      const diskMetrics = readTraceDatabaseMetrics(logFile);
      expect(diskMetrics).not.toBeNull();
      expect(diskMetrics?.totalHttpRecords).toBe(1);
      expect(diskMetrics?.totalToolRecords).toBe(1);

      tracer.close();
      rmSync(logFile, { force: true });
    });

    it('does nothing when disabled', async () => {
      const logFile = join(tmpdir(), `test-tracer-disabled-${Date.now()}.db`);
      const tracer = new Tracer({ enabled: false, filePath: logFile });

      tracer.recordHttp('GET', '/health', 200, 1, 'anonymous');
      tracer.flush();

      expect(existsSync(logFile)).toBe(false);
      expect(tracer.getMetrics().totalHttpRecords).toBe(0);
      tracer.close();
    });

    it('rotates database and preserves coincidence writes during rotation', async () => {
      const logFile = join(tmpdir(), `test-tracer-rot-${Date.now()}.db`);
      const tracer = new Tracer({ enabled: true, filePath: logFile, periodDays: 1 });

      tracer.recordHttp('POST', '/mcp', 200, 10, 'client-bob', '127.0.0.1', 'sess-2');
      tracer.flush();

      const beforeMetrics = tracer.getMetrics();
      expect(beforeMetrics.totalHttpRecords).toBe(1);
      expect(beforeMetrics.archiveFiles.length).toBe(0);

      // Trigger rotation
      tracer.rotate();

      // Post-rotation: active DB should be fresh and 1 archive should exist
      const afterRotateMetrics = tracer.getMetrics();
      expect(afterRotateMetrics.archiveFiles.length).toBe(1);
      expect(afterRotateMetrics.totalHttpRecords).toBe(0);

      // Now record a coincidence write in the fresh database
      tracer.recordTool('variant_search', 12, 'success', 'client-bob', 'sess-2', { gene: 'TP53' });
      tracer.flush();

      const newMetrics = tracer.getMetrics();
      expect(newMetrics.totalToolRecords).toBe(1);

      // Clean up active DB and archive
      const archiveFile = join(tmpdir(), afterRotateMetrics.archiveFiles[0].name);
      tracer.close();

      rmSync(logFile, { force: true });
      rmSync(archiveFile, { force: true });
    });

    it('drains pending queue into archive before rotating and writes post-rotation records to fresh db', () => {
      const logFile = join(tmpdir(), `test-tracer-drain-${Date.now()}.db`);
      const tracer = new Tracer({ enabled: true, filePath: logFile, periodDays: 1 });

      // Record without manually calling flush()
      tracer.recordHttp('GET', '/mcp', 200, 5, 'client-alice', '127.0.0.1', 'sess-1', 'req-drain');

      // Trigger rotation - step 1 must drain this record into the archive DB
      tracer.rotate();

      const afterRotate = tracer.getMetrics();
      expect(afterRotate.archiveFiles.length).toBe(1);
      expect(afterRotate.totalHttpRecords).toBe(0); // Active DB is fresh

      // Verify archived DB contains the pre-rotation record
      const archivePath = join(tmpdir(), afterRotate.archiveFiles[0].name);
      const archiveMetrics = readTraceDatabaseMetrics(archivePath);
      expect(archiveMetrics?.totalHttpRecords).toBe(1);

      tracer.close();
      rmSync(logFile, { force: true });
      rmSync(archivePath, { force: true });
    });

    it('resumes active database period on restart when period is still valid', () => {
      const logFile = join(tmpdir(), `test-tracer-restart-active-${Date.now()}.db`);
      const tracer1 = new Tracer({ enabled: true, filePath: logFile, periodDays: 7 });
      tracer1.recordHttp('GET', '/health', 200, 2, 'anonymous');
      tracer1.close();

      const metricsBefore = readTraceDatabaseMetrics(logFile);
      expect(metricsBefore?.totalHttpRecords).toBe(1);
      expect(metricsBefore?.archiveFiles.length).toBe(0);

      // Boot second tracer instance against same file
      const tracer2 = new Tracer({ enabled: true, filePath: logFile, periodDays: 7 });
      const metricsAfter = tracer2.getMetrics();
      expect(metricsAfter.totalHttpRecords).toBe(1);
      expect(metricsAfter.archiveFiles.length).toBe(0);
      expect(metricsAfter.periodStart).toBe(metricsBefore?.periodStart);

      tracer2.close();
      rmSync(logFile, { force: true });
    });

    it('rotates immediately on boot when stored period has elapsed', async () => {
      const logFile = join(tmpdir(), `test-tracer-restart-expired-${Date.now()}.db`);
      const tracer1 = new Tracer({ enabled: true, filePath: logFile, periodDays: 1 });
      tracer1.recordHttp('GET', '/health', 200, 2, 'anonymous');
      tracer1.flush();

      // Tamper period epochs in trace_meta to simulate elapsed time in the past
      const { createRequire } = await import('node:module');
      const DatabaseSyncClass = createRequire(import.meta.url)('node:sqlite').DatabaseSync;
      const db = new DatabaseSyncClass(logFile);
      db.exec("UPDATE trace_meta SET value = '1000' WHERE key = 'period_start_epoch';");
      db.exec("UPDATE trace_meta SET value = '2000' WHERE key = 'period_end_epoch';");
      db.close();
      tracer1.close();

      // Boot tracer2 against expired file -> should rotate immediately
      const tracer2 = new Tracer({ enabled: true, filePath: logFile, periodDays: 1 });
      const metrics = tracer2.getMetrics();
      expect(metrics.archiveFiles.length).toBe(1);
      expect(metrics.totalHttpRecords).toBe(0); // Fresh active db

      const archivePath = join(tmpdir(), metrics.archiveFiles[0].name);
      tracer2.close();
      rmSync(logFile, { force: true });
      rmSync(archivePath, { force: true });
    });
  });
});
