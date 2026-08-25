import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBackend } from '../../db/backends/sqlite/backend.js';
import { createBackend, initializeBackend, getDefaultBackend, closeBackend, getSupportedTypes } from '../../db/backends/index.js';

function sqliteConfig(file: string, attach?: string[]) {
  return { type: 'sqlite' as const, host: 'localhost', port: 0, database: file, ...(attach ? { attach } : {}) };
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

describe('SqliteBackend multi-database (ATTACH)', () => {
  let dir: string;
  let mainFile: string;

  async function createExtraDb(name: string, ddl: string): Promise<string> {
    const file = join(dir, name);
    rmSync(file, { force: true });
    const { loadSqliteModule } = await import('../../db/backends/sqlite/connection.js');
    const { DatabaseSync } = await loadSqliteModule();
    const db = new DatabaseSync(file);
    db.exec(ddl);
    db.close();
    return file;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'biomcp-db-multi-'));
    const seed = await createSeedDb();
    mainFile = join(dir, 'main-copy.db');
    writeFileSync(mainFile, '');
    const { loadSqliteModule } = await import('../../db/backends/sqlite/connection.js');
    const { DatabaseSync } = await loadSqliteModule();
    const db = new DatabaseSync(mainFile);
    db.exec('CREATE TABLE shared (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO shared (label) VALUES (\'from-main\')');
    db.close();
    rmSync(seed.dir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    return closeBackend();
  });

  it('attaches extra databases read-only under derived aliases', async () => {
    const markers = await createExtraDb('markers.db', "CREATE TABLE markers (gene TEXT, locus TEXT); INSERT INTO markers VALUES ('KRAS', '12p12.1')");
    const backend = new SqliteBackend(sqliteConfig(mainFile, [markers]));
    await backend.connect();
    const result = await backend.executeQuery({ sql: "SELECT s.label, m.locus FROM shared s JOIN markers m ON m.gene = 'KRAS'" });
    expect(result.success).toBe(true);
    expect(result.data?.rows).toEqual([{ label: 'from-main', locus: '12p12.1' }]);
    await backend.disconnect();
  });

  it('exposes databases with aliases, files, and table counts (main first)', async () => {
    const markers = await createExtraDb('markers.db', 'CREATE TABLE markers (gene TEXT)');
    const second = await createExtraDb('second.sqlite', 'CREATE TABLE t2 (x INTEGER)');
    const backend = new SqliteBackend(sqliteConfig(mainFile, [markers, second]));
    await backend.connect();
    const databases = await backend.listDatabases();
    expect(databases.map((d) => d.name)).toEqual(['main', 'markers', 'second']);
    expect(databases[0].file.endsWith('main-copy.db')).toBe(true);
    expect(databases[1].tableCount).toBe(1);
    const collections = await backend.listCollections();
    const byDb = new Map<string, string[]>();
    for (const c of collections) byDb.set(c.database!, [...(byDb.get(c.database!) ?? []), c.name]);
    expect(byDb.get('main')).toEqual(['shared']);
    expect(byDb.get('markers')).toEqual(['markers']);
    expect(byDb.get('second')).toEqual(['t2']);
    await backend.disconnect();
  });

  it('sanitizes awkward aliases: dashes, leading digits, reserved names', async () => {
    const dashed = await createExtraDb('depmap-26Q1.db', 'CREATE TABLE d1 (x INTEGER)');
    const numeric = await createExtraDb('2024.db', 'CREATE TABLE n1 (x INTEGER)');
    const reserved = await createExtraDb('main.db', 'CREATE TABLE r1 (x INTEGER)');
    const backend = new SqliteBackend(sqliteConfig(mainFile, [dashed, numeric, reserved]));
    await backend.connect();
    const names = (await backend.listDatabases()).map((d) => d.name);
    expect(names).toEqual(['main', 'depmap_26q1', '_2024', 'main_2']);
    for (const [qualifier, table] of [['depmap_26q1', 'd1'], ['_2024', 'n1'], ['main_2', 'r1']] as const) {
      const columns = await backend.describeCollection(`${qualifier}.${table}`);
      expect(columns.map((c) => c.field)).toEqual(['x']);
    }
    await backend.disconnect();
  });

  it('suffixes duplicate aliases and dedupes repeated files', async () => {
    const first = await createExtraDb('dup.db', 'CREATE TABLE a (x INTEGER)');
    const second = await createExtraDb('dup (1).db', 'CREATE TABLE b (x INTEGER)');
    const backend = new SqliteBackend(sqliteConfig(mainFile, [first, second, first]));
    await backend.connect();
    const databases = await backend.listDatabases();
    const names = databases.map((d) => d.name);
    expect(names).toEqual(['main', 'dup', 'dup_1']); // third entry deduped by realpath
    await backend.disconnect();
  });

  it('describes qualified tables and rejects unknown aliases with guidance', async () => {
    const markers = await createExtraDb('markers.db', 'CREATE TABLE markers (gene TEXT PRIMARY KEY, locus TEXT NOT NULL)');
    const backend = new SqliteBackend(sqliteConfig(mainFile, [markers]));
    await backend.connect();
    const columns = await backend.describeCollection('markers.markers');
    expect(columns.map((c) => c.field)).toEqual(['gene', 'locus']);
    expect(columns[0].key).toBe('PRI');
    await expect(backend.describeCollection('ghost.markers')).rejects.toThrow(/Unknown database "ghost"[\s\S]*markers/);
    await backend.disconnect();
  });

  it('blocks writes to attached databases', async () => {
    const markers = await createExtraDb('markers.db', 'CREATE TABLE markers (gene TEXT)');
    const backend = new SqliteBackend(sqliteConfig(mainFile, [markers]));
    await backend.connect();
    const result = await backend.executeQuery({ sql: "INSERT INTO markers.markers VALUES ('X')" });
    expect(result.success).toBe(false);
    await backend.disconnect();
  });

  it('hints at alias qualification on no-such-table errors', async () => {
    const markers = await createExtraDb('markers.db', 'CREATE TABLE markers (gene TEXT)');
    const backend = new SqliteBackend(sqliteConfig(mainFile, [markers]));
    await backend.connect();
    const result = await backend.executeQuery({ sql: 'SELECT * FROM markerz' });
    expect(result.success).toBe(false);
    expect(result.error?.hints?.some((h) => /alias\.table/.test(h))).toBe(true);
    const single = new SqliteBackend(sqliteConfig(mainFile));
    await single.connect();
    const bare = await single.executeQuery({ sql: 'SELECT * FROM markerz' });
    expect(bare.error?.hints?.some((h) => /alias\.table/.test(h))).toBe(false);
    await backend.disconnect();
    await single.disconnect();
  });

  it('fails attach for missing files without creating them, naming the entry', async () => {
    const missing = join(dir, 'does-not-exist.db');
    const backend = new SqliteBackend(sqliteConfig(mainFile, [missing]));
    await expect(backend.connect()).rejects.toThrow(/does-not-exist\.db[\s\S]*not found/);
    expect(existsSync(missing)).toBe(false);
  });

  it('attaches files with URI-hostile characters in their names', async () => {
    const odd = await createExtraDb('hash#tag.db', "CREATE TABLE odd (v TEXT); INSERT INTO odd VALUES ('ok')");
    const q = await createExtraDb('q?mark.db', "CREATE TABLE oddq (v TEXT); INSERT INTO oddq VALUES ('ok')");
    const backend = new SqliteBackend(sqliteConfig(mainFile, [odd, q]));
    await backend.connect();
    const r1 = await backend.executeQuery({ sql: 'SELECT v FROM hash_tag.odd' });
    const r2 = await backend.executeQuery({ sql: 'SELECT v FROM q_mark.oddq' });
    expect(r1.data?.rows).toEqual([{ v: 'ok' }]);
    expect(r2.data?.rows).toEqual([{ v: 'ok' }]);
    await backend.disconnect();
  });

  it('rejects more than 10 attached databases, naming every entry', async () => {
    const extras = Array.from({ length: 11 }, (_, i) => join(dir, `extra${i}.db`));
    const backend = new SqliteBackend(sqliteConfig(mainFile, extras));
    await expect(backend.connect()).rejects.toThrow(/Too many attached databases[\s\S]*extra10\.db/);
  });

  it('omits row counts for databases over the size gate', async () => {
    const markers = await createExtraDb('markers.db', 'CREATE TABLE markers (gene TEXT); INSERT INTO markers VALUES (\'KRAS\')');
    class GatedBackend extends SqliteBackend {
      protected get rowCountSizeGateBytes(): number {
        return 1;
      }
    }
    const backend = new GatedBackend(sqliteConfig(mainFile, [markers]));
    await backend.connect();
    const collections = await backend.listCollections();
    const markersTable = collections.find((c) => c.name === 'markers')!;
    expect(markersTable.rowCount).toBeNull();
    const sharedTable = collections.find((c) => c.name === 'shared')!;
    expect(sharedTable.rowCount).toBeNull();
    const databases = await backend.listDatabases();
    expect(databases.every((d) => d.rowCountOmitted === true)).toBe(true);
    await backend.disconnect();
  });
});

