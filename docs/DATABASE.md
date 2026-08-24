# Database Access

Optional read-only SQL access to your own databases through three MCP tools (`db_query`, `db_list_tables`, `db_describe_table`). The tools ship inside the standard `biomcp` package but stay **dormant until configured** — without a `DB_TYPE` environment variable the tool list is unchanged.

## Backends

| Backend | Driver | Notes |
|---------|--------|-------|
| **MySQL** | [`mysql2`](https://www.npmjs.com/package/mysql2) | Optional peer dependency — npm does **not** auto-install it; see [installation modes](#installation-modes). The server prints an actionable install hint if it is missing |
| **SQLite** (local file) | built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) | No extra dependency; requires Node >= 22.13. The file is opened strictly read-only |

## Installation modes

There is one package; the backend you get depends on what is installed next to it:

| Mode | Setup | Works from |
|------|-------|-----------|
| Core only / SQLite | nothing extra — `npx biomcp` anywhere (Node >= 22.13) | any directory |
| MySQL | local tree containing both packages: `npm install biomcp mysql2`, then run `npx biomcp` from that directory | that directory |

Why the difference: `mysql2` is a peer dependency, and Node resolves peers relative to the running script's install tree. A bare `npx biomcp` executes from the npx cache, which cannot see a separately installed `mysql2` — global installs do not help either. If the driver is missing when `DB_TYPE=mysql` is set, startup still succeeds and the first db tool call returns an actionable error: *"Install it to enable MySQL tools: npm install mysql2"*.

## Enabling

Set `DB_TYPE` plus the connection variables for your backend. The complete, canonical list lives in [ENV-VARS.md → Database access](ENV-VARS.md#database-access-optional-feature); the essentials:

```bash
# MySQL
DB_TYPE=mysql DB_HOST=localhost DB_PORT=3306 DB_USER=bio_user DB_PASSWORD=… DB_DATABASE=bio

# SQLite (local file)
DB_TYPE=sqlite DB_SQLITE_PATH=/data/bio.db
```

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

The db tools are registered at server startup, so **restart your MCP client** after adding or changing these variables — see [AGENT-INSTALL.md → Verify](AGENT-INSTALL.md#4-verify) for per-client restart specifics.

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

## Prebuilt external databases

Some data sources (e.g. DepMap) have no usable programmatic API, so their data is acquired
and organized ahead of time by standalone scripts in
[`scripts/external-databases/`](../scripts/external-databases/README.md) — orchestrated
through Makefile targets, never at MCP-tool call time.

### DepMap (Cancer Dependency Map)

```bash
make depmap-list RAW_DIR=/path/to/staged/files   # what to stage + verification status
make depmap-build RAW_DIR=/path/to/staged/files   # md5-verify + build the SQLite DB
```

Staging is a one-time manual step (browser download from the DepMap portal — its CAPTCHA
blocks programmatic access); the script verifies every file's md5 against DepMap's official
manifest. The build takes ~3 minutes and produces a ~5 GB database (CRISPR gene
effect/dependency, expression, copy number, mutations, model/gene metadata) — see the
[script README](../scripts/external-databases/depmap/README.md) for the schema, semantics,
and licensing notes. Then point the db tools at it:

```bash
DB_TYPE=sqlite DB_SQLITE_PATH=scripts/external-databases/depmap/dist/depmap-26Q1.db npx .
```

The script's live-manifest integration test is skipped unless `BIOMCP_DEPMAP_IT=1` is set.

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
