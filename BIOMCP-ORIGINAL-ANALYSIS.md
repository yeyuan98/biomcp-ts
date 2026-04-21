# BioMCP Original Implementation Analysis

> Analyzed from the genomoncology/biomcp Rust codebase (v0.8.22, edition 2024)
> Repository: https://github.com/genomoncology/biomcp

## 1. Project Overview

BioMCP is a biomedical CLI tool and MCP (Model Context Protocol) server written in Rust. It provides comprehensive tools for querying genes, variants, diseases, drugs, clinical trials, articles, pathways, proteins, adverse events, pharmacogenomics (PGx), diagnostics, phenotypes, and GWAS associations from 50+ upstream biomedical data sources.

**Package**: `biomcp-cli` v0.8.22
**License**: MIT
**Homepage**: https://biomcp.org

## 2. Architecture

### 2.1 Layered Architecture

```
CLI (clap args) -> Entities (business logic) -> Sources (API clients) -> Transform (data mapping) -> Render (output formatting)
```

### 2.2 Module Organization (`src/`)

```
src/
  main.rs                  # Binary: biomcp (MCP + CLI entry)
  main_biomcp_cli.rs       # Binary: biomcp-cli (legacy alias, includes main.rs)
  lib.rs                   # Library crate public surface
  gene.rs                  # Gene entity public re-exports
  error.rs                 # BioMcpError enum (thiserror)
  test_support.rs          # Test utilities (env locks, temp dirs)
  cli/                     # CLI parsing and command execution (33 modules)
  mcp/                     # MCP server (stdio + HTTP transport)
  sources/                 # 57 upstream API client modules
  entities/                # 14 entity domain models and workflows
  transform/               # Data transformation adapters (11 modules)
  render/                  # Output formatting (JSON, Markdown, Charts)
  cache/                   # Disk-based HTTP cache management
  utils/                   # Date parsing, file download, serde helpers
  generated/               # Protobuf-generated AlphaGenome types
```

### 2.3 Key Architectural Patterns

- **Entity-First Design**: Each entity has dedicated CLI args, entity model, source clients, transform adapters, and renderers
- **MCP-as-Shell Pattern**: Single `biomcp` MCP tool accepts CLI command strings, auto-exposing all CLI functionality via MCP
- **Section-Based Enrichment**: Entities support optional "sections" (e.g., `biomcp get gene BRAF pathways,hpa,expression`), independently fetched with timeouts
- **Source Federation**: Article search fans out to 5 backends in parallel, deduplicates, and applies configurable ranking
- **Dual Output Mode**: Every command supports `--json` for structured JSON and default Markdown output
- **Disk-Based HTTP Cache**: 10GB default, 24h max age, automatic eviction, per-request `--no-cache` via tokio task_local

## 3. Entry Points

### 3.1 `biomcp` binary (`src/main.rs`)

Async tokio runtime. Dispatches:
- `mcp` / `serve` -> MCP over stdio (`run_stdio()`)
- `serve-http` -> MCP Streamable HTTP on Axum at `/mcp`
- All other commands -> CLI execution (`run_outcome()`)

### 3.2 `biomcp-cli` binary (`src/main_biomcp_cli.rs`)

Exact duplicate of `biomcp` binary (backward compatibility).

### 3.3 Library surface (`src/lib.rs`)

Exports `cli`, `error`, `gene`, `mcp` modules. Private modules: `cache`, `entities`, `render`, `sources`, `transform`, `utils`.

## 4. CLI Structure

### 4.1 Command Hierarchy

**Search/Get pattern** (12 entity types each):
- `search <entity> <query> [--limit N] [--json]`
- `get <entity> <id> [--sections ...] [--json]`

**Entity-specific cross-entity commands**:
- `gene articles BRAF` - find articles for a gene
- `variant trials "BRAF V600E"` - find trials for a variant
- `drug interactions <drug>` - drug-gene interactions
- `disease genes <disease>` - gene associations
- `article references <pmid>` - citation graph traversal

**Infrastructure commands**:
- `study` - local cBioPortal analytics (query, survival, compare, co-occurrence, cohort, filter, download, list, top-mutated)
- `health` - API connectivity check
- `cache` - HTTP cache inspection (path, stats, clean, clear)
- `batch` - parallel get (comma-separated IDs, max 10)
- `enrich` - gene set enrichment (g:Profiler)
- `discover` - free-text concept resolution

**System commands**: `ema sync`, `who sync`, `who-ivd sync`, `cvx sync`, `gtr sync`, `update`, `uninstall`, `list`, `skill`

