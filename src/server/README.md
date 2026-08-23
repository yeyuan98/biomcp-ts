# Server Layer

MCP protocol layer for biomcp-ts. Bootstraps a `McpServer` over `StdioServerTransport`, registers all biomedical tools with Zod-validated input schemas, and handles errors from upstream bioinformatics APIs.

## Server Initialization

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'biomcp', version: '1.0.0' });
// register tool modules...
const transport = new StdioServerTransport();
await server.connect(transport);
```

Entry point: `src/server/index.ts`. Calls nine registration functions in order: `registerGeneTools`, `registerVariantTools`, `registerDrugTools`, `registerDiseaseTools`, `registerArticleTools`, `registerTrialTools`, `registerUtilityTools`, `registerPdbTools`, `registerPatentTools`.

## Tool Handler Pattern

Every tool handler follows the same contract:

1. Zod schema validates and destructures input parameters (the SDK handles parsing)
2. Call one or more entity functions from `src/entities/`
3. Return `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`
4. On error: return `{ content: [{ type: 'text', text: String(error) }], isError: true }`

Section-based tools (e.g. `gene_diseases`) call `geneGet(symbol, ['disgenet', 'diseases'])` and extract specific sections from the result.

## Complete Tool Registry

### Gene Tools (`tools/gene.ts`) — 7 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `gene_search` | `query: string`, `gene_type?: "protein-coding" \| "ncRNA" \| "pseudo"`, `chromosome?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search for genes by symbol, name, or keyword | readOnly, openWorld |
| `gene_get` | `symbol: string`, `sections?: ("pathways" \| "ontology" \| "diseases" \| "protein" \| "go" \| "interactions" \| "clinical_evidence" \| "expression" \| "protein_atlas" \| "druggability" \| "dosage_sensitivity" \| "constraint" \| "disease_associations" \| "funding" \| "all")[]`, `limit?: number (1-100, default 20)` | Get detailed gene information by symbol | readOnly, openWorld |
| `gene_diseases` | `symbol: string`, `limit?: number (1-50, default 10)` | Get diseases associated with a gene. Requires `DISGENET_API_KEY`; falls back to OpenTargets | readOnly, openWorld |
| `gene_drugs` | `symbol: string` | Find drugs targeting a gene | readOnly |
| `gene_trials` | `symbol: string` | Find clinical trials for a gene | readOnly |
| `gene_articles` | `symbol: string` | Find articles about a gene | readOnly |
| `gene_enrich` | `genes: string[]` | Pathway enrichment analysis for a gene list | readOnly |

### Variant Tools (`tools/variant.ts`) — 4 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `variant_search` | `query?: string`, `gene?: string`, `significance?: "benign" \| "likely_benign" \| "pathogenic" \| "likely_pathogenic" \| "uncertain"`, `max_frequency?: number`, `min_cadd?: number`, `consequence?: string`, `rsid?: string`, `hgvsp?: string`, `hgvsc?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search for variants by rsid, HGVS, gene+protein change | readOnly, openWorld |
| `variant_get` | `id: string`, `sections?: ("core" \| "frequency" \| "predictions" \| "clinical" \| "alphagenome_scores" \| "all")[]`, `limit?: number (1-100, default 20)` | Get detailed variant information with optional sections | readOnly, openWorld |
| `variant_oncokb` | `gene: string`, `protein_change: string` | Get OncoKB annotations. Requires `ONCOKB_TOKEN` | readOnly, openWorld |
| `variant_trials` | `variant: string` | Find clinical trials for a variant | readOnly |

### Drug Tools (`tools/drug.ts`) — 3 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `drug_search` | `query: string`, `drug_type?: string`, `source?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search for drugs by name, mechanism, or keyword | readOnly, openWorld |
| `drug_get` | `name: string`, `sections?: ("core" \| "us_regulatory" \| "eu_regulatory" \| "who_regulatory" \| "safety" \| "targets" \| "indications" \| "all")[]`, `limit?: number (1-100, default 20)` | Get detailed drug information by name | readOnly, openWorld |
| `drug_trials` | `drug: string` | Find clinical trials for a drug | readOnly |

### Disease Tools (`tools/disease.ts`) — 4 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `disease_search` | `query: string`, `disease_type?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search for diseases by name, phenotype, or keyword | readOnly, openWorld |
| `disease_get` | `disease_id: string`, `sections?: ("core" \| "gene_associations" \| "phenotypes" \| "pathways" \| "survival" \| "all")[]`, `limit?: number (1-100, default 20)` | Get detailed disease information by ID | readOnly, openWorld |
| `disease_drugs` | `disease_id: string`, `limit?: number (1-50, default 20)` | Get drugs for a disease via OpenTargets | readOnly, openWorld |
| `disease_trials` | `disease_id: string`, `limit?: number (1-50, default 20)` | Get clinical trials for a disease | readOnly, openWorld |

