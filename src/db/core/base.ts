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

/** node:sqlite reports every failure as code ERR_SQLITE_ERROR with the real
 * SQLite result code in the numeric `errcode` property. Map the codes this
 * toolkit has dedicated hints/behavior for so they actually trigger. */
function normalizeErrorCode(err: Error): string | undefined {
  const code = (err as Error & { code?: string }).code;
  if (code === 'ERR_SQLITE_ERROR') {
    const errcode = (err as Error & { errcode?: number }).errcode;
    if (errcode === 14) return 'SQLITE_CANTOPEN';
    if (errcode === 26) return 'SQLITE_NOTADB';
    if (errcode === 8) return 'SQLITE_READONLY';
  }
  return code;
}

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
    const errorCode = normalizeErrorCode(err);
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