### 4.2 SearchEntity targets (14)

`All`, `Gene`, `Disease`, `Diagnostic`, `Pgx`, `Phenotype`, `Gwas`, `Article`, `Trial`, `Variant`, `Drug`, `Pathway`, `Protein`, `AdverseEvent`

### 4.3 GetEntity targets (11)

`Gene`, `Article`, `Disease`, `Diagnostic`, `Pgx`, `Trial`, `Variant`, `Drug`, `Pathway`, `Protein`, `AdverseEvent`

## 5. MCP Server

### 5.1 Implementation (`src/mcp/shell.rs`)

Uses `rmcp` crate (Rust MCP SDK). Implements `ServerHandler` trait with `ToolRouter<Self>`.

### 5.2 MCP Tool: `biomcp`

Single MCP tool with function name `"biomcp"`, title `"BioMCP"`, `read_only_hint = true`.

**Input schema**:
```json
{
  "command": "string (max 1024 chars)"
}
```

Parses via `shlex::split()`, validates against allowlist, calls `cli::execute_mcp()`.

**Output**: Text content + optional base64-encoded SVG image for charts.

### 5.3 MCP Command Allowlist

Allowed: `search`, `get`, `variant`, `drug`, `disease`, `article`, `gene`, `pathway`, `protein`, `list`, `version`, `health`, `batch`, `enrich`, `discover`

Allowed study subcommands: `list`, `top-mutated`, `query`, `filter`, `cohort`, `survival`, `compare`, `co-occurrence`, `download --list`

Partially allowed: `skill` (read-only allowed: list, show, slug/number lookup; `skill install` blocked)

Blocked: `cache`, `ema sync`, `who sync`, `update`, `uninstall`

### 5.4 MCP Resources

- `biomcp://help` - BioMCP overview markdown
- `biomcp://skill/<slug>` - Individual embedded skill content

### 5.5 HTTP Transport

Axum server at `/mcp` (Streamable HTTP). Health probes: `GET /health`, `GET /readyz`, `GET /`.

## 6. Data Sources (API Endpoints)

### 6.1 Summary Table

