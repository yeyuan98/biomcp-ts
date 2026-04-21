# BioMCP Original Implementation Analysis

> Analyzed from the genomoncology/biomcp Rust codebase (v0.8.22, edition 2024)
> Repository: https://github.com/genomoncology/biomcp
> Commit reference: agent/coder/25223b56 branch

## 1. Project Overview

BioMCP is a biomedical CLI tool and MCP (Model Context Protocol) server written in Rust. It provides read-only biomedical search, detail retrieval, cross-entity pivots, enrichment, and study analytics across 50+ upstream data sources.

**Package**: `biomcp-cli` v0.8.22 | **License**: MIT | **Homepage**: https://biomcp.org

### Key Capabilities

| Domain | Entities |
|--------|----------|
| Genomics | Gene, Variant, Protein |
| Pharmacology | Drug, Adverse Event, PGx |
| Clinical | Trial, Diagnostic |
| Literature | Article |
| Disease Biology | Disease, Pathway |
| Population Genetics | GWAS, Phenotype |
| Study Analytics | Study (cBioPortal) |

## 2. Architecture

### 2.1 Dual-Mode Binary

Two entry points sharing the same command engine:

| Binary | Entry Point | Purpose |
|--------|-------------|---------|
| `biomcp` | `src/main.rs` | MCP server + CLI |
| `biomcp-cli` | `src/main_biomcp_cli.rs` | CLI-only alias (includes main.rs) |

Dispatch logic:
- `Commands::Mcp` / `Commands::Serve` -> `mcp::run_stdio()` (stdin/stdout JSON-RPC)
- `Commands::ServeHttp(args)` -> `mcp::run_http(host, port)` (Axum at `/mcp`)
- All other commands -> `cli::run_outcome(cli)` (CLI mode)

### 2.2 Module Organization (`src/`)

```
src/
  main.rs, main_biomcp_cli.rs  # Binary entry points
  lib.rs                        # Public API: cli, error, gene, mcp
  error.rs                      # BioMcpError (thiserror)
  gene.rs                       # Gene entity re-exports

  cli/                          # Command parsing & dispatch
    mod.rs, commands.rs         # clap Commands enum, routing
    outcome.rs                  # run(), execute_mcp(), run_outcome()
    shared.rs                   # build_cli(), pagination, search JSON
    discover.rs                 # Free-text concept resolution
    search_all.rs               # Federated cross-entity search
    gene/, drug/, disease/, ... # Per-entity CLI subcommand modules
    study/                      # cBioPortal analytics subcommands
    system/                     # health, cache, sync, version
    skill.rs                    # Embedded skill/guide system
    update.rs                   # Self-update mechanism

  mcp/                          # MCP server
    mod.rs                      # BioMcpServer (rmcp framework)
    shell.rs                    # Tool registration, command allowlist

  sources/                      # 54 API client modules (see Section 4)
    mod.rs                      # shared_client(), streaming_client(), rate_limit
    rate_limit.rs               # Per-source rate limit config

  entities/                     # Entity-level workflows (multi-source orchestration)
    mod.rs                      # SearchPage<T> generic
    gene.rs                     # Gene entity (15 optional sections)
    variant/                    # Variant entity (MyVariant + enrichment)
    drug/                       # Drug entity (regional: US/EU/WHO)
    disease/                    # Disease entity (associations, survival)
    article/                    # Article entity (federated search, ranking)
    trial/                      # Trial entity (CTGov + NCI CTS)
    pathway.rs                  # Pathway entity (Reactome/KEGG/WikiPathways)
    protein.rs                  # Protein entity (UniProt + enrichment)
    pgx.rs                      # PGx entity (CPIC + PharmGKB)
    adverse_event.rs            # Adverse event entity
    study.rs                    # Study entity (local cBioPortal)
    discover.rs                 # Discover entity (OLS4 free-text resolution)
    diagnostic/                 # Diagnostic entity (local GTR/WHO IVD)

  transform/                    # API response -> domain model adapters
    gene.rs, variant.rs, drug.rs, disease.rs, article.rs,
    pathway.rs, protein.rs, adverse_event.rs, trial.rs

  render/                       # Output formatters
    mod.rs                      # Render trait
    markdown/                   # Per-entity markdown templates (minijinja)
    json.rs                     # JSON output with _meta.next_commands
    provenance.rs               # Data source provenance tracking
    chart.rs                    # SVG chart generation (kuva)

  cache/                        # HTTP response cache
    manager.rs                  # SizeAwareCacheManager (cacache-backed)
    config.rs                   # ENV > TOML > defaults
    planner.rs, clean.rs        # Eviction strategies
    limits.rs, migration.rs     # Size limits, format migration

  generated/                    # Protobuf/gRPC generated code
    google.gdm.gdmscience.alphagenome.v1main.rs  # AlphaGenome gRPC

  utils/                        # Date parsing, downloads, query escaping
```

### 2.3 Data Flow

```
CLI/MCP command
  -> clap parse
  -> outcome.rs dispatch
  -> entity handler (multi-source orchestration)
    -> source client (HTTP/gRPC)
    -> transform adapter (API shape -> domain model)
    -> entity model (unified domain types)
  -> render (markdown/JSON)
```

### 2.4 Three-Layer Pipeline

| Layer | Responsibility | Example |
|-------|---------------|---------|
| `sources/` | HTTP clients, auth, retry, rate limiting | `MyGeneClient`, `PubmedClient` |
| `transform/` | API response -> domain entity mapping | `from_mygene_get()`, `from_clinicaltrials_hit()` |
| `entities/` | Multi-source orchestration, section assembly | `gene::get()` assembles 15 sections from 12 sources |

