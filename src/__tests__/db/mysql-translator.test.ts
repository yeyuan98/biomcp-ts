import mysql2 from 'mysql2';
import {
  mapMysqlTablesToCollections,
  mapMysqlColumnsToSchema,
  createMysqlTypeNameResolver,
  extractFieldInfo,
} from '../../db/backends/mysql/translator.js';

const MYSQL_TYPES = (mysql2 as unknown as { Types: Record<string, unknown> }).Types;

describe('mapMysqlTablesToCollections', () => {
  it('maps information_schema rows including views', () => {
    const rows = [
      { TABLE_NAME: 'genes', TABLE_TYPE: 'BASE TABLE', ENGINE: 'InnoDB', TABLE_ROWS: 42, CREATE_TIME: new Date('2026-01-01T00:00:00Z'), TABLE_COMMENT: '' },
      { TABLE_NAME: 'gene_summary', TABLE_TYPE: 'VIEW', ENGINE: null, TABLE_ROWS: null, CREATE_TIME: null, TABLE_COMMENT: 'summary view' },
    ];
    const collections = mapMysqlTablesToCollections(rows as never);
    expect(collections[0]).toMatchObject({ name: 'genes', type: 'table', engine: 'InnoDB', rowCount: 42 });
    expect(collections[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(collections[1]).toMatchObject({ name: 'gene_summary', type: 'view', comment: 'summary view' });
  });
});

describe('mapMysqlColumnsToSchema', () => {
  it('maps DESCRIBE-style rows', () => {
    const rows = [
      { Field: 'id', Type: 'int', Null: 'NO', Key: 'PRI', Default: null, Extra: 'auto_increment', Comment: '' },
      { Field: 'symbol', Type: 'varchar(32)', Null: 'YES', Key: '', Default: null, Extra: '', Comment: 'gene symbol' },
    ];
    const columns = mapMysqlColumnsToSchema(rows as never);
    expect(columns[0]).toMatchObject({ field: 'id', type: 'int', nullable: false, key: 'PRI', extra: 'auto_increment' });
    expect(columns[1]).toMatchObject({ field: 'symbol', nullable: true, comment: 'gene symbol' });
  });
});

describe('createMysqlTypeNameResolver', () => {
  it('resolves numeric type codes to names and falls back to raw value', () => {
    const resolve = createMysqlTypeNameResolver(MYSQL_TYPES);
    expect(resolve(253)).toBe('VAR_STRING');
    expect(resolve(3)).toBe('LONG');
    expect(resolve(9999)).toBe('9999');
  });

  it('extractFieldInfo uses resolver output', () => {
    const fields = extractFieldInfo(
      [{ name: 'symbol', type: 253 }] as never,
      createMysqlTypeNameResolver(MYSQL_TYPES)
    );
    expect(fields).toEqual([{ name: 'symbol', type: 'VAR_STRING', nullable: true, key: null, default: null, extra: null }]);
  });
});
