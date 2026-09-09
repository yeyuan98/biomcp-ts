import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

export interface HttpTraceRecord {
  type: 'http_request';
  timestamp: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  clientLabel: string;
  clientIp?: string;
  sessionId?: string;
  requestId?: string;
}

export interface ToolTraceRecord {
  type: 'tool_call';
  timestamp: string;
  tool: string;
  sessionId?: string;
  clientLabel: string;
  durationMs: number;
  status: 'success' | 'error';
  inputArgs?: Record<string, unknown>;
  error?: string;
  requestId?: string;
}

export type TraceRecord = HttpTraceRecord | ToolTraceRecord;

export interface TracerOptions {
  enabled?: boolean;
  filePath?: string;
  periodDays?: number;
  flushIntervalMs?: number;
  batchThreshold?: number;
  maxQueueSize?: number;
}

export interface TraceMetrics {
  enabled: boolean;
  filePath: string;
  fileSizeBytes: number;
  periodStart: string | null;
  periodEnd: string | null;
  totalHttpRecords: number;
  totalToolRecords: number;
  queueLength: number;
  archiveFiles: Array<{ name: string; sizeBytes: number }>;
}

type SqlValue = null | number | bigint | string;

interface QueuedTrace {
  type: 'http' | 'tool';
  params: SqlValue[];
}

const SENSITIVE_KEY_PATTERN = /token|key|secret|password|auth/i;
const MAX_STRING_LENGTH = 512;

