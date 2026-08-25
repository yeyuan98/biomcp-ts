# Entities Layer

The business logic layer for biomcp-ts. Each entity module (gene, variant, drug, disease, article, trial, pdb, patent, geo, sra, genbank, gtex, ensembl) implements a consistent **search / get / sections** pattern:

1. **`search`** — queries a primary data source with filters, returns lightweight result arrays
2. **`get`** — fetches a single entity by identifier, optionally enriching with parallel section fetches
3. **Sections** — optional data slices fetched concurrently from upstream APIs; each section has its own upstream source and auth requirements

## Section Fetching Strategy

All entity `get` functions use the same pattern (patent is the exception — per-section priority chains, see `patent/README.md`):

- Sections are dispatched via `Promise.allSettled` with an **8-second timeout** per section (`fetchWithTimeout`, `SECTION_TIMEOUT_MS = 8000`); `geneGet` additionally guards the whole call with a 30s overall abort
- Fulfilled sections populate `result.sections[<name>]`
- Failed sections (timeout, network error, auth missing) populate `result.sections[<name>] = { error: "..." }`
- Section fetchers return `{ _error: "..." }` as a single-element array or object when the upstream source itself fails (e.g., `{ _error: "Pathway lookup failed (source: reactome): ..." }`)

Option/result types are exported from each entity module (directory modules keep them in `types.ts`); this README documents function signatures and section tables only.

---

## Gene (`gene.ts`)

**Primary source:** MyGene.info (`mygene` connection)

### Exported Functions

```ts
geneSearch(query: string, options?: GeneSearchOptions): Promise<GeneSearchResult[]>
geneGet(symbol: string, sections?: string[]): Promise<GeneResult>
transformMyGeneResponse(data: MyGeneGetResponse['hits'][0]): GeneResult
```

### Sections

| Section | Upstream API | Auth | Notes |
|---------|-------------|------|-------|
| `pathways` | Reactome | None | Searches by gene symbol, filters `types=Pathway`, returns up to 10 (cross-entity `geneToPathways` uses 20) |
| `protein` | UniProt | None | Queries `gene:<symbol> AND organism_id:9606` |
| `ontology` | MyGene.info | None | GO terms from MyGene `go` field (BP/MF/CC), deduplicated, up to 20 |
| `go` | MyGene.info | None | Same upstream as `ontology` but up to 50 terms with `aspect` field |
| `interactions` | STRING-db | None | Interaction partners via `/json/interaction_partners`, up to 20 |
| `civic` | CIViC (GraphQL) | None | Clinical variants for gene |
| `expression` | GTEx | None | Delegates to `entities/gtex.ts` `gtexMedianExpression` (GTEx Analysis v10, versioned gencodeId resolution, top-20 tissues by median TPM) |
| `hpa` | Human Protein Atlas | None | Subcellular location from `/search` |
| `druggability` | DGIdb (GraphQL) + OpenTargets (GraphQL) | None | DGIdb drug interactions + OpenTargets tractability |
| `clingen` | — | — | **Stub**: always returns `{ _error: "...not available via public API..." }` |
| `constraint` | gnomAD (GraphQL) | None | LOEUF, missense bad LOEUF, synonymous OE scores (GRCh38) |
| `disgenet` | DisGeNET | `DISGENET_API_KEY` | Gene-disease associations via shared `entities/disgenet.ts` (`/gda/summary`, raw `Authorization` header, bounded to 2 pages / ~20 rows) |
| `diseases` | OpenTargets (GraphQL) | None | Associated diseases via `target.associatedDiseases`, up to 20 |
| `funding` | NIH Reporter | None | NIH grants mentioning gene, up to 20 |

Use `sections: ['all']` to fetch all sections, or `sections: ['core']` (default) for just the base record.

**Tool-name aliases:** MCP tool section names map onto entity keys in `SECTION_ALIASES` (gene.ts) and `GENE_STORAGE_KEYS` (server/tools/gene.ts): `clinical_evidence`↔`civic`, `protein_atlas`↔`hpa`, `dosage_sensitivity`↔`clingen`, `disease_associations`↔`disgenet`.

---

## Variant (`variant.ts`)

**Primary source:** MyVariant.info (`myvariant` connection)

### Exported Functions

```ts
variantSearch(options: VariantSearchOptions): Promise<VariantSearchResult[]>
variantGet(id: string, sections?: string[]): Promise<VariantResult>
fetchOncoKbAnnotation(gene: string, proteinChange: string): Promise<OncoKbAnnotation | null>
getVariantSearchFilters(): readonly string[]
getVariantGetSections(): readonly string[]
transformMyVariantHit(hit: any): VariantSearchResult
```

