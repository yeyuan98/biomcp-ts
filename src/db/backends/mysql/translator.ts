import type * as mysql from 'mysql2/promise';
import type {
  ICollectionInfo,
  IColumnSchema,
} from '../../interface/index.js';

export type MysqlTypeNameResolver = (typeCode: unknown) => string;

const DEFAULT_TYPE_NAME: MysqlTypeNameResolver = (typeCode) => String(typeCode ?? 'unknown');

export function createMysqlTypeNameResolver(types: Record<string, unknown>): MysqlTypeNameResolver {
  const codeToName = new Map<unknown, string>();
  for (const [name, code] of Object.entries(types)) {
    codeToName.set(code, name);
  }
  return (typeCode) => codeToName.get(typeCode) ?? String(typeCode ?? 'unknown');
}

export function extractFieldInfo(
  fieldPackets: mysql.FieldPacket[] | null | undefined,
  resolveTypeName: MysqlTypeNameResolver = DEFAULT_TYPE_NAME
) {
  if (!fieldPackets || !Array.isArray(fieldPackets)) {
    return [];
  }

  return fieldPackets.map((field) => ({
    name: field.name ?? 'unknown',
    type: resolveTypeName(field.type),
    nullable: true,
    key: null,
    default: null,
    extra: null,
  }));
}

export function mapMysqlTablesToCollections(rows: mysql.RowDataPacket[]): ICollectionInfo[] {
  return rows.map((row) => ({
    name: row.TABLE_NAME || row.table_name || row.name || String(row[0] ?? 'unknown'),
    type: mapTableType(row.TABLE_TYPE || row.table_type || row.type),
    engine: row.ENGINE || row.engine || null,
    rowCount: row.TABLE_ROWS ?? row.table_rows ?? row.rows ?? null,
    createdAt: row.CREATE_TIME instanceof Date
      ? row.CREATE_TIME.toISOString()
      : (row.create_time || null),
    comment: row.TABLE_COMMENT || row.table_comment || row.comment || null,
  }));
}

function mapTableType(mysqlType: string): 'table' | 'view' {
  const upper = (mysqlType || '').toUpperCase();
  if (upper.includes('VIEW')) return 'view';
  return 'table';
}

export function mapMysqlColumnsToSchema(rows: mysql.RowDataPacket[]): IColumnSchema[] {
  return rows.map((row) => ({
    field: row.Field || row.COLUMN_NAME || row.field || row.column_name || 'unknown',
    type: row.Type || row.COLUMN_TYPE || row.type || row.column_type || 'unknown',
    nullable: (row.Null || row.IS_NULLABLE || row.nullable) === 'YES',
    key: row.Key || row.COLUMN_KEY || row.key || null,
    defaultValue: row.Default ?? row.COLUMN_DEFAULT ?? row.default ?? null,
    extra: row.Extra || row.EXTRA || row.extra || null,
    comment: row.Comment || row.COLUMN_COMMENT || row.comment || null,
  }));
}

export const LIST_TABLES_SQL = `
  SELECT
    TABLE_NAME,
    TABLE_TYPE,
    ENGINE,
    TABLE_ROWS,
    CREATE_TIME,
    TABLE_COMMENT
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
  ORDER BY TABLE_NAME
`;

export const DESCRIBE_TABLE_SQL = `
  SELECT
    COLUMN_NAME as Field,
    COLUMN_TYPE as Type,
    IS_NULLABLE as \`Null\`,
    COLUMN_KEY as \`Key\`,
    COLUMN_DEFAULT as \`Default\`,
    EXTRA as Extra,
    COLUMN_COMMENT as Comment
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
  ORDER BY ORDINAL_POSITION
`;
