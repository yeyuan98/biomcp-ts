# Database Access

Optional read-only SQL access to your own databases through three MCP tools (`db_query`, `db_list_tables`, `db_describe_table`). The tools ship inside the standard `biomcp` package but stay **dormant until configured** — without a `DB_TYPE` (set via env, or filled from `.biomcp.json` by the `biomcp_configure` tool at startup) the tool list is unchanged.

## Backends

| Backend | Driver | Notes |
|---------|--------|-------|
| **MySQL** | [`mysql2`](https://www.npmjs.com/package/mysql2) | Optional peer dependency — npm does **not** auto-install it; see [installation modes](#installation-modes). The server prints an actionable install hint if it is missing |
| **SQLite** (local file) | built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) | No extra dependency; requires Node >= 22.13. The file is opened strictly read-only |

## Installation modes

There is one package; the backend you get depends on what is installed next to it:

| Mode | Setup | Works from |
|------|-------|-----------|
| Core only / SQLite | nothing extra — `npx -y biomcp` anywhere (Node >= 22.13) | any directory |
| MySQL | pinned one-shot **as the client command array** (zero-install): `["npx","-y","-p","biomcp@0.9","-p","mysql2@3","biomcp"]` — or a local tree invoked by absolute path: `npm install biomcp mysql2`, then client command `["node","<ABSOLUTE_PATH>/biomcp-mysql/node_modules/biomcp/dist/bundle.js"]` | any directory (the client spawns the server) |

Why the difference: `mysql2` is a peer dependency, and Node resolves peers relative to the running script's install tree. A bare `npx biomcp` executes from the npx cache, which cannot see a separately installed `mysql2` — global installs do not help either, and MCP clients control the server's working directory, so "run `npx biomcp` from the tree's directory" never reaches the server (the absolute `node` path is what makes a local tree work). If the driver is missing when `DB_TYPE=mysql` is set, startup still succeeds and the first db tool call returns an actionable error pointing at the one-shot command / local tree, and at the `biomcp_configure` tool for prerequisites. `biomcp doctor` reports your install mode and driver resolvability (docs/AGENT-INSTALL.md §3).

## Enabling

Set `DB_TYPE` plus the connection variables for your backend. The complete, canonical list lives in [ENV-VARS.md → Database access](ENV-VARS.md#database-access-optional-feature); the essentials:

```bash
# MySQL
DB_TYPE=mysql DB_HOST=localhost DB_PORT=3306 DB_USER=bio_user DB_PASSWORD=… DB_DATABASE=bio

# SQLite (local file)
DB_TYPE=sqlite DB_SQLITE_PATH=/data/bio.db

# SQLite (multiple files: first = main, rest attached read-only)
DB_TYPE=sqlite DB_SQLITE_PATH=/data/bio.db,/data/depmap-26Q1.db
```

Agents can also enable this feature via the always-available `biomcp_configure` tool (`{"action":"set","values":{"features.database.enabled":true,"features.database.type":"sqlite","features.database.sqlite_path":["data/bio.db"]}}`, persisted to the `.biomcp.json` project file) — sensitive keys like `sqlite_path` require `confirm_sensitive: true`, and the MySQL driver tree below is still something the tool can only guide you through, not perform.

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

The db tools are registered at server startup, so **restart your MCP client** after adding or changing these variables — see [AGENT-INSTALL.md → Verify & troubleshoot](AGENT-INSTALL.md#5-verify--troubleshoot) for per-client restart specifics.

## Multiple SQLite databases

`DB_SQLITE_PATH` accepts a **comma-separated list of database files** (paths containing commas are not supported). The first file is the **main** database; every additional file is ATTACHed read-only under an alias derived from its filename (`depmap-26Q1.db` → `depmap_26q1`; sanitized to `[a-z0-9_]`, lowercased, suffixed on collisions). Up to 10 extra files (SQLite's own limit).

What this enables through the same three tools:

- **Discovery**: `db_list_tables` returns a `databases` array (name, file, table count — `main` first) and every collection carries its owning `database`.
- **Qualified access**: reference tables as `alias.table` in `db_query` and `db_describe_table`. Unqualified names resolve against main first, then attached databases in order — qualify to disambiguate when the same table name exists in more than one file.
- **Cross-database JOINs** in a single query:

```sql
SELECT m.CellLineName, e.value
FROM depmap_26q1.gene_effect e JOIN depmap_26q1.models m ON m.model_id = e.model_id
WHERE e.gene_symbol = 'KRAS' ORDER BY e.value ASC LIMIT 10
```

Notes:

- Both the main file and every attached file are opened strictly read-only (`mode=ro` URIs plus `PRAGMA query_only = ON`); a missing file fails startup of the first tool call with an error naming the entry.
- Row counts are exact in `db_list_tables` except for databases larger than 256 MB, where they are omitted (a `notes` entry says so) — use `SELECT COUNT(*)` instead.
- A WAL-mode database in a read-only *directory* cannot be attached (SQLite needs to create its `-shm` file there); place it on writable storage or convert it (`PRAGMA journal_mode=DELETE`).

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

List tables/views across every configured database: a `databases` array (SQLite multi-file setups list `main` plus attached aliases with file paths and table counts) and per-table engine, row count (approximate for MySQL via `information_schema`, exact for SQLite tables except >256 MB databases, where omitted), owning database, creation time, and comments.

### `db_describe_table`

Get column schema: name, type, nullability, key type (`PRI`/`UNI`/`MUL`), default value, and comments. Accepts `table` (resolved against main first) or `alias.table` for attached databases.

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

Or combine it with your own main database in a comma list (see [Multiple SQLite databases](#multiple-sqlite-databases)):
`DB_SQLITE_PATH=/data/bio.db,scripts/external-databases/depmap/dist/depmap-26Q1.db` — then query `depmap_26q1.gene_effect` and JOIN across both.

The script's live-manifest integration test is skipped unless `BIOMCP_DEPMAP_IT=1` is set.

## Programmatic Use

The feature is exported from the `biomcp/db` subpath:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDbTools } from 'biomcp/db';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
registerDbTools(server);
```

The subpath also exposes backend classes (`MysqlBackend`, `SqliteBackend`), `createBackend`/`initializeBackend`, and the `validateReadOnlyQuery` validator for custom integrations. For multiple SQLite databases, pass extra files via the typed `attach` field:

```ts
await initializeBackend({
  type: 'sqlite',
  host: 'localhost',
  port: 0,
  database: '/data/bio.db',          // main
  attach: ['/data/depmap-26Q1.db'],  // read-only, alias 'depmap_26q1'
});
```

## Security Model

- Read-only by construction: statement allow-list, keyword deny-list, and multi-statement rejection at the tool layer
- Defense-in-depth: SQLite connections additionally enforce `PRAGMA query_only = ON` at the driver level
- Table names passed to introspection are validated against a strict identifier regex, making `PRAGMA` interpolation injection-safe

## Testing

See [src/__tests__/README.md](../src/__tests__/README.md#database-tests). Unit tests cover the validator, env loader, SQLite backend (temp-file databases, including multi-database ATTACH), translators, and MCP-level tool behavior; integration suites run against a live MySQL server or local SQLite files when the respective `BIOMCP_DB_IT_*` variables are set.
