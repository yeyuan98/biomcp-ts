import type { IConnectionConfig, IConnectionPool } from './connection.js';
import type { IQuery, IQueryResult } from './query.js';
import type { ICollectionInfo, IColumnSchema } from './schema.js';
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
}

export type BackendType = DatabaseType;

export interface IBackendFactory {
  create(config: IConnectionConfig): IDatabaseBackend;
  getSupportedTypes(): BackendType[];
}