## 3. MCP Server

### 3.1 Tool Registration

Uses `rmcp` crate with proc macros. Registers **one tool** named `"biomcp"`:

```rust
#[tool(annotations(title = "BioMCP", read_only_hint = true))]
async fn biomcp(&self, Parameters(ShellCommand { command }): ...) -> Result<CallToolResult, McpError>
```

The tool accepts a single `command` string, parses it with `shlex::split`, and dispatches to the CLI engine.

### 3.2 Command Allowlist (Read-Only Enforcement)

| Allowed (full) | Allowed (partial) | Blocked |
|----------------|-------------------|---------|
| search, get, variant, drug, disease, article, gene, pathway, protein, list, version, health, batch, enrich, discover | study (list/top-mutated/query/filter/cohort/survival/compare/co-occurrence; download only with --list), skill (all except install) | cache, update, ema sync, who sync, who-ivd sync, mutating commands |

### 3.3 MCP Resources

- `biomcp://help` - Overview (via skill::show_overview())
- `biomcp://skill/<slug>` - Individual skill/guide pages

### 3.4 Transport

| Transport | Endpoint | Description |
|-----------|----------|-------------|
| stdio | stdin/stdout | JSON-RPC, Ctrl+C graceful shutdown, 5s handshake timeout |
| Streamable HTTP | `/mcp` | Axum router, health at `/health`, `/readyz` |

## 4. Data Sources (54 Modules)

### 4.1 Source Infrastructure (`src/sources/mod.rs`)

**Shared HTTP client** (`shared_client()`):
- reqwest + retry (3x exponential backoff)
- Disk cache (http-cache-reqwest/cacache, max-stale=86400s)
- Per-source rate limiting (mutex-based)
- 8MB max body size
- JSON content-type validation

**Specialized clients**:
- `streaming_http_client()` - Raw reqwest, no middleware (UniProt, Enrichr)
- `semantic_scholar_shared_pool_client()` - S2-specific 429 handling

**Environment overrides**: Every source supports `BIOMCP_<SOURCE>_BASE` env var to override base URL.

**Cache modes**: `BIOMCP_CACHE_MODE`: "infinite" (ForceCache), "off" (NoStore), default (conditional)

### 4.2 Source Catalog

#### Genomics

| # | Source | File | Base URL | Auth | Protocol | Rate Limit |
|---|--------|------|----------|------|----------|------------|
| 1 | MyGene.info | `mygene.rs` | `https://mygene.info/v3` | None | REST GET/POST | Default (100ms) |
| 2 | MyVariant.info | `myvariant.rs` | `https://myvariant.info/v1` | None | REST GET | Default (100ms) |
| 3 | ClinVar (via MyVariant) | `myvariant.rs` | (aggregated in MyVariant fields) | None | - | - |
| 4 | gnomAD | `gnomad.rs` | `https://gnomad.broadinstitute.org/api` | None | GraphQL POST | Default (100ms) |
| 5 | ClinGen | `clingen.rs` | `https://search.clinicalgenome.org` | None | REST GET | Default (100ms) |
| 6 | CIViC | `civic.rs` | `https://civicdb.org/api` | None | GraphQL POST | 334ms |
| 7 | DGIdb | `dgidb.rs` | `https://dgidb.org/api` | None | GraphQL POST | Default (100ms) |
| 8 | DisGeNET | `disgenet.rs` | `https://api.disgenet.com` | `DISGENET_API_KEY` (Authorization header) | REST GET | Default (100ms) |
| 9 | GTEx | `gtex.rs` | `https://gtexportal.org` | None | REST GET | Default (100ms) |
| 10 | HPA | `hpa.rs` | `https://www.proteinatlas.org` | None | REST GET (XML) | Default (100ms) |
| 11 | GWAS Catalog | `gwas.rs` | `https://www.ebi.ac.uk/gwas/rest/api` | None | REST GET (Spring) | Default (100ms) |
| 12 | STRING | `string.rs` | `https://string-db.org/api` | None | REST GET (JSON) | Default (100ms) |
| 13 | AlphaGenome | `alphagenome.rs` | `gdmscience.googleapis.com:443` | `ALPHAGENOME_API_KEY` (gRPC metadata) | gRPC (streaming) | N/A |
| 14 | Open Targets | `opentargets.rs` | `https://api.platform.opentargets.org/api/v4` | None | GraphQL POST | 500ms |
| 15 | OncoKB | `oncokb.rs` | `https://www.oncokb.org/api/v1` | `ONCOKB_TOKEN` (Bearer) | REST GET | Default (100ms) |

#### Proteins & Pathways

| # | Source | File | Base URL | Auth | Protocol | Rate Limit |
|---|--------|------|----------|------|----------|------------|
| 16 | UniProt | `uniprot.rs` | `https://rest.uniprot.org` | None | REST GET (streaming) | Default (100ms) |
| 17 | InterPro | `interpro.rs` | `https://www.ebi.ac.uk/interpro/api` | None | REST GET | Default (100ms) |
| 18 | ComplexPortal | `complexportal.rs` | `https://www.ebi.ac.uk/intact/complex-ws` | None | REST GET | Default (100ms) |
| 19 | Reactome | `reactome.rs` | `https://reactome.org/ContentService` | None | REST GET | Default (100ms) |
| 20 | KEGG | `kegg.rs` | `https://rest.kegg.jp` | None | REST GET (plain text) | 334ms |
| 21 | WikiPathways | `wikipathways.rs` | `https://www.wikipathways.org/json` | None | REST GET | Default (100ms) |

