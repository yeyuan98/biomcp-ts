# Server Layer

MCP protocol layer for biomcp-ts. Bootstraps a `McpServer` over `StdioServerTransport`, registers all biomedical tools with Zod-validated input schemas, and handles errors from upstream bioinformatics APIs.

## Server Initialization

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'biomcp', version: VERSION });
// VERSION is imported from src/version.ts and mirrors package.json
// register tool modules...
const transport = new StdioServerTransport();
await server.connect(transport);
```

Entry point: `src/server/index.ts`. Before any registration it loads the optional `.biomcp.json` project config (fill-if-unset into env; see `src/config/`). Then it calls fifteen registration functions in order: `registerGeneTools`, `registerVariantTools`, `registerDrugTools`, `registerDiseaseTools`, `registerArticleTools`, `registerTrialTools`, `registerUtilityTools`, `registerPdbTools`, `registerPatentTools`, `registerGeoTools`, `registerSraTools`, `registerGenbankTools`, `registerGtexTools`, `registerEnsemblTools`, `registerConfigureTool` (the `biomcp_configure` meta tool — deliberate `biomcp_` prefix exception so it is self-identifying in flat multi-server tool listings). The three optional-feature registrars (`registerDbToolsIfConfigured`, `registerAnalysisRToolsIfConfigured`, `registerBiowasmToolsIfConfigured`) run after those, gated on env/config.

## Tool Handler Pattern

Every tool handler follows the same contract:

1. Zod schema validates and destructures input parameters (the SDK handles parsing)
2. Call one or more entity functions from `src/entities/`
3. Return `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`
4. On error: return `{ content: [{ type: 'text', text: String(error) }], isError: true }`

Error surfaces: malformed input fails the SDK's zod validation before the handler runs and comes back as `isError: true` content prefixed `MCP error -32602: Input validation error` (SDK 1.29 converts the protocol error into a tool error result), while domain errors — unsupported accessions (e.g. GDS guidance in `geo_get`, the ENA pointer in `sra_get`), not-found, size gates — surface as `isError: true` content carrying the handler's error text the LLM can read and act on.

Section-based tools (e.g. `gene_diseases`) call `geneGet(symbol, ['disgenet', 'diseases'])` and extract specific sections from the result.

## Complete Tool Registry

### Gene Tools (`tools/gene.ts`) — 7 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `gene_search` | `query: string`, `chromosome?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search for genes by symbol, name, or keyword | readOnly, openWorld |
| `gene_get` | `symbol: string`, `sections?: ("pathways" \| "ontology" \| "diseases" \| "protein" \| "go" \| "interactions" \| "clinical_evidence" \| "expression" \| "protein_atlas" \| "druggability" \| "dosage_sensitivity" \| "constraint" \| "disease_associations" \| "funding" \| "all")[]`, `limit?: number (1-100, default 20)`, `smart?: boolean (default false — auto-resolve gene aliases, e.g. "HER2" → "ERBB2")` | Get detailed gene information by symbol | readOnly, openWorld |
| `gene_diseases` | `symbol: string`, `limit?: number (1-50, default 10)` | Get diseases associated with a gene. Requires `DISGENET_API_KEY`; falls back to OpenTargets | readOnly, openWorld |
| `gene_drugs` | `symbol: string` | Find drugs targeting a gene | readOnly |
| `gene_trials` | `symbol: string` | Find clinical trials for a gene | readOnly |
| `gene_articles` | `symbol: string` | Find articles about a gene | readOnly |
| `gene_enrich` | `genes: string[]` | Pathway enrichment analysis for a gene list | readOnly |