export function sanitizeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 6) {
    return '[Max depth reached]';
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      return `[Truncated: ${value.length} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 20) {
      return `[Array with ${value.length} items truncated]`;
    }
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    return value.map((item) => sanitizeValue(item, depth + 1, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        sanitized[k] = '[REDACTED]';
      } else {
        sanitized[k] = sanitizeValue(v, depth + 1, seen);
      }
    }
    return sanitized;
  }
  return value;
}

export function formatCompactUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function getDatabaseSyncClass(): typeof DatabaseSync {
  try {
    const require = createRequire(import.meta.url);
    return require('node:sqlite').DatabaseSync;
  } catch (error) {
    throw new Error(
      'The built-in "node:sqlite" module is not available in this Node.js build.\n' +
        'BioMCP requires Node.js >= 22.13.0.',
      { cause: error },
    );
  }
}

export class Tracer {
  readonly enabled: boolean;
  readonly filePath: string;
  readonly periodDays: number;
  private readonly flushIntervalMs: number;
  private readonly batchThreshold: number;
  private readonly maxQueueSize: number;

  private queue: QueuedTrace[] = [];
  private db: DatabaseSync | null = null;
  private insertHttpStmt: StatementSync | null = null;
  private insertToolStmt: StatementSync | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  private isRotating = false;
  private isFlushing = false;
  private periodStartEpoch = 0;
  private periodEndEpoch = 0;

  constructor(options?: TracerOptions) {
    this.enabled = options?.enabled ?? false;
    this.filePath = options?.filePath ?? 'biomcp-traces.db';
    this.periodDays = Math.max(1, options?.periodDays ?? 7);
    this.flushIntervalMs = options?.flushIntervalMs ?? 500;
    this.batchThreshold = options?.batchThreshold ?? 50;
    this.maxQueueSize = options?.maxQueueSize ?? 10_000;

    if (this.enabled) {
      this.initDatabase(false);
      this.flushTimer = setInterval(() => this.onTick(), this.flushIntervalMs);
      this.flushTimer.unref();
    }
  }

  private initDatabase(forceNewPeriod = false): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const DatabaseSyncClass = getDatabaseSyncClass();
      const db = new DatabaseSyncClass(this.filePath);

      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
      db.exec('PRAGMA busy_timeout = 5000;');

      db.exec(`
        CREATE TABLE IF NOT EXISTS trace_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS http_traces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT,
          timestamp TEXT NOT NULL,
          epoch_ms INTEGER NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          status INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          client_label TEXT NOT NULL,
          client_ip TEXT,
          session_id TEXT
        );
        CREATE TABLE IF NOT EXISTS tool_traces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT,
          timestamp TEXT NOT NULL,
          epoch_ms INTEGER NOT NULL,
          tool TEXT NOT NULL,
          session_id TEXT,
          client_label TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          input_args TEXT,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_http_epoch ON http_traces(epoch_ms);
        CREATE INDEX IF NOT EXISTS idx_http_req_id ON http_traces(request_id);
        CREATE INDEX IF NOT EXISTS idx_tool_epoch ON tool_traces(epoch_ms);
        CREATE INDEX IF NOT EXISTS idx_tool_req_id ON tool_traces(request_id);
        CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_traces(tool);
      `);

      this.db = db;
      this.insertHttpStmt = db.prepare(`
        INSERT INTO http_traces (request_id, timestamp, epoch_ms, method, path, status, duration_ms, client_label, client_ip, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
      this.insertToolStmt = db.prepare(`
        INSERT INTO tool_traces (request_id, timestamp, epoch_ms, tool, session_id, client_label, duration_ms, status, input_args, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);

      this.initOrLoadPeriod(forceNewPeriod);
    } catch (err) {
      console.error('[biomcp:tracer] Failed to initialize trace database:', err);
      this.closeDatabaseHandle();
    }
  }

  private initOrLoadPeriod(forceNewPeriod: boolean): void {
    if (!this.db) return;

    if (forceNewPeriod) {
      this.setNewPeriod();
      return;
    }

    const startRow = this.getMeta('period_start_epoch');
    const endRow = this.getMeta('period_end_epoch');

    if (startRow && endRow) {
      const parsedStart = parseInt(startRow, 10);
      const parsedEnd = parseInt(endRow, 10);

      if (Number.isFinite(parsedStart) && Number.isFinite(parsedEnd) && parsedStart > 0 && parsedEnd > 0) {
        this.periodStartEpoch = parsedStart;
        this.periodEndEpoch = parsedEnd;

        // If existing database period has already elapsed, rotate immediately
        if (Date.now() >= this.periodEndEpoch) {
          this.rotate();
        }
        return;
      }
    }
    this.setNewPeriod();
  }

  private setNewPeriod(): void {
    if (!this.db) return;
    const now = Date.now();
    this.periodStartEpoch = now;
    this.periodEndEpoch = now + this.periodDays * 24 * 60 * 60 * 1000;

    const setMeta = this.db.prepare('INSERT OR REPLACE INTO trace_meta (key, value) VALUES (?, ?)');
    setMeta.run('period_start_epoch', String(this.periodStartEpoch));
    setMeta.run('period_end_epoch', String(this.periodEndEpoch));
  }

  private getMeta(key: string): string | null {
    if (!this.db) return null;
    try {
      const stmt = this.db.prepare('SELECT value FROM trace_meta WHERE key = ?');
      const row = stmt.get(key) as { value?: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private closeDatabaseHandle(): void {
    this.insertHttpStmt = null;
    this.insertToolStmt = null;
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore close error
      }
      this.db = null;
    }
  }

  private onTick(): void {
    if (!this.enabled) return;

    if (Date.now() >= this.periodEndEpoch && !this.isRotating) {
      this.rotate();
      return;
    }

    if (this.queue.length > 0 && !this.isRotating && !this.isFlushing) {
      this.flushSync();
    }
  }

  private enqueue(trace: QueuedTrace): void {
    if (!this.enabled) return;

    if (this.queue.length >= this.maxQueueSize) {
      // Load shedding: drop oldest to prevent V8 memory exhaustion
      this.queue.shift();
    }
    this.queue.push(trace);

    // If threshold reached and not rotating, flush immediately
    if (this.queue.length >= this.batchThreshold && !this.isRotating && !this.isFlushing) {
      this.flushSync();
    }
  }

  private doFlushSync(ignoreRotating = false): void {
    if (this.isFlushing || (!ignoreRotating && this.isRotating) || !this.db || this.queue.length === 0) {
      return;
    }

    this.isFlushing = true;
    const batch = this.queue;
    this.queue = [];

    try {
      this.db.exec('BEGIN IMMEDIATE;');
      for (const item of batch) {
        if (item.type === 'http') {
          this.insertHttpStmt?.run(...item.params);
        } else {
          this.insertToolStmt?.run(...item.params);
        }
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Ignore rollback error
      }
      // Re-insert unwritten records at head of queue for retry
      this.queue.unshift(...batch);
      if (this.queue.length > this.maxQueueSize) {
        this.queue.length = this.maxQueueSize;
      }
      console.error('[biomcp:tracer] Batch flush failed, records retained in memory:', err);
    } finally {
      this.isFlushing = false;
    }
  }

  flushSync(): void {
    this.doFlushSync(false);
  }

  flush(): void {
    this.flushSync();
  }

  rotate(): void {
    if (!this.enabled || this.isRotating) return;
    this.isRotating = true;

    try {
      // 1. Drain whatever is currently queued into the existing database before archiving
      this.doFlushSync(true);

      if (!this.db) {
        this.initDatabase(false);
        return;
      }

      // 2. Fetch period timestamps
      const startEpoch = this.periodStartEpoch || Date.now();
      const endEpoch = Date.now();

      // 3. Checkpoint WAL into main DB
      try {
        const chk = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get() as { busy?: number } | undefined;
        if (chk?.busy === 1) {
          console.warn('[biomcp:tracer] Trace database busy during checkpoint. Rotation deferred.');
          return;
        }
      } catch (chkErr) {
        console.warn('[biomcp:tracer] Warning during wal_checkpoint:', chkErr);
      }

      // 4. Switch journal mode to DELETE (merges and unlinks -wal and -shm files)
      try {
        this.db.exec('PRAGMA journal_mode = DELETE;');
      } catch (jmErr) {
        console.warn('[biomcp:tracer] Warning setting journal_mode to DELETE:', jmErr);
      }

      // 5. Close database handle
      this.closeDatabaseHandle();

      // 6. Build archive file path and rename active file
      const archivePath = this.computeUniqueArchivePath(startEpoch, endEpoch);
      if (existsSync(this.filePath)) {
        renameSync(this.filePath, archivePath);
      }

      // 7. Open fresh active database with brand new period
      this.initDatabase(true);
    } catch (err) {
      console.error('[biomcp:tracer] Rotation failed, recovering active database:', err);
      if (!this.db) {
        try {
          this.initDatabase(false);
        } catch (recoveryErr) {
          console.error('[biomcp:tracer] Failed to recover trace database:', recoveryErr);
        }
      }
    } finally {
      this.isRotating = false;
      // Flush coincidence records that arrived in this.queue while isRotating was true
      if (this.db && this.queue.length > 0) {
        this.flushSync();
      }
    }
  }

  private computeUniqueArchivePath(startEpoch: number, endEpoch: number): string {
    const dir = dirname(this.filePath);
    const ext = extname(this.filePath) || '.db';
    const base = basename(this.filePath, ext);
    const startStr = formatCompactUtc(new Date(startEpoch));
    const endStr = formatCompactUtc(new Date(endEpoch));
    let target = join(dir, `${base}-archive_${startStr}_${endStr}${ext}`);

    let counter = 1;
    while (existsSync(target)) {
      target = join(dir, `${base}-archive_${startStr}_${endStr}.${counter}${ext}`);
      counter++;
    }
    return target;
  }

  record(record: TraceRecord): void {
    if (!this.enabled) return;

    if (record.type === 'http_request') {
      const epochMs = new Date(record.timestamp).getTime() || Date.now();
      const cleanPath = record.path.split('?')[0];
      this.enqueue({
        type: 'http',
        params: [
          record.requestId ?? null,
          record.timestamp,
          epochMs,
          record.method,
          cleanPath,
          record.status,
          record.durationMs,
          record.clientLabel,
          record.clientIp ?? null,
          record.sessionId ?? null,
        ],
      });
    } else {
      const epochMs = new Date(record.timestamp).getTime() || Date.now();
      const serializedArgs = record.inputArgs ? JSON.stringify(record.inputArgs) : null;
      this.enqueue({
        type: 'tool',
        params: [
          record.requestId ?? null,
          record.timestamp,
          epochMs,
          record.tool,
          record.sessionId ?? null,
          record.clientLabel,
          record.durationMs,
          record.status,
          serializedArgs,
          record.error ?? null,
        ],
      });
    }
  }

  recordHttp(
    method: string,
    path: string,
    status: number,
    durationMs: number,
    clientLabel: string,
    clientIp?: string,
    sessionId?: string,
    requestId?: string,
  ): void {
    if (!this.enabled) return;
    this.record({
      type: 'http_request',
      timestamp: new Date().toISOString(),
      method,
      path,
      status,
      durationMs: Math.round(durationMs),
      clientLabel,
      clientIp,
      sessionId,
      requestId,
    });
  }

  recordTool(
    tool: string,
    durationMs: number,
    status: 'success' | 'error',
    clientLabel: string,
    sessionId?: string,
    args?: Record<string, unknown>,
    error?: string,
    requestId?: string,
  ): void {
    if (!this.enabled) return;
    this.record({
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      tool,
      sessionId,
      clientLabel,
      durationMs: Math.round(durationMs),
      status,
      inputArgs: args ? (sanitizeValue(args) as Record<string, unknown>) : undefined,
      error,
      requestId,
    });
  }

  getMetrics(): TraceMetrics {
    const fileSizeBytes = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    let totalHttpRecords = 0;
    let totalToolRecords = 0;

    if (this.db) {
      try {
        const httpRow = this.db.prepare('SELECT COUNT(*) as count FROM http_traces').get() as { count?: number };
        totalHttpRecords = httpRow?.count ?? 0;
        const toolRow = this.db.prepare('SELECT COUNT(*) as count FROM tool_traces').get() as { count?: number };
        totalToolRecords = toolRow?.count ?? 0;
      } catch {
        // Ignore query error
      }
    }

    const archiveFiles = getTraceArchiveFiles(this.filePath);

    return {
      enabled: this.enabled,
      filePath: this.filePath,
      fileSizeBytes,
      periodStart: this.periodStartEpoch ? new Date(this.periodStartEpoch).toISOString() : null,
      periodEnd: this.periodEndEpoch ? new Date(this.periodEndEpoch).toISOString() : null,
      totalHttpRecords,
      totalToolRecords,
      queueLength: this.queue.length,
      archiveFiles,
    };
  }

  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushSync();
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        // Ignore
      }
      this.closeDatabaseHandle();
    }
  }
}

/**
 * Scans directory for historic archives matching the trace database prefix.
 */
export function getTraceArchiveFiles(traceFilePath: string): Array<{ name: string; sizeBytes: number }> {
  const dir = dirname(traceFilePath);
  if (!existsSync(dir)) return [];

  const ext = extname(traceFilePath) || '.db';
  const base = basename(traceFilePath, ext);
  const prefix = `${base}-archive_`;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const archives: Array<{ name: string; sizeBytes: number }> = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(ext)) {
        try {
          const stats = statSync(join(dir, entry.name));
          archives.push({ name: entry.name, sizeBytes: stats.size });
        } catch {
          // Ignore
        }
      }
    }
    return archives.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Reads metrics directly from a SQLite trace database file on disk (for CLI status inspection).
 */
export function readTraceDatabaseMetrics(filePath: string): TraceMetrics | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const DatabaseSyncClass = getDatabaseSyncClass();
    const db = new DatabaseSyncClass(filePath, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 3000;');
    } catch {
      // Ignore busy_timeout error on readOnly handle
    }
    let totalHttpRecords = 0;
    let totalToolRecords = 0;
    let periodStart: string | null = null;
    let periodEnd: string | null = null;

    try {
      const httpRow = db.prepare('SELECT COUNT(*) as count FROM http_traces').get() as { count?: number };
      totalHttpRecords = httpRow?.count ?? 0;
      const toolRow = db.prepare('SELECT COUNT(*) as count FROM tool_traces').get() as { count?: number };
      totalToolRecords = toolRow?.count ?? 0;

      const startRow = db.prepare("SELECT value FROM trace_meta WHERE key = 'period_start_epoch'").get() as { value?: string };
      if (startRow?.value) {
        const startMs = parseInt(startRow.value, 10);
        if (Number.isFinite(startMs) && startMs > 0) {
          periodStart = new Date(startMs).toISOString();
        }
      }
      const endRow = db.prepare("SELECT value FROM trace_meta WHERE key = 'period_end_epoch'").get() as { value?: string };
      if (endRow?.value) {
        const endMs = parseInt(endRow.value, 10);
        if (Number.isFinite(endMs) && endMs > 0) {
          periodEnd = new Date(endMs).toISOString();
        }
      }
    } catch {
      // Table might not exist yet
    } finally {
      db.close();
    }

    const stats = statSync(filePath);
    return {
      enabled: true,
      filePath,
      fileSizeBytes: stats.size,
      periodStart,
      periodEnd,
      totalHttpRecords,
      totalToolRecords,
      queueLength: 0,
      archiveFiles: getTraceArchiveFiles(filePath),
    };
  } catch {
    return null;
  }
}