describe('SqliteBackend attach failure and recovery', () => {
  let dir: string;
  let mainFile: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'biomcp-db-recovery-'));
    mainFile = join(dir, 'main.db');
    const { loadSqliteModule } = await import('../../db/backends/sqlite/connection.js');
    const { DatabaseSync } = await loadSqliteModule();
    const db = new DatabaseSync(mainFile);
    db.exec("CREATE TABLE shared (label TEXT); INSERT INTO shared VALUES ('m')");
    db.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    return closeBackend();
  });

  it('does not serve partial data after a failed connect, and recovers on retry', async () => {
    const good = join(dir, 'good.db');
    const missing = join(dir, 'missing.db');
    const { loadSqliteModule } = await import('../../db/backends/sqlite/connection.js');
    const { DatabaseSync } = await loadSqliteModule();
    const g = new DatabaseSync(good);
    g.exec("CREATE TABLE g (v TEXT); INSERT INTO g VALUES ('ok')");
    g.close();

    const backend = new SqliteBackend(sqliteConfig(mainFile, [good, missing]));
    await expect(backend.connect()).rejects.toThrow(/missing\.db/);

    // No silent partial data: list methods re-run connect() and fail loudly.
    await expect(backend.listCollections()).rejects.toThrow(/missing\.db/);
    await expect(backend.listDatabases()).rejects.toThrow(/missing\.db/);

    // Operator fixes the typo (file appears); retry heals the SAME backend.
    const m = new DatabaseSync(missing);
    m.exec('CREATE TABLE m (x INTEGER)');
    m.close();
    const result = await backend.executeQuery({ sql: 'SELECT v FROM g' });
    expect(result.success).toBe(true);
    expect(result.data?.rows).toEqual([{ v: 'ok' }]);
    await backend.disconnect();
  });

  it('initializeBackend failure leaves no poisoned default backend', async () => {
    await expect(initializeBackend(sqliteConfig(mainFile, [join(dir, 'nope.db')]))).rejects.toThrow(/nope\.db/);
    expect(getDefaultBackend()).toBeNull();
  });

  it('skips an extra entry that resolves to the main file itself', async () => {
    const backend = new SqliteBackend(sqliteConfig(mainFile, [mainFile]));
    await backend.connect();
    const databases = await backend.listDatabases();
    expect(databases.map((d) => d.name)).toEqual(['main']);
    await backend.disconnect();
  });

  it('describes views and runs named-param queries against attached databases', async () => {
    const extra = join(dir, 'views.db');
    rmSync(extra, { force: true });
    const { loadSqliteModule } = await import('../../db/backends/sqlite/connection.js');
    const { DatabaseSync } = await loadSqliteModule();
    const x = new DatabaseSync(extra);
    x.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, category TEXT);
      CREATE VIEW fancy AS SELECT id FROM items WHERE category = 'fancy';
      INSERT INTO items (category) VALUES ('fancy'), ('plain');
    `);
    x.close();
    const backend = new SqliteBackend(sqliteConfig(mainFile, [extra]));
    await backend.connect();
    const columns = await backend.describeCollection('views.fancy');
    expect(columns.map((c) => c.field)).toEqual(['id']);
    const result = await backend.executeQuery({
      sql: 'SELECT COUNT(*) AS n FROM views.items WHERE category = :cat',
      params: { cat: 'fancy' },
    });
    expect(result.data?.rows).toEqual([{ n: 1 }]);
    await backend.disconnect();
  });
});