### Variant Tools (`tools/variant.ts`) — 4 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `variant_search` | `query?: string`, `gene?: string`, `significance?: "benign" \| "likely_benign" \| "pathogenic" \| "likely_pathogenic" \| "uncertain"`, `max_frequency?: number`, `min_cadd?: number`, `consequence?: string`, `rsid?: string`, `hgvsp?: string`, `hgvsc?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search for variants by rsid, HGVS, gene+protein change | readOnly, openWorld |
| `variant_get` | `id: string`, `sections?: ("core" \| "frequency" \| "predictions" \| "clinical" \| "alphagenome_scores" \| "all")[]` (`alphagenome_scores` currently returns an error stub pending gRPC reimplementation), `limit?: number (1-100, default 20)` | Get detailed variant information with optional sections | readOnly, openWorld |
| `variant_oncokb` | `gene: string`, `protein_change: string` | Get OncoKB annotations. Requires `ONCOKB_TOKEN` | readOnly, openWorld |
| `variant_trials` | `variant: string` | Find clinical trials for a variant | readOnly |

### Drug Tools (`tools/drug.ts`) — 3 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `drug_search` | `query: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search for drugs by name, mechanism, or keyword | readOnly, openWorld |
| `drug_get` | `name: string`, `sections?: ("core" \| "us_regulatory" \| "eu_regulatory" \| "who_regulatory" \| "safety" \| "targets" \| "indications" \| "all")[]`, `limit?: number (1-100, default 20)` | Get detailed drug information by name | readOnly, openWorld |
| `drug_trials` | `drug: string` | Find clinical trials for a drug | readOnly |

### Disease Tools (`tools/disease.ts`) — 4 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `disease_search` | `query: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search for diseases by name, phenotype, or keyword | readOnly, openWorld |
| `disease_get` | `disease_id: string`, `sections?: ("core" \| "gene_associations" \| "phenotypes" \| "pathways" \| "all")[]`, `limit?: number (1-100, default 20)` | Get detailed disease information by ID | readOnly, openWorld |
| `disease_drugs` | `disease_id: string`, `limit?: number (1-50, default 20)` | Get drugs for a disease via OpenTargets | readOnly, openWorld |
| `disease_trials` | `disease_id: string`, `limit?: number (1-50, default 20)` | Get clinical trials for a disease | readOnly, openWorld |

### Article Tools (`tools/article.ts`) — 2 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `article_search` | `query: string`, `source?: "pubmed" \| "europepmc" \| "semantic_scholar" \| "pubtator" \| "litsense"`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)`, `dateRange?: string` (YYYY-MM-DD/YYYY-MM-DD, open-ended allowed) | Federated literature search with deduplication and optional date filtering (pubmed, europepmc, semantic_scholar). Note: europepmc truncates date ranges to year-level granularity | readOnly, openWorld |
| `article_get` | `id: string` (PMID, PMCID, or DOI), `sections?: ("core" \| "oa" \| "annotations" \| "graph" \| "citation" \| "all")[]`, `limit?: number (1-100, default 20)`, `citation_mode?: "fast" \| "full"` (default "fast"), `citation_direction?: "forward" \| "backward" \| "both"` (default "both") | Get detailed article information by identifier. Citation: fast mode (~4s, 4 providers — Europe PMC, Semantic Scholar, OpenCitations, Crossref counts/references — with automatic PubMed fallback) or full mode (~15-30s, all 5 providers incl. PubMed). Forward citation lists come from Europe PMC, Semantic Scholar, and OpenCitations; Crossref provides counts and backward references only. Results cached 10min. DOIs are resolved via NCBI IDConv with PubMed esearch fallback | readOnly, openWorld |

### Trial Tools (`tools/trial.ts`) — 2 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `trial_search` | `query: string`, `status?: string`, `phase?: string`, `intervention_type?: string`, `limit?: number (1-50, default 10)`, `page_token?: string` (cursor from previous response) | Search clinical trials by condition, intervention, or keyword | readOnly, openWorld |
| `trial_get` | `nct_id: string`, `sections?: ("core" \| "eligibility" \| "locations" \| "outcomes" \| "all")[]`, `limit?: number (1-100, default 20)` | Get detailed trial information by NCT ID | readOnly, openWorld |

