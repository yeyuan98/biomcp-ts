import type {
  ICollectionInfo,
  IColumnSchema,
} from '../../interface/index.js';
import type { SqliteDatabase } from './connection.js';

export interface SqliteMasterRow {
  name: string;
  type: string;
}

export function mapSqliteTablesToCollections(rows: SqliteMasterRow[]): ICollectionInfo[] {
  return rows.map((row) => ({
    name: row.name,
    type: row.type === 'view' ? 'view' : 'table',
    engine: 'SQLite',
    rowCount: null,
    createdAt: null,
    comment: null,
  }));
}

export interface PragmaTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

export function mapPragmaColumnsToSchema(rows: PragmaTableInfoRow[]): IColumnSchema[] {
  return rows.map((row) => ({
    field: row.name,
    type: row.type || 'unknown',
    nullable: row.notnull === 0,
    key: row.pk > 0 ? 'PRI' : null,
    defaultValue: row.dflt_value,
    extra: null,
    comment: null,
  }));
}

export const LIST_TABLES_SQL = `
  SELECT name, type
  FROM sqlite_master
  WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
  ORDER BY name
`;

export function describeTable(db: SqliteDatabase, table: string): PragmaTableInfoRow[] {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as unknown as PragmaTableInfoRow[];
}

export function countRows(db: SqliteDatabase, table: string): number | null {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)}`).get() as { n: number };
    return typeof row?.n === 'number' ? row.n : null;
  } catch {
    return null;
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
