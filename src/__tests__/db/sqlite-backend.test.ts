import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBackend } from '../../db/backends/sqlite/backend.js';
import { createBackend, initializeBackend, getDefaultBackend, closeBackend, getSupportedTypes } from '../../db/backends/index.js';

function sqliteConfig(file: string) {
  return { type: 'sqlite' as const, host: 'localhost', port: 0, database: file };
}

async function createSeedDb(): Promise<{ dir: string; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'biomcp-db-'));
  const file = join(dir, 'bio.db');
  const { loadSqliteModule } = await import('../../db/backends/sqlite/connection.js');
  const { DatabaseSync } = await loadSqliteModule();
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE genes (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, chromosome TEXT);
    CREATE TABLE variants (id INTEGER PRIMARY KEY, gene_id INTEGER REFERENCES genes(id), hgvsp TEXT);
    CREATE VIEW gene_symbols AS SELECT symbol FROM genes;
    INSERT INTO genes (symbol, chromosome) VALUES ('BRAF', '7'), ('TP53', '17'), ('EGFR', '7');
    INSERT INTO variants (gene_id, hgvsp) VALUES (1, 'p.V600E'), (3, 'p.L858R');
  `);
  db.close();
  return { dir, file };
}

describe('backend registry', () => {
  it('supports mysql and sqlite only', () => {
    expect(getSupportedTypes().sort()).toEqual(['mysql', 'sqlite']);
  });

  it('throws for unknown backend type', () => {
    expect(() => createBackend({ type: 'mongodb' as never, host: 'x', port: 1, database: 'd' })).toThrow(/Unsupported backend type/);
  });
});

describe('SqliteBackend', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    ({ dir, file } = await createSeedDb());
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    return closeBackend();
  });

  it('connect throws actionable error for missing file', async () => {
    const backend = new SqliteBackend(sqliteConfig(join(dir, 'nope.db')));
    await expect(backend.connect()).rejects.toThrow(/not found.*DB_SQLITE_PATH/s);
  });

  it('initializeBackend lifecycle works with default backend', async () => {
    const backend = await initializeBackend(sqliteConfig(file));
    expect(getDefaultBackend()).toBe(backend);
    expect(backend.isConnected()).toBe(true);
    await closeBackend();
    expect(getDefaultBackend()).toBeNull();
  });

  it('lists tables and views with exact row counts for tables', async () => {
    const backend = new SqliteBackend(sqliteConfig(file));
    await backend.connect();
    const collections = await backend.listCollections();
    const names = Object.fromEntries(collections.map((c) => [c.name, c]));
    expect(Object.keys(names).sort()).toEqual(['gene_symbols', 'genes', 'variants']);
    expect(names.genes.type).toBe('table');
    expect(names.genes.rowCount).toBe(3);
    expect(names.gene_symbols.type).toBe('view');
    expect(names.gene_symbols.rowCount).toBeNull();
    await backend.disconnect();
  });

  it('describes table columns with keys and nullability', async () => {
    const backend = new SqliteBackend(sqliteConfig(file));
    await backend.connect();
    const columns = await backend.describeCollection('genes');
    expect(columns.map((c) => c.field)).toEqual(['id', 'symbol', 'chromosome']);
    expect(columns[0].key).toBe('PRI');
    expect(columns[1].nullable).toBe(false);
    expect(columns[2].nullable).toBe(true);
    await backend.disconnect();
  });

  it('executes queries with named parameters and reports fields/metadata', async () => {
    const backend = new SqliteBackend(sqliteConfig(file));
    await backend.connect();
    const result = await backend.executeQuery({
      sql: 'SELECT symbol FROM genes WHERE chromosome = :chr AND id >= :minId ORDER BY id',
      params: { chr: '7', minId: 1 },
    });
    expect(result.success).toBe(true);
    expect(result.data?.rows.map((r) => r.symbol)).toEqual(['BRAF', 'EGFR']);
    expect(result.data?.fields.map((f) => f.name)).toEqual(['symbol']);
    expect(typeof result.metadata.executionTimeMs).toBe('number');
    expect(result.metadata.backend).toBe('sqlite');
    await backend.disconnect();
  });

  it('enforces read-only at the database level as defense in depth', async () => {
    const backend = new SqliteBackend(sqliteConfig(file));
    await backend.connect();
    const result = await backend.executeQuery({ sql: "INSERT INTO genes (symbol) VALUES ('X')" });
    expect(result.success).toBe(false);
    await backend.disconnect();
  });

  it('returns structured errors for bad SQL', async () => {
    const backend = new SqliteBackend(sqliteConfig(file));
    await backend.connect();
    const result = await backend.executeQuery({ sql: 'SELECT * FROM nope_table' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBeDefined();
    expect(Array.isArray(result.error?.hints)).toBe(true);
    await backend.disconnect();
  });
});
