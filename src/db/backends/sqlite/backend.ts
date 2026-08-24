import { statSync } from 'node:fs';
import type {
  IConnectionConfig,
  IConnectionPool,
  IQuery,
  IQueryResult,
  ICollectionInfo,
  IColumnSchema,
} from '../../interface/index.js';
import { BaseBackend } from '../../core/base.js';
import { openReadOnlyDatabase, loadSqliteModule, type SqliteDatabase } from './connection.js';
import {
  mapSqliteTablesToCollections,
  mapPragmaColumnsToSchema,
  describeTable as pragmaDescribeTable,
  countRows,
  LIST_TABLES_SQL,
} from './translator.js';

export class SqliteBackend extends BaseBackend {
  readonly type = 'sqlite';
  readonly config: IConnectionConfig;

  private db: SqliteDatabase | null = null;

  constructor(config: IConnectionConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    loadSqliteModule();
    const file = this.config.database;
    let stats;
    try {
      stats = statSync(file);
    } catch (error) {
      throw new Error(
        `SQLite database file not found: ${file}\n` +
        'Set DB_SQLITE_PATH to an existing database file.',
        { cause: error }
      );
    }
    if (!stats.isFile()) {
      throw new Error(`DB_SQLITE_PATH is not a file: ${file}`);
    }
    if (!this.db) {
      this.db = openReadOnlyDatabase(file);
    }
    this.db.prepare('SELECT 1').get();
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        this.db = null;
      }
      this.db = null;
    }
    this._connected = false;
  }

  getPool(): IConnectionPool | null {
    return this.db
      ? {
          getConnection: async () => ({
            isConnected: () => true,
            close: async () => undefined,
          }),
          end: async () => this.disconnect(),
          isHealthy: () => this.db !== null && this._connected,
        }
      : null;
  }

  async executeQuery(query: IQuery): Promise<IQueryResult> {
    const startTime = Date.now();

    try {
      if (!this._connected || !this.db) {
        await this.connect();
      }

      const stmt = this.db!.prepare(query.sql);
      const rows = this.bindAndAll(stmt, query.params);
      const executionTimeMs = Date.now() - startTime;

      return this.createSuccessResult(rows, statementFieldInfo(stmt), executionTimeMs);
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      const result = this.createErrorResult(error, executionTimeMs);
      if (result.error?.code === 'SQLITE_CANTOPEN') {
        await this.disconnect().catch(() => undefined);
      }
      return result;
    }
  }

  async listCollections(): Promise<ICollectionInfo[]> {
    if (!this.db) {
      await this.connect();
    }
    const rows = this.db!.prepare(LIST_TABLES_SQL).all() as unknown as Parameters<typeof mapSqliteTablesToCollections>[0];
    return mapSqliteTablesToCollections(rows).map((info) =>
      info.type === 'table' ? { ...info, rowCount: countRows(this.db!, info.name) } : info
    );
  }

  async describeCollection(name: string): Promise<IColumnSchema[]> {
    if (!this.db) {
      await this.connect();
    }
    return mapPragmaColumnsToSchema(pragmaDescribeTable(this.db!, name));
  }

  private bindAndAll(
    stmt: ReturnType<SqliteDatabase['prepare']>,
    params?: Record<string, unknown> | unknown[]
  ): Record<string, unknown>[] {
    if (params === undefined || (Array.isArray(params) ? params.length === 0 : Object.keys(params).length === 0)) {
      return stmt.all() as Record<string, unknown>[];
    }
    return stmt.all(params as Record<string, never>) as Record<string, unknown>[];
  }
}

function statementFieldInfo(stmt: ReturnType<SqliteDatabase['prepare']>) {
  try {
    const columns = stmt.columns();
    if (!Array.isArray(columns)) return [];
    return columns.map((col) => ({
      name: col.name ?? 'unknown',
      type: typeof col.type === 'string' && col.type.length > 0 ? col.type : 'unknown',
      nullable: true,
      key: null,
      default: null,
      extra: null,
    }));
  } catch {
    return [];
  }
}