#### Drugs & Pharmacology

| # | Source | File | Base URL | Auth | Protocol | Rate Limit |
|---|--------|------|----------|------|----------|------------|
| 22 | MyChem.info | `mychem.rs` | `https://mychem.info/v1` | None | REST GET | Default (100ms) |
| 23 | ChEMBL | `chembl.rs` | `https://www.ebi.ac.uk/chembl/api/data` | None | REST GET | Default (100ms) |
| 24 | EMA | `ema.rs` | `https://www.ema.europa.eu/en/documents/report` | None | Local-file (JSON batch, stale 72h) | N/A |
| 25 | OpenFDA FAERS | `openfda.rs` | `https://api.fda.gov` | `OPENFDA_API_KEY` (optional) | REST GET | Default (100ms) |
| 26 | CPIC | `cpic.rs` | `https://api.cpicpgx.org/v1` | None | REST GET (PostgREST) | 250ms |
| 27 | PharmGKB | `pharmgkb.rs` | `https://api.pharmgkb.org/v1` | None | REST GET | 500ms |
| 28 | WHO Prequalification | `who_pq.rs` | `https://extranet.who.int/prequal/medicines/prequalified/` | None | Local-file (CSV, stale 72h) | N/A |

#### Diseases

| # | Source | File | Base URL | Auth | Protocol | Rate Limit |
|---|--------|------|----------|------|----------|------------|
| 29 | MyDisease.info | `mydisease.rs` | `https://mydisease.info/v1` | None | REST GET | Default (100ms) |
| 30 | Monarch Initiative | `monarch.rs` | `https://api-v3.monarchinitiative.org` | None | REST GET | Default (100ms) |
| 31 | SEER | `seer.rs` | `https://seer.cancer.gov/statistics-network/explorer/source/content_writers` | None | REST GET | Default (100ms) |
| 32 | MedlinePlus | `medlineplus.rs` | `https://wsearch.nlm.nih.gov` | None | REST GET (XML) | Default (100ms) |
| 33 | HPO | `hpo.rs` | `https://ontology.jax.org/api/hp` | None | REST GET | Default (100ms) |

#### Literature

| # | Source | File | Base URL | Auth | Protocol | Rate Limit |
|---|--------|------|----------|------|----------|------------|
| 34 | PubMed | `pubmed.rs` | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` | `NCBI_API_KEY` (optional, 3-10 req/s) | REST GET | 100ms (key) / 334ms |
| 35 | PubTator3 | `pubtator.rs` | `https://www.ncbi.nlm.nih.gov/research/pubtator3-api` | `NCBI_API_KEY` (optional) | REST GET | 100ms (key) / 334ms |
| 36 | Europe PMC | `europepmc.rs` | `https://www.ebi.ac.uk/europepmc/webservices/rest` | None | REST GET | Default (100ms) |
| 37 | Semantic Scholar | `semantic_scholar.rs` | `https://api.semanticscholar.org` | `S2_API_KEY` (optional) | REST GET | 1000ms (key) / 2000ms |
| 38 | LitSense2 | `litsense2.rs` | `https://www.ncbi.nlm.nih.gov/research/litsense2-api/api` | None | REST GET | 1000ms |
| 39 | NCBI E-utilities efetch | `ncbi_efetch.rs` | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` | `NCBI_API_KEY` (optional) | REST GET | Default (100ms) |
| 40 | NCBI ID Converter | `ncbi_idconv.rs` | `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles` | `NCBI_API_KEY` (optional) | REST GET | 334ms |
| 41 | PMC Open Access | `pmc_oa.rs` | `https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi` | `NCBI_API_KEY` (optional) | REST GET | 334ms |

#### Clinical Trials

| # | Source | File | Base URL | Auth | Protocol | Rate Limit |
|---|--------|------|----------|------|----------|------------|
| 42 | ClinicalTrials.gov | `clinicaltrials.rs` | `https://clinicaltrials.gov/api/v2` | None | REST GET | Default (100ms) |
| 43 | NCI CTS | `nci_cts.rs` | `https://clinicaltrialsapi.cancer.gov/api/v2` | `NCI_API_KEY` (X-API-KEY header) | REST GET | Default (100ms) |

#### Diagnostics & Registries

| # | Source | File | Base URL | Auth | Protocol | Rate Limit |
|---|--------|------|----------|------|----------|------------|
| 44 | NCBI GTR | `gtr.rs` | `https://ftp.ncbi.nlm.nih.gov/pub/GTR/data/` | None | Local-file (TSV, stale 7d) | N/A |
| 45 | WHO IVD | `who_ivd.rs` | `https://extranet.who.int/prequal/vitro-diagnostics/prequalified/in-vitro-diagnostics/export` | None | Local-file (CSV, stale 72h) | N/A |
| 46 | CDC CVX/MVX | `cvx.rs` | `https://www2.cdc.gov/vaccines/iis/iisstandards/downloads/` | None | Local-file (CSV, stale 30d) | N/A |
| 47 | VAERS | `vaers.rs` | `https://wonder.cdc.gov` | None | REST GET | Default (100ms) |

#### Enrichment & Analysis