| # | Source | Base URL | Protocol | Auth | Domain |
|---|--------|----------|----------|------|--------|
| 1 | AlphaGenome | `https://gdmscience.googleapis.com:443` | gRPC | `ALPHAGENOME_API_KEY` | DNA variant scoring |
| 2 | cBioPortal | `https://www.cbioportal.org/api` | REST | None | Cancer genomics |
| 3 | cBioPortal DataHub | `https://datahub.assets.cbioportal.org` | REST | None | Study data downloads |
| 4 | ChEMBL | `https://www.ebi.ac.uk/chembl/api/data` | REST | None | Drug bioactivity |
| 5 | CIViC | `https://civicdb.org/api` | GraphQL | None | Clinical variant evidence |
| 6 | ClinGen | `https://search.clinicalgenome.org` | REST | None | Gene/variant clinical relevance |
| 7 | ClinicalTrials.gov | `https://clinicaltrials.gov/api/v2` | REST | None | Clinical trials |
| 8 | ComplexPortal | `https://www.ebi.ac.uk/intact/complex-ws` | REST | None | Protein complexes |
| 9 | CPIC | `https://api.cpicpgx.org/v1` | REST (PostgREST) | None | Pharmacogenomics |
| 10 | CDC CVX/MVX | `https://www2.cdc.gov/vaccines/iis/iisstandards/downloads/` | CSV download | None | Vaccine codes |
| 11 | DGIdb | `https://dgidb.org/api` | GraphQL | None | Drug-gene interactions |
| 12 | DisGeNET | `https://api.disgenet.com` | REST | `DISGENET_API_KEY` | Gene-disease associations |
| 13 | EMA | `https://www.ema.europa.eu/en/documents/report` | JSON batch download | None | EU drug regulatory |
| 14 | Enrichr | `https://maayanlab.cloud/Enrichr` | REST | None | Gene set enrichment |
| 15 | Europe PMC | `https://www.ebi.ac.uk/europepmc/webservices/rest` | REST | None | Literature |
| 16 | gnomAD | `https://gnomad.broadinstitute.org/api` | GraphQL | None | Population genetics |
| 17 | g:Profiler | `https://biit.cs.ut.ee/gprofiler/api` | REST | None | Gene set enrichment |
| 18 | GTEx | `https://gtexportal.org` | REST | None | Gene expression |
| 19 | NCBI GTR | `https://ftp.ncbi.nlm.nih.gov/pub/GTR/data/` | FTP download | None | Genetic test registry |
| 20 | GWAS Catalog | `https://www.ebi.ac.uk/gwas/rest/api` | REST | None | GWAS associations |
| 21 | HPA | `https://www.proteinatlas.org` | REST (XML) | None | Protein expression |
| 22 | HPO | `https://ontology.jax.org/api/hp` | REST | None | Phenotype ontology |
| 23 | InterPro | `https://www.ebi.ac.uk/interpro/api` | REST | None | Protein domains |
| 24 | KEGG | `https://rest.kegg.jp` | REST | None | Pathways |
| 25 | LitSense2 | `https://www.ncbi.nlm.nih.gov/research/litsense2-api/api` | REST | None | Semantic article search |
| 26 | MedlinePlus | `https://wsearch.nlm.nih.gov` | REST | None | Consumer health topics |
| 27 | Monarch Initiative | `https://api-v3.monarchinitiative.org` | REST | None | Disease/phenotype |
| 28 | MyChem.info | `https://mychem.info/v1` | REST | None | Drug identity |
| 29 | MyDisease.info | `https://mydisease.info/v1` | REST | None | Disease identity |
| 30 | MyGene.info | `https://mygene.info/v3` | REST | None | Gene identity |
| 31 | MyVariant.info | `https://myvariant.info/v1` | REST | None | Variant identity |
| 32 | NCBI E-utilities (efetch) | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` | REST | Optional `NCBI_API_KEY` | Article full text |
| 33 | NCBI ID Converter | `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles` | REST | None | PMID/PMCID conversion |
| 34 | NCI CTS | `https://clinicaltrialsapi.cancer.gov/api/v2` | REST | None | NCI trial data |
| 35 | NIH Reporter | `https://api.reporter.nih.gov/v2` | REST | None | NIH grants |
| 36 | OLS4 | `https://www.ebi.ac.uk/ols4` | REST | None | Ontology lookup |
| 37 | OncoKB | `https://www.oncokb.org/api/v1` | REST | `oncokb_token` | Oncology variant evidence |
| 38 | OpenFDA FAERS | `https://api.fda.gov` | REST | Optional `OPENFDA_API_KEY` | Adverse events |
| 39 | Open Targets | `https://api.platform.opentargets.org/api/v4` | GraphQL | None | Gene-disease-drug targets |
| 40 | PharmGKB | `https://api.pharmgkb.org/v1` | REST | None | Pharmacogenomics |
| 41 | PMC Open Access | `https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi` | REST | None | Full text access |
| 42 | PubMed E-utilities | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` | REST | Optional `NCBI_API_KEY` | Literature search |
| 43 | PubTator3 | `https://www.ncbi.nlm.nih.gov/research/pubtator3-api` | REST | None | Annotated article search |
| 44 | QuickGO | `https://www.ebi.ac.uk/QuickGO/services` | REST | None | GO annotations |
| 45 | Reactome | `https://reactome.org/ContentService` | REST | None | Pathways |
| 46 | SEER | `https://seer.cancer.gov/statistics-network/explorer/source/content_writers` | REST | None | Cancer statistics |
| 47 | Semantic Scholar | `https://api.semanticscholar.org` | REST | Optional `S2_API_KEY` | Article metadata |
| 48 | STRING | `https://string-db.org/api` | REST | None | Protein interactions |
| 49 | UMLS | `https://uts-ws.nlm.nih.gov` | REST | `UMLS_API_KEY` | Unified Medical Language |
| 50 | UniProt | `https://rest.uniprot.org` | REST | None | Protein data |
| 51 | CDC VAERS | `https://wonder.cdc.gov` | REST | None | Vaccine adverse events |
| 52 | WHO IVD | `https://extranet.who.int/prequal/vitro-diagnostics/prequalified/in-vitro-diagnostics/export` | CSV download | None | In-vitro diagnostics |
| 53 | WHO Prequalification | `https://extranet.who.int/prequal/medicines/prequalified/` | CSV download | None | Drug/vaccine PQ |
| 54 | WikiPathways | `https://www.wikipathways.org/json` | REST | None | Pathways |

### 6.2 Detailed Endpoint Information

#### AlphaGenome (gRPC)
- **Endpoint**: `https://gdmscience.googleapis.com:443`
- **Auth**: `ALPHAGENOME_API_KEY` -> `x-goog-api-key` metadata header
- **RPCs used**: `ScoreVariant` (streaming)
- **Scorers**: GeneMaskLFCScorer (RNA_SEQ), GeneMaskSplicingScorer (SPLICE_SITES), CenterMaskScorer (DNASE, width=501)
- **Proto files**: `protos/dna_model.proto`, `dna_model_service.proto`, `tensor.proto`

