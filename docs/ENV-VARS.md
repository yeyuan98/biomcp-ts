# Environment Variables

Single source of truth for every environment variable BioMCP reads. BioMCP works with **zero configuration** — everything below is optional except where noted. Set variables in your MCP client's server entry (`env` / `environment` / `[mcp_servers.*.env]` blocks) or in the shell that launches the server; see [AGENT-INSTALL.md](AGENT-INSTALL.md).

## Project config file `.biomcp.json` (alternative to env blocks)

The optional-feature variables in the three feature sections below (and only those — API keys, proxy, cache location, and security boundaries stay env-only) can instead live in a `.biomcp.json` file in the **server's working directory** (the project root for project-scoped clients like Claude Code or OpenCode). The file is loaded once at server startup:

```json
{
  "features": {
    "analysis_biowasm": { "enabled": true, "workers": 2 },
    "database": { "enabled": true, "type": "sqlite", "sqlite_path": ["data/geo.db"] }
  }
}
```

- **Precedence:** environment variables always win; the file fills unset variables only.
- **Tooling:** the always-available `biomcp_configure` MCP tool queries and edits this file (status / set / reset with validation, conflict detection, and dependency prerequisites) — agents can self-serve configuration through it. Env-only parameters are query-only there, and env values are never displayed (presence + fingerprint only).
- **Sensitive/secret file keys:** `analysis_r.mirror_url`, `analysis_r.github_repo`, `analysis_biowasm.mirror_url`, `database.sqlite_path`, `database.host`, `database.user`, `database.database` are classified **sensitive**, and `database.password` **secret** — the first `set` of any of them via `biomcp_configure` is refused by design; re-send the same call with `confirm_sensitive: true`. Secrets are redacted in every tool response.
- **Kill switch:** `BIOMCP_PROJECT_CONFIG=0` disables file loading entirely. A `.biomcp.json` committed in a cloned repository takes effect on startup like any local file — audit a cloned one like any project configuration, or disable file loading with the kill switch.
- Relative paths (`sqlite_path`, plain-path `mirror_url`) resolve against the config file's directory, not the process cwd.
- The file applies to the MCP server entry (`biomcp` / `dist/bundle.js`) only, not the library exports (`biomcp/db`, `biomcp/biowasm`).
- Security boundaries (`ANALYSIS_BIOWASM_DATA_DIR`, `ANALYSIS_BIOWASM_WORKER_PATH`) are deliberately **not** file-settable.

| Variable | Used by | Effect |
|----------|---------|--------|
| `BIOMCP_PROJECT_CONFIG` | config file loader | `0`/`false` disables `.biomcp.json` loading entirely (kill switch) |

## API keys and identifiers

Optional. Without them the affected tools still work using keyless fallbacks or lower rate limits.

