import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getDbConfigFromEnv,
  initializeBackend,
  getDefaultBackend,
  closeBackend,
} from '../../db/index.js';
import type { IDatabaseBackend, IQueryResult } from '../../db/index.js';
import { validateReadOnlyQuery, validateCollectionName } from '../../db/index.js';

async function getOrCreateBackend(): Promise<IDatabaseBackend> {
  let backend = getDefaultBackend();
  if (!backend) {
    const config = getDbConfigFromEnv();
    if (!config) {
      throw new Error(
        'Database access is not configured. Set DB_TYPE=mysql or DB_TYPE=sqlite along with the required connection variables.'
      );
    }
    backend = await initializeBackend(config);
  }
  return backend;
}

function toToolResult(result: IQueryResult | unknown): {
  content: { type: 'text'; text: string }[];
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

function toErrorResult(error: unknown): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: 'text', text: String(error) }],
    isError: true,
  };
}

export function registerDbTools(server: McpServer): void {
  server.registerTool(
    'db_query',
    {
      description: `Execute a read-only SELECT query on the configured database(s).

**Examples:**
- Simple query: \`SELECT * FROM genes LIMIT 10\`
- With named params: \`SELECT * FROM variants WHERE significance = :significance\`
- Cross-database join (multiple SQLite files configured): \`SELECT m.CellLineName, e.value FROM gene_effect e JOIN models m ON m.model_id = e.model_id WHERE e.gene_symbol = 'KRAS' LIMIT 10\`

**Parameters:**
- Use named placeholders like \`:paramName\` for parameters
- Pass parameter values in the \`params\` object: { "significance": "pathogenic" }

**Multiple databases:** when several SQLite files are configured, table names resolve against the main (first) database, then attached databases in order. Qualify as \`alias.table\` (aliases come from the \`databases\` array in db_list_tables output) to disambiguate when the same table name exists in more than one database.

**Note:** Only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH statements are allowed (read-only access).
Configure via environment variables: DB_TYPE (mysql|sqlite) plus connection settings; for SQLite, DB_SQLITE_PATH is a comma-separated list of database files (first = main, rest attached read-only).`,
      inputSchema: {
        sql: z.string().describe('SELECT SQL query to execute. Use named placeholders like :name for parameters.'),
        params: z.record(z.string(), z.unknown()).optional().describe('Named parameters as key-value pairs'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sql, params }) => {
      try {
        const backend = await getOrCreateBackend();

        const validation = validateReadOnlyQuery(sql, backend.type);
        if (!validation.valid && validation.error) {
          return toToolResult(validation.error);
        }

        const result = await backend.executeQuery({ sql, params });
        return toToolResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    }
  );

  server.registerTool(
    'db_list_tables',
    {
      description: `List all tables/views across the configured database(s) with metadata.

**Returns:**
- \`databases\`: every reachable database (SQLite multi-file setups: \`main\` plus attached aliases) with its file path and table count
- \`collections\`: table/view names with their owning \`database\`, type, and row count
- Row count is approximate for MySQL; exact for SQLite tables, except for large databases (>256 MB) where it is omitted (use SELECT COUNT(*) instead)

**Usage:** Call this first to discover available databases, aliases, and tables before using db_describe_table or db_query. Reference tables from attached databases as \`alias.table\`.`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const backend = await getOrCreateBackend();
        const collections = await backend.listCollections();
        const databases = backend.listDatabases ? await backend.listDatabases() : undefined;
        const notes = (databases ?? [])
          .filter((d) => d.rowCountOmitted)
          .map(
            (d) =>
              `rowCount omitted for '${d.name}' (database exceeds 256 MB); use SELECT COUNT(*) for exact counts`
          );
        return toToolResult({
          backend: backend.type,
          ...(databases ? { databases } : {}),
          collections,
          count: collections.length,
          ...(notes.length > 0 ? { notes } : {}),
        });
      } catch (error) {
        return toErrorResult(error);
      }
    }
  );

  server.registerTool(
    'db_describe_table',
    {
      description: `Get the column schema for a specific table.

**Returns for each column:**
- Field name
- Data type
- Nullable status
- Key type (PRI for primary key)
- Default value

**Workflow:**
1. Use \`db_list_tables\` first to see available databases, aliases, and tables
2. Use this tool to understand the column structure
3. Use \`db_query\` to query the data

**Multiple databases:** table names resolve against the main database first, then attached databases in order; qualify as \`alias.table\` to disambiguate when the same table name exists in more than one database (SQLite multi-file setups).`,
      inputSchema: {
        table_name: z.string().describe('Table name to describe — plain (resolved against main first) or alias.table for an attached database. Use db_list_tables to see databases and tables.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ table_name }) => {
      try {
        const backend = await getOrCreateBackend();

        const validation = validateCollectionName(table_name, backend.type);
        if (!validation.valid && validation.error) {
          return toToolResult(validation.error);
        }

        const columns = await backend.describeCollection(table_name);
        if (columns.length === 0) {
          const hints = [
            'Use db_list_tables to see available tables',
            'Check the table name for typos',
          ];
          const databases = backend.listDatabases ? await backend.listDatabases() : undefined;
          if (databases && databases.length > 1) {
            hints.push(
              'If the table lives in an attached database, qualify it as alias.table ' +
              '(aliases are listed in the databases array of db_list_tables output)'
            );
          }
          return toToolResult({
            success: false,
            error: {
              code: 'COLLECTION_NOT_FOUND',
              message: `Table '${table_name}' not found or has no columns.`,
              hints,
            },
            metadata: { executionTimeMs: 0, backend: backend.type },
          });
        }

        return toToolResult({
          collection: table_name,
          columns,
          columnCount: columns.length,
          backend: backend.type,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    }
  );
}

export function isDbConfigured(): boolean {
  return !!process.env.DB_TYPE?.trim();
}

export function registerDbToolsIfConfigured(server: McpServer): boolean {
  if (!isDbConfigured()) {
    return false;
  }
  registerDbTools(server);
  return true;
}

export async function shutdownDbBackend(): Promise<void> {
  await closeBackend();
}