### Query Rewriting

`rewriteVariantQuery` transforms raw queries before sending to MyVariant:
- Contains `:` → passed through as-is
- Matches `^rs\d+$` → prefixed as `dbsnp.rsid:<query>`
- Matches `^[NX]M_\d+\.\d+:...` → passed through as-is
- Otherwise → passed through unchanged

### Sections

| Section | Upstream API | Auth | Notes |
|---------|-------------|------|-------|
| `core` | MyVariant.info | None | Returns the base variant fields |
| `frequency` | MyVariant.info (gnomAD fields) | None | Exome/genome AF and population breakdown from `gnomad_exome` / `gnomad_genome` |
| `predictions` | MyVariant.info (dbNSFP/CADD fields) | None | CADD, SIFT, PolyPhen, REVEL, VEST, conservation, AlphaMissense, ClinPred, MetaRNN, BayesDel |
| `clinical` | MyVariant.info (ClinVar) + CIViC (GraphQL) + OncoKB | `ONCOKB_TOKEN` for OncoKB | ClinVar + CIViC + OncoKB oncogenic/therapy data. CIViC queries `gene(entrezSymbol)` + `variants(name:)`; the `name` arg is a server-side substring pre-filter, the exact match happens client-side with both sides normalized identically (`normalizeProteinChange`) |
| `alphagenome` | — | — | **Stub**: returns `{ _error: "AlphaGenome scoring is temporarily unavailable: native gRPC transport pending reimplementation" }` — no transport exists |

### Available Filters (`getVariantSearchFilters()`)

`gene`, `hgvsp`, `hgvsc`, `rsid`, `protein_alias`, `significance`, `max_frequency`, `min_cadd`, `consequence`, `review_status`, `population`, `revel_min`, `gerp_min`, `tumor_site`, `condition`, `impact`, `lof`, `has`, `missing`, `therapy`

### Available Sections (`getVariantGetSections()`)

`core`, `frequency`, `predictions`, `clinical`, `alphagenome`

---

## Drug (`drug.ts`)

**Primary source:** MyChem.info (`mychem` connection)

### Exported Functions

```ts
drugSearch(query: string, options?: DrugSearchOptions): Promise<DrugSearchResult[]>
drugGet(name: string, sections?: string[]): Promise<DrugResult>
resolveBestMatch(name: string, hits: Array<Record<string, unknown>>): BestMatchResult | null
transformMyChemHit(hit: Record<string, unknown>): DrugSearchResult
transformMyChemResponse(data: Record<string, unknown>): DrugResult
```

`drugGet` resolves free-text names to a ChEMBL ID by scoring MyChem candidates (3 = exact ChEMBL name match, 2 = exact synonym/display name, 1 = contains).

### Sections

| Section | Upstream API | Auth | Notes |
|---------|-------------|------|-------|
| `us_regulatory` | OpenFDA | None | FDA label data (approval status, NDC codes, brand name) |
| `eu_regulatory` | — | — | **Stub**: always returns `{ authorized: false }` |
| `who_regulatory` | — | — | **Stub**: always returns `{ prequalified: false }` |
| `safety` | OpenFDA | None | Box warnings, warnings, adverse reactions from drug label |
| `targets` | OpenTargets (GraphQL) | None | Resolves ChEMBL ID via OpenTargets search, then fetches mechanisms of action with gene targets |
| `indications` | OpenTargets (GraphQL) | None | Drug indications with max clinical stage, resolved via ChEMBL ID |

---

## Disease (`disease.ts`)

**Primary source:** MyDisease.info (`mydisease` connection)

### Exported Functions

```ts
diseaseSearch(query: string, options?: DiseaseSearchOptions): Promise<DiseaseSearchResult[]>
diseaseGet(diseaseId: string, sections?: string[]): Promise<DiseaseResult>
transformMyDiseaseHit(hit: Record<string, unknown>): DiseaseSearchResult
transformMyDiseaseResponse(data: Record<string, unknown>): DiseaseResult
```

### Special Behaviors

- **Fallback lookup**: `diseaseGet` first attempts a direct `/disease/<id>` endpoint; if that fails, falls back to a `/query` search
- **Animal disease demotion**: Search results matching `MONDO:1010*` (animal diseases) are sorted to the end

### Sections

