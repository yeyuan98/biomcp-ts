export interface IQuery {
  sql: string;
  params?: Record<string, unknown> | unknown[];
  options?: IQueryOptions;
}

export interface IQueryOptions {
  timeout?: number;
  limit?: number;
  offset?: number;
}

export interface IFieldInfo {
  name: string;
  type: string;
  nullable: boolean;
  key: string | null;
  default: unknown;
  extra: string | null;
}

export interface IResultMetadata {
  executionTimeMs: number;
  backend: string;
  [key: string]: unknown;
}

export interface IStructuredError {
  code: string;
  message: string;
  details?: string;
  hints?: string[];
}

export interface IQueryResult {
  success: boolean;
  data?: {
    rows: IRow[];
    rowCount: number;
    fields: IFieldInfo[];
  };
  error?: IStructuredError;
  metadata: IResultMetadata;
}

export type IRow = Record<string, unknown>;
