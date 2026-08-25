import type { IConnectionConfig, IConnectionPool } from './connection.js';
import type { IQuery, IQueryResult } from './query.js';
import type { ICollectionInfo, IColumnSchema, IDatabaseInfo } from './schema.js';
import type { DatabaseType } from './connection.js';

export interface IDatabaseBackend {
  readonly type: string;
  readonly config: IConnectionConfig;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getPool(): IConnectionPool | null;

  executeQuery(query: IQuery): Promise<IQueryResult>;
  listCollections(): Promise<ICollectionInfo[]>;
  describeCollection(name: string): Promise<IColumnSchema[]>;
  /** Optional: enumerate the databases (main + attached) reachable from this
   * backend. Backends that only see a single database may omit this. */
  listDatabases?(): Promise<IDatabaseInfo[]>;
}

export type BackendType = DatabaseType;

export interface IBackendFactory {
  create(config: IConnectionConfig): IDatabaseBackend;
  getSupportedTypes(): BackendType[];
}