| Section | Upstream API | Auth | Notes |
|---------|-------------|------|-------|
| `gene_associations` | DisGeNET | `DISGENET_API_KEY` | Gene-disease associations via shared `entities/disgenet.ts` (`/gda/summary` with normalized disease codes, e.g. `MONDO_0007254`) |
| `phenotypes` | Monarch Initiative | None | HPO phenotype annotations filtered to `HP:` prefixed terms, up to 20 |
| `pathways` | Reactome | None | Pathway search by disease ID, up to 20 |

---

## Article (`article/`)

**Primary source:** PubMed (via the shared `eutils` connection) for get; federated across 5 sources for search

### Architecture

```
article/
├── index.ts              # Re-exports all public API
├── types.ts              # Article, ArticleSearchOptions, ArticleResult, ArticleGetOptions
├── europepmc-shared.ts   # Shared EuropePMC helpers
├── semantic-scholar-queue.ts  # Global single-flight queue for ALL Semantic Scholar traffic
├── search/               # Search backends (5 sources)
│   ├── index.ts          # articleSearch() orchestrator + federatedSearch (20s per-backend throw timeout)
│   ├── dedup.ts          # deduplicateAndRank()
│   ├── pubmed.ts         # searchPubMed(), formatPubMedDate()
│   ├── europepmc.ts      # searchEuropePMC(), transformEuropePMC() (cursorMark deep pagination)
│   ├── semantic-scholar.ts # searchSemanticScholar(), transformSemanticScholar()
│   ├── pubtator.ts       # searchPubTator(), transformPubTator()
│   └── litsense.ts       # searchLitSense(), transformLitSense()
├── detail/               # Article get + sections
│   ├── index.ts          # articleGet() orchestrator (sections run via Promise.allSettled)
│   ├── id-resolution.ts  # parseArticleId(), resolveToPmid(), resolveDoiToPmid()
│   ├── open-access.ts    # fetchOpenAccess(), parseOaXml()
│   └── annotations.ts    # fetchAnnotations(), fetchCitationGraph()
├── citation/             # Citation providers
│   ├── index.ts          # getCitations() orchestrator (federated)
│   ├── types.ts          # ArticleId, CitationRecord, CitationCount, FederatedCitationResult
│   ├── cache.ts          # 10-minute federated result cache
│   ├── pubmed.ts         # PubMed elink-based provider (+ EFetch enrichment)
│   ├── europepmc.ts      # EuropePMC citations/references API
│   ├── semantic-scholar.ts # Semantic Scholar graph API
│   ├── crossref.ts       # Crossref count + backward references provider
│   └── opencitations.ts  # OpenCitations v2 DOI-based provider
└── transform/
    └── pubmed.ts         # parsePubMedXml()
```

### Exported Functions

```ts
articleSearch(query: string, options?: ArticleSearchOptions): Promise<Article[]>
articleGet(identifier: string, sections?: string[]): Promise<ArticleResult>
getCitations(id: ArticleId, options?: { direction?: 'forward' | 'backward' | 'both'; source?; limit?; full?; articleYear? }): Promise<FederatedCitationResult>
deduplicateAndRank(articles: Article[], limit: number): Article[]
transformEuropePMC(a: EuropePMCResult): Article
transformSemanticScholar(a: SemanticScholarPaper): Article
transformPubTator(a: PubTatorResult): Article
transformLitSense(a: LitSenseResult): Article
```

(`getCitations` is exported from `article/citation/index.ts`, not the article barrel.)

### Federated Search

When no `source` is specified, `articleSearch` queries all 5 backends concurrently via `Promise.allSettled`, each wrapped in a 20-second throw-mode `withTimeout` so a hung backend is recorded as an error result. With `dateRange` set, only the 3 backends that support date filtering run (PubMed, Europe PMC, Semantic Scholar).

| Backend | Connection | Notes |
|---------|-----------|-------|
| PubMed | `eutils` | Two-step: `esearch` → `efetch` XML → `parsePubMedXml` |
| Europe PMC | `europepmc` | Supports `cursorMark` for deep pagination, `dateRange` as year range |
| Semantic Scholar | `semantic_scholar` | REST API with `externalIds` mapping; all S2 traffic (search + citations) is serialized through the single-flight `semantic-scholar-queue` to avoid unauthenticated 429s |
| PubTator | `pubtator` | BioNER-annotated search; server-side pagination via `page`/`size` (size clamped 10–100, page derived from offset) |
| LitSense | `litsense` | Sentence-level search (NCBI) via `limit=` param |

Results are deduplicated by PMID/PMCID/DOI and ranked by citation count via `deduplicateAndRank`.

### Federated Citation