| # | Source | File | Base URL | Auth | Protocol | Rate Limit |
|---|--------|------|----------|------|----------|------------|
| 48 | Enrichr | `enrichr.rs` | `https://maayanlab.cloud/Enrichr` | None | POST multipart + GET | Default (100ms) |
| 49 | g:Profiler | `gprofiler.rs` | `https://biit.cs.ut.ee/gprofiler/api` | None | REST POST (own client, 15s timeout) | N/A |
| 50 | OLS4 | `ols4.rs` | `https://www.ebi.ac.uk/ols4` | None | REST GET | Default (100ms) |
| 51 | QuickGO | `quickgo.rs` | `https://www.ebi.ac.uk/QuickGO/services` | None | REST GET | Default (100ms) |

#### Funding & Research

| # | Source | File | Base URL | Auth | Protocol | Rate Limit |
|---|--------|------|----------|------|----------|------------|
| 52 | NIH Reporter | `nih_reporter.rs` | `https://api.reporter.nih.gov/v2` | None | REST GET | 1000ms |

#### cBioPortal (Study Analytics)

| # | Source | File | Base URL | Auth | Protocol | Rate Limit |
|---|--------|------|----------|------|----------|------------|
| 53 | cBioPortal API | `cbioportal.rs` | `https://www.cbioportal.org/api` | None | REST GET/POST | Default (100ms) |
| 54 | cBioPortal DataHub | `cbioportal_download.rs` | `https://datahub.assets.cbioportal.org` | None | REST GET (own client) | N/A |
| - | cBioPortal Study | `cbioportal_study.rs` | (local file reader) | None | Local TSV | N/A |

#### Terminology

| # | Source | File | Base URL | Auth | Protocol | Rate Limit |
|---|--------|------|----------|------|----------|------------|
| 55 | UMLS | `umls.rs` | `https://uts-ws.nlm.nih.gov` | `UMLS_API_KEY` (apiKey query param) | REST GET | Default (100ms) |

### 4.3 Verified API Endpoints

#### MyGene.info (`mygene.rs`)
```
GET /query?q=<query>&species=human&fields=...&size=...&from=...&chr=...
GET /query?q=symbol:"<SYMBOL>"&species=human&fields=...&size=1
POST /gene  (form: ids=1,2,3&fields=symbol&species=human)  [batch, max 200]
```

#### MyVariant.info (`myvariant.rs`)
```
GET /query?q=<query>&fields=...&size=...&from=...
GET /variant/<id>?fields=...  (hgvs/rsid/chr:pos)
```
18 search params: gene, hgvsp, hgvsc, rsid, protein_alias, significance, max_frequency, min_cadd, consequence, review_status, population, revel_min, gerp_min, tumor_site, condition, impact, lof, has, missing, therapy

#### ClinicalTrials.gov v2 (`clinicaltrials.rs`)
```
GET /studies?query.cond=...&query.intr=...&query.locn=...&filter.overallStatus=...&countTotal=true&pageToken=...&pageSize=...&fields=...
GET /studies/<nct_id>?fields=...
```

#### NCI CTS (`nci_cts.rs`)
```
GET /trials?...
GET /trials/<nct_id>
Header: X-API-KEY: <NCI_API_KEY>
```

#### MyChem.info (`mychem.rs`)
```
GET /query?q=<query>&fields=...&size=...&from=...
```
Aggregates: DrugBank, ChEMBL, DrugCentral, GtoPDB, NDC, UNII, ChEBI, OpenFDA

#### MyDisease.info (`mydisease.rs`)
```
GET /query?q=<query>&fields=...&size=...&from=...
GET /disease/<id>?fields=...
```
Scoped filters: --source (mondo/doid/mesh), --inheritance, --phenotype, --onset

#### DisGeNET (`disgenet.rs`)
```
GET /api/v1/gda/summary?gene_ncbi_id=...&page_number=0
GET /api/v1/gda/summary?disease=UMLS_<cui>&page_number=0
GET /api/v1/entity/disease?disease_free_text_search_string=...
Header: Authorization: <DISGENET_API_KEY>
```

#### OncoKB (`oncokb.rs`)
```
GET /annotate/mutations/byProteinChange
Header: Authorization: Bearer <ONCOKB_TOKEN>
```

#### Open Targets (`opentargets.rs`)
```
POST /graphql  (drug sections, disease sections, gene sections)
```

#### CIViC (`civic.rs`)
```
POST /graphql  (CivicContextQuery)
```

#### DGIdb (`dgidb.rs`)
```
POST /graphql  (GeneDruggability query)
```

#### gnomAD (`gnomad.rs`)
```
POST /  (GraphQL: GeneConstraint query, $symbol, GRCh38)
```

#### UniProt (`uniprot.rs`)
```
GET /uniprotkb/stream?query=...&format=json&fields=...&size=...  (streaming client)
GET /uniprotkb/<accession>.json?fields=...
```

#### Europe PMC (`europepmc.rs`)
```
GET /search?query=...&format=json&page=...&pageSize=...&sort=...
GET /<id>/fullTextXML  (NoStore)
```

#### PubMed E-utilities (`pubmed.rs`)
```
GET /esearch?db=pubmed&term=...&retmax=...&retstart=...&sort=relevance&datetype=pdat&mindate=...&maxdate=...&api_key=...
```

#### PubTator3 (`pubtator.rs`)
```
GET /annotations/annotate/
GET /annotations/search?keywords=<query>&document_type=...&total=...&page=...
```

