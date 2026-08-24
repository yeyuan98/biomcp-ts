# Environment Variables

Single source of truth for every environment variable BioMCP reads. BioMCP works with **zero configuration** — everything below is optional except where noted. Set variables in your MCP client's server entry (`env` / `environment` / `[mcp_servers.*.env]` blocks) or in the shell that launches the server; see [AGENT-INSTALL.md](AGENT-INSTALL.md).

## API keys and identifiers

Optional. Without them the affected tools still work using keyless fallbacks or lower rate limits.

| Variable | Used by | Effect |
|----------|---------|--------|
| `NCBI_API_KEY` | PubMed, PMC OA, NCBI ID conversion, PubTator | Higher NCBI E-utilities rate limits (from 3 to 10 req/s) |
| `NCBI_EMAIL` | PubMed, PubTator | Polite-contact `tool`/`email` parameters on NCBI E-utilities requests |
| `S2_API_KEY` | Semantic Scholar | Higher rate limits on Semantic Scholar article search/citations |
| `OPENFDA_API_KEY` | OpenFDA | Higher rate limits for drug regulatory data |
| `ONCOKB_TOKEN` | `variant_oncokb` | **Required for this tool** — OncoKB precision-oncology annotations ([request access](https://www.oncokb.org/account/register)) |
| `DISGENET_API_KEY` | DisGeNET sources | **Required for DisGeNET associations** — disease-gene association data |
| `CROSSREF_EMAIL` | Crossref | Puts requests in the Crossref polite pool (faster, more reliable metadata) |
| `EPO_OPS_CONSUMER_KEY` + `EPO_OPS_CONSUMER_SECRET` | Patent search/detail | Enables the EPO OPS backend (worldwide patents incl. EP/WO claims). Both must be set together |
| `USPTO_API_KEY` | USPTO ODP patent backend | Enables USPTO Open Data Portal application search |

> Keyless defaults: US patents search via USPTO Public Search (no key needed); Google Patents as best-effort fallback.

## Database access (optional feature)

Activates the `db_query` / `db_list_tables` / `db_describe_table` tools when `DB_TYPE` is set. Full guide: [DATABASE.md](DATABASE.md).

| Variable | Required | Purpose |
|----------|----------|---------|
| `DB_TYPE` | yes (`mysql` or `sqlite`) | Selects the backend and activates the db tools |
| `DB_HOST` / `DB_PORT` | MySQL | Defaults: `localhost` / `3306` |
| `DB_USER` (or `DB_USERNAME`) / `DB_PASSWORD` | MySQL | Credentials |
| `DB_DATABASE` | MySQL | Database name |
| `DB_SQLITE_PATH` | SQLite | Path to an existing `.db`/`.sqlite` file (opened read-only) |
| `DB_CONNECTION_TIMEOUT_MS` | no | Connect timeout, default `10000` |

## Proxy

Honored by every upstream request via proxy-aware global fetch (undici).

| Variable | Purpose |
|----------|---------|
| `HTTPS_PROXY` / `https_proxy` | Proxy for HTTPS requests |
| `HTTP_PROXY` / `http_proxy` | Proxy for HTTP requests |
| `NO_PROXY` / `no_proxy` | Comma-separated hosts to bypass the proxy |

## Test-only

Never read by the shipped server — used only by the optional live-MySQL integration suite:

| Variable | Purpose |
|----------|---------|
| `BIOMCP_DB_IT_HOST` / `BIOMCP_DB_IT_PORT` | MySQL server under test (suite skips unless both are set) |
| `BIOMCP_DB_IT_USER` / `BIOMCP_DB_IT_PASSWORD` / `BIOMCP_DB_IT_DATABASE` | Credentials (defaults: `root` / empty / `bio`) |

See [src/__tests__/README.md](../src/__tests__/README.md#database-tests).