### Configuration Tool (`tools/configure.ts`) — 1 tool

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `biomcp_configure` | `action?: "status" \| "set" \| "reset" (default "status")`, `values?: record<string, unknown>`, `target?: string \| string[]`, `filter?: string`, `dry_run?: boolean`, `confirm_sensitive?: boolean` | Unified configuration surface over the `.biomcp.json` project config file + env vars: status (per-feature running state, provenance, conflicts, prerequisites, parameter catalog), set/reset with closed-set dotted-id validation (atomic batches, sensitive-key confirm gate, secret redaction). Env-only parameters are query-only and value-masked (presence + fingerprint) | write, destructive (reset), idempotent |

### Utility Tools (`tools/utility.ts`) — 2 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `discover` | `query: string` | Free-text concept resolution | readOnly |
| `batch_get` | `inputs: { entity: "gene" \| "variant" \| "drug" \| "disease" \| "trial" \| "article" \| "patent", id: string, sections?: string[] }[]` | Get multiple entities in parallel | readOnly |

### PDB Tools (`tools/pdb.ts`) — 1 tool

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `pdb` | `query?: string`, `pdb_id?: string`, `sections?: ("polymer_entities" \| "ligands" \| "assembly" \| "experiment" \| "citation" \| "all")[]`, `download?: boolean` (default false), `format?: "cif" \| "pdb"` (default "cif"), `limit?: number` (1-50, default 10), `offset?: number` (default 0) | Access RCSB PDB: search structures (query), get metadata (pdb_id), download files (pdb_id + download) | openWorld |

Param-based dispatch: `query` → search mode, `pdb_id` → get mode, `pdb_id` + `download=true` → download mode. Downloads save to OS temp dir and return file path + size. Default format is mmCIF (universally available); legacy PDB format may 404 for some entries. `pdb` and `geo_get` are the only tools with `readOnlyHint: false` (they can write downloaded files to disk).

### Patent Tools (`tools/patent.ts`) — 2 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `patent_search` | `query: string` (quote exact multi-word concepts, e.g. "mRNA display"), `assignee?: string`, `inventor?: string`, `cpc?: string` (full symbol e.g. "C12N15/11"), `status?: "granted" \| "application"`, `date_range?: string` (YYYY-MM-DD/YYYY-MM-DD, open-ended allowed), `limit?: number (1-50, default 10)`, `offset?: number (default 0)`, `source?: "ops" \| "uspto_odp" \| "ppubs" \| "google_patents"`, `sort_by?: "relevance" \| "recency"` (default relevance; ppubs only), `seminal?: boolean` (default true: co-citation discovery of foundational prior art in `seminal_prior_art`; ~5-20s, set false for fastest lookups) | Search patents worldwide. Backends: ppubs (US full-text conceptual search, keyless, relevance-ranked — default US backend), ops (EPO OPS worldwide bibliographic, keyed), uspto_odp (US application metadata, bibliographic, keyed), google_patents (best-effort). Auto mode = worldwide + ppubs; hard ppubs failure falls back to uspto_odp once (tagged `_note`); 0-hit searches get a `_hint` | readOnly, openWorld |
| `patent_get` | `patent_id: string` (e.g. "US11027025B2", "EP3904939B1"), `sections?: ("core" \| "abstract" \| "claims" \| "citations" \| "family" \| "classifications" \| "all")[]`, `limit?: number (1-100, default 20)` | Get patent details with per-section source fallback chains. Claims: US fulltext via PPUBS, EP/WO via OPS. Citations include forward (`ct=`) and backward references | readOnly, openWorld |

