# Environment Variables

Single source of truth for every environment variable BioMCP reads. BioMCP works with **zero configuration** — everything below is optional except where noted. Set variables in your MCP client's server entry (`env` / `environment` / `[mcp_servers.*.env]` blocks) or in the shell that launches the server; see [AGENT-INSTALL.md](AGENT-INSTALL.md).

## API keys and identifiers

Optional. Without them the affected tools still work using keyless fallbacks or lower rate limits.

| Variable | Used by | Effect |
|----------|---------|--------|
| `NCBI_API_KEY` | PubMed, GEO, SRA, GenBank, PMC OA, NCBI ID conversion, PubTator | Higher NCBI E-utilities rate limits (from 3 to 10 req/s) |
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

> The MySQL backend additionally requires the optional peer driver `mysql2` installed next to biomcp (a plain `npx biomcp` cannot see it) — see [DATABASE.md → Installation modes](DATABASE.md#installation-modes).

| Variable | Required | Purpose |
|----------|----------|---------|
| `DB_TYPE` | yes (`mysql` or `sqlite`) | Selects the backend and activates the db tools |
| `DB_HOST` / `DB_PORT` | MySQL | Defaults: `localhost` / `3306` |
| `DB_USER` (or `DB_USERNAME`) / `DB_PASSWORD` | MySQL | Credentials |
| `DB_DATABASE` | MySQL | Database name |
| `DB_SQLITE_PATH` | SQLite | Comma-separated list of existing `.db`/`.sqlite` files (all opened read-only): the first is the **main** database, the rest are attached under filename-derived aliases — enables `alias.table` names and cross-database JOINs; see [DATABASE.md → Multiple SQLite databases](DATABASE.md#multiple-sqlite-databases) |
| `DB_CONNECTION_TIMEOUT_MS` | no | Connect timeout, default `10000` |

## R analysis (optional feature)

Activates the `analysis_r_deseq2` / `analysis_r_edger` / `analysis_r_limma` / `analysis_r_session_info` tools (Bioconductor DE in sandboxed WebAssembly R). Full guide: [R-ANALYSIS.md](R-ANALYSIS.md).

> Requires the optional peer dependency `webr` installed next to biomcp — see [R-ANALYSIS.md → Enabling](R-ANALYSIS.md#enabling).

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANALYSIS_R` | yes (`1`/`true`) | Activates the R analysis tools |
| `ANALYSIS_R_MIRROR_URL` | no | Override the wasm package bundle source: an extracted bundle directory, a `.tar.gz` archive (path, `file://`, or http(s) URL), for offline/self-hosted use. Default: latest GitHub release asset, cached in `~/.cache/biomcp/` |
| `ANALYSIS_R_TIMEOUT_MS` | no | Per-analysis timeout, default `600000` (10 min); exceeded analyses are interrupted |
| `ANALYSIS_R_MEM_LIMIT_MB` | no | RSS watermark above which new analyses are refused, default `2048` |
| `ANALYSIS_R_GITHUB_REPO` | no | `owner/repo` to fetch release assets from (default: this project's repository) |
| `BIOMPC_CACHE_DIR` | no | Base directory for the mirror cache (default `~/.cache/biomcp`) |

## Proxy

Honored by every upstream request via proxy-aware global fetch (undici).

| Variable | Purpose |
|----------|---------|
| `HTTPS_PROXY` / `https_proxy` | Proxy for HTTPS requests |
| `HTTP_PROXY` / `http_proxy` | Proxy for HTTP requests |
| `NO_PROXY` / `no_proxy` | Comma-separated hosts to bypass the proxy |

## Test-only

Never read by the shipped server — used only by the optional live-database integration suites:

| Variable | Purpose |
|----------|---------|
| `BIOMCP_DB_IT_HOST` / `BIOMCP_DB_IT_PORT` | MySQL server under test (suite skips unless both are set) |
| `BIOMCP_DB_IT_USER` / `BIOMCP_DB_IT_PASSWORD` / `BIOMCP_DB_IT_DATABASE` | Credentials (defaults: `root` / empty / `bio`) |
| `BIOMCP_DB_IT_SQLITE_PATH` | SQLite file(s) under test, same comma-list syntax as `DB_SQLITE_PATH` (suite skips unless set) |

See [src/__tests__/README.md](../src/__tests__/README.md#database-tests).