When the `citation` section is requested, `getCitations` queries citation providers concurrently via `Promise.allSettled`. Within each provider, forward/backward/count requests run in parallel. Timeouts are unified in `connections/fetch-utils.ts` (`withTimeout`, `DEFAULT_PROVIDER_TIMEOUT_MS = 10000`, `'null'` mode for citation providers) — see `connections/README.md` for the full timeout layering.

**Fast mode** (default) queries 4 providers (`FAST_PROVIDER_IDS`); **full mode** (`full: true`) adds PubMed. Fast mode falls back to PubMed when a PMID is available and the fast providers returned counts but no items (or backward items but no forward ones).

| Provider | Fast Mode | Forward Citations | Backward References | Citation Count | Notes |
|----------|:-:|---|---|---|---|
| Europe PMC | ✓ | `/MED/{pmid}/citations` (`citationList.citation`) | `/MED/{pmid}/references` | `citedByCount` from search | Resolves DOI/PMCID → PMID first |
| Semantic Scholar | ✓ | `/graph/v1/paper/{id}/citations` | `/graph/v1/paper/{id}/references` | `citationCount` | Serialized through the S2 single-flight queue; 429s degrade to partial results (no retry) |
| Crossref | ✓ | — (upstream removed the `references:` filter) | `reference` array from `/works/{doi}` | `is-referenced-by-count` | DOI-based; work response cached within query |
| OpenCitations | ✓ | `/citations/doi:{doi}` | `/references/doi:{doi}` | `/citation-count/doi:{doi}` | v2 API (`api.opencitations.net/index/v2`), `doi:`-prefixed paths, redirects refused |
| PubMed | full only | elink `pubmed_pubmed_citedin` + EFetch enrichment | elink `pubmed_pubmed_refs` | derived from elink | PMID-centric |

**Caching**: federated results cached 10 minutes (citation/cache.ts); per-query caches use short TTLs (Crossref work 60s, PubMed elink 30s). Use `clearCitationCache()` to clear.

Citation records are deduplicated by PMID (primary), then DOI, then PMCID; for duplicates the record with the most populated fields is kept (field-completeness scoring). `articleYear` filters backward references to same-year-or-earlier.

### Sections

| Section | Upstream API | Auth | Notes |
|---------|-------------|------|-------|
| `open_access` (alias `oa`) | NCBI ID Converter + PMC OA | None | Resolves PMCID → parses OA XML for PDF URL |
| `annotations` | PubTator (BioC JSON) | None | NER annotations (genes, diseases, variants, etc.) with offset positions |
| `citation_graph` (alias `graph`) | PubMed E-utilities (`elink`) | None | Forward citations and references as PMID lists. **Deprecated** — use `citation` |
| `citation` | citation providers (federated) | `S2_API_KEY` optional | Rich citation data with metadata, counts from multiple sources, deduplicated |

### Special Behaviors

- `articleGet` accepts numeric PMIDs, PMCIDs (via ID Converter), and DOIs (via ID Converter or PubMed esearch fallback)
- Error messages include contextual hints (e.g., rate-limit advice for 429, index-not-found for 400)
- The `graph` section is deprecated in favor of `citation`; both work for backward compatibility

---

## Trial (`trial.ts`)

**Primary source:** ClinicalTrials.gov API v2 (`clinicaltrials` connection)

### Exported Functions

```ts
trialSearch(query: string, options?: TrialSearchOptions): Promise<TrialSearchResponse>
trialGet(nctId: string, sections?: string[]): Promise<TrialResult>
transformTrialSearchResult(trial: ClinicalTrialsSearchStudy): TrialSearchResult
transformTrialResponse(data: ClinicalTrialsDetailStudy): TrialResult
```

`TrialSearchResponse` is `{ studies: TrialSearchResult[]; nextPageToken?: string }` — pass `nextPageToken` back as `pageToken` for cursor-based pagination (replaces the old `offset` param).

### Search Behavior

- `searchType: 'condition'` (default) → `query.cond` parameter
- `searchType: 'intervention'` → `query.intr` parameter
- `status` is uppercased before sending

### Sections

| Section | Upstream API | Auth | Notes |
|---------|-------------|------|-------|
| `eligibility` | ClinicalTrials.gov | None | Criteria text, age limits, sex, healthy volunteers |
| `locations` | ClinicalTrials.gov | None | Facility, city, state, country, zip, recruitment status |
| `outcomes` | ClinicalTrials.gov | None | Primary and secondary outcome measures with timeframes |

All sections re-fetch the full study record from `/studies/<nctId>` and extract the relevant `protocolSection` submodule.

---

## PDB (`pdb.ts`)

