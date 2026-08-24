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
      description: `Execute a read-only SELECT query on the configured database.

**Examples:**
- Simple query: \`SELECT * FROM genes LIMIT 10\`
- With named params: \`SELECT * FROM variants WHERE significance = :significance\`

**Parameters:**
- Use named placeholders like \`:paramName\` for parameters
- Pass parameter values in the \`params\` object: { "significance": "pathogenic" }

**Note:** Only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH statements are allowed (read-only access).
Configure via environment variables: DB_TYPE (mysql|sqlite) plus connection settings.`,
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
      description: `List all tables/views in the configured database with metadata.

**Returns:**
- Table/view names and types
- Storage engine (MySQL)
- Row count (approximate for MySQL; exact count for SQLite tables)

**Usage:** Call this first to discover what tables are available before using db_describe_table or db_query.`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const backend = await getOrCreateBackend();
        const collections = await backend.listCollections();
        return toToolResult({
          backend: backend.type,
          collections,
          count: collections.length,
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
1. Use \`db_list_tables\` first to see available tables
2. Use this tool to understand the column structure
3. Use \`db_query\` to query the data`,
      inputSchema: {
        table_name: z.string().describe('Name of the table to describe. Use db_list_tables to see available tables.'),
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
          return toToolResult({
            success: false,
            error: {
              code: 'COLLECTION_NOT_FOUND',
              message: `Table '${table_name}' not found or has no columns.`,
              hints: [
                'Use db_list_tables to see available tables',
                'Check the table name for typos',
              ],
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

export function registerDbToolsIfConfigured(server: McpServer): boolean {
  if (!process.env.DB_TYPE?.trim()) {
    return false;
  }
  registerDbTools(server);
  return true;
}

export async function shutdownDbBackend(): Promise<void> {
  await closeBackend();
}
