# Entities Layer

The business logic layer for biomcp-ts. Each entity module (gene, variant, drug, disease, article, trial, pdb) implements a consistent **search / get / sections** pattern:

1. **`search`** — queries a primary data source with filters, returns lightweight result arrays
2. **`get`** — fetches a single entity by identifier, optionally enriching with parallel section fetches
3. **Sections** — optional data slices fetched concurrently from upstream APIs; each section has its own upstream source and auth requirements

## Section Fetching Strategy

All entity `get` functions (except article) use the same pattern:

- Sections are dispatched via `Promise.allSettled` with an **8-second timeout** per section (`fetchWithTimeout`, `SECTION_TIMEOUT_MS = 8000`)
- Fulfilled sections populate `result.sections[<name>]`
- Failed sections (timeout, network error, auth missing) populate `result.sections[<name>] = { error: "..." }`
- Section fetchers return `{ _error: "..." }` as a single-element array or object when the upstream source itself fails (e.g., `{ _error: "Pathway lookup failed (source: reactome): ..." }`)
- The article entity does **not** use `Promise.allSettled` for sections; it fetches sequentially

---

## Gene (`gene.ts`)

**Primary source:** MyGene.info (`mygene` connection)

### Exported Functions

```ts
geneSearch(query: string, options?: GeneSearchOptions): Promise<GeneSearchResult[]>
geneGet(symbol: string, sections?: string[]): Promise<GeneResult>
transformMyGeneResponse(data: MyGeneGetResponse['hits'][0]): GeneResult
```

### Exported Types

| Type | Fields |
|------|--------|
| `GeneSearchOptions` | `gene_type?: 'protein-coding' \| 'ncRNA' \| 'pseudo'`, `chromosome?: string`, `limit?: number`, `offset?: number` |
| `GeneSearchResult` | `symbol`, `name`, `entrez_id?`, `genomic_coordinates?: { chromosome, start, end }`, `uniprot_id?`, `omim_id?` |
| `GeneGetOptions` | `sections?: string[]` |
| `GeneResult` | `symbol`, `name`, `summary?`, `chromosome?`, `position?`, `sections?: Record<string, unknown>` |

### Sections

| Section | Upstream API | Auth | Notes |
|---------|-------------|------|-------|
| `pathways` | Reactome | None | Searches by gene symbol, filters `types=Pathway`, returns up to 20 |
| `protein` | UniProt | None | Queries `gene:<symbol> AND organism_id:9606` |
| `ontology` | MyGene.info | None | Fetches GO terms from MyGene `go` field (BP/MF/CC), deduplicates, up to 20 |
| `go` | MyGene.info | None | Same upstream as `ontology` but returns up to 50 terms with `aspect` field |
| `interactions` | STRING-db | None | Interaction partners via `/json/interaction_partners`, up to 20 |
| `civic` | CIViC (GraphQL) | None | Clinical variants for gene |
| `expression` | GTEx | None | Resolves Ensembl ID via MyGene, then tries multiple Ensembl version suffixes (`.13`, `.12`, `.14`...) against GTEx v8 median expression |
| `hpa` | Human Protein Atlas | None | Subcellular location from `/search` |
| `druggability` | DGIdb (GraphQL) + OpenTargets (GraphQL) | None | DGIdb drug interactions + OpenTargets tractability |
| `clingen` | — | — | **Stub**: always returns `{ _error: "...not available via public API..." }` |
| `constraint` | gnomAD (GraphQL) | None | LOEUF, missense bad LOEUF, synonymous OE scores (GRCh38) |
| `disgenet` | DisGeNET | `DISGENET_API_KEY` | Gene-disease associations, up to 20 |
| `diseases` | OpenTargets (GraphQL) | None | Associated diseases via `target.associatedDiseases`, up to 20 |
| `funding` | NIH Reporter | None | NIH grants mentioning gene, up to 20 |

Use `sections: ['all']` to fetch all sections, or `sections: ['core']` (default) for just the base record.

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

### Exported Types