#### cBioPortal
- `GET /genes?keyword=<gene>&pageSize=1&pageNumber=0` - Gene to Entrez ID
- `GET /studies/{study_id}` - Study metadata
- `GET /molecular-profiles/{profile_id}/mutations?sampleListId=...&entrezGeneId=...&pageSize=...&pageNumber=...` - Mutated samples (paginated)
- `POST /studies/{study_id}/clinical-data/fetch?clinicalDataType=SAMPLE` - Cancer type distribution

#### cBioPortal DataHub
- `GET /study_list.json` - List study IDs
- `GET /{study_id}.tar.gz` - Download study archive

#### ChEMBL
- `GET /mechanism.json?molecule_chembl_id=<id>&limit=<n>` - Drug mechanisms
- `GET /target/{target_chembl_id}.json` - Target summary

#### CIViC
- `POST /graphql` - Evidence items and assertions (variables: molecularProfileName, therapyName, diseaseName, first)

#### ClinGen
- `GET /api/genes/look/{gene_symbol}` - Gene lookup (HGNC ID)
- `GET /kb/gene-validity/download` - Gene-disease validity CSV
- `GET /kb/gene-dosage/download` - Gene dosage sensitivity CSV

#### ClinicalTrials.gov (v2 API)
- `GET /studies?query.cond=...&query.intr=...&query.locn=...&filter.overallStatus=...&aggFilters=...&query.term=...&countTotal=true&pageToken=...&pageSize=...&fields=...` - Search
- `GET /studies/{nct_id}?fields=...` - Get by NCT ID

#### ComplexPortal
- `GET /search/{accession}?number=25&filters=species_f:("Homo sapiens")` - Complex details

#### CPIC (PostgREST)
- `GET /pair_view?genesymbol=eq.<GENE>&select=*&limit=...&offset=...&order=...` - Gene-drug pairs
- `GET /pair_view?drugname=ilike.*<drug>*&...` - Drug pairs
- `GET /recommendation_view?lookupkey->><GENE>=not.is.null&...` - Recommendations by gene
- `GET /recommendation_view?drugname=ilike.*<drug>*&...` - Recommendations by drug
- `GET /population_frequency_view?genesymbol=eq.<GENE>&...` - Allele frequencies
- `GET /guideline_summary_view?genes=cs.[...]&...` - Guidelines

#### DGIdb
- `POST /graphql` - Gene druggability query (`DgidbGeneDruggability`, variables: $gene, $first)

#### DisGeNET
- `GET /api/v1/gda/summary?gene_ncbi_id=...&page_number=0` - Gene-disease associations
- `GET /api/v1/gda/summary?disease=UMLS_<cui>&page_number=0` - Disease-gene associations
- `GET /api/v1/entity/disease?disease_free_text_search_string=...` - Disease resolution
- **Auth**: `DISGENET_API_KEY` -> `Authorization` header

#### EMA
- Downloads 6 JSON batch files: medicines, post_authorisation, referrals, psusas, dhpcs, shortages
- Base: `https://www.ema.europa.eu/en/documents/report`

#### Enrichr
- `POST /addList` - Submit gene list (multipart: list, description)
- `GET /enrich?userListId=<id>&backgroundType=<library>` - Enrichment results

#### Europe PMC
- `GET /search?query=...&format=json&page=...&pageSize=...&sort=...` - Search articles
- `GET /{id}/fullTextXML` - Full-text XML
- Sort options: `P_PDATE_D desc` (date), `CITED desc` (citations)

#### gnomAD
- `POST /` (GraphQL) - `GeneConstraint` query with `$symbol` (GRCh38)

#### g:Profiler
- `POST /gost/profile/` - `{"organism":"hsapiens","query":["GENE1",...]}`

#### GTEx
- `GET /api/v2/reference/geneSearch?geneId=<ensembl>&gencodeVersion=v26` - Gene ID resolution
- `GET /api/v2/expression/medianGeneExpression?gencodeId=...&datasetId=gtex_v8` - Median expression

#### GWAS Catalog
- `GET /singleNucleotidePolymorphisms/{rsid}/associations?projection=associationByStudy&page=0&size=<n>` - Associations by rsID
- `GET /studies/{study_id}` - Study details

#### HPA
- `GET /{ensembl_id}.xml` - Protein expression data (XML)

#### HPO
- `GET /terms/{hpo_id}` - Term lookup (e.g., HP:0001653)
- `GET /search?q=<query>` - Search terms

