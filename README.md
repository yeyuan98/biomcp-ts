# BioMCP

A high-performance MCP server that gives LLMs access to 25 biomedical tools federated across 50+ upstream APIs — genes, variants, drugs, diseases, literature, clinical trials, and structural biology in a single integration.

Adapted from the [BioMCP Rust](https://github.com/genomoncology/biomcp) with agent-first development approach and enhancements. Kudos to the original authors.

## Highlights

- **25 tools** across 8 domains — search, retrieve, and cross-reference biomedical entities
- **50+ upstream sources** — MyGene, MyVariant, MyChem, MyDisease, ClinVar, gnomAD, UniProt, Reactome, OpenTargets, CIViC, OncoKB, DisGeNET, GTEx, STRING, DGIdb, ClinicalTrials.gov, PubMed, EuropePMC, Semantic Scholar, PubTator, LitSense, Monarch Initiative, OpenFDA, NIH Reporter, AlphaGenome, and more
- **Section-based fetching** — `entityGet(id, sections)` fans out to multiple sources with per-section timeouts and graceful degradation (failed sections return `{ _error }` instead of crashing)
- **Federated article search** — queries 5 literature backends simultaneously with PMID/PMCID/DOI deduplication
- **Zero-config startup** — works out of the box; optional API keys unlock higher rate limits and premium data
- **283 tests** — 189 unit tests (mocked) + 94 integration tests (live APIs via in-process MCP client, with automatic retry on 429 rate limits)

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

### Gene (7)

| Tool | Description |
|------|-------------|
| `gene_search` | Search genes by symbol, name, or keyword with type/chromosome filters |
| `gene_get` | Get detailed gene info by HGNC symbol with optional sections (pathways, protein, GO, interactions, expression, constraint, druggability, clinical evidence, disease associations, funding) |
| `gene_diseases` | Get diseases associated with a gene (DisGeNET / OpenTargets) |
| `gene_drugs` | Find drugs targeting a gene (OpenTargets) |
| `gene_trials` | Find clinical trials for a gene |
| `gene_articles` | Find articles about a gene |
| `gene_enrich` | Pathway enrichment analysis for a gene list (Reactome) |

### Variant (4)

| Tool | Description |
|------|-------------|
| `variant_search` | Search variants by rsid, HGVS, gene, ClinVar significance, frequency, CADD |
| `variant_get` | Get detailed variant info with optional sections (frequency, predictions, clinical, alphagenome_scores) |
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
| `disease_get` | Get detailed disease info by ID (DOID, MONDO, OMIM, etc.) with optional sections (gene_associations, phenotypes, pathways, survival) |
| `disease_drugs` | Get drugs for a disease (OpenTargets) |
| `disease_trials` | Get clinical trials for a disease (ClinicalTrials.gov) |

### Article (2)

| Tool | Description |
|------|-------------|
| `article_search` | Federated literature search across PubMed, EuropePMC, Semantic Scholar, PubTator, and LitSense with optional date range filtering. Returns `{results: [...], total_results?: number}`. Supports `enrich_pmid=true` to resolve PMID for results missing it. |
| `article_get` | Get detailed article info by identifier (PMID, PMCID, or DOI) with optional sections: `open_access` (includes license info), `annotations` (limit parameter controls max annotations), `citation_graph` |

### Trial (2)

| Tool | Description |
|------|-------------|
| `trial_search` | Search clinical trials by condition, intervention, status, or phase |
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

### Citation Module

**Modes:**
- **Fast** (default): Europe PMC, Semantic Scholar, Crossref (~4s)
  - Returns: Citations with title, authors, journal, year when available
  - Note: Crossref requires DOI; Europe PMC auto-resolves DOI/PMCID to PMID
- **Full** (`citation_mode="full"`): All 5 providers (~15-30s)
  - Adds: PubMed (PMID only) and OpenCitations (DOI only)
  - Use for: Comprehensive citation analysis

**Provider Data Coverage:**
| Provider | Forward | Backward | Count | Required ID |
|----------|---------|----------|-------|-------------|
| Europe PMC | ✓ | ✓ | ✓ | PMID/DOI/PMCID |
| Semantic Scholar | ✓ | ✓ | ✓ | PMID/DOI/PMCID |
| Crossref | ✓ | ✓ | ✓ | DOI only |
| PubMed | ✓ | ✓ | ✓ | PMID only |
| OpenCitations | ✓ | ✓ | ✓ | DOI only |

**Automatic Fallback:** Fast mode automatically queries PubMed when other providers return counts but no items (requires PMID).

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

### Local Testing with npx

After building, you can test the MCP server locally via npx:

```bash
make build        # Creates dist/bundle.js
npx .             # Runs the bundled MCP server
```

This is the recommended workflow for local development and testing.

## Environment Variables

All keys are optional. BioMCP works without any keys — they unlock higher rate limits and additional data sources.

| Variable | Source | Benefit |
|----------|--------|---------|
| `NCBI_API_KEY` | [NCBI](https://www.ncbi.nlm.nih.gov/account/settings/) | Higher PubMed / NCBI rate limits |
| `S2_API_KEY` | [Semantic Scholar API key](https://www.semanticscholar.org/product/api#api-key-form) (prevents 429 rate limits) |
| `OPENFDA_API_KEY` | [OpenFDA](https://open.fda.gov/apis/) | OpenFDA API access |
| `NCI_API_KEY` | [NCI CTS](https://cts.nci.nih.gov/) | NCI Clinical Trials API |
| `ONCOKB_TOKEN` | [OncoKB](https://www.oncokb.org/) | OncoKB cancer variant annotations |
| `DISGENET_API_KEY` | [DisGeNET](https://www.disgenet.org/) | Disease-gene associations |
| `UMLS_API_KEY` | [UMLS](https://www.nlm.nih.gov/research/umls/) | UMLS terminology services |
| `ALPHAGENOME_API_KEY` | [AlphaGenome](https://www.alphagenome.com/) | AlphaGenome variant scores |

## License

[MIT](LICENSE)