**Primary sources:** RCSB PDB Data API (`pdb_data` connection), Search API (`pdb_search` connection), File Download (`pdb_files` connection)

### Exported Functions

```ts
pdbSearch(query: string, options?: PdbSearchOptions): Promise<PdbSearchResult[]>
pdbGet(pdbId: string, sections?: string[]): Promise<PdbResult>
pdbDownload(pdbId: string, format?: 'cif' | 'pdb'): Promise<PdbDownloadResult>
validatePdbId(pdbId: string): void
formatFileSize(bytes: number): string
```

### Search Behavior

- Uses `post()` on the `pdb_search` connection (RCSB Search API v2, POST to `/query`)
- Full-text search via `service: "full_text"` with compact verbosity
- Fetches summary metadata for top results in parallel via `fetchWithTimeout`
- Handles empty results (204 No Content) gracefully

### Sections

| Section | Upstream API | Auth | Notes |
|---------|-------------|------|-------|
| `polymer_entities` | RCSB Data API `/core/polymer_entity/{id}_{entityId}` | None | One request per polymer entity from `container_ids` |
| `ligands` | RCSB Data API `/core/nonpolymer_entity/{id}_{entityId}` | None | One request per non-polymer entity |
| `assembly` | RCSB Data API `/core/assembly/{id}-{assemblyId}` | None | One request per biological assembly |
| `experiment` | Extracted from core `exptl`, `refine`, `em_3d_reconstruction` | None | No additional network request |
| `citation` | Extracted from core `rcsb_primary_citation` | None | No additional network request |

### Download & Validation

- Fetches from `https://files.rcsb.org/download/{id}.{ext}`; saves to OS temp directory (`mkdtempSync`) with timestamped filename
- Default format is `cif` (mmCIF, universally available); legacy `pdb` format may 404 for some entries and returns a clear error suggesting retry with `cif`
- Files >1 MB include `_warn` field advising the agent to use grep/read specific line ranges
- `validatePdbId` rejects IDs not matching `/^[A-Za-z0-9]{4}$/`; AlphaFold/CSM IDs (`AF_`/`MA_` prefix) are rejected with a pointer to AlphaFold DB

---

## Patent (`patent/`)

Directory module at `src/entities/patent/`. See `src/entities/patent/README.md` for the full architecture, source ladder, seminal prior-art discovery, verified API contract appendix, and degradation behavior.

```ts
patentSearch(query: string, options?: PatentSearchOptions): Promise<PatentSearchResponse>
patentGet(publicationNumber: string, sections?: string[]): Promise<PatentResult>
```

### Sections (per-section priority chains, auth-aware)

| Section | Chain |
|---------|-------|
| `core` (default) | OPS biblio → GP/Wayback → PPUBS (US) |
| `abstract` | OPS abstract → GP/Wayback → PPUBS (US) |
| `claims` | PPUBS `claimsHtml` (US) → OPS claims (EP/WO/EU/CA — no US fulltext) → GP/Wayback; capped ~100 KB with `_warn` |
| `citations` | OPS backward + `ct=` forward → GP/Wayback → PPUBS `usRef*`/`foreignRef*` |
| `family` | OPS INPADOC family → GP/Wayback `docdbFamily` → PPUBS (US) |
| `classifications` | OPS IPC+CPC → GP/Wayback → ODP/PPUBS (US) |

Google Patents detail falls back to Wayback Machine snapshots when live access is blocked (IP-block proven; see patent README).

---

## GEO (`geo.ts`)

**Primary sources:** NCBI E-utilities db=gds (`eutils` connection), GEO SOFT viewer (`geo_soft` connection)

### Exported Functions

```ts
geoSearch(query: string, options?: GeoSearchOptions): Promise<GeoSearchResult[]>
geoGet(accession: string, options?: GeoGetOptions): Promise<GeoDetail>
geoToSraAccessions(accession: string): Promise<string[]>
```

`GeoSearchOptions` filters by `entryType` (`gse`/`gsm`/`gpl`/`gds`, appended as `[ETYP]`), `organism` (`[ORGN]`), `limit` (≤50), `offset`. `GeoGetOptions` controls optional supplementary-file download (`download`, `maxBytes` ≥ 1 MB, default 50 MB).

### Behavior

