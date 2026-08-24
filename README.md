# BioMCP

A high-performance MCP server that gives LLMs access to 27 biomedical tools federated across 50+ upstream APIs — genes, variants, drugs, diseases, literature, clinical trials, and structural biology in a single integration.

Adapted from the [BioMCP Rust](https://github.com/genomoncology/biomcp) with agent-first development approach and enhancements. Kudos to the original authors.

## Highlights

- **27 tools** across 9 domains — search, retrieve, and cross-reference biomedical entities
- **50+ upstream sources** — MyGene, MyVariant, MyChem, MyDisease, ClinVar, gnomAD, UniProt, Reactome, OpenTargets, CIViC, OncoKB, DisGeNET, GTEx, STRING, DGIdb, ClinicalTrials.gov, PubMed, EuropePMC, Semantic Scholar, PubTator, LitSense, Monarch Initiative, OpenFDA, NIH Reporter, and more
- **Section-based fetching** — `entityGet(id, sections)` fans out to multiple sources with per-section timeouts and graceful degradation (failed sections return `{ _error }` instead of crashing)
- **Federated article search** — queries 5 literature backends simultaneously with PMID/PMCID/DOI deduplication
- **Patent access** — worldwide patent search and detail via keyed EPO OPS / USPTO ODP; keyless USPTO Public Search and Google Patents (+Wayback archive) fallbacks
- **Zero-config startup** — works out of the box; optional API keys unlock higher rate limits and premium data
- **629 unit tests** (mocked) + **97 integration tests** (live APIs via in-process MCP client, 5 keyed skips)

## Quick Start

### Install and build

```bash
git clone <repo-url> && cd biomcp-ts
make install build
```

### Configure with Claude Desktop

Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "biomcp": {
      "command": "npx",
      "args": ["biomcp"]
    }
  }
}
```

Or from a local checkout:

```json
{
  "mcpServers": {
    "biomcp": {
      "command": "node",
      "args": ["/path/to/biomcp-ts/dist/bundle.js"]
    }
  }
}
```

### Direct stdio

```bash
npm start
```

### Any MCP-compatible client

BioMCP speaks standard MCP over **stdio**. Point any MCP client at the `biomcp` binary or `node dist/bundle.js`.

## Available Tools

Full tool schemas (params, enums, defaults) live in [src/server/README.md](src/server/README.md).

### Gene (7)

| Tool | Description |
|------|-------------|
| `gene_search` | Search genes by symbol, name, or keyword with chromosome filter |
| `gene_get` | Get detailed gene info by HGNC symbol with optional sections (core, pathways, protein, ontology, go, interactions, expression, protein_atlas, constraint, druggability, dosage_sensitivity, clinical_evidence, disease_associations, diseases, funding). Set `smart=true` to auto-resolve gene aliases (e.g., "HER2" → "ERBB2") |
| `gene_diseases` | Get diseases associated with a gene (DisGeNET / OpenTargets) |
| `gene_drugs` | Find drugs targeting a gene (OpenTargets) |
| `gene_trials` | Find clinical trials for a gene |
| `gene_articles` | Find articles about a gene |
| `gene_enrich` | Pathway enrichment analysis for a gene list (Reactome) |

### Variant (4)

| Tool | Description |
|------|-------------|
| `variant_search` | Search variants by rsid, HGVS, gene, ClinVar significance, frequency, CADD |
| `variant_get` | Get detailed variant info with optional sections (frequency, predictions, clinical; `alphagenome_scores` currently returns an unavailability error pending reimplementation) |
| `variant_oncokb` | Get OncoKB cancer variant annotations (requires `ONCOKB_TOKEN`) |
| `variant_trials` | Find clinical trials for a variant |

### Drug (3)

| Tool | Description |
|------|-------------|
| `drug_search` | Search drugs by name, mechanism, or keyword |
| `drug_get` | Get detailed drug info with optional sections (us_regulatory, eu_regulatory, who_regulatory, safety, targets, indications) |
| `drug_trials` | Find clinical trials for a drug |

### Disease (4)

| Tool | Description |
|------|-------------|
| `disease_search` | Search diseases by name, phenotype, or keyword |
| `disease_get` | Get detailed disease info by ID (DOID, MONDO, OMIM, etc.) with optional sections (gene_associations, phenotypes, pathways) |
| `disease_drugs` | Get drugs for a disease (OpenTargets) |
| `disease_trials` | Get clinical trials for a disease (ClinicalTrials.gov) |

### Article (2)

| Tool | Description |
|------|-------------|
| `article_search` | Federated literature search across PubMed, EuropePMC, Semantic Scholar, PubTator, and LitSense with optional date range filtering |
| `article_get` | Get detailed article info by identifier (PMID, PMCID, or DOI) with optional sections: `oa` (open access / license info), `annotations`, `graph` (citation graph), `citation` (fast/full citation data) |

### Trial (2)

| Tool | Description |
|------|-------------|
| `trial_search` | Search clinical trials by condition, intervention, status, or phase. Cursor-based pagination via `page_token` |
| `trial_get` | Get detailed trial info by NCT ID with optional sections (eligibility, locations, outcomes) |

### Utility (2)

| Tool | Description |
|------|-------------|
| `discover` | Free-text concept resolution across all entity types |
| `batch_get` | Retrieve multiple entities in parallel |

### Structural Biology (1)

| Tool | Description |
|------|-------------|
| `pdb` | Search PDB structures, get entry metadata with optional sections (polymer entities, ligands, assembly, experiment, citation), and download structure files (mmCIF/PDB) |

### Patents (2)

| Tool | Description |
|------|-------------|
| `patent_search` | Search patents worldwide (US, EP, WO, JP, 100+ authorities) with assignee/inventor/CPC/status/date filters and relevance ranking (`sort_by`). Quote exact multi-word concepts (e.g. "mRNA display"). Foundational prior art is auto-discovered via co-citation mining (`seminal_prior_art`; disable with `seminal: false`). Default backends: USPTO Public Search full-text (US, keyless, relevance-ranked) + EPO OPS (worldwide, keyed); uspto_odp (US bibliographic metadata) and google_patents (best-effort) available via `source` |
| `patent_get` | Get patent details by publication number with sections: abstract, claims (US fulltext via USPTO Public Search; EP/WO via EPO OPS), citations (forward + backward), family, classifications |

### Citation Module

Citations federate 5 providers in fast (~4s) or full (~15-30s) mode. Forward citation lists come from Europe PMC, OpenCitations, and Semantic Scholar; Crossref supplies counts and backward references. Provider matrix and schema details: [src/server/README.md](src/server/README.md).

### Database (3) — optional variant

Read-only SQL access to your own databases, enabled only when `DB_TYPE` is set (see [Database Access](#database-access)).

| Tool | Description |
|------|-------------|
| `db_query` | Execute a read-only SELECT query with named parameters (`:name`). Allows SELECT/SHOW/DESCRIBE/EXPLAIN/WITH only; blocks writes, multiple statements, and `INTO OUTFILE/DUMPFILE`. Backends: MySQL (`mysql2`) and local-file SQLite (built-in `node:sqlite`, opened read-only) |
| `db_list_tables` | List tables/views with engine, row count (approximate for MySQL, exact for SQLite tables), and comments |
| `db_describe_table` | Get column schema: name, type, nullability, key type, default value |

## Database Access

The database tools ship inside the standard package but stay **dormant until configured** — without a `DB_TYPE` environment variable the tool list is unchanged.

**Backends**

- **MySQL** — requires the optional driver: `npm install mysql2` (an optional peer dependency; the server prints an actionable install hint if it is missing)
- **SQLite (local file)** — no extra dependency; uses the Node.js built-in `node:sqlite` module (Node >= 22.13). The file is opened strictly read-only

**Configuration (environment variables)**

| Variable | Required | Purpose |
|----------|----------|---------|
| `DB_TYPE` | yes (`mysql` or `sqlite`) | Selects the backend and activates the db tools |
| `DB_HOST` / `DB_PORT` | MySQL | Defaults: `localhost` / `3306` |
| `DB_USER` (or `DB_USERNAME`) / `DB_PASSWORD` | MySQL | Credentials |
| `DB_DATABASE` | MySQL | Database name |
| `DB_SQLITE_PATH` | SQLite | Path to an existing `.db`/`.sqlite` file (opened read-only) |
| `DB_CONNECTION_TIMEOUT_MS` | no | Connect timeout, default `10000` |

**Example (Claude Desktop)**

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

Programmatic use is available via the `biomcp/db` subpath export (`registerDbTools(server)`, backend classes, and the read-only query validator).

## Development

```bash
make              # Show available targets
make install      # Install dependencies
make build        # Compile and bundle into dist/bundle.js
make typecheck    # Type-check without emitting
make test         # Run unit tests (fast, mocked)
make test-integration  # Run integration tests (live APIs, ~60s)
make test-all     # Run all tests
make clean        # Remove build artifacts
```

After `make build`, `npx .` runs the bundled MCP server locally — the recommended workflow for development testing.

## Environment Variables

BioMCP works without any configuration. Optional keys unlock higher rate limits and extra sources; two are required for specific features (noted below). Proxy variables apply to every tool via proxy-aware global fetch.

| Variable | Required | Purpose |
|----------|----------|---------|
| `NCBI_API_KEY` | no | Higher PubMed / NCBI E-utilities rate limits |
| `NCBI_EMAIL` | no | Polite-contact `tool`/`email` params on NCBI E-utilities requests |
| `S2_API_KEY` | no | Semantic Scholar rate limits |
| `OPENFDA_API_KEY` | no | OpenFDA rate limits |
| `ONCOKB_TOKEN` | for `variant_oncokb` | OncoKB cancer variant annotations |
| `DISGENET_API_KEY` | for DisGeNET associations | DisGeNET disease-gene associations |
| `CROSSREF_EMAIL` | no | Crossref polite pool |
| `EPO_OPS_CONSUMER_KEY` / `EPO_OPS_CONSUMER_SECRET` | no | EPO OPS worldwide patent search + detail |
| `USPTO_API_KEY` | no | USPTO Open Data Portal application search |
| `DB_TYPE` + [database variables](#database-access) | for `db_*` tools | MySQL or local-file SQLite read-only access |
| `HTTPS_PROXY` / `HTTP_PROXY` (+ lowercase) | no | Route all upstream requests through a proxy |
| `NO_PROXY` | no | Comma-separated proxy exclusions (honored by undici) |

## License

[MIT](LICENSE)
