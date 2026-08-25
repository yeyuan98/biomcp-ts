import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDbToolsIfConfigured } from '../../server/tools/db.js';
import { closeBackend } from '../../db/index.js';

async function createDbHarness(env: Record<string, string | undefined>) {
  const server = new McpServer({ name: 'db-test', version: '1.0.0' });
  const savedEntries = Object.entries(env).map(([k]) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const registered = registerDbToolsIfConfigured(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'db-test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    registered,
    callTool: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content[0] as { text: string }).text;
      return {
        isError: result.isError === true,
        text,
        json: () => JSON.parse(text),
      };
    },
    listToolNames: async () => (registered ? (await client.listTools()).tools.map((t) => t.name) : []),
    cleanup: async () => {
      for (const [k, v] of savedEntries) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await client.close();
    },
  };
}

describe('registerDbToolsIfConfigured gating', () => {
  it('does not register without DB_TYPE', async () => {
    const h = await createDbHarness({});
    expect(h.registered).toBe(false);
    expect(await h.listToolNames()).toEqual([]);
    await h.cleanup();
  });

  it('registers db tools with DB_TYPE set', async () => {
    const h = await createDbHarness({ DB_TYPE: 'sqlite' });
    expect(h.registered).toBe(true);
    const names = await h.listToolNames();
    expect(names).toEqual(expect.arrayContaining(['db_query', 'db_list_tables', 'db_describe_table']));
    await h.cleanup();
  });
});

describe('db tools end-to-end over MCP (sqlite)', () => {
  let dir: string;
  let file: string;
  let harness: Awaited<ReturnType<typeof createDbHarness>>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'biomcp-mcp-db-'));
    file = join(dir, 'bio.db');
    const { loadSqliteModule } = await import('../../db/backends/sqlite/connection.js');
    const { DatabaseSync } = await loadSqliteModule();
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE genes (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, chromosome TEXT);
      INSERT INTO genes (symbol, chromosome) VALUES ('BRAF', '7'), ('TP53', '17'), ('EGFR', '7');
    `);
    db.close();
    harness = await createDbHarness({ DB_TYPE: 'sqlite', DB_SQLITE_PATH: file });
  }, 20000);

  afterAll(async () => {
    await harness.cleanup();
    await closeBackend();
    rmSync(dir, { recursive: true, force: true });
  });

  it('db_query returns structured rows', async () => {
    const r = await harness.callTool('db_query', { sql: 'SELECT symbol FROM genes ORDER BY id LIMIT :n', params: { n: 2 } });
    expect(r.isError).toBe(false);
    expect(r.json().success).toBe(true);
    expect(r.json().data.rows.map((row: { symbol: string }) => row.symbol)).toEqual(['BRAF', 'TP53']);
  });

  it('db_query rejects write attempts with validation payload', async () => {
    const r = await harness.callTool('db_query', { sql: 'DROP TABLE genes' });
    expect(r.isError).toBe(false);
    expect(r.json().success).toBe(false);
    expect(r.json().error.code).toBe('NOT_READ_ONLY');
  });

  it('db_list_tables lists tables', async () => {
    const r = await harness.callTool('db_list_tables');
    expect(r.json().count).toBe(1);
    expect(r.json().collections[0].name).toBe('genes');
  });

  it('db_describe_table returns schema and not-found payload', async () => {
    const ok = await harness.callTool('db_describe_table', { table_name: 'genes' });
    expect(ok.json().columnCount).toBe(3);
    expect(ok.json().columns[0].key).toBe('PRI');

    const missing = await harness.callTool('db_describe_table', { table_name: 'nope' });
    expect(missing.json().success).toBe(false);
    expect(missing.json().error.code).toBe('COLLECTION_NOT_FOUND');
  });

  it('incomplete config surfaces actionable error at call time', async () => {
    await closeBackend();
    const h = await createDbHarness({ DB_TYPE: 'sqlite', DB_SQLITE_PATH: undefined });
    const r = await h.callTool('db_list_tables');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/DB_SQLITE_PATH/);
    await h.cleanup();
  });
});

describe('db tools multi-database over MCP (sqlite ATTACH)', () => {
  let dir: string;
  let mainFile: string;
  let extraFile: string;
  let harness: Awaited<ReturnType<typeof createDbHarness>>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'biomcp-mcp-multidb-'));
    mainFile = join(dir, 'main.db');
    extraFile = join(dir, 'depmap-26Q1.db');
    const { loadSqliteModule } = await import('../../db/backends/sqlite/connection.js');
    const { DatabaseSync } = await loadSqliteModule();
    const main = new DatabaseSync(mainFile);
    main.exec("CREATE TABLE genes (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL); INSERT INTO genes (symbol) VALUES ('BRAF')");
    main.close();
    const extra = new DatabaseSync(extraFile);
    extra.exec(`
      CREATE TABLE gene_effect (model_id TEXT, gene_symbol TEXT, value REAL);
      INSERT INTO gene_effect VALUES ('ACH-000222', 'BRAF', -4.46);
    `);
    extra.close();
    harness = await createDbHarness({
      DB_TYPE: 'sqlite',
      DB_SQLITE_PATH: `${mainFile},${extraFile}`,
    });
  }, 20000);

  afterAll(async () => {
    await harness.cleanup();
    await closeBackend();
    rmSync(dir, { recursive: true, force: true });
  });

  it('db_list_tables exposes databases array with derived aliases (main first)', async () => {
    const r = await harness.callTool('db_list_tables');
    expect(r.json().databases.map((d: { name: string }) => d.name)).toEqual(['main', 'depmap_26q1']);
    expect(r.json().databases[1].file).toBe(extraFile);
    const collections = r.json().collections;
    expect(collections.find((c: { name: string; database?: string }) => c.name === 'genes')?.database).toBe('main');
    expect(collections.find((c: { name: string; database?: string }) => c.name === 'gene_effect')?.database).toBe('depmap_26q1');
  });

  it('db_query joins across databases with alias-qualified names', async () => {
    const r = await harness.callTool('db_query', {
      sql: "SELECT g.symbol, e.model_id, e.value FROM depmap_26q1.gene_effect e JOIN main.genes g ON g.symbol = e.gene_symbol",
    });
    expect(r.isError).toBe(false);
    expect(r.json().data.rows).toEqual([{ symbol: 'BRAF', model_id: 'ACH-000222', value: -4.46 }]);
  });

  it('db_describe_table accepts alias-qualified names and hints on miss', async () => {
    const ok = await harness.callTool('db_describe_table', { table_name: 'depmap_26q1.gene_effect' });
    expect(ok.json().columnCount).toBe(3);

    const missing = await harness.callTool('db_describe_table', { table_name: 'gene_effectz' });
    expect(missing.json().error.code).toBe('COLLECTION_NOT_FOUND');
    expect(missing.json().error.hints.some((h: string) => /alias\.table/.test(h))).toBe(true);
  });

  it('db_query error hints mention alias qualification for missing tables', async () => {
    const r = await harness.callTool('db_query', { sql: 'SELECT * FROM gene_effectz' });
    expect(r.json().success).toBe(false);
    expect(r.json().error.hints.some((h: string) => /alias\.table/.test(h))).toBe(true);
  });
});