- `geoGet` validates the accession (GSE/GSM/GPL only — GDS curated DataSets are rejected with a pointer to the underlying series/sample), fetches the SOFT record (`acc.cgi?targ=self&form=text&view=full`), parses it via `transform/soft.ts`, and enriches series details with best-effort esummary gds metadata (sample preview ≤20, n_samples, PubMed IDs, BioProject, SRA tokens). Enrichment failure degrades to SOFT-only output
- SOFT relations power the cross-links: `sra` (SRP/SRX/SRR tokens from `SRA:` relations), `bioproject`, `super_series`/`sub_series`, `series` (from a sample back to its GSE)
- The SOFT endpoint may serve HTML block pages to datacenter IPs — detected and surfaced as an explicit error
- `geoToSraAccessions` (SOFT relations → esummary extrelations → elink fallback) is not exposed as a tool

### Source / Auth

| Source | Connection | Auth | Notes |
|--------|-----------|------|-------|
| E-utilities gds | `eutils` | `NCBI_API_KEY` optional | esearch + esummary; shared 3 req/s NCBI budget |
| GEO SOFT viewer | `geo_soft` | None | Plain-text SOFT records; 300 ms rate interval; HTML block-page sniffing |

---

## SRA (`sra/`)

**Primary source:** NCBI E-utilities db=sra (`eutils` connection)

### Exported Functions

```ts
sraSearch(query: string, options?: { limit?: number; offset?: number }): Promise<SraSearchResultItem[]>
sraGet(accession: string): Promise<SraDetail>
```

Directory module: `index.ts` (E-utilities orchestration) + `transform/experiment-package.ts` (fast-xml-parser for SRA experiment-package XML → `SraRecord`).

### Behavior

- `sraSearch` runs esearch db=sra, then efetches experiment-package XML in batches of 10; items carry `experiment_accession`, `study_accession`, `sample_accession`, `organism`, `library_strategy`, `run_count`, `first_run_accession`, `bioproject`
- `sraGet` dispatches on the accession prefix: SRR → run detail (instrument, `total_spots`/`total_bases`/`size_bytes`), SRP → study detail (experiment list, capped at 50), SRS → sample detail (matching experiments), otherwise SRX experiment detail (library strategy/source/selection/layout, platform, runs)
- ENA (ERP/ERR) and DDBJ (DRP/DRR) accessions are rejected at the tool layer with an ENA pointer — NCBI SRA does not index them
- efetch responses are multi-MB; batch size 10 (far below the 200-id eutils cap) keeps responses bounded

### Source / Auth

| Source | Connection | Auth | Notes |
|--------|-----------|------|-------|
| E-utilities sra | `eutils` | `NCBI_API_KEY` optional | esearch + efetch XML; shared 3 req/s NCBI budget |

---

## GenBank (`genbank.ts`)

**Primary source:** NCBI E-utilities db=nuccore (`eutils` connection)

### Exported Functions

```ts
genbankSearch(query: string, options?: GenbankSearchOptions): Promise<GenbankSearchResult[]>
genbankGet(accession: string, options?: GenbankGetOptions): Promise<GenbankRecord>
genbankToGeneIds(accession: string): Promise<number[]>
```

### Behavior

- `genbankGet` fetches esummary metadata first (length, organism, sourcedb), then validates region constraints: whole records capped at 2,000,000 bp (larger requires `seq_start`/`seq_stop`), region span ≤ 10 Mb, coordinates ≤ record length, `seq_start > seq_stop` only with `strand: 2`; rettype switches to `gbwithparts` for records > 20 Mb
- `sequence_text` is the raw efetch text (GenBank flat file or FASTA); a hard `maxResponseBytes` cap (default 30 MB) errors on oversized responses instead of truncating
- `genbankToGeneIds` runs elink nuccore→gene (≤100 links) — entrezgene IDs for MyGene-backed tools
- `NCBI_API_KEY` optional (higher rate limits)

### Source / Auth

| Source | Connection | Auth | Notes |
|--------|-----------|------|-------|
| E-utilities nuccore | `eutils` | `NCBI_API_KEY` optional | esearch + esummary + efetch + elink; shared 3 req/s NCBI budget |

---

## GTEx (`gtex.ts`)