#### InterPro
- `GET /entry/interpro/{accession}` - Entry details
- `GET /entry/interpro/{accession}/protein?taxonomy=human&page_size=...` - Proteins

#### KEGG
- `GET /list/pathway/hsa` - Human pathways
- `GET /find/{query}` - Search
- `GET /conv/genes/ncbi-geneid:{id}` - ID conversion

#### LitSense2
- `GET /search?q=<query>&limit=...` - Semantic article search

#### MedlinePlus
- `GET /medlineplus/search?query=<query>&count=...` - Consumer health topic search
- `GET /medlineplus/connect/{code}` - Topic by code

#### Monarch Initiative
- `GET /api/v3/entity/{id}` - Entity lookup
- `GET /api/v3/disease/{id}` - Disease details
- `GET /api/v3/gene/{id}` - Gene details

#### MyChem.info
- `GET /query?q=<query>&fields=...&size=...` - Drug search
- `GET /drug/{id}` - Drug by ID

#### MyDisease.info
- `GET /query?q=<query>&fields=...&size=...` - Disease search
- `GET /query?q={name}&fields=...` - Disease by name
- `GET /disease/{id}` - Disease by ID

#### MyGene.info
- `GET /query?q=<query>&fields=...&size=...&from=...` - Gene search
- `GET /gene/{id}` - Gene by ID

#### MyVariant.info
- `GET /query?q=<query>&fields=...&size=...` - Variant search
- `GET /variant/{id}` - Variant by ID

#### NCBI E-utilities (efetch)
- `GET /efetch?db=pubmed&id=...&rettype=xml&retmode=` - Fetch article XML
- `GET /esearch?db=pubmed&term=...&retmax=...&retstart=...` - Search

#### NCBI ID Converter
- `GET /?ids=<pmid>&format=json` - PMID to PMCID conversion

#### NCI CTS
- `GET /trials?...` - Search trials
- `GET /trials/{nct_id}` - Get trial by NCT ID

#### NIH Reporter
- `GET /projects?query.term=...&...` - Search projects
- `GET /projects/{project_id}` - Project details

#### OLS4
- `GET /api/terms?iri=<ontology_iri>&size=...` - Ontology term lookup
- `GET /api/search?q=<query>&ontology=...&size=...` - Search

#### OncoKB
- `GET /annotate/mutations/byProteinChange` - Variant annotation
- **Auth**: `oncokb_token` -> Authorization header

#### OpenFDA FAERS
- `GET /drug/event.json?search=<query>&limit=...&skip=...` - Adverse event search
- `GET /drug/event.json?search=<query>&count=patient.drug.medicinalproduct` - Count
- **Auth**: Optional `OPENFDA_API_KEY` as query param

#### Open Targets
- `POST /graphql` - Drug sections, disease sections, gene sections
- Queries: DrugSections (indications, mechanismsOfAction), DiseaseSections (associatedTargets), GeneSections (associationCounts)

#### PharmGKB
- `GET /data/download?view=...&...` - Various data downloads

#### PMC Open Access
- `GET ?id=<pmid>&format=json` - Check OA availability
- Used to discover download URLs for open-access articles

#### PubMed E-utilities
- `GET /esearch?db=pubmed&term=...&retmax=...&retstart=...&sort=relevance&datetype=pdat&mindate=...&maxdate=...` - Search
- **Auth**: Optional `NCBI_API_KEY` increases rate limit (10 req/sec vs 3)

#### PubTator3
- `GET /annotations/annotate/` - Annotate text
- `GET /annotations/search?keywords=<query>&document_type=...&total=...&page=...` - Search articles

#### QuickGO
- `GET /ontology/go/terms/{go_id}` - GO term details
- `GET /annotation/search?geneProductId=<gene>&taxonId=9606&pageSize=...` - GO annotations

#### Reactome
- `GET /search/query?query=...&species=Homo%20sapiens&limit=...&offset=...` - Search
- `GET /data/pathways/top/Homo%20sapiens` - All human pathways
- `GET /data/query/{st_id}` - Pathway by ID
- `GET /data/participants/{st_id}` - Pathway participants
- `GET /data/pathway/{st_id}/containedEvents` - Pathway events

#### SEER
- `GET /get_var_formats.php` - Site catalog
- `GET /render_region_5.php?site=<code>&data_type=4&graph_type=1&compareBy=sex&relative_survival_interval=5` - Survival data

#### Semantic Scholar
- `GET /graph/v1/paper/search?query=...&limit=...&offset=...&fields=...` - Search papers
- `GET /graph/v1/paper/{paper_id}?fields=...` - Paper details (TLDR, citations, references)
- `GET /graph/v1/paper/batch?fields=...` - Batch paper lookup
- **Auth**: Optional `S2_API_KEY` increases rate limit

