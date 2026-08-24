import type * as mysql from 'mysql2/promise';
import type {
  IConnectionConfig,
  IConnectionPool,
  IQuery,
  IQueryResult,
  ICollectionInfo,
  IColumnSchema,
} from '../../interface/index.js';
import { BaseBackend } from '../../core/base.js';
import { createPoolConfig, validateMysqlConfig } from './connection.js';
import {
  extractFieldInfo,
  mapMysqlTablesToCollections,
  mapMysqlColumnsToSchema,
  createMysqlTypeNameResolver,
  LIST_TABLES_SQL,
  DESCRIBE_TABLE_SQL,
} from './translator.js';

let driverPromise: Promise<typeof mysql> | null = null;

export async function loadMysqlDriver(): Promise<typeof mysql> {
  if (!driverPromise) {
    driverPromise = import('mysql2/promise')
      .then((mod) => {
        const candidate = mod as unknown as { default?: typeof mysql };
        return (candidate.default ?? mod) as typeof mysql;
      })
      .catch((error) => {
        driverPromise = null;
        throw new Error(
          'The "mysql2" package is required for the MySQL backend but is not installed.\n' +
          'Install it to enable MySQL tools: npm install mysql2',
          { cause: error }
        );
      });
  }
  return driverPromise;
}

export class MysqlBackend extends BaseBackend {
  readonly type = 'mysql';
  readonly config: IConnectionConfig;

  private pool: mysql.Pool | null = null;

  constructor(config: IConnectionConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    validateMysqlConfig(this.config);
    const mysql = await loadMysqlDriver();
    if (!this.pool) {
      this.pool = mysql.createPool(createPoolConfig(this.config));
    }
    await this.pool.query('SELECT 1');
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => undefined);
      this.pool = null;
    }
    this._connected = false;
  }

  getPool(): IConnectionPool | null {
    return this.pool
      ? {
          getConnection: async () => {
            const conn = await this.pool!.getConnection();
            return {
              isConnected: () => true,
              close: async () => conn.release(),
            };
          },
          end: async () => this.disconnect(),
          isHealthy: () => this.pool !== null && this._connected,
        }
      : null;
  }

  async executeQuery(query: IQuery): Promise<IQueryResult> {
    const startTime = Date.now();

    try {
      const mysql = await loadMysqlDriver();
      if (!this._connected || !this.pool) {
        await this.connect();
      }

      const params = query.params ?? {};
      const [rows, fields] = await this.pool!.query(query.sql, params as mysql.QueryValues);
      const executionTimeMs = Date.now() - startTime;

      return this.createSuccessResult(
        rows as mysql.RowDataPacket[],
        extractFieldInfo(fields, createMysqlTypeNameResolver(mysql.Types as unknown as Record<string, unknown>)),
        executionTimeMs
      );
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      const result = this.createErrorResult(error, executionTimeMs);
      if (isConnectionLevelFailure(result)) {
        await this.disconnect().catch(() => undefined);
      }
      return result;
    }
  }

  async listCollections(): Promise<ICollectionInfo[]> {
    if (!this.pool) {
      await this.connect();
    }
    const [rows] = await this.pool!.query<mysql.RowDataPacket[]>(LIST_TABLES_SQL);
    return mapMysqlTablesToCollections(rows);
  }

  async describeCollection(name: string): Promise<IColumnSchema[]> {
    if (!this.pool) {
      await this.connect();
    }
    const [rows] = await this.pool!.query<mysql.RowDataPacket[]>(DESCRIBE_TABLE_SQL, [name]);
    return mapMysqlColumnsToSchema(rows);
  }
}

function isConnectionLevelFailure(result: IQueryResult): boolean {
  const code = result.error?.code ?? '';
  return ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'ER_ACCESS_DENIED_ERROR'].includes(code);
}