| Type | Fields |
|------|--------|
| `VariantSearchOptions` | `query?: string`, `gene?: string`, `hgvsp?: string`, `significance?: 'benign' \| 'likely_benign' \| 'pathogenic' \| 'likely_pathogenic' \| 'uncertain'`, `max_frequency?: number`, `limit?: number`, `offset?: number` |
| `VariantSearchResult` | `id`, `gene?`, `hgvs_p?`, `hgvs_c?`, `significance?`, `clinvar_stars?`, `gnomad_af?` |
| `VariantGetOptions` | `sections?: string[]` |
| `VariantResult` | `id`, `gene?`, `hgvs_p?`, `hgvs_c?`, `rsid?`, `cosmic_id?`, `significance?`, `conditions?`, `sections?: Record<string, unknown>` |
| `FrequencySection` | `gnomad_af?`, `gnomad_exome_af?`, `gnomad_genome_af?`, `exac_af?`, `popul_max?`, `population_breakdown?: Record<string, number>` |
| `PredictionsSection` | `cadd_score?`, `cadd_phred?`, `sift_score?`, `sift_pred?`, `polyphen_score?`, `polyphen_pred?`, `revel_score?`, `vest_score?`, `conservation?: { phylop?, phastcons?, gerp? }`, `other?: { alphamissense?, clinpred?, metarnn?, bayesdel? }` |
| `ClinicalSection` | `clinvar?: { id?, significance?, stars?, conditions?, review_status?, submitters? }`, `cancer?: { oncogenic?, effect?, therapies? }`, `civic?: { id?, clinical_significance?, evidence_score? }` |
| `AlphaGenomeSection` | `expression_lfc?`, `splice_score?`, `chromatin_score?`, `top_gene?`, `scorers?` |
| `OncoKbAnnotation` | `oncogenic?`, `level?`, `effect?`, `therapies?: Array<{ name, level?, drugs? }>` |

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
| `frequency` | MyVariant.info (gnomAD fields) | None | Extracts exome/genome AF and population breakdown from `gnomad_exome` / `gnomad_genome` |
| `predictions` | MyVariant.info (dbNSFP/CADD fields) | None | Aggregates CADD, SIFT, PolyPhen, REVEL, VEST, conservation, AlphaMissense, ClinPred, MetaRNN, BayesDel |
| `clinical` | MyVariant.info (ClinVar) + CIViC (GraphQL) + OncoKB | `ONCOKB_TOKEN` for OncoKB | ClinVar + CIViC variant annotations + OncoKB oncogenic/therapy data |
| `alphagenome` | AlphaGenome (gRPC) | `ALPHAGENOME_API_KEY` | Expression LFC, splice scores, chromatin scores via GeneMaskLFCScorer, GeneMaskSplicingScorer, CenterMaskScorer |

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
transformMyChemHit(hit: Record<string, unknown>): DrugSearchResult
transformMyChemResponse(data: Record<string, unknown>): DrugResult
```

### Exported Types

| Type | Fields |
|------|--------|
| `DrugSearchOptions` | `drug_type?: string`, `source?: string`, `limit?: number`, `offset?: number` |
| `DrugSearchResult` | `name`, `chembl_id?`, `inchi_key?`, `synonyms?`, `molecular_formula?`, `molecular_weight?`, `chebi_id?`, `unii?` |
| `DrugGetOptions` | `sections?: string[]` |
| `DrugResult` | `name`, `chembl_id?`, `aliases?`, `molecular_formula?`, `molecular_weight?`, `smiles?`, `inchi?`, `inchi_key?`, `sections?: Record<string, unknown>` |

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

### Exported Types

| Type | Fields |
|------|--------|
| `DiseaseSearchOptions` | `disease_type?: string`, `limit?: number`, `offset?: number` |
| `DiseaseSearchResult` | `name`, `disease_id`, `mondo_id?`, `doid?` |
| `DiseaseGetOptions` | `sections?: string[]` |
| `DiseaseResult` | `name`, `disease_id`, `description?`, `ontology?`, `sections?: Record<string, unknown>` |

### Special Behaviors

- **Fallback lookup**: `diseaseGet` first attempts a direct `/disease/<id>` endpoint; if that fails, falls back to a `/query` search
- **Animal disease demotion**: Search results matching `MONDO:1010*` (animal diseases) are sorted to the end

### Sections

| Section | Upstream API | Auth | Notes |
|---------|-------------|------|-------|
| `gene_associations` | DisGeNET | `DISGENET_API_KEY` | Gene-disease associations, up to 20 |
| `phenotypes` | Monarch Initiative | None | HPO phenotype annotations filtered to `HP:` prefixed terms, up to 20 |
| `pathways` | Reactome | None | Pathway search by disease ID, up to 20 |
| `survival` | SEER | None | Median overall and progression-free survival |

---

## Article (`article.ts`)

**Primary source:** PubMed (`pubmed` connection) for get; federated across 5 sources for search

### Exported Functions

```ts
articleSearch(query: string, options?: ArticleSearchOptions): Promise<Article[]>
articleGet(identifier: string, sections?: string[]): Promise<ArticleResult>
deduplicateAndRank(articles: Article[], limit: number): Article[]
transformEuropePMC(a: EuropePMCResult): Article
transformSemanticScholar(a: SemanticScholarPaper): Article
transformPubTator(a: PubTatorResult): Article
transformLitSense(a: LitSenseResult): Article
```

### Exported Types

| Type | Fields |
|------|--------|
| `ArticleSearchOptions` | `source?: 'pubmed' \| 'europepmc' \| 'semantic_scholar' \| 'pubtator' \| 'litsense'`, `limit?`, `offset?`, `cursorMark?` |
| `Article` | `pmid?`, `pmcid?`, `doi?`, `title?`, `abstract?`, `authors?`, `journal?`, `publication_date?`, `cited_by?`, `is_open_access?`, `source?`, `score?`, `mesh_headings?`, `publication_types?`, `keywords?`, `chemicals?` |
| `ArticleGetOptions` | `sections?: string[]` |
| `ArticleResult` | Extends `Article` with `sections?: Record<string, unknown>` |

### Federated Search

When no `source` is specified, `articleSearch` queries all 5 backends concurrently via `Promise.allSettled`:

| Backend | Connection | Notes |
|---------|-----------|-------|
| PubMed | `pubmed` | Two-step: `esearch` → `efetch` XML → `parsePubMedXml` |
| Europe PMC | `europepmc` | Supports `cursorMark` for deep pagination |
| Semantic Scholar | `semantic_scholar` | REST API with `externalIds` mapping |
| PubTator | `pubtator` | BioNER-annotated search |
| LitSense | `litsense` | Sentence-level search (NCBI) |

Results are deduplicated by PMID/PMCID/DOI and ranked by citation count via `deduplicateAndRank`.

### Sections (sequential, not Promise.allSettled)

| Section | Upstream API | Auth | Notes |
|---------|-------------|------|-------|
| `open_access` | NCBI ID Converter + PMC OA | None | Resolves PMCID → parses OA XML for PDF URL |
| `annotations` | PubTator (BioC JSON) | None | NER annotations (genes, diseases, variants, etc.) with offset positions |
| `citation_graph` | PubMed E-utilities (`elink`) | None | Forward citations (`pubmed_pubmed_citedin`) and references (`pubmed_pubmed_refs`) |

### Special Behaviors

- `articleGet` only accepts numeric PMIDs; other identifiers throw
- Error messages include contextual hints (e.g., rate-limit advice for 429, index-not-found for 400)

---

## Trial (`trial.ts`)

**Primary source:** ClinicalTrials.gov API v2 (`clinicaltrials` connection)

### Exported Functions

```ts
trialSearch(query: string, options?: TrialSearchOptions): Promise<TrialSearchResult[]>
trialGet(nctId: string, sections?: string[]): Promise<TrialResult>
transformTrialSearchResult(trial: ClinicalTrialsSearchStudy): TrialSearchResult
transformTrialResponse(data: ClinicalTrialsDetailStudy): TrialResult
```

### Exported Types

| Type | Fields |
|------|--------|
| `TrialSearchOptions` | `status?: string`, `phase?: string`, `intervention_type?: string`, `searchType?: 'condition' \| 'intervention'`, `limit?`, `offset?` |
| `TrialSearchResult` | `nct_id`, `title?`, `status?`, `phase?`, `conditions?`, `interventions?`, `sponsor?` |
| `TrialGetOptions` | `sections?: string[]` |
| `TrialResult` | `nct_id`, `title?`, `short_title?`, `status?`, `phase?`, `conditions?`, `interventions?`, `sponsor?`, `collaborator?`, `contacts?`, `sections?: Record<string, unknown>` |

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

### Exported Types

| Type | Fields |
|------|--------|
| `PdbSearchOptions` | `limit?: number`, `offset?: number` |
| `PdbSearchResult` | `pdb_id`, `score?`, `summary?: PdbEntrySummary` |
| `PdbEntrySummary` | `pdb_id`, `title`, `experimental_method?`, `resolution?`, `molecular_weight?`, `polymer_count?`, `polymer_composition?`, `deposition_date?`, `release_date?`, `organism?`, `doi?`, `pmid?`, `authors?`, `space_group?`, `unit_cell?`, `container_ids?` |
| `PdbResult` | `pdb_id`, `summary: PdbEntrySummary`, `sections?: Record<string, unknown>` |
| `PdbDownloadResult` | `file_path`, `file_size_bytes`, `file_size_human`, `format`, `pdb_id`, `_warn?` |

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

### Download Behavior

- Fetches from `https://files.rcsb.org/download/{id}.{ext}`
- Saves to OS temp directory (`mkdtempSync`) with timestamped filename
- Default format is `cif` (mmCIF, universally available for all experimental entries)
- Legacy `pdb` format may 404 for some entries; returns clear error suggesting retry with `cif`
- Files >1 MB include `_warn` field advising the agent to use grep/read specific line ranges

### Validation

- `validatePdbId` rejects IDs not matching `/^[A-Za-z0-9]{4}$/`
- AlphaFold/CSM IDs (starting with `AF_` or `MA_`) are rejected with a message pointing to AlphaFold DB

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
| `diseaseToGenes` | DisGeNET (`/api/v1/disease/{diseaseId}`) | `DISGENET_API_KEY` |
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
- Posts newline-delimited symbols to `https://reactome.org/AnalysisService/identifiers/projection` (direct `fetch`, 15s timeout)
- Returns up to 30 pathways with `p_value`, `genes_overlap`, `genes_total`

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
- Supports: `gene`, `variant`, `drug`, `disease`, `trial`, `article`
- Each input is independent; failures are captured per-item

**Exported types:**

```ts
BatchGetInput { entity: string; id: string; sections?: string[] }
BatchGetResult { entity: string; id: string; success: boolean; data?: unknown; error?: string }
```
