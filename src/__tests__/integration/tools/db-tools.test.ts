import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerDbTools } from '../../../server/tools/db.js';
import { closeBackend } from '../../../db/index.js';

const IT_HOST = process.env.BIOMCP_DB_IT_HOST;
const IT_PORT = process.env.BIOMCP_DB_IT_PORT;
const IT_USER = process.env.BIOMCP_DB_IT_USER ?? 'root';
const IT_PASSWORD = process.env.BIOMCP_DB_IT_PASSWORD ?? '';
const IT_DATABASE = process.env.BIOMCP_DB_IT_DATABASE ?? 'bio';

const mysqlAvailable = Boolean(IT_HOST && IT_PORT);
const describeIfMysql = mysqlAvailable ? describe : describe.skip;

describeIfMysql('db tools against live MySQL', () => {
  let callTool: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; json: () => any }>;

  beforeAll(async () => {
    process.env.DB_TYPE = 'mysql';
    process.env.DB_HOST = IT_HOST;
    process.env.DB_PORT = IT_PORT;
    process.env.DB_USER = IT_USER;
    process.env.DB_PASSWORD = IT_PASSWORD;
    process.env.DB_DATABASE = IT_DATABASE;

    const server = new McpServer({ name: 'db-it', version: '1.0.0' });
    registerDbTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'db-it-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    callTool = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return {
        isError: result.isError === true,
        json: () => JSON.parse((result.content[0] as { text: string }).text),
      };
    };
  }, 30000);

  afterAll(async () => {
    for (const key of ['DB_TYPE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE']) {
      delete process.env[key];
    }
    await closeBackend();
  });

  it('connects eagerly and lists tables via information_schema', async () => {
    const r = await callTool('db_list_tables');
    expect(r.isError).toBe(false);
    expect(r.json().backend).toBe('mysql');
    expect(Array.isArray(r.json().collections)).toBe(true);
  });

  it('executes named-param queries with LIMIT :n and typed fields', async () => {
    const r = await callTool('db_query', {
      sql: 'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = :schema ORDER BY TABLE_NAME LIMIT :n',
      params: { schema: IT_DATABASE, n: 5 },
    });
    expect(r.json().success).toBe(true);
    expect(r.json().data.rows.length).toBeLessThanOrEqual(5);
    expect(r.json().data.fields[0].type).toMatch(/^[A-Z]/);
  });

  it('returns structured error with hints for unknown table', async () => {
    const r = await callTool('db_query', { sql: 'SELECT * FROM definitely_missing_table_xyz' });
    expect(r.json().success).toBe(false);
    expect(r.json().error.code).toBe('ER_NO_SUCH_TABLE');
    expect(r.json().error.hints.length).toBeGreaterThan(0);
  });
});