**Primary source:** GTEx Portal API v2 (`gtex` connection, https://gtexportal.org)

### Exported Functions

```ts
gtexMedianExpression(geneIdentifier: string, options?: { tissueSiteDetailId?: string; limit?: number }): Promise<GTExMedianExpressionResult>
gtexEqtl(geneIdentifier: string, tissueSiteDetailId: string, options?: { limit?: number }): Promise<GTExEqtlResult>
resolveGencodeId(geneIdentifier: string): Promise<GencodeIdResolution>
getGtexTissues(): Promise<GTExTissueInfo[]>
getGtexDatasets(): Promise<GTExDatasetInfo[]>
```

### Behavior

- Dataset selection: latest `gtex_vN` release derived from `/api/v2/metadata/dataset` with a pinned `gtex_v10` fallback when metadata is unavailable (non-GTEx datasets like kids_first_harmonization are excluded)
- Gene resolution: HGNC symbols and Ensembl IDs (bare or versioned) resolve to a versioned `gencodeId` via `/api/v2/reference/geneSearch` — symbol queries are prefix-fuzzy (TP53 also returns TP53BP2...), so an exact `geneSymbolUpper` match is required (up to 2 pages). Unversioned ENSG yields empty data with HTTP 200 from expression endpoints, hence the mandatory resolver. Results memoized per identifier
- `gtexMedianExpression` returns tissues sorted by median TPM descending (54 tissue sites, limit-clipped); `tissueSiteDetailId` filters to a single tissue
- `gtexEqtl` validates the tissue against the dataset tissue list, then returns associations sorted by ascending p-value; empty `data` with HTTP 200 is legitimate (no significant eQTLs) and yields `associations: []`

### Source / Auth

| Source | Connection | Auth | Notes |
|--------|-----------|------|-------|
| GTEx Portal API v2 | `gtex` | None | Keyless; 100 ms rate interval |

---

## Ensembl (`ensembl.ts`)

**Primary source:** Ensembl REST (https://rest.ensembl.org, `ensembl` connection — keyless, 55,000 req/hour per IP verified via `x-ratelimit-*` headers; 100 ms serial pacing + retry for transient 500/503s)

> **Excluded endpoints:** `/xrefs/*` and `/phenotype/*` hung/503'd consistently during 2026-08 probing and are deliberately not used (documented in the module header comment); external references come from `/lookup?expand=1` instead. `/homology/symbol` also proved flaky — symbols resolve to stable IDs via `/lookup` first, then only `/homology/id` is hit.

### Exported Functions

```ts
ensemblLookup(geneOrId: string, options?: { species?: string; expand?: boolean }): Promise<EnsemblGeneInfo>
ensemblHomology(gene: string, options?: { species?: string; type?: 'orthologues' | 'paralogues'; target_species?: string; target_taxon?: number; limit?: number }): Promise<EnsemblHomologyResult>
ensemblConsequence(variant: string, options?: { species?: string; limit?: number }): Promise<EnsemblConsequenceResult>
ensemblRegion(region: string, options?: { species?: string; features?: ('gene' | 'transcript' | 'variation')[]; limit?: number }): Promise<EnsemblRegionResult>
resolveEnsemblGene(geneIdentifier: string, species?: string): Promise<EnsemblGeneInfo>
isEnsemblGeneId(input: string): boolean
```

### Behavior

- `ensemblLookup`: `/lookup/symbol/{species}/{symbol}` or `/lookup/id/{ensg}` (auto-routed on ID prefix; transcript/protein IDs rejected with guidance). `expand=1` adds transcripts with translation/protein IDs, exon counts, canonical flags
- `ensemblHomology`: Compara orthologues/paralogues with percent identity, sorted desc (nulls last), limit-clipped with `truncated` marker; semicolon-matrix params (`type=…;target_species=…`) verified live
- `ensemblConsequence`: VEP compute-on-demand — HGVS c./p./g. via GET `/vep/{species}/hgvs/{url-encoded}`; rsIDs via POST `/vep/{species}/id` (the GET rsID form does not exist upstream). Both forms return an **array** of results (unwrapped to the first entry). Effects sorted by impact severity (HIGH > MODERATE > LOW > MODIFIER), limit-clipped; colocated ClinVar/COSMIC/gnomAD data capped at 5 entries
- `ensemblRegion`: `/overlap/region/{species}/{chr}:{start}-{end}` with REPEATED `feature=` params (comma lists are rejected upstream); region format validated, span ≤ 10 Mb; results capped at `limit` with `total`/`truncated`
- Species passes through verbatim (aliases like `mouse` accepted upstream); invalid species surface as upstream 400s

### Source / Auth

| Source | Connection | Auth | Notes |
|--------|-----------|------|-------|
| Ensembl REST | `ensembl` | None | Keyless; 100 ms interval under the 55k/hr IP budget; retry 3×200 ms |

---

## Cross-Entity (`cross-entity.ts`)

Orchestrates queries that span multiple entity types. All pivot functions delegate to the appropriate entity's search/get or query upstream APIs directly.

### Pivot Functions

```ts
geneToDrugs(geneSymbol: string): Promise<Array<{ drug_name: string; source: string; action_type?: string }>>
geneToTrials(geneSymbol: string): Promise<Array<{ nct_id: string; title?: string; status?: string }>>
geneToPathways(geneSymbol: string): Promise<Array<{ pathway_id: string; name: string; source: string }>>
geneToArticles(geneSymbol: string): Promise<Article[]>
variantToTrials(variantId: string): Promise<Array<{ nct_id: string; title?: string; status?: string }>>
drugToGenes(drugName: string): Promise<Array<{ gene_symbol: string; name: string; source: string; action_type?: string }>>
drugToTrials(drugName: string): Promise<Array<{ nct_id: string; title?: string; status?: string }>>
drugToAdverseEvents(drugName: string): Promise<Array<{ reaction?: string; frequency?: string; source?: string }>>
diseaseToDrugs(diseaseQuery: string): Promise<Array<{ drug_name: string; source: string; phase?: string }>>
diseaseToGenes(diseaseId: string): Promise<Array<{ gene_symbol: string; name: string; source: string; score?: number }>>
diseaseToTrials(diseaseQuery: string): Promise<Array<{ nct_id: string; title?: string; status?: string }>>
```

### Pivot Upstream Sources

| Function | Primary Source | Auth |
|----------|---------------|------|
| `geneToDrugs` | OpenTargets (GraphQL) | None |
| `geneToTrials` | ClinicalTrials.gov (via `trialSearch`) | None |
| `geneToPathways` | Reactome | None |
| `geneToArticles` | Federated article search (via `articleSearch`) | None |
| `variantToTrials` | ClinicalTrials.gov (via `trialSearch`) | None |
| `drugToGenes` | OpenTargets (GraphQL) | None |
| `drugToTrials` | ClinicalTrials.gov (via `trialSearch`, `searchType: 'intervention'`) | None |
| `drugToAdverseEvents` | OpenFDA (`/drug/event.json`) | None |
| `diseaseToDrugs` | MyDisease (ID resolution) + OpenTargets (GraphQL) | None |
| `diseaseToGenes` | DisGeNET via shared `entities/disgenet.ts` (`/gda/summary`) | `DISGENET_API_KEY` |
| `diseaseToTrials` | ClinicalTrials.gov (via `trialSearch`) | None |

#### `diseaseToDrugs` ID Resolution

When the input matches `^(DOID|MONDO|OMIM|OMOPS|ORPHA):`, the function first resolves it via MyDisease to get a human-readable label. If the MONDO-based OpenTargets search fails, it tries an EFO ID probe (`MONDO:` → `MONDO_`).

### Search All

```ts
searchAll(query: string, options?: { limit?: number; entities?: string[] }): Promise<SearchAllResult[]>
```

- Searches across all 6 entity types concurrently via `Promise.allSettled`
- Default entities: `['gene', 'variant', 'drug', 'disease', 'article', 'trial']`
- Default limit: 5 per entity

**Exported type:** `SearchAllResult { entity_type: string; results: unknown[] }`

### Enrichment

```ts
geneEnrichment(geneSymbols: string[]): Promise<PathwayEnrichmentResult[]>
```

- Requires **at least 3** gene symbols
- Posts newline-delimited symbols (plain-text body, not JSON) to Reactome AnalysisService `/identifiers/projection` via the `reactome_analysis` connection (registry-supplied timeout/retry/rate-limit)
- Returns up to 30 pathways with `p_value`, `genes_overlap`, `genes_total`; timeouts degrade to an `_error` row instead of throwing

**Exported type:** `PathwayEnrichmentResult { pathway_id, name, p_value?, genes_overlap?, genes_total?, source }`

### Discovery

```ts
discover(query: string): Promise<DiscoverResult[]>
```

- Searches gene, variant, drug, and disease concurrently via `Promise.allSettled` (limit 3 each)
- Returns at most one result per entity type
- If no bio-entity matches, falls back to OLS4 (`ols4` connection) ontology search

**Exported type:** `DiscoverResult { entity_type, identifier, name, source?, description?, matches? }`

### Batch Get

```ts
batchGet(inputs: BatchGetInput[]): Promise<BatchGetResult[]>
```

- Dynamically imports the appropriate entity `get` function based on `input.entity`
- Supports: `gene`, `variant`, `drug`, `disease`, `trial`, `article`, `patent`
- Each input is independent; failures are captured per-item

**Exported types:**

```ts
BatchGetInput { entity: string; id: string; sections?: string[] }
BatchGetResult { entity: string; id: string; success: boolean; data?: unknown; error?: string }
```

All outbound fetch is proxy-aware — see `src/connections/README.md` (Proxy-aware fetch).