### GEO Tools (`tools/geo.ts`) — 2 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `geo_search` | `query: string` (free text or `GSE183947[Accession]` field syntax), `entry_type?: "gse" \| "gsm" \| "gpl" \| "gds"` (default gse), `organism?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search NCBI GEO via E-utilities db=gds (esearch + esummary). Each result carries cross-links: `sra_project` → `sra_get`, `bioproject`, `pubmed_ids` → `article_get`, `accession` → `geo_get`. `NCBI_API_KEY` optional (higher rate limits) | readOnly, openWorld |
| `geo_get` | `accession: string` (regex `^(GSE\|GSM\|GPL\|GDS)\d+$`, e.g. GSE183947, GSM5574685, GPL11154; GSE/GSM/GPL return SOFT records, while GDS curated DataSets are not served by SOFT and return guidance pointing at the underlying GSE/GSM), `download?: boolean` (default false), `max_bytes?: number (min 1000000, default 52428800 = 50 MB)` | Get the full SOFT record from the GEO SOFT viewer (`acc.cgi?targ=self&form=text&view=full`): series detail includes summary, organisms, platform_ids, sample preview (≤20), supplementary file URLs, and cross-references (sra, pubmed_ids, bioproject, super/sub-series); enriched with esummary gds metadata (best-effort). `download=true` saves the first supplementary file (.gz/.csv/.txt) to a temp path and returns path/size/URL | openWorld |

### SRA Tools (`tools/sra.ts`) — 2 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `sra_search` | `query: string` (free text, accession SRP/SRX/SRR/SRS, or `"RNA-SEQ AND Homo sapiens[Organism]"`), `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search NCBI SRA via E-utilities (esearch db=sra → efetch experiment-package XML, batches of 10). Items list experiment/study/sample accessions, organism, library strategy, run count, and `first_run_accession` for chaining into `sra_get`. `NCBI_API_KEY` optional | readOnly, openWorld |
| `sra_get` | `accession: string` (SRP/SRX/SRR/SRS/SZ, e.g. SRR14432476; ENA `ER*`/DDBJ `DR*` accessions rejected with an ENA pointer — NCBI SRA does not index them) | Get full SRA entry details: SRR run (instrument, total_spots, total_bases, size_bytes), SRX experiment (library strategy/source/selection/layout, platform), SRP study (experiment list, ≤50), or SRS sample. Shares the NCBI E-utilities 3 req/s budget | readOnly, openWorld |