#### STRING
- `GET /json/network?identifiers=<gene>&species=9606&required_score=...` - Protein interactions
- `GET /json/interaction_partners?identifiers=<gene>&species=9606&limit=...` - Interaction partners

#### UMLS
- `GET /rest/search/current?string=<query>&pageSize=...&sabs=...&searchType=exact` - Concept search
- `GET /rest/content/current/CUI/{cui}/atoms` - Concept atoms
- **Auth**: `UMLS_API_KEY` -> query params

#### UniProt
- `GET /uniprotkb/stream?query=...&format=json&fields=...&size=...` - Search
- `GET /uniprotkb/{accession}.json?fields=...` - Entry by accession

#### CDC VAERS
- `GET /api/...` - Vaccine adverse event data (via wonder.cdc.gov)

#### WHO IVD
- `GET /export?page&_format=csv` - Download WHO prequalified IVD list (CSV)

#### WHO Prequalification
- `GET /finished-pharmaceutical-products/export?page&_format=csv` - Drug PQ list
- `GET /active-pharmaceutical-ingredients/export?page&_format=csv` - API PQ list
- `GET /vaccines/prequalified/export` - Vaccine PQ list

#### WikiPathways
- `GET /findPathwaysByText?query=...&format=json&limit=...` - Search pathways
- `GET /getPathway?pathwayId=...&format=json` - Pathway by ID

### 6.3 Environment Variables for API Keys

| Variable | Source | Effect |
|----------|--------|--------|
| `ALPHAGENOME_API_KEY` | AlphaGenome | Required for variant prediction |
| `DISGENET_API_KEY` | DisGeNET | Required for gene-disease associations |
| `UMLS_API_KEY` | UMLS | Required for concept search |
| `oncokb_token` | OncoKB | Optional, enables oncology evidence |
| `NCBI_API_KEY` | NCBI (PubMed, PubTator) | Optional, increases rate limit (3->10 req/s) |
| `S2_API_KEY` | Semantic Scholar | Optional, increases rate limit |
| `OPENFDA_API_KEY` | OpenFDA | Optional, increases rate limit |

### 6.4 Rate Limiting Middleware

12 explicit per-URL-prefix policies plus a 100ms default fallback. Intervals are adjustable via `BIOMCP_*_MIN_INTERVAL_MS` env vars:

| API | Default Interval |
|-----|-----------------|
| PubTator3 | 100ms (with NCBI key) / 334ms (without) |
| PMC OA | 334ms |
| PubMed E-utilities | 100ms (with NCBI key) / 334ms (without) |
| LitSense2 | 1000ms |
| NCBI ID Conv | 334ms |
| NIH Reporter | 1000ms |
| Open Targets | 500ms |
| CIViC | 334ms |
| CPIC | 250ms |
| PharmGKB | 500ms |
| Semantic Scholar | 1000ms (with S2 key) / 2000ms (without) |
| KEGG | 334ms |
| Default (all others) | 100ms |

## 7. Entity Models

### 7.1 Gene (`src/entities/gene.rs`, ~3050 lines)

The most complex entity. Aggregates from 15+ upstream sources.

**Key structs**: `Gene`, `GeneSection`, `GeneGetResult`, `GeneSearchFilters`, `GeneConstraint`, `GenePathway`, `GeneInteraction`, `GeneProtein`, `GeneDisgenet`, `EnrichmentResult`

**Sections** (optional enrichment): pathways, interactions, protein, hpa, expression, diseases, diagnostics, funding, disgenet, opentargets, gnomad_constraint

**Sources used**: MyGene.info (primary), ClinGen, CIViC, DGIdb, DisGeNET, Enrichr, gnomAD, GTEx, HPA, NIH Reporter, OpenTargets, QuickGO, Reactome, STRING, UniProt

### 7.2 Article (`src/entities/article/`, 25 files)

Complex sub-directory with multi-backend federation.

**Key structs**: `Article`, `ArticleSearchFilters`, `ArticleSort`, `ArticleRankingOptions`, `ArticleSourceFilter`

**Backends**: PubTator3, Europe PMC, PubMed, LitSense2, Semantic Scholar

**Subsystems**: candidate collection/dedup, detail retrieval, Semantic Scholar enrichment, citation/reference graph traversal, source federation planning, query construction, multi-signal ranking, full-text extraction (JATS XML, PDF, HTML)

