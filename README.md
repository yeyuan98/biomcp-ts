# BioMCP

A high-performance MCP server that gives LLMs access to 50 biomedical tools federated across 40+ upstream APIs — genes, variants, drugs, diseases, literature, and clinical trials in a single integration.

Adapted from the [BioMCP Rust](https://github.com/genomoncology/biomcp) with agent-first development approach and enhancements. Kudos to the original authors.

## Highlights

- **50 tools** across 7 domains — search, retrieve, and cross-reference biomedical entities
- **40+ upstream sources** — MyGene, MyVariant, MyChem, MyDisease, ClinVar, gnomAD, UniProt, Reactome, OpenTargets, CIViC, OncoKB, DisGeNET, GTEx, STRING, DGIdb, ClinicalTrials.gov, PubMed, EuropePMC, Semantic Scholar, PubTator, LitSense, Monarch Initiative, OpenFDA, NIH Reporter, AlphaGenome, and more
- **Section-based fetching** — `entityGet(id, sections)` with per-section timeouts and graceful degradation (failed sections return `{ _error }` instead of crashing)
- **Federated article search** — queries 5 literature backends simultaneously with PMID/PMCID/DOI deduplication
- **Zero-config startup** — works out of the box; optional API keys unlock higher rate limits and premium data

## Quick Start

### Install and build

```bash
git clone <repo-url> && cd biomcp-ts
npm install && npm run build
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
      "args": ["/path/to/biomcp-ts/dist/server/index.js"]
    }
  }
}
```

### Direct stdio

```bash
npm start
```

### Any MCP-compatible client

BioMCP speaks standard MCP over **stdio**. Point any MCP client at the `biomcp` binary or `node dist/server/index.js`.

## Available Tools

### Gene (10)

| Tool | Description |
|------|-------------|
| `gene_search` | Search genes by symbol, name, or keyword with type/chromosome filters |
| `gene_get` | Get detailed gene info by HGNC symbol with optional sections |
| `gene_pathways` | Get Reactome pathways containing a gene |
| `gene_diseases` | Get diseases associated with a gene (DisGeNET / OpenTargets) |
| `gene_go_enrichment` | Get GO term enrichment via QuickGO |
| `gene_interactions` | Get protein-protein interactions via STRING |
| `gene_expression` | Get GTEx tissue expression levels |
| `gene_constraint` | Get gnomAD constraint metrics (pLI, LOEUF, etc.) |
| `gene_druggability` | Get druggability data via DGIdb and OpenTargets |
| `gene_clingen` | Get ClinGen dosage sensitivity data |

### Variant (6)

| Tool | Description |
|------|-------------|
| `variant_search` | Search variants by rsid, HGVS, gene, ClinVar significance, frequency, CADD |
| `variant_get` | Get detailed variant info with optional sections (core, frequency, predictions, clinical, alphagenome) |
| `variant_frequency` | Get gnomAD population frequency data |
| `variant_predictions` | Get pathogenicity predictions (CADD, SIFT, PolyPhen, conservation) |
| `variant_oncokb` | Get OncoKB cancer variant annotations (requires `ONCOKB_TOKEN`) |
| `variant_alphagenome` | Get AlphaGenome variant scores via gRPC (requires `ALPHAGENOME_API_KEY`) |

### Drug (6)

| Tool | Description |
|------|-------------|
| `drug_search` | Search drugs by name, mechanism, or keyword |
| `drug_get` | Get detailed drug info with optional sections |
| `drug_targets` | Get drug targets via ChEMBL |
| `drug_indications` | Get drug indications via ChEMBL |
| `drug_adverse_events` | Get adverse events via OpenFDA |
| `drug_regulatory` | Get FDA regulatory information |

### Disease (6)

| Tool | Description |
|------|-------------|
| `disease_search` | Search diseases by name, phenotype, or keyword |
| `disease_get` | Get detailed disease info by ID (DOID, MONDO, OMIM, etc.) with optional sections |
| `disease_genes` | Get genes associated with a disease via DisGeNET (requires `DISGENET_API_KEY`) |
| `disease_phenotypes` | Get HPO phenotypes for a disease |
| `disease_drugs` | Get drugs for a disease via OpenTargets |
| `disease_trials` | Get clinical trials for a disease via ClinicalTrials.gov |

### Article (4)

| Tool | Description |
|------|-------------|
| `article_search` | Federated literature search across PubMed, EuropePMC, Semantic Scholar, PubTator, and LitSense |
| `article_get` | Get detailed article info by PMID with optional sections |
| `article_annotations` | Get PubTator biomedical entity annotations for an article |
| `article_citations` | Get citation graph for an article via Semantic Scholar |

### Trial (5)

| Tool | Description |
|------|-------------|
| `trial_search` | Search clinical trials by condition, intervention, status, or phase |
| `trial_get` | Get detailed trial info by NCT ID with optional sections |
| `trial_eligibility` | Get inclusion/exclusion eligibility criteria |
| `trial_locations` | Get trial site locations |
| `trial_outcomes` | Get primary and secondary outcomes |

### Cross-Entity / Pivot (10)

| Tool | Description |
|------|-------------|
| `gene_drugs` | Find drugs targeting a gene |
| `gene_trials` | Find clinical trials for a gene |
| `gene_articles` | Find articles about a gene |
| `variant_trials` | Find clinical trials for a variant |
| `drug_genes` | Find genes targeted by a drug |
| `drug_trials` | Find clinical trials for a drug |
| `gene_enrich` | Pathway enrichment analysis for a gene list |
| `discover` | Free-text concept resolution across all entity types |
| `search_all` | Federated search across all entity types simultaneously |
| `batch_get` | Retrieve multiple entities in parallel |

### Utility (3)

| Tool | Description |
|------|-------------|
| `biomcp_health` | Check connectivity to upstream data sources |
| `biomcp_list` | List available entities, tools, and operations |
| `version` | Get BioMCP server version |

## Environment Variables

All keys are optional. BioMCP works without any keys — they unlock higher rate limits and additional data sources.

| Variable | Source | Benefit |
|----------|--------|---------|
| `NCBI_API_KEY` | [NCBI](https://www.ncbi.nlm.nih.gov/account/settings/) | Higher PubMed / NCBI rate limits |
| `S2_API_KEY` | [Semantic Scholar](https://www.semanticscholar.org/product/api#api-key-form) | Semantic Scholar API access |
| `OPENFDA_API_KEY` | [OpenFDA](https://open.fda.gov/apis/) | OpenFDA API access |
| `NCI_API_KEY` | [NCI CTS](https://cts.nci.nih.gov/) | NCI Clinical Trials API |
| `ONCOKB_TOKEN` | [OncoKB](https://www.oncokb.org/) | OncoKB cancer variant annotations |
| `DISGENET_API_KEY` | [DisGeNET](https://www.disgenet.org/) | Disease-gene associations (required for `disease_genes`, `gene_diseases`) |
| `UMLS_API_KEY` | [UMLS](https://www.nlm.nih.gov/research/umls/) | UMLS terminology services |
| `ALPHAGENOME_API_KEY` | [AlphaGenome](https://www.alphagenome.com/) | AlphaGenome variant scores (required for `variant_alphagenome`) |

## License

[MIT](LICENSE)
