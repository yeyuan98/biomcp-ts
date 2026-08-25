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

export function listTablesSql(schema: string = 'main'): string {
  return `
    SELECT name, type
    FROM ${quoteIdentifier(schema)}.sqlite_master
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `;
}

/** Kept for backward compatibility with earlier consumers. */
export const LIST_TABLES_SQL = listTablesSql();

/** Splits an optionally qualified `alias.table` name on the first dot. The
 * validator guarantees at most one dot and identifier-safe characters. */
export function parseQualifiedName(name: string): { schema: string; table: string } {
  const dot = name.indexOf('.');
  if (dot === -1) {
    return { schema: 'main', table: name };
  }
  return { schema: name.slice(0, dot), table: name.slice(dot + 1) };
}

export function describeTable(db: SqliteDatabase, table: string, schema: string = 'main'): PragmaTableInfoRow[] {
  return db
    .prepare(`PRAGMA ${quoteIdentifier(schema)}.table_info(${quoteIdentifier(table)})`)
    .all() as unknown as PragmaTableInfoRow[];
}

export function countRows(db: SqliteDatabase, table: string, schema: string = 'main'): number | null {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`)
      .get() as { n: number };
    return typeof row?.n === 'number' ? row.n : null;
  } catch {
    return null;
  }
}

export function countTables(db: SqliteDatabase, schema: string = 'main'): number {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(schema)}.sqlite_master WHERE type = 'table'`)
      .get() as { n: number };
    return typeof row?.n === 'number' ? row.n : 0;
  } catch {
    return 0;
  }
}

/** Total size of a database in bytes, from its header page metadata. Returns 0
 * when the pragmas are unavailable (never throws). */
export function databaseSizeBytes(db: SqliteDatabase, schema: string = 'main'): number {
  try {
    const pageCount = db.prepare(`PRAGMA ${quoteIdentifier(schema)}.page_count`).get() as { page_count?: number };
    const pageSize = db.prepare(`PRAGMA ${quoteIdentifier(schema)}.page_size`).get() as { page_size?: number };
    if (typeof pageCount?.page_count === 'number' && typeof pageSize?.page_size === 'number') {
      return pageCount.page_count * pageSize.page_size;
    }
    return 0;
  } catch {
    return 0;
  }
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