### GenBank Tools (`tools/genbank.ts`) — 3 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `genbank_search` | `query: string` (plain terms, accession, or `"TP53[Gene Name] AND Homo sapiens[Organism]"`), `organism?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search NCBI nucleotide (E-utilities db=nuccore, esearch + esummary). Results include accession.version, definition, length_bp, organism, taxon_id, topology, sourcedb. `NCBI_API_KEY` optional | readOnly, openWorld |
| `genbank_get` | `accession: string` (versioned or bare, e.g. NC_000023.11, NG_017013.2, KJ668569.2), `format?: "genbank" \| "fasta"` (default genbank), `seq_start?: number (min 1)`, `seq_stop?: number (min 1)` (both required together; 1-based inclusive; required for records > 2 Mb; span ≤ 10 Mb), `strand?: 1 \| 2` (2 = reverse slice, allows seq_start > seq_stop; the region field echoes the request as given while NCBI's text shows complement(min..max)), `max_response_bytes?: number (default 30000000)` | Fetch a nucleotide record (esummary metadata + efetch text). Whole-record fetches capped at 2,000,000 bp; oversized responses error instead of truncating. Output guard: `sequence_text` truncated to its first 200,000 characters with a truncation note | readOnly, openWorld |
| `genbank_genes` | `accession: string` (GenBank/RefSeq, versioned or bare, e.g. NG_017013.2) | Map a nucleotide accession to NCBI Gene IDs (elink nuccore→gene, ≤100 links) — entrezgene IDs usable directly with MyGene-backed gene tools | readOnly, openWorld |

### GTEx Tools (`tools/gtex.ts`) — 2 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `gtex_expression` | `gene: string` (HGNC symbol `TP53` or Ensembl ID `ENSG00000141510`, versioned or bare), `tissue?: string` (tissueSiteDetailId, e.g. Brain_Cortex, Whole_Blood), `limit?: number (1-54, default 20)` | Get median gene expression across GTEx tissues (Analysis v10, 54 tissue sites, TPM, sorted highest first). Genes resolve to a versioned gencodeId first (symbol or bare ENSG do not work directly on expression endpoints). Dataset pinned to `gtex_v10` with metadata-derived latest-release fallback | readOnly, openWorld |
| `gtex_eqtl` | `gene: string` (HGNC symbol or Ensembl ID), `tissue: string` (required tissueSiteDetailId, e.g. Whole_Blood), `limit?: number (1-100, default 20)` | Get significant cis-eQTL associations (GTEx v10 `singleTissueEqtl`): variant_id, p_value, nes, sorted by ascending p-value. Empty `associations` is legitimate (no significant eQTLs). Invalid tissue IDs are rejected against the dataset tissue list | readOnly, openWorld |

### Ensembl Tools (`tools/ensembl.ts`) — 4 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `ensembl_lookup` | `gene_or_id: string` (HGNC symbol `BRAF` or Ensembl gene ID `ENSG00000157764`, versioned or bare — versions resolve to the current record), `species?: string` (default "human"; scientific names or aliases like `mouse`), `expand?: boolean` (default false) | Resolve a gene in Ensembl terms for any of ~356 species: stable ID (+version), symbol, biotype, coordinates on the current assembly (GRCh38 human, GRCm39 mouse), canonical transcript; `expand=true` adds all transcripts with translation/protein IDs. The identifier/structure authority — for rich human annotation use `gene_get` instead | readOnly, openWorld |
| `ensembl_homology` | `gene: string` (symbol or ENSG), `species?: string` (default human), `type?: "orthologues" \| "paralogues"` (default orthologues), `target_species?: string`, `target_taxon?: number`, `limit?: number (1-100, default 20)` | Find orthologues/paralogues across species via Ensembl Compara: target stable IDs, species, taxonomy level, percent identity — sorted by identity. Symbols resolve to stable IDs first (the `/homology/symbol` route proved flaky upstream). The cross-species gene mapping source in biomcp | readOnly, openWorld |
| `ensembl_consequence` | `variant: string` (HGVS c./p./g. like `NM_004333:c.1799T>A`, or rsID `rs113488060`), `species?: string` (default human), `limit?: number (1-50, default 10)` | Compute variant consequences on demand via Ensembl VEP — works for NOVEL variants absent from databases and non-human species. Returns most_severe_consequence, top-N per-transcript effects (impact, codons/amino acids, SIFT/PolyPhen where available) and co-located ClinVar/COSMIC/gnomAD data. Prefer HGVS input — rsID resolution can be less specific upstream. For known human variants `variant_get` adds deep pre-computed scores (CADD, REVEL, …) | readOnly, openWorld |
| `ensembl_region` | `region: string` (`chr:start-end`, e.g. `7:140450000-140480000`; span ≤ 5 Mb upstream limit), `features?: ("gene" \| "transcript" \| "variation")[]` (default ["gene","variation"]), `species?: string` (default human), `limit?: number (1-500, default 50)` | Query what lives in a genomic interval on the current assembly: genes/transcripts (stable IDs, symbols, biotypes) and known variants (rsIDs, alleles, consequences, clinical significance) — locus-triage queries. Results capped at limit with truncated marker; sequence text belongs in `genbank_get` | readOnly, openWorld |

### Database Tools (`tools/db.ts`) — 3 tools (optional)

Registered only when `DB_TYPE` is set — see [docs/DATABASE.md](../../docs/DATABASE.md).

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `db_query` | `sql: string`, `params?: Record<string, unknown>` | Execute a read-only SELECT query with named parameters (`:name`). Allow-list: SELECT/SHOW/DESCRIBE/EXPLAIN/WITH; blocks writes, multi-statement SQL, `INTO OUTFILE/DUMPFILE` | readOnly |
| `db_list_tables` | — | List tables/views with engine, row count, creation time, comments | readOnly |
| `db_describe_table` | `table_name: string` | Column schema: name, type, nullability, key type, default value | readOnly |

### R Analysis Tools (`tools/ranalysis.ts`) — 4 tools (optional)

Registered only when `ANALYSIS_R` is set — see [docs/R-ANALYSIS.md](../../docs/R-ANALYSIS.md). Requires the optional peer dependency `webr`.

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `analysis_r_deseq2` | shared inputs (below), `alpha?: number (0.001–0.2, default 0.05)`, `fit_type?: "parametric" \| "local" \| "mean"`, `shrink?: boolean` | DESeq2 differential expression (negative binomial, Wald test, independent filtering; optional `lfcShrink(type="normal")`) | — |
| `analysis_r_edger` | shared inputs, `test?: "qlm" \| "exact"` | edgeR differential expression (filterByExpr, TMM, quasi-likelihood F-test or 2-group exact test) | — |
| `analysis_r_limma` | shared inputs | limma-voom differential expression (filterByExpr, TMM, voom, eBayes, topTable) | — |
| `analysis_r_session_info` | — | R runtime report: versions, memory, mirror endpoint | readOnly |

Shared inputs: `counts` (object `{genes, samples, matrix}` or CSV string; raw integer counts, ≤50,000 genes x ≤64 samples), `coldata` (object `{samples, columns}` or CSV; string columns become factors), `design` (RHS formula over coldata columns, whitelisted charset + token denylist), `contrast?` `{variable, numerator, denominator}` or `coef?` (model-matrix column; default: last design term), `top_n?` (1–200, default 50), `include_full?` (boolean), `format?` `"table" \| "json"`. Output: markdown table + summary by default; `include_full` adds base64(gzip(TSV)) of the full results.

### Biowasm Analysis Tools (`tools/biowasm.ts`) — 8 tools (optional)

Registered only when `ANALYSIS_BIOWASM` is set — see [docs/BIOWASM-ANALYSIS.md](../../docs/BIOWASM-ANALYSIS.md). No npm peer dependency; wasm assets (~4.5 MB) download and pin-verify at first use.

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `analysis_bam_summary` | shared source inputs (below), output shaping | Alignment inspection: header contigs/lengths, sample + read groups, flagstat metrics, idxstats per-contig counts when an index is available | readOnly |
| `analysis_bam_view_region` | shared source inputs, `region: {chrom, start?, end?}` (required; 1-based inclusive, span ≤ 100 Mb), `mode?: "count" \| "depth" \| "pileup" \| "reads"` (default count), `depth_bins?: number (1–1,000,000)`, output shaping | Region access to an alignment (samtools view -c/depth/mpileup/view -b); reads+`format="artifact"` returns a BAM artifact | — |
| `analysis_bcf_summary` | shared source inputs, output shaping | VCF/BCF header inspection: contigs, sample count + names, INFO/FORMAT inventory | readOnly |
| `analysis_bcf_view_region` | shared source inputs, `region` (required), `projection?: {fields?: ("CHROM" \| "POS" \| "ID" \| "REF" \| "ALT" \| "QUAL" \| "FILTER" \| "INFO" \| "AF" \| "AC" \| "AN" \| "DP" \| "TYPE" \| "GT" \| "GQ" \| "DP_SAMPLE" \| "AD")[] (default CHROM,POS,REF,ALT; ≤ 20), samples?: string[] (≤ 10,000)}`, `filter?: string` (bcftools expression, ≤ 512 chars, denylisted), `variant_types?: ("snps" \| "indels" \| "mnps" \| "other")[]`, output shaping | Variants in a region as a narrow projection (bcftools query -r/-t -s -i -v); `format="artifact"` slices to a VCF.gz artifact | — |
| `analysis_bed_op` | `source` (A track, shared schema), `b_source?` (B track; required for binary ops), `op: "intersect" \| "merge" \| "subtract" \| "coverage" \| "jaccard" \| "sort"`, `sorted_inputs?: boolean (default false — adds -sorted)`, `strand?: boolean (default false — -s)`, `fraction_overlap?: number (0–1, -f)`, output shaping | Interval algebra (bedtools); table/json only (bedtools prints to stdout) | — |
| `analysis_biowasm_convert` | shared source inputs, `to: "SAM" \| "BAM" \| "CRAM" \| "VCF" \| "BCF" \| "TSV"` (input format inferred from the source), projection/filter (TSV), output shaping | Format plumbing; result is an artifact handle (id, host path, sha256, size, ≤ 2 KB preview) reusable as `artifact_id` | — |
| `analysis_biowasm_session_info` | — | Runtime report: pinned tool versions, asset cache state, engine status, artifact count, memory | readOnly |
| `analysis_biowasm_cli` | `tool: "samtools" \| "bedtools" \| "bcftools"`, `args: string[] (1–32; subcommand-level allowlist — phase 1 simplification; no shell metacharacters, no "..", paths only under /shared)` | Constrained escape hatch for allowlisted subcommands; output captured under a 2 MB cap | — |

Shared source inputs: `source` (strict union — exactly one of `{content}` ≤ 20 MiB with format sniffing, `{artifact_id}` from a prior response, or `{host_path}` under `ANALYSIS_BIOWASM_DATA_DIR`), `index?` (`"auto"` default with sibling `.bai/.csi/.tbi/.crai` detection, or `{content}`/`{host_path}`). Output shaping: `format?` `"table"` (markdown, default) \| `"json"` \| `"artifact"` (where supported), `top_n?` (1–200, default 50), `include_content?` (inline artifacts ≤ 2 MB as base64(gzip)). Every response embeds io_stats (bytes read, elapsed).

**Total: 40 core tools** across 14 registration modules (+3 optional database tools, +4 optional R analysis tools, +8 optional biowasm analysis tools).

## Error Handling (`errors.ts`)

### `BioMCPError` Interface

```ts
interface BioMCPError {
  code: string;
  message: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}
```

### `ErrorCodes` Constant

| Code | Meaning |
|------|---------|
| `ENTITY_NOT_FOUND` | Entity ID does not exist in upstream API |
| `INVALID_INPUT` | Malformed input parameter |
| `TIMEOUT` | Upstream API request timed out or was aborted |
| `API_ERROR` | Unhandled upstream API error |
| `RATE_LIMIT` | HTTP 429 or rate limit message from upstream |
| `AUTH_REQUIRED` | HTTP 401/403, missing API key |
| `NETWORK_ERROR` | Network connectivity or fetch failure |
| `VALIDATION_ERROR` | Input failed schema validation |

### `createError(code, message, suggestion?, details?): BioMCPError`

Constructs a `BioMCPError` object.

### `formatError(error: unknown): BioMCPError`

Classifies a thrown value into a `BioMCPError` by inspecting `error.message` for keywords:

- `"not found"` / `"does not exist"` → `ENTITY_NOT_FOUND`
- `"timeout"` / `"abort"` → `TIMEOUT`
- `"401"` / `"403"` / `"unauthorized"` → `AUTH_REQUIRED`
- `"429"` / `"rate limit"` → `RATE_LIMIT`
- `"network"` / `"fetch"` / `"connect"` → `NETWORK_ERROR`
- Plain `string` → `INVALID_INPUT`
- Fallback → `API_ERROR`

Each classification attaches a human-readable `suggestion` and the original error in `details.originalError`.

### `withErrorHandling<T>(fn: () => Promise<T>, operationName?: string): Promise<{ data?: T; error?: BioMCPError }>`

Wraps an async function. Resolves to `{ data }` on success, `{ error }` on failure. Prepends `operationName` to the error message if provided.

### Section Helpers

| Function | Signature | Purpose |
|----------|-----------|---------|
| `getSectionError` | `(sectionData: unknown) => string \| undefined` | Returns `obj._error` if present |
| `extractSection<T>` | `(data: unknown, ...paths: string[]) => T \| undefined` | Returns the first non-null value at a path, or `undefined` if `_error` exists |
| `sectionResult<T>` | `(result: { sections?: Record<string, unknown> }, sectionName: string, subPath?: string) => T \| { _error: string } \| undefined` | Extracts a section from `result.sections[sectionName]`, optionally drilling into `subPath`. Returns `{ _error }` object if the section failed |

## Validation System (`validation.ts`)

### `ValidationResult` Interface

```ts
interface ValidationResult {
  success: boolean;
  errors?: Array<{ path: string; message: string }>;
  data?: unknown;
}
```

### `validateInput<T extends z.ZodType>(schema: T, data: unknown): ValidationResult`

Runs `schema.safeParse(data)`. Returns `{ success: true, data }` or `{ success: false, errors }` with dot-joined paths.

### `InputValidation` Schemas

| Key | Schema | Constraints |
|-----|--------|-------------|
| `geneSymbol` | `z.string()` | min 1, max 50, regex `/^[A-Za-z0-9\-_]+$/` |
| `variantId` | `z.string()` | min 1, max 100 |
| `drugName` | `z.string()` | min 1, max 200 |
| `diseaseQuery` | `z.string()` | min 1, max 200 |
| `articleId` | `z.string()` | regex `/^(?:\d+|PMC\d+|10\.\d{4,}\/\S+)$/i` (PMID, PMCID, or DOI) |
| `nctId` | `z.string()` | regex `/^NCT\d{8}$/` |
| `patentId` | `z.string()` | regex `/^[A-Za-z]{2}\s?(?:RE|PP|H)?\s?\d{5,}\s?(?:[A-Za-z]\d{0,2})?$/` (publication number) |
| `limit` | `z.number()` | int, min 1, max 100 |
| `offset` | `z.number()` | int, min 0 |

### `isValidEntityInput(entity: string, id: string): boolean`

Validates an entity identifier against the appropriate `InputValidation` schema. Supports: `gene`, `variant`, `drug`, `disease`, `trial` (accepts NCT ID or PMID), `article` (accepts PMID, PMCID, or DOI), `patent` (accepts publication numbers like US11027025B2).

### `getEntitySuggestions(entity: string): string`

Returns a human-readable suggestion describing which search tool to use for valid IDs.

### `formatValidationErrors(errors: Array<{ path: string; message: string }>): string`

Formats validation errors into a multi-line string for user-facing output.

## File Structure

```
src/server/
  index.ts            Server bootstrap, McpServer + StdioServerTransport
  errors.ts           BioMCPError types, formatError, withErrorHandling, section helpers
  validation.ts       Zod schemas, validateInput, isValidEntityInput, getEntitySuggestions
  tools/
    gene.ts           7 gene tools (search, get, diseases, drugs, trials, articles, enrich)
    variant.ts        4 variant tools (search, get, oncokb, trials)
    drug.ts           3 drug tools (search, get, trials)
    disease.ts        4 disease tools (search, get, drugs, trials)
    article.ts        2 article tools (search, get)
    trial.ts          2 trial tools (search, get)
    utility.ts        2 utility tools (discover, batch_get)
    pdb.ts            1 PDB tool (search, get, download)
    patent.ts         2 patent tools (search, get)
    geo.ts            2 GEO tools (search, get + optional download)
    sra.ts            2 SRA tools (search, get)
    genbank.ts        3 GenBank tools (search, get, genes)
    gtex.ts            2 GTEx tools (expression, eqtl)
    ensembl.ts         4 Ensembl tools (lookup, homology, consequence, region)
    db.ts              3 database tools (optional, DB_TYPE)
    ranalysis.ts       4 R analysis tools (optional, ANALYSIS_R)
    biowasm.ts         8 biowasm analysis tools (optional, ANALYSIS_BIOWASM)
```
