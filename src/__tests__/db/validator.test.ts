import { validateReadOnlyQuery, validateCollectionName, stripStringLiterals } from '../../db/core/validator.js';

describe('validateReadOnlyQuery', () => {
  it('allows SELECT', () => {
    expect(validateReadOnlyQuery('SELECT * FROM genes', 'mysql').valid).toBe(true);
  });

  it.each(['SHOW TABLES', 'DESCRIBE genes', 'EXPLAIN SELECT 1'])('allows %s prefix', (sql) => {
    expect(validateReadOnlyQuery(sql, 'mysql').valid).toBe(true);
  });

  it('allows read-only CTE (WITH ... SELECT)', () => {
    expect(validateReadOnlyQuery('WITH g AS (SELECT 1 AS n) SELECT * FROM g', 'sqlite').valid).toBe(true);
  });

  it('rejects empty query', () => {
    const r = validateReadOnlyQuery('   ', 'mysql');
    expect(r.valid).toBe(false);
    expect(r.error?.error?.code).toBe('EMPTY_QUERY');
  });

  it('rejects multiple statements', () => {
    const r = validateReadOnlyQuery('SELECT 1; SELECT 2', 'mysql');
    expect(r.error?.error?.code).toBe('MULTIPLE_STATEMENTS');
  });

  it.each([
    'DELETE FROM genes',
    'INSERT INTO genes VALUES (1)',
    'UPDATE genes SET symbol = :x',
    'DROP TABLE genes',
    'TRUNCATE TABLE genes',
    'ALTER TABLE genes ADD COLUMN x INT',
  ])('rejects non-read-only statement %s via prefix or keyword', (sql) => {
    const r = validateReadOnlyQuery(sql, 'mysql');
    expect(r.valid).toBe(false);
    expect(['NOT_READ_ONLY', 'FORBIDDEN_KEYWORD']).toContain(r.error?.error?.code);
  });

  it('matches forbidden keyword as standalone word outside literals', () => {
    const r = validateReadOnlyQuery('SELECT * FROM v WHERE a = 1 OR DELETE', 'mysql');
    expect(r.valid).toBe(false);
    expect(r.error?.error?.code).toBe('FORBIDDEN_KEYWORD');
  });

  it('does not match keywords embedded in identifiers (word boundaries)', () => {
    expect(validateReadOnlyQuery('SELECT deleted_at, created_at FROM genes', 'mysql').valid).toBe(true);
    expect(validateReadOnlyQuery('SELECT DELETE_extra FROM genes', 'mysql').valid).toBe(true);
  });

  it('does not false-positive on keywords inside quoted literals', () => {
    expect(validateReadOnlyQuery("SELECT * FROM genes WHERE name = 'DELETE me'", 'mysql').valid).toBe(true);
    expect(validateReadOnlyQuery('SELECT * FROM genes WHERE note = "DROP it"', 'sqlite').valid).toBe(true);
  });

  it('handles escaped quotes inside literals', () => {
    expect(validateReadOnlyQuery("SELECT * FROM genes WHERE name = 'it''s DROP time'", 'mysql').valid).toBe(true);
  });

  it.each([
    "SELECT * FROM genes INTO OUTFILE '/tmp/x'",
    "SELECT * FROM genes INTO DUMPFILE '/tmp/x'",
  ])('blocks %s', (sql) => {
    const r = validateReadOnlyQuery(sql, 'mysql');
    expect(r.error?.error?.code).toBe('FORBIDDEN_KEYWORD');
  });
});

describe('stripStringLiterals', () => {
  it('removes single-quoted content', () => {
    expect(stripStringLiterals("SELECT 'DELETE'")).toBe("SELECT ''");
  });

  it('removes double-quoted content', () => {
    expect(stripStringLiterals('SELECT "DROP"')).toBe('SELECT ""');
  });

  it('preserves escaped quotes as boundary', () => {
    expect(stripStringLiterals("'a''b'")).toBe("''");
  });
});

describe('validateCollectionName', () => {
  it('accepts plain identifiers', () => {
    expect(validateCollectionName('genes_2', 'mysql').valid).toBe(true);
  });

  it('rejects empty and invalid names', () => {
    expect(validateCollectionName('', 'mysql').valid).toBe(false);
    expect(validateCollectionName('gene-table', 'mysql').valid).toBe(false);
    expect(validateCollectionName('genes; DROP TABLE x', 'mysql').valid).toBe(false);
    expect(validateCollectionName('1genes', 'mysql').valid).toBe(false);
  });
});
