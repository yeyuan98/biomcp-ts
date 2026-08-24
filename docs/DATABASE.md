# Database Access

Optional read-only SQL access to your own databases through three MCP tools (`db_query`, `db_list_tables`, `db_describe_table`). The tools ship inside the standard `biomcp` package but stay **dormant until configured** — without a `DB_TYPE` environment variable the tool list is unchanged.

## Backends

| Backend | Driver | Notes |
|---------|--------|-------|
| **MySQL** | [`mysql2`](https://www.npmjs.com/package/mysql2) | Optional peer dependency — run `npm install mysql2`; the server prints an actionable install hint if it is missing |
| **SQLite** (local file) | built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) | No extra dependency; requires Node >= 22.13. The file is opened strictly read-only |

## Enabling

Set `DB_TYPE` plus the connection variables for your backend in the MCP client configuration:

| Variable | Required | Purpose |
|----------|----------|---------|
| `DB_TYPE` | yes (`mysql` or `sqlite`) | Selects the backend and activates the db tools |
| `DB_HOST` / `DB_PORT` | MySQL | Defaults: `localhost` / `3306` |
| `DB_USER` (or `DB_USERNAME`) / `DB_PASSWORD` | MySQL | Credentials |
| `DB_DATABASE` | MySQL | Database name |
| `DB_SQLITE_PATH` | SQLite | Path to an existing `.db`/`.sqlite` file (opened read-only) |
| `DB_CONNECTION_TIMEOUT_MS` | no | Connect timeout, default `10000` |

### Example (Claude Desktop)

```json
{
  "mcpServers": {
    "biomcp": {
      "command": "npx",
      "args": ["biomcp"],
      "env": {
        "DB_TYPE": "sqlite",
        "DB_SQLITE_PATH": "/data/bio.db"
      }
    }
  }
}
```

## Tools

### `db_query`

Execute a read-only SELECT query with named parameters (`:name`).

- Allowed statement types: `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`, and read-only CTEs (`WITH ... SELECT`)
- Rejected: writes, multiple statements (semicolons), forbidden keywords, `INTO OUTFILE/DUMPFILE`
- String literals are stripped before keyword scanning, so quoted text never triggers false positives

```json
{
  "sql": "SELECT symbol FROM genes WHERE chromosome = :chr ORDER BY id LIMIT :n",
  "params": { "chr": "7", "n": 10 }
}
```

Results are structured JSON: rows, column field info, execution time, and backend identity. Errors carry a code plus actionable hints (e.g., `ER_NO_SUCH_TABLE` suggests running `db_list_tables`).

### `db_list_tables`

List tables/views with engine, row count (approximate for MySQL via `information_schema`, exact for SQLite tables), creation time, and comments.

### `db_describe_table`

Get column schema: name, type, nullability, key type (`PRI`/`UNI`/`MUL`), default value, and comments.

## Programmatic Use

The feature is exported from the `biomcp/db` subpath:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDbTools } from 'biomcp/db';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
registerDbTools(server);
```

The subpath also exposes backend classes (`MysqlBackend`, `SqliteBackend`), `createBackend`/`initializeBackend`, and the `validateReadOnlyQuery` validator for custom integrations.

## Security Model

- Read-only by construction: statement allow-list, keyword deny-list, and multi-statement rejection at the tool layer
- Defense-in-depth: SQLite connections additionally enforce `PRAGMA query_only = ON` at the driver level
- Table names passed to introspection are validated against a strict identifier regex, making `PRAGMA` interpolation injection-safe

## Testing

See [src/__tests__/README.md](../src/__tests__/README.md#database-tests). Unit tests cover the validator, env loader, SQLite backend (temp-file databases), translators, and MCP-level tool behavior; an integration suite runs against a live MySQL server when `BIOMCP_DB_IT_*` variables are set.