### 7.3 Disease (`src/entities/disease/`, 17 files)

**Key structs**: `Disease`, `DiseaseSearchFilters`, `DiseaseGeneAssociation`, `ClinicalFeature`

**Subsystems**: gene-disease associations (OpenTargets, DisGeNET), clinical features (MedlinePlus), gene set enrichment, label fallback (OLS4), MONDO/ontology resolution, SEER survival data

### 7.4 Drug (`src/entities/drug/`, 14 files)

**Key structs**: `Drug`, `DrugSearchFilters`, `DrugRegion`, `DrugLabel`, `DrugTarget`

### 7.5 Variant (`src/entities/variant/`, 9 files)

**Key structs**: `Variant`, `VariantSearchFilters`, `VariantIdFormat`, `GwasSearchFilters`, `VariantPrediction`

**Prediction**: AlphaGenome scoring (expression LFC, splice score, chromatin score)

### 7.6 Trial (`src/entities/trial/`, 5 files)

**Key structs**: `Trial`, `TrialSearchFilters`, `TrialSource`

**Sources**: ClinicalTrials.gov, NCI CTS

### 7.7 Protein (`src/entities/protein.rs`, ~625 lines)

**Key structs**: `Protein`, `ProteinDomain`, `ProteinInteraction`, `ProteinComplex`

### 7.8 Pathway (`src/entities/pathway.rs`, ~1026 lines)

**Key structs**: `Pathway`, `PathwaySearchFilters`, `PathwayEnrichment`

**Sources**: Reactome, KEGG, WikiPathways

### 7.9 PGx (`src/entities/pgx.rs`, ~864 lines)

**Key structs**: `Pgx`, `PgxInteraction`, `PgxRecommendation`

**Sources**: CPIC, PharmGKB

### 7.10 Adverse Event (`src/entities/adverse_event.rs`, ~2499 lines)

**Key structs**: `AdverseEvent`, `AdverseEventSearchFilters`, `AdverseEventReport`

**Sources**: OpenFDA FAERS, CDC VAERS

### 7.11 Diagnostic (`src/entities/diagnostic/`, 3 files)

**Key structs**: `Diagnostic`, `DiagnosticSearchFilters`

**Sources**: NCBI GTR, ClinGen, WHO IVD

### 7.12 Study (`src/entities/study.rs`, ~1423 lines)

**Key structs**: `StudyInfo`, `MutationFrequencyResult`, `TopMutatedGenesResult`, `SurvivalResult`, `CoOccurrenceResult`

Local cBioPortal analytics from downloaded study data files.

### 7.13 Discover (`src/entities/discover.rs`, ~2290 lines)

**Key structs**: `DiscoverResult`, `DiscoverConcept`, `DiscoverType`, `DiscoverIntent`, `AliasFallbackDecision`

Free-text concept resolution engine using OLS4, UMLS, MedlinePlus.

**DiscoverType enum**: Gene, Drug, Disease, Symptom, Pathway, Variant, Unknown

**DiscoverIntent enum**: DirectMatch, FuzzyMatch, MultiMatch, NoMatch, ArticleSuggestion

### 7.14 Generic Types

- `SearchPage<T>`: Generic pagination wrapper (offset + cursor)

## 8. Transform Layer (`src/transform/`)

Data adapters that map raw API responses to entity structs:

| Module | Mapping |
|--------|---------|
| `gene.rs` | MyGene.info raw -> `Gene` entity |
| `variant.rs` | MyVariant.info raw -> `Variant` entity |
| `disease.rs` | MyDisease.info raw -> `Disease` entity |
| `drug.rs` | MyChem.info raw -> `Drug` entity |
| `trial.rs` | ClinicalTrials.gov/NCI raw -> `Trial` entity |
| `pathway.rs` | Reactome/KEGG/WikiPathways raw -> `Pathway` entity |
| `protein.rs` | UniProt raw -> `Protein` entity |
| `adverse_event.rs` | OpenFDA/VAERS raw -> `AdverseEvent` entity |
| `article.rs` + `article/` | Multi-source article transforms (anchors, annotations, federation, HTML, JATS XML, PDF) |

## 9. Rendering System

### 9.1 JSON Output (`src/render/json.rs`, ~994 lines)

- `to_pretty()` - Pretty-printed JSON
- `to_entity_json()` - Entity with `_meta` envelope
- `_meta` includes: `evidence_urls`, `next_commands`, `section_sources`

### 9.2 Markdown Output (`src/render/markdown/`, 40 files)

Per-entity markdown rendering for all 12 entity types, plus evidence, funding, related, sections helpers.