#### Semantic Scholar (`semantic_scholar.rs`)
```
GET /graph/v1/paper/search?query=...&limit=...&offset=...&fields=...
GET /graph/v1/paper/<paper_id>?fields=...
GET /graph/v1/paper/batch?fields=...
Header: x-api-key: <S2_API_KEY> (optional)
```

#### LitSense2 (`litsense2.rs`)
```
GET /sentences/?query=<query>&rerank=true  (max 4096 char)
GET /passages/?query=<query>&rerank=true
```

#### Reactome (`reactome.rs`)
```
GET /search/query?query=...&species=Homo%20sapiens&limit=...&offset=...
GET /data/pathways/top/Homo%20sapiens
GET /data/query/<st_id>
GET /data/participants/<st_id>
GET /data/pathway/<st_id>/containedEvents
```

#### KEGG (`kegg.rs`)
```
GET /find/pathway/<query>  (plain text TSV, filters to hsa* human only)
GET /get/<pathway_id>  (flat text: ENTRY/NAME/DESCRIPTION/GENE fields)
```

#### WikiPathways (`wikipathways.rs`)
```
GET /findPathwaysByText?query=...&format=json&limit=...
GET /getPathway?pathwayId=...&format=json
```

#### ChEMBL (`chembl.rs`)
```
GET /mechanism.json?molecule_chembl_id=<id>&limit=<n>
GET /target/<target_chembl_id>.json
```

#### OpenFDA FAERS (`openfda.rs`)
```
GET /drug/event.json?search=<query>&limit=...&skip=...
GET /drug/event.json?search=<query>&count=patient.drug.medicinalproduct
```

#### ClinGen (`clingen.rs`)
```
GET /api/genes/look/<gene_symbol>
GET /kb/gene-validity/download  (CSV)
GET /kb/gene-dosage/download  (CSV)
```

#### CPIC (`cpic.rs`) - PostgREST
```
GET /pair_view?genesymbol=eq.<GENE>&select=*&limit=...&offset=...&order=...
GET /pair_view?drugname=ilike.*<drug>*&...
GET /recommendation_view?lookupkey->><GENE>=not.is.null&...
GET /recommendation_view?drugname=ilike.*<drug>*&...
GET /population_frequency_view?genesymbol=eq.<GENE>&...
GET /guideline_summary_view?genes=cs.[...]&...
```

#### PharmGKB (`pharmgkb.rs`)
```
GET /data/download?view=...&...
```

#### GWAS Catalog (`gwas.rs`)
```
GET /singleNucleotidePolymorphisms/<rsid>/associations?projection=associationByStudy&page=0&size=<n>
GET /singleNucleotidePolymorphisms/search/findByGene?geneName=<GENE>&page=0&size=<n>
GET /singleNucleotidePolymorphisms/search/findByDiseaseTrait?diseaseTrait=<query>&page=0&size=<n>
GET /studies/search/findByDiseaseTrait?diseaseTrait=<query>&page=0&size=<n>
GET /associations/search/findByStudyAccessionId?studyAccessionId=<GCST>&...
```

#### GTEx (`gtex.rs`)
```
GET /api/v2/reference/geneSearch?geneId=<ensembl>&gencodeVersion=v26
GET /api/v2/expression/medianGeneExpression?gencodeId=...&datasetId=gtex_v8
```

#### HPA (`hpa.rs`)
```
GET /<ensembl_id>.xml  (requires ENSG* ID)
```

#### Monarch Initiative (`monarch.rs`)
```
GET /v3/api/association?object=<disease_id>&subject_category=biolink:Gene&limit=<n>
GET /v3/api/association?subject=<disease_id>&object_category=biolink:PhenotypicFeature&limit=<n>
GET /v3/api/association?object=<disease_id>&subject_category=biolink:Genotype&limit=<n>
GET /v3/api/semsim/search/<hpo_terms>/Human%20Diseases?limit=<n>
```

#### SEER (`seer.rs`)
```
GET /get_var_formats.php
GET /render_region_5.php?site=<code>&data_type=4&graph_type=1&compareBy=sex&relative_survival_interval=5
```

#### Enrichr (`enrichr.rs`)
```
POST /addList  (multipart: list, description)
GET /enrich?userListId=<id>&backgroundType=<library>
```

#### g:Profiler (`gprofiler.rs`)
```
POST /gost/profile/  (own client, 15s timeout)
Body: {"organism":"hsapiens","query":["GENE1",...]}  (max 50 genes)
```

#### NIH Reporter (`nih_reporter.rs`)
```
GET /projects?query.term=...
GET /projects/<project_id>
```

#### HPO (`hpo.rs`)
```
GET /terms/<hpo_id>
GET /search?q=<query>
```

#### OLS4 (`ols4.rs`)
```
GET /api/terms?iri=<ontology_iri>&size=...
GET /api/search?q=<query>&ontology=...&size=...
```

#### QuickGO (`quickgo.rs`)
```
GET /ontology/go/terms/<go_id>
GET /annotation/search?geneProductId=<gene>&taxonId=9606&pageSize=...
```

#### InterPro (`interpro.rs`)
```
GET /entry/interpro/protein/uniprot/<accession>/?page_size=<n>
```

#### ComplexPortal (`complexportal.rs`)
```
GET /search/<accession>?number=25&filters=species_f:("Homo sapiens")
```

#### STRING (`string.rs`)
```
GET /json/network?identifiers=<gene>&species=9606&required_score=...
GET /json/interaction_partners?identifiers=<gene>&species=9606&limit=...
```