### Article Tools (`tools/article.ts`) — 2 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `article_search` | `query: string`, `source?: "pubmed" \| "europepmc" \| "semantic_scholar" \| "pubtator" \| "litsense"`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)`, `dateRange?: string` (YYYY-MM-DD/YYYY-MM-DD, open-ended allowed) | Federated literature search with deduplication and optional date filtering (pubmed, europepmc, semantic_scholar). Note: europepmc truncates date ranges to year-level granularity | readOnly, openWorld |
| `article_get` | `id: string` (PMID, PMCID, or DOI), `sections?: ("core" \| "oa" \| "annotations" \| "graph" \| "citation" \| "all")[]`, `limit?: number (1-100, default 20)`, `citation_mode?: "fast" \| "full"` (default "fast"), `citation_direction?: "forward" \| "backward" \| "both"` (default "both") | Get detailed article information by identifier. Citation section uses fast mode (Europe PMC, Semantic Scholar, Crossref; ~4s) or full mode (adds PubMed, OpenCitations; ~15-30s). Results cached 10min. DOIs are resolved via NCBI IDConv with PubMed esearch fallback | readOnly, openWorld |

### Trial Tools (`tools/trial.ts`) — 2 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `trial_search` | `query: string`, `status?: string`, `phase?: string`, `intervention_type?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search clinical trials by condition, intervention, or keyword | readOnly, openWorld |
| `trial_get` | `nct_id: string`, `sections?: ("core" \| "eligibility" \| "locations" \| "outcomes" \| "all")[]`, `limit?: number (1-100, default 20)` | Get detailed trial information by NCT ID | readOnly, openWorld |

### Utility Tools (`tools/utility.ts`) — 2 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `discover` | `query: string` | Free-text concept resolution | readOnly |
| `batch_get` | `inputs: { entity: "gene" \| "variant" \| "drug" \| "disease" \| "trial" \| "article" \| "patent", id: string, sections?: string[] }[]` | Get multiple entities in parallel | readOnly |

### PDB Tools (`tools/pdb.ts`) — 1 tool

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `pdb` | `query?: string`, `pdb_id?: string`, `sections?: ("polymer_entities" \| "ligands" \| "assembly" \| "experiment" \| "citation" \| "all")[]`, `download?: boolean` (default false), `format?: "cif" \| "pdb"` (default "cif"), `limit?: number` (1-50, default 10), `offset?: number` (default 0) | Access RCSB PDB: search structures (query), get metadata (pdb_id), download files (pdb_id + download) | openWorld |

Param-based dispatch: `query` → search mode, `pdb_id` → get mode, `pdb_id` + `download=true` → download mode. Downloads save to OS temp dir and return file path + size. Default format is mmCIF (universally available); legacy PDB format may 404 for some entries.

### Patent Tools (`tools/patent.ts`) — 2 tools

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `patent_search` | `query: string` (quote exact multi-word concepts, e.g. "mRNA display"), `assignee?: string`, `inventor?: string`, `cpc?: string` (full symbol e.g. "C12N15/11"), `status?: "granted" \| "application"`, `date_range?: string` (YYYY-MM-DD/YYYY-MM-DD, open-ended allowed), `limit?: number (1-50, default 10)`, `offset?: number (default 0)`, `source?: "ops" \| "uspto_odp" \| "ppubs" \| "google_patents"`, `sort_by?: "relevance" \| "recency"` (default relevance; ppubs only), `seminal?: boolean` (default true: co-citation discovery of foundational prior art in `seminal_prior_art`; ~5-15s, set false for fastest lookups) | Search patents worldwide. Backends: ppubs (US full-text conceptual search, keyless, relevance-ranked — default US backend), ops (EPO OPS worldwide bibliographic, keyed), uspto_odp (US application metadata, bibliographic, keyed), google_patents (best-effort). Auto mode = worldwide + ppubs; hard ppubs failure falls back to uspto_odp once (tagged `_note`); 0-hit searches get a `_hint` | readOnly, openWorld |
| `patent_get` | `patent_id: string` (e.g. "US11027025B2", "EP3904939B1"), `sections?: ("core" \| "abstract" \| "claims" \| "citations" \| "family" \| "classifications" \| "all")[]`, `limit?: number (1-100, default 20)` | Get patent details with per-section source fallback chains. Claims: US fulltext via PPUBS, EP/WO via OPS. Citations include forward (`ct=`) and backward references | readOnly, openWorld |

**Total: 27 tools** across 9 registration modules.

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
```
