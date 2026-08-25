# BioMCP

A high-performance MCP server that gives LLMs access to 40 biomedical tools federated across 50+ upstream APIs — genes, variants, drugs, diseases, literature, clinical trials, structural biology, and functional genomics in a single integration.

## Highlights

- **40 tools** across 14 domains — search, retrieve, and cross-reference biomedical entities (+3 optional database tools)
- **50+ upstream sources** — MyGene, MyVariant, MyChem, MyDisease, ClinVar, gnomAD, UniProt, Reactome, OpenTargets, CIViC, OncoKB, DisGeNET, GTEx, STRING, DGIdb, ClinicalTrials.gov, PubMed, EuropePMC, Semantic Scholar, PubTator, LitSense, Monarch Initiative, OpenFDA, NIH Reporter, NCBI GEO, SRA, GenBank, Ensembl, and more
- **Functional genomics & sequences** — GEO series/sample search with SOFT detail parsing, SRA experiment/run metadata, GenBank/RefSeq records with region slices, and GTEx v10 median expression + cis-eQTLs
- **Section-based fetching** — `entityGet(id, sections)` fans out to multiple sources with per-section timeouts and graceful degradation (failed sections return `{ _error }` instead of crashing)
- **Federated article search** — queries 5 literature backends simultaneously with PMID/PMCID/DOI deduplication
- **Patent access** — worldwide patent search and detail via keyed EPO OPS / USPTO ODP; keyless USPTO Public Search and Google Patents (+Wayback archive) fallbacks
- **Zero-config startup** — works out of the box; optional API keys unlock higher rate limits and premium data
- **~906 unit tests** (mocked) + **129 integration tests** (live APIs via in-process MCP client, gated skips)

## Install

```bash
npx biomcp        # zero-config stdio MCP server; Node >= 22.13
```

**Setup is guided in [docs/AGENT-INSTALL.md](docs/AGENT-INSTALL.md)** — copy-paste config snippets for Claude Desktop, Claude Code, Codex, and OpenCode, plus an agent-friendly checklist for API keys and optional features.

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

### GEO (2)

| Tool | Description |
|------|-------------|
| `geo_search` | Search NCBI GEO for functional genomics studies (expression microarrays, RNA-seq, single-cell series) by entry type (GSE/GSM/GPL/GDS) and organism; results carry cross-links (sra_project, bioproject, pubmed_ids) for chaining |
| `geo_get` | Get the full SOFT record for a GEO series/sample/platform: summary, organisms, sample preview (≤20), supplementary file URLs, and cross-references; optionally download the first supplementary file |

### SRA (2)

| Tool | Description |
|------|-------------|
| `sra_search` | Search NCBI's Sequence Read Archive for sequencing experiments and runs by free text, accession, or field syntax; returns experiment/study/sample accessions with library strategy and run counts |
| `sra_get` | Get full details for an SRA accession: SRR run (instrument, spots, bases, size), SRX experiment (library design), SRP study (experiment list), or SRS sample; ENA/DDBJ accessions rejected with an ENA pointer |

### GenBank (3)

| Tool | Description |
|------|-------------|
| `genbank_search` | Search NCBI nucleotide records (GenBank/RefSeq/INSDC) by plain terms, accession, or field syntax; results include accession.version, definition, length, organism, topology |
| `genbank_get` | Fetch a GenBank/RefSeq record as GenBank flat file or FASTA; whole records capped at 2 Mb — larger records require a `seq_start`/`seq_stop` region (up to 10 Mb, reverse-strand via `strand=2`) |
| `genbank_genes` | Map a GenBank/RefSeq accession to its NCBI Gene IDs (elink nuccore→gene) for bridging into gene tools |

### GTEx (2)

| Tool | Description |
|------|-------------|
| `gtex_expression` | Get median gene expression across GTEx tissues (Analysis v10, 54 tissue sites, TPM, highest first); accepts HGNC symbol or Ensembl gene ID, with optional single-tissue filter |
| `gtex_eqtl` | Get significant cis-eQTL associations for a gene in a specific GTEx tissue (v10): variant_id, p_value, NES, slope, sorted by ascending p-value |

### Ensembl (4)

| Tool | Description |
|------|-------------|
| `ensembl_lookup` | Resolve a gene in Ensembl terms for any of ~356 species: stable ID (+version), symbol, coordinates on the current assembly, canonical transcript; `expand=true` adds transcripts with translation/protein IDs |
| `ensembl_homology` | Find orthologues/paralogues across species via Ensembl Compara — target stable IDs, taxonomy level, percent identity, sorted by identity; filter with `target_species`/`target_taxon` |
| `ensembl_consequence` | Compute variant consequences on demand via Ensembl VEP for NOVEL variants and non-human species: most severe consequence, per-transcript effects (SIFT/PolyPhen), co-located ClinVar/COSMIC/gnomAD data. Known human variants get deeper pre-computed scores via `variant_get`; prefer HGVS input over rsIDs for precision |
| `ensembl_region` | Query genes/transcripts/known variants in a genomic interval (`chr:start-end`) on the current assembly — locus triage |

### Citation Module

Citations federate 5 providers in fast (~4s) or full (~15-30s) mode. Forward citation lists come from Europe PMC, OpenCitations, and Semantic Scholar; Crossref supplies counts and backward references. Provider matrix and schema details: [src/server/README.md](src/server/README.md).

## Optional Features

Capabilities that ship with the package but stay inactive until enabled. Each links to its own guide:

| Feature | Enable | Guide |
|---------|--------|-------|
| **Database access** — read-only SQL tools (`db_query`, `db_list_tables`, `db_describe_table`) for MySQL and local-file SQLite | Set `DB_TYPE` (+ connection env vars); MySQL also needs `npm install biomcp mysql2` in a local tree | [docs/DATABASE.md](docs/DATABASE.md) |

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/AGENT-INSTALL.md](docs/AGENT-INSTALL.md) | Guided installation & client configuration (Claude Desktop, Claude Code, Codex, OpenCode) |
| [docs/ENV-VARS.md](docs/ENV-VARS.md) | Single source of truth for every environment variable |
| [docs/DATABASE.md](docs/DATABASE.md) | Database access feature guide |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Build, test, publish workflow |
| [src/server/README.md](src/server/README.md) | Full tool schemas (params, enums, defaults) |

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attributions.

BioMCP-TS is adapted from the upstream [BioMCP Rust](https://github.com/genomoncology/biomcp) project (MIT) with an agent-first development approach and enhancements — kudos to the original authors.