#### UMLS (`umls.rs`)
```
GET /rest/search/current?string=<query>&pageSize=...&sabs=...&searchType=exact&apiKey=...
GET /rest/content/current/CUI/<cui>/atoms?apiKey=...
```

#### MedlinePlus (`medlineplus.rs`)
```
GET /ws/query?db=healthTopics&term=<query>&retmax=<n>  (XML response)
```

#### NCBI ID Converter (`ncbi_idconv.rs`)
```
GET /?ids=<pmid>&format=json&api_key=...
```

#### PMC Open Access (`pmc_oa.rs`)
```
GET ?id=<pmid>&format=json
```

#### cBioPortal API (`cbioportal.rs`)
```
GET /genes?keyword=<gene>&pageSize=1&pageNumber=0
GET /studies/<study_id>
GET /molecular-profiles/<profile_id>/mutations?sampleListId=...&entrezGeneId=...&pageSize=...&pageNumber=...
POST /studies/<study_id>/clinical-data/fetch?clinicalDataType=SAMPLE
```

#### cBioPortal DataHub (`cbioportal_download.rs`)
```
GET /study_list.json
GET /<study_id>.tar.gz
```

#### AlphaGenome (`alphagenome.rs`) - gRPC
```
Endpoint: gdmscience.googleapis.com:443
RPC: ScoreVariant (streaming)
Metadata: x-goog-api-key: <ALPHAGENOME_API_KEY>
Scorers: GeneMaskLFCScorer (RNA_SEQ), GeneMaskSplicingScorer (SPLICE_SITES), CenterMaskScorer (DNASE)
Response: Chunked tensor payloads, zstd + bfloat16/float16/float32/float64
```

### 4.4 API Key Summary

| Env Variable | Source | Required | Delivery Method |
|-------------|--------|----------|-----------------|
| `ALPHAGENOME_API_KEY` | AlphaGenome | Yes | gRPC metadata `x-goog-api-key` |
| `DISGENET_API_KEY` | DisGeNET | Yes | `Authorization` header |
| `UMLS_API_KEY` | UMLS | Yes | `apiKey` query param |
| `ONCOKB_TOKEN` | OncoKB | No | `Authorization: Bearer` header |
| `NCI_API_KEY` | NCI CTS | No | `X-API-KEY` header |
| `NCBI_API_KEY` | PubMed, PubTator, efetch, ID Conv, PMC OA | No | `api_key` query param |
| `S2_API_KEY` | Semantic Scholar | No | `x-api-key` header |
| `OPENFDA_API_KEY` | OpenFDA | No | `api_key` query param |

### 4.5 Rate Limiting Defaults

| API | Default Interval |
|-----|-----------------|
| PubTator (with NCBI key) | 100ms |
| PubTator (without key) | 334ms |
| PMC OA | 334ms |
| PubMed (with NCBI key) | 100ms |
| PubMed (without key) | 334ms |
| LitSense2 | 1000ms |
| NCBI ID Conv | 334ms |
| NIH Reporter | 1000ms |
| Open Targets | 500ms |
| CIViC | 334ms |
| CPIC | 250ms |
| PharmGKB | 500ms |
| Semantic Scholar (with S2 key) | 1000ms |
| Semantic Scholar (without key) | 2000ms |
| KEGG | 334ms |
| Default (all others) | 100ms |

## 5. Entity Models

### 5.1 Gene (`entities/gene.rs`)

**Search result**: `GeneSearchResult { symbol, name, entrez_id, genomic_coordinates, uniprot_id, omim_id }`

**Full entity**: `Gene` with 15 optional sections:

| Section | Data Sources | Content |
|---------|-------------|---------|
| pathways | Reactome | GenePathway { source, id, name } |
| ontology | Enrichr (GO_Biological_Process_2025, GO_Molecular_Function_2025) | EnrichmentResult { library, terms } |
| diseases | Enrichr (DisGeNET, OMIM_Disease) | EnrichmentResult |
| diagnostics | Local GTR/WHO IVD | DiagnosticSearchResult |
| protein | UniProt | GeneProtein { accession, name, function, length, isoforms } |
| go | QuickGO | GeneGoTerm { id, name, aspect, evidence } |
| interactions | STRING | GeneInteraction { partner, score } |
| civic | CIViC | CivicContext |
| expression | GTEx | GeneExpression { tissues } |
| hpa | HPA | GeneHpa (tissue/cell/RNA expression) |
| druggability | DGIdb + OpenTargets | GeneDruggability { categories, interactions, tractability } |
| clingen | ClinGen | GeneClinGen { validity, haploinsufficiency, triplosensitivity } |
| constraint | gnomAD | GeneConstraint { pli, loeuf, mis_z, syn_z, transcript } |
| disgenet | DisGeNET | GeneDisgenet { associations: [{disease_name, disease_cui, score, ...}] } |
| funding | NIH Reporter | NihReporterFundingSection |

**Get strategies**: Baseline, OpenTargetsEnsembl, ParallelTop (default)
**Optional section timeout**: 8s default (`BIOMCP_GENE_OPTIONAL_TIMEOUT_MS`)

### 5.2 Variant (`entities/variant/mod.rs`)

**Search result**: `VariantSearchResult { id, gene, hgvs_p, legacy_name, significance, clinvar_stars, gnomad_af, revel, gerp }`