### 9.3 Chart Rendering (`src/render/chart.rs`, ~1997 lines)

Uses `kuva` crate. 12 chart types: Bar, StackedBar, Pie, Waterfall, Heatmap, Histogram, Density, Box, Violin, Ridgeline, Scatter, Survival.

Output modes: terminal (Unicode), SVG file, MCP inline SVG (base64). PNG via `charts-png` feature.

### 9.4 Provenance (`src/render/provenance.rs`, ~1783 lines)

`SectionSource { key, label, sources }` - tracks which upstream APIs contributed to each entity section.

## 10. Cache System (`src/cache/`)

- **Backend**: `cacache` (disk-based, content-addressed)
- **Default max size**: 10GB
- **Default max age**: 24h
- **Stale tolerance**: `max-stale=86400` (24h)
- **Per-request control**: `--no-cache` flag via `tokio::task_local`
- **Auth handling**: Authenticated requests forced to `NoStore`
- **Config resolution**: `BIOMCP_CACHE_DIR` env -> `cache.toml` in XDG config -> XDG cache home default (`~/.cache/biomcp`)
- **Eviction**: Size-aware with age, LRU, and orphan GC strategies

## 11. Error Handling (`src/error.rs`)

```rust
#[derive(thiserror::Error, Debug)]
#[non_exhaustive]
enum BioMcpError {
    HttpClientInit(reqwest::Error),
    Http(#[from] reqwest::Error),
    HttpMiddleware(#[from] reqwest_middleware::Error),
    Api { api: String, message: String },
    ApiJson { api: String, #[source] source: serde_json::Error },
    NotFound { entity: String, id: String, suggestion: String },
    InvalidArgument(String),
    ApiKeyRequired { api: String, env_var: String, docs_url: String },
    SourceUnavailable { source_name: String, reason: String, suggestion: String },
    Template(#[from] minijinja::Error),
    Json(#[from] serde_json::Error),
    Io(#[from] std::io::Error),
}
```

## 12. HTTP Client Infrastructure

**Three singleton clients** via `OnceLock`:

1. `HTTP_CLIENT` - Default with retry + cache + rate limit middleware
2. `SEMANTIC_SCHOLAR_SHARED_POOL_HTTP_CLIENT` - Same + 429 rate limit middleware
3. `STREAMING_HTTP_CLIENT` - Raw `reqwest::Client` without middleware

**Middleware stack**: Cache (cacache) -> RetryTransientMiddleware (3 retries, exponential backoff) -> RateLimitMiddleware (per-API prefix)

**Dependencies**: `reqwest` (rustls-tls), `reqwest-middleware`, `reqwest-retry`, `http-cache-reqwest`, `cacache`

## 13. Build System

- **Build**: `build.rs` compiles AlphaGenome protos via `tonic-build`, generates MCP tool description
- **Proto files**: `protos/dna_model.proto` (537 lines), `dna_model_service.proto` (269 lines), `tensor.proto` (105 lines)
- **Vendored proto output**: `src/generated/google.gdm.gdmscience.alphagenome.v1main.rs` (1485 lines)
- **Build metadata**: `BIOMCP_BUILD_GIT_SHA`, `BIOMCP_BUILD_GIT_TAG`, `BIOMCP_BUILD_DATE`

## 14. Embedded Skills

Skills embedded via `rust-embed` from `skills/` directory. Exposed as MCP resources and installable to agent config directories.

## 15. Configuration

- **manifest.json**: MCP bundle manifest (v0.3), binary entry at `server/biomcp`
- **User config**: `oncokb_token`, `disgenet_api_key`, `s2_api_key` (optional, sensitive)
- **Feature flags**: `charts-png` (enables kuva/png backend)

## 16. Key Dependencies

| Crate | Purpose |
|-------|---------|
| `clap` (derive) | CLI argument parsing |
| `tokio` (rt-multi-thread) | Async runtime |
| `axum` | HTTP server for MCP transport |
| `reqwest` + middleware | HTTP client with retry, cache, rate limiting |
| `cacache` | Disk-based HTTP cache |
| `tonic` + `prost` | gRPC client for AlphaGenome |
| `rmcp` | MCP server SDK |
| `serde` / `serde_json` | JSON serialization |
| `minijinja` | Template rendering |
| `kuva` | Chart rendering |
| `thiserror` / `anyhow` | Error handling |
| `roxmltree` | XML parsing (HPA) |
| `readability-rust` / `htmd` / `unpdf` | HTML/Markdown/PDF text extraction |
| `rust-embed` | Embedded skills |
| `csv` | CSV parsing |
