import type {
  IDatabaseBackend,
  IConnectionConfig,
  IConnectionPool,
  IQuery,
  IQueryResult,
  ICollectionInfo,
  IColumnSchema,
  IFieldInfo,
  IStructuredError,
  IResultMetadata,
  IRow,
} from '../interface/index.js';
import { getErrorHints } from './validator.js';

export abstract class BaseBackend implements IDatabaseBackend {
  abstract readonly type: string;
  abstract readonly config: IConnectionConfig;

  protected _connected: boolean = false;

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract getPool(): IConnectionPool | null;

  isConnected(): boolean {
    return this._connected;
  }

  abstract executeQuery(query: IQuery): Promise<IQueryResult>;
  abstract listCollections(): Promise<ICollectionInfo[]>;
  abstract describeCollection(name: string): Promise<IColumnSchema[]>;

  protected createSuccessResult(
    rows: IRow[],
    fields: IFieldInfo[],
    executionTimeMs: number
  ): IQueryResult {
    return {
      success: true,
      data: {
        rows,
        rowCount: rows.length,
        fields,
      },
      metadata: {
        executionTimeMs,
        backend: this.type,
      },
    };
  }

  protected createErrorResult(
    error: unknown,
    executionTimeMs: number,
    additionalHints?: string[]
  ): IQueryResult {
    const err = error instanceof Error ? error : new Error(String(error));
    const errorCode = (err as Error & { code?: string }).code;
    const baseHints = getErrorHints(errorCode);
    const hints = additionalHints ? [...baseHints, ...additionalHints] : [...baseHints];

    const structuredError: IStructuredError = {
      code: errorCode || 'UNKNOWN_ERROR',
      message: err.message || 'Unknown error occurred',
      hints,
    };

    return {
      success: false,
      error: structuredError,
      metadata: {
        executionTimeMs,
        backend: this.type,
      },
    };
  }

  protected createFieldInfo(
    name: string,
    type: string = 'unknown',
    nullable: boolean = true
  ): IFieldInfo {
    return {
      name,
      type,
      nullable,
      key: null,
      default: null,
      extra: null,
    };
  }
}