**Full entity**: `Variant` with sections:
- Core: gene, id, hgvs_p/c, rsid, cosmic_id, significance, clinvar fields, conditions
- Frequency: gnomad_af, allele_frequency, population_breakdown (19 gnomAD subpopulations)
- Predictions: cadd_score, sift_pred, polyphen_pred, conservation (phylop, phastcons, gerp), expanded_predictions (revel, alphamissense, clinpred, metarnn, bayesdel, etc.)
- Clinical: cancer_frequencies, cosmic_context, cgi_associations, civic, gwas associations
- AlphaGenome: prediction { expression_lfc, splice_score, chromatin_score, top_gene }

**22 search filters**: gene, hgvsp, hgvsc, rsid, protein_alias, significance, max_frequency, min_cadd, consequence, review_status, population, revel_min, gerp_min, tumor_site, condition, impact, lof, has, missing, therapy

**OncoKB**: `VariantOncoKbResult { gene, alteration, oncogenic, level, effect, therapies[] }`

### 5.3 Drug (`entities/drug/mod.rs`)

**Search result**: `DrugSearchResult { name, drugbank_id, drug_type, mechanism, target }`

**Full entity**: `Drug` with regional sections:
- Core: name, drugbank_id, chembl_id, unii, mechanism(s), approval info, brand_names, route, targets, indications, interactions, pharm_classes, top_adverse_events
- US: label (DrugLabel), approvals, shortage, us_safety_warnings
- EU: ema_regulatory, ema_safety (DHPCs, referrals, PSUSAs), ema_shortage
- WHO: who_prequalification
- Cross-entity: civic

**9 sections**: label, regulatory, safety, shortage, targets, indications, interactions, civic, approvals
**Regional search**: `DrugRegion { Us, Eu, Who, All }`

### 5.4 Disease (`entities/disease/mod.rs`)

**Search result**: `DiseaseSearchResult { id, name, synonyms_preview, resolved_via, source_id }`

**Full entity**: `Disease` with 13 sections:
- Core: id (MONDO), name, definition, synonyms, parents, xrefs
- Associations: associated_genes, gene_associations (with OpenTargets scores), top_genes, treatment_landscape
- Phenotypes: phenotypes (HPO), clinical_features, key_features
- Variants: variants, top_variant
- Models: models (Monarch disease models)
- Prevalence: prevalence evidence
- Survival: survival (SEER data, by sex, observed + modeled)
- Other: pathways, funding (NIH Reporter), diagnostics, civic, disgenet

**12 sections**: genes, pathways, phenotypes, diagnostics, variants, models, prevalence, survival, funding, civic, disgenet, clinical_features

### 5.5 Article (`entities/article/mod.rs`)

**Search result**: `ArticleSearchResult { pmid, pmcid, doi, title, journal, date, citation_count, source, score, abstract_snippet, ranking }`

**Full entity**: `Article` with:
- Core: pmid, pmcid, doi, title, authors, journal, date, citation_count, abstract_text
- Open access: open_access, full_text_path, full_text_source (JATS XML, HTML, PDF)
- Annotations: genes, diseases, chemicals, mutations (from PubTator)
- Semantic Scholar: tldr, citation_count, influential_citation_count, references, OA PDF
- Graph: citations, references, recommendations (ArticleGraphResult)

**5 search backends**: PubTator3, Europe PMC, PubMed, Semantic Scholar, LitSense2
**3 ranking modes**: Lexical, Semantic, Hybrid (default)
**Default weights**: semantic=0.4, lexical=0.3, citations=0.2, position=0.1
**3 sections**: annotations, fulltext, tldr

### 5.6 Trial (`entities/trial/mod.rs`)

**Search result**: `TrialSearchResult { nct_id, title, status, phase, conditions, sponsor, matched_intervention_label }`

**Full entity**: `Trial` with:
- Core: nct_id, source, title, status, phase, study_type, age_range, conditions, interventions, sponsor, enrollment, summary, dates
- Sections: eligibility_text, locations (TrialLocation), outcomes (primary/secondary), arms, references

**2 sources**: ClinicalTrials.gov (default), NCI CTS
**5 sections**: eligibility, locations, outcomes, arms, references
**19 search filters**: condition, intervention, facility, status, phase, study_type, age, sex, sponsor, date range, mutation, criteria, biomarker, prior_therapies, progression_on, line_of_therapy, results_available, geo (lat/lon/distance)

### 5.7 Pathway (`entities/pathway.rs`)

**Search result**: `PathwaySearchResult { source, id, name }`

**Full entity**: `Pathway` with:
- Core: source, id, name, species, summary
- Sections: genes (extracted from participants), events (Reactome only), enrichment (g:Profiler, Reactome REAC only)

**3 sources**: Reactome (default), KEGG (can be disabled via `BIOMCP_DISABLE_KEGG`), WikiPathways
**3 sections**: genes, events (Reactome only), enrichment (Reactome only)
Search results are ranked by title match tier (exact > prefix > contains) across sources.

### 5.8 Protein (`entities/protein.rs`)

**Search result**: `ProteinSearchResult { accession, uniprot_id, name, gene_symbol, species }`

**Full entity**: `Protein` with:
- Core: accession, entry_id, name, gene_symbol, organism, length, function
- Sections: structures (PDB, paginated), domains (InterPro), interactions (STRING), complexes (ComplexPortal)

**4 sections**: domains, interactions, complexes, structures
Resolves gene symbols to UniProt accessions via MyGene.info.

### 5.9 PGx (`entities/pgx.rs`)

**Search result**: `PgxSearchResult { genesymbol, drugname, cpiclevel, pgxtesting, guidelinename }`