| Variable | Used by | Effect |
|----------|---------|--------|
| `NCBI_API_KEY` | PubMed, GEO, SRA, GenBank, PMC OA, NCBI ID conversion, PubTator | Higher NCBI E-utilities rate limits (from 3 to 10 req/s) |
| `NCBI_EMAIL` | PubMed, PubTator | Polite-contact `tool`/`email` parameters on NCBI E-utilities requests |
| `S2_API_KEY` | Semantic Scholar | Higher rate limits on Semantic Scholar article search/citations |
| `OPENFDA_API_KEY` | OpenFDA | Higher rate limits for drug regulatory and adverse event (FAERS) data |
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
| `ANALYSIS_R_MIRROR_URL` | no | Override the wasm package bundle source: a `.tar.gz` archive (path, `file://`, or http(s) URL) is extracted and checksum-verified; an extracted **directory** is trusted as-is (no re-verification) and served directly. Default: latest GitHub release asset, cached in `~/.cache/biomcp/` |
| `ANALYSIS_R_TIMEOUT_MS` | no | Per-analysis timeout, default `600000` (10 min); exceeded analyses are interrupted |
| `ANALYSIS_R_ASSET_TIMEOUT_MS` | no | Download timeout for the ~62 MB wasm package bundle, default `600000` (10 min), range 30000–3600000. Raise it on slow links — or self-fetch the release asset and point `ANALYSIS_R_MIRROR_URL` at the local file (see [R-ANALYSIS.md → What happens on first use](R-ANALYSIS.md#what-happens-on-first-use)) |
| `ANALYSIS_R_MEM_LIMIT_MB` | no | RSS watermark above which new analyses are refused, default `2048` |
| `ANALYSIS_R_GITHUB_REPO` | no | `owner/repo` to fetch release assets from (default: this project's repository) |
| `BIOMCP_CACHE_DIR` | no | Base directory for the mirror cache (default `~/.cache/biomcp`) |

## Biowasm analysis (optional feature)

Activates the `analysis_bam_summary` / `analysis_bam_view_region` / `analysis_bcf_summary` / `analysis_bcf_view_region` / `analysis_bed_op` / `analysis_biowasm_convert` / `analysis_biowasm_session_info` / `analysis_biowasm_cli` tools (samtools/bedtools/bcftools in sandboxed WebAssembly). Full guide: [BIOWASM-ANALYSIS.md](BIOWASM-ANALYSIS.md).

> No npm peer dependency — unlike R analysis there is nothing to install; the wasm assets (~4.5 MB) download at first use into `~/.cache/biomcp/` (checksum-verified).

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANALYSIS_BIOWASM` | yes (`1`/`true`) | Activates the biowasm analysis tools |
| `ANALYSIS_BIOWASM_TIMEOUT_MS` | no | Per-run **inactivity** timeout, default `600000` (10 min): every worker progress message (advancing bytes) resets it, so long full-stream jobs with live progress survive; exceeded runs terminate and respawn the worker. See also the absolute ceiling `ANALYSIS_BIOWASM_MAX_RUN_MS` |
| `ANALYSIS_BIOWASM_MAX_RUN_MS` | no | Absolute per-run ceiling, default `3600000` (1 h) — no progress can extend it (backstop against runaway runs); pairs with the `ANALYSIS_BIOWASM_TIMEOUT_MS` inactivity deadline above |
| `ANALYSIS_BIOWASM_MEM_LIMIT_MB` | no | RSS watermark above which new runs are refused, default `2048` — **whole-process** (covers every worker in the `ANALYSIS_BIOWASM_WORKERS` pool, since worker_threads share the process) |
| `ANALYSIS_BIOWASM_WORKERS` | no | Worker-pool size, default `1` (= strictly serial, the pre-pool behavior). Values ≥ 1; concurrent tool calls then execute in parallel on N single-threaded wasm workers (slots spawn lazily under contention). Not to be confused with the singular `ANALYSIS_BIOWASM_WORKER_PATH` (the worker bundle location). Budget memory before raising: each worker carries its own V8 heap + wasm linear memory (worst case ≈ 2 GB per worker on top of the host process); keep `pool × ~2 GB` comfortably under `ANALYSIS_BIOWASM_MEM_LIMIT_MB` and the machine's RAM |
| `ANALYSIS_BIOWASM_DATA_DIR` | no | Allowlist root for `host_path` sources (unset = host files denied); every path is resolved and prefix-checked after normalization |
| `ANALYSIS_BIOWASM_MIRROR_URL` | no | Override the wasm asset source: a `.tar.gz` archive (path, `file://`, or http(s) URL) is extracted and pin-verified; an extracted **directory** is trusted as-is. Default: the biowasm CDN, cached in `~/.cache/biomcp/` |
| `ANALYSIS_BIOWASM_WORKER_PATH` | no | Explicit path to the biowasm worker bundle (`dist/biowasm-worker.js`); dev mode running from `src/` needs this or a prior `npm run build` |

## Proxy

Honored by every upstream request via proxy-aware global fetch (undici).

| Variable | Purpose |
|----------|---------|
| `HTTPS_PROXY` / `https_proxy` | Proxy for HTTPS requests |
| `HTTP_PROXY` / `http_proxy` | Proxy for HTTP requests |
| `NO_PROXY` / `no_proxy` | Comma-separated hosts to bypass the proxy |

## Test-only

Never read by the shipped server — used only by the optional integration / perf suites:

| Variable | Purpose |
|----------|---------|
| `BIOMCP_DB_IT_HOST` / `BIOMCP_DB_IT_PORT` | MySQL server under test (suite skips unless both are set) |
| `BIOMCP_DB_IT_USER` / `BIOMCP_DB_IT_PASSWORD` / `BIOMCP_DB_IT_DATABASE` | Credentials (defaults: `root` / empty / `bio`) |
| `BIOMCP_DB_IT_SQLITE_PATH` | SQLite file(s) under test, same comma-list syntax as `DB_SQLITE_PATH` (suite skips unless set) |

See [src/__tests__/README.md](../src/__tests__/README.md#database-tests).