**Full entity**: `Pgx` with:
- Core: query, gene, drug, interactions (gene-drug pairs)
- Sections: recommendations (CPIC), frequencies (allele populations), guidelines, annotations (PharmGKB)

**4 sections**: recommendations, frequencies, guidelines, annotations
Primary source: CPIC. Enrichment: PharmGKB (10s timeout).

### 5.10 Adverse Event, Diagnostic, Study, Discover, Phenotype

- **Adverse Event**: OpenFDA FAERS + VAERS + FDA recalls + MAUDE devices
- **Diagnostic**: Local NCBI GTR + WHO IVD data
- **Study**: Local cBioPortal analytics (mutation frequency, CNA, expression, survival, co-occurrence, comparison)
- **Discover**: Free-text resolution via OLS4 (cross-entity concept lookup)
- **Phenotype**: HPO/Monarch semantic similarity search

## 6. Transform Layer

Located in `src/transform/`, each module maps raw API response structs to domain entity models:

| Module | Key Functions |
|--------|--------------|
| `gene.rs` | `from_mygene_get()`, `from_mygene_hit()`, `normalize_summary()`, `normalize_aliases()` |
| `variant.rs` | Maps MyVariant fields to Variant entity with population breakdowns |
| `drug.rs` | Maps MyChem fields to Drug entity with mechanism/target extraction |
| `disease.rs` | Maps MyDisease fields to Disease entity with HPO/MONDO resolution |
| `article.rs` | Maps PubTator/EPMC/PubMed/S2/LitSense2 to Article |
| `pathway.rs` | `from_reactome_hit()`, `from_kegg_hit()`, `from_wikipathways_hit()`, `from_reactome_record()`, `from_kegg_record()`, `from_wikipathways_record()` |
| `protein.rs` | `from_uniprot_record_base()`, `from_uniprot_search_record()` |
| `adverse_event.rs` | Maps OpenFDA/VAERS responses |
| `trial.rs` | Maps ClinicalTrials.gov v2 / NCI CTS responses |

## 7. Caching Architecture

- **Backend**: cacache (content-addressable disk cache)
- **Integration**: http-cache-reqwest middleware
- **Size tracking**: AtomicU64 approximate size
- **Max size**: 10GB default (`BIOMCP_CACHE_MAX_SIZE`)
- **Min disk free**: 10% default (`BIOMCP_CACHE_MIN_DISK_FREE`)
- **Max age**: 86400s default (`[cache].max_age_secs`)
- **Eviction**: Async (tokio::spawn), age-based + size LRU + orphan GC
- **Override**: `--no-cache` CLI flag, `BIOMCP_CACHE_MODE=off`

## 8. Error Handling

`BioMcpError` enum (thiserror, non_exhaustive):

| Variant | Purpose |
|---------|---------|
| `HttpClientInit` | HTTP client creation failure |
| `Http` | Request failure |
| `Api { api, message }` | Upstream API error |
| `ApiJson { api, source }` | JSON parse from API |
| `NotFound { entity, id, suggestion }` | Not found with actionable suggestion |
| `InvalidArgument(String)` | Bad user input |
| `ApiKeyRequired { api, env_var, docs_url }` | Missing API key |
| `SourceUnavailable { source_name, reason, suggestion }` | Source down with alternative |

## 9. CLI Command Grammar

### Top-Level Commands

| Command | Description |
|---------|-------------|
| `search <entity> -q <query> [filters]` | Search across entities |
| `get <entity> <id> [sections]` | Retrieve entity details |
| `<entity> <action>` | Cross-entity shortcuts (e.g., `gene trials BRAF`) |
| `study <action>` | cBioPortal analytics |
| `discover -q <text>` | Free-text concept resolution |
| `batch get <entity> <id1,id2,...>` | Parallel get (up to 10/20 IDs) |
| `enrich -g <gene1,gene2,...>` | Gene-set enrichment via g:Profiler |
| `list` | Entity reference cards |
| `version`, `health` | System info |

### Entity Commands

Each entity supports: `search`, `get`, and entity-specific helpers.
Example: `gene trials BRAF`, `drug adverse-events aspirin`, `variant articles V600E`

## 10. Key Design Decisions for TS Rewrite

1. **Single-tool MCP pattern**: One `"biomcp"` tool wrapping full CLI grammar. Consider whether to keep this or register per-entity tools.

2. **Three-layer separation**: `sources` (HTTP) -> `transform` (mapping) -> `entities` (orchestration). Maintain this in TS.

3. **Multi-source orchestration**: Each entity `get()` fans out to 5-15 sources concurrently with timeout-based degradation. Use `Promise.allSettled()` patterns.

4. **Section-based enrichment**: Entities have optional sections fetched in parallel. Sections have independent timeouts and graceful degradation.

5. **Federated article search**: 5 backends with cross-source deduplication and composite ranking. Most complex search pipeline.

6. **Local-file sources**: EMA, WHO PQ, WHO IVD, GTR, CVX download and cache remote files locally. Need a download + file-cache layer.

7. **Rate limiting**: Per-source mutex-based rate limiting. In TS, use token buckets or simple setTimeout chains.

8. **Auth patterns**: 3 required keys (AlphaGenome, DisGeNET, UMLS), 5 optional keys. Pass via headers or query params.

9. **Output dual-rendering**: Markdown (human) and JSON (agent) with `_meta.next_commands` for agent guidance.

10. **cBioPortal study analytics**: Local TSV file processing with statistical analysis (mutation frequency, CNA, expression, survival curves).
