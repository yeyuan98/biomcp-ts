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

Entry point: `src/server/index.ts`. Calls eight registration functions in order: `registerGeneTools`, `registerVariantTools`, `registerDrugTools`, `registerDiseaseTools`, `registerArticleTools`, `registerTrialTools`, `registerUtilityTools`, `registerPivotTools`.

## Tool Handler Pattern

Every tool handler follows the same contract:

1. Zod schema validates and destructures input parameters (the SDK handles parsing)
2. Call one or more entity functions from `src/entities/`
3. Return `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`
4. On error: return `{ content: [{ type: 'text', text: String(error) }], isError: true }`

Section-specific tools (e.g. `gene_pathways`) use `sectionResult()` from `errors.ts` to extract a single section from the entity result. If the section contains a `_error` key, it is returned with `isError: true`.

## Complete Tool Registry

### Gene Tools (`tools/gene.ts`)

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `gene_search` | `query: string`, `gene_type?: "protein-coding" \| "ncRNA" \| "pseudo"`, `chromosome?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search for genes by symbol, name, or keyword | readOnly, openWorld |
| `gene_get` | `symbol: string`, `sections?: ("pathways" \| "ontology" \| "diseases" \| "diagnostics" \| "protein" \| "go" \| "interactions" \| "civic" \| "expression" \| "hpa" \| "druggability" \| "clingen" \| "constraint" \| "disgenet" \| "funding" \| "all")[]` | Get detailed gene information by symbol | readOnly, openWorld |
| `gene_pathways` | `symbol: string`, `limit?: number (1-50, default 10)` | Get pathways containing a gene | readOnly, openWorld |
| `gene_diseases` | `symbol: string`, `limit?: number (1-50, default 10)` | Get diseases associated with a gene. Requires `DISGENET_API_KEY`; falls back to OpenTargets | readOnly, openWorld |
| `gene_go_enrichment` | `symbol: string` | Get GO term enrichment via QuickGO | readOnly, openWorld |
| `gene_interactions` | `symbol: string`, `limit?: number (1-50, default 20)` | Get protein interactions via STRING | readOnly, openWorld |
| `gene_expression` | `symbol: string`, `limit?: number (1-50, default 20)` | Get GTEx tissue expression (~54 tissues) | readOnly, openWorld |
| `gene_constraint` | `symbol: string` | Get gnomAD constraint metrics | readOnly, openWorld |
| `gene_druggability` | `symbol: string` | Get druggability data via DGIdb and OpenTargets | readOnly, openWorld |
| `gene_clingen` | `symbol: string` | Get ClinGen dosage sensitivity | readOnly, openWorld |

### Variant Tools (`tools/variant.ts`)

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `variant_search` | `query?: string`, `gene?: string`, `significance?: "benign" \| "likely_benign" \| "pathogenic" \| "likely_pathogenic" \| "uncertain"`, `max_frequency?: number`, `min_cadd?: number`, `consequence?: string`, `rsid?: string`, `hgvsp?: string`, `hgvsc?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search for variants by rsid, HGVS, gene+protein change | readOnly, openWorld |
| `variant_get` | `id: string`, `sections?: ("core" \| "frequency" \| "predictions" \| "clinical" \| "alphagenome" \| "all")[]` | Get detailed variant information with optional sections | readOnly, openWorld |
| `variant_frequency` | `id: string` | Get population frequency data from gnomAD | readOnly, openWorld |
| `variant_predictions` | `id: string` | Get pathogenicity predictions (CADD, SIFT, PolyPhen, conservation) | readOnly, openWorld |
| `variant_oncokb` | `gene: string`, `protein_change: string` | Get OncoKB annotations. Requires `ONCOKB_TOKEN` | readOnly, openWorld |
| `variant_alphagenome` | `id: string`, `gene?: string` | Get AlphaGenome variant scores via gRPC. Requires `ALPHAGENOME_API_KEY` | readOnly, openWorld |

### Drug Tools (`tools/drug.ts`)

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `drug_search` | `query: string`, `drug_type?: string`, `source?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search for drugs by name, mechanism, or keyword | readOnly, openWorld |
| `drug_get` | `name: string`, `sections?: ("core" \| "us_regulatory" \| "eu_regulatory" \| "who_regulatory" \| "safety" \| "targets" \| "indications" \| "all")[]` | Get detailed drug information by name | readOnly, openWorld |
| `drug_targets` | `name: string`, `limit?: number (1-50, default 20)` | Get drug targets via ChEMBL | readOnly, openWorld |
| `drug_indications` | `name: string`, `limit?: number (1-50, default 20)` | Get drug indications via ChEMBL | readOnly, openWorld |
| `drug_adverse_events` | `name: string` | Get adverse events via OpenFDA | readOnly, openWorld |
| `drug_regulatory` | `name: string` | Get FDA regulatory information | readOnly, openWorld |

### Disease Tools (`tools/disease.ts`)

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `disease_search` | `query: string`, `disease_type?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search for diseases by name, phenotype, or keyword | readOnly, openWorld |
| `disease_get` | `disease_id: string`, `sections?: ("core" \| "gene_associations" \| "phenotypes" \| "pathways" \| "survival" \| "all")[]` | Get detailed disease information by ID | readOnly, openWorld |
| `disease_genes` | `disease_id: string`, `limit?: number (1-50, default 20)` | Get genes associated with a disease via DisGeNET. Requires `DISGENET_API_KEY` | readOnly, openWorld |
| `disease_phenotypes` | `disease_id: string`, `limit?: number (1-50, default 20)` | Get HPO phenotypes for a disease | readOnly, openWorld |
| `disease_drugs` | `disease_id: string`, `limit?: number (1-50, default 20)` | Get drugs for a disease via OpenTargets | readOnly, openWorld |
| `disease_trials` | `disease_id: string`, `limit?: number (1-50, default 20)` | Get clinical trials for a disease | readOnly, openWorld |

### Article Tools (`tools/article.ts`)

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `article_search` | `query: string`, `source?: "pubmed" \| "europepmc" \| "semantic_scholar" \| "pubtator" \| "litsense"`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Federated literature search with deduplication | readOnly, openWorld |
| `article_get` | `pmid: string`, `sections?: ("core" \| "oa" \| "annotations" \| "graph" \| "all")[]` | Get detailed article information by PMID | readOnly, openWorld |
| `article_annotations` | `pmid: string` | Get PubTator annotations for an article | readOnly, openWorld |
| `article_citations` | `pmid: string` | Get citation graph for an article | readOnly, openWorld |

### Trial Tools (`tools/trial.ts`)

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `trial_search` | `query: string`, `status?: string`, `phase?: string`, `intervention_type?: string`, `limit?: number (1-50, default 10)`, `offset?: number (default 0)` | Search clinical trials by condition, intervention, or keyword | readOnly, openWorld |
| `trial_get` | `nct_id: string`, `sections?: ("core" \| "eligibility" \| "locations" \| "outcomes" \| "all")[]` | Get detailed trial information by NCT ID | readOnly, openWorld |
| `trial_eligibility` | `nct_id: string` | Get eligibility criteria for a trial | readOnly, openWorld |
| `trial_locations` | `nct_id: string`, `limit?: number (1-100, default 50)` | Get trial location sites | readOnly, openWorld |
| `trial_outcomes` | `nct_id: string` | Get trial outcomes | readOnly, openWorld |

### Pivot / Cross-Entity Tools (`tools/pivot.ts`)

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `gene_drugs` | `symbol: string` | Find drugs targeting a gene | readOnly |
| `gene_trials` | `symbol: string` | Find clinical trials for a gene | readOnly |
| `gene_articles` | `symbol: string` | Find articles about a gene | readOnly |
| `variant_trials` | `variant: string` | Find clinical trials for a variant | readOnly |
| `drug_genes` | `drug: string` | Find genes targeted by a drug | readOnly |
| `drug_trials` | `drug: string` | Find clinical trials for a drug | readOnly |
| `gene_enrich` | `genes: string[]` | Pathway enrichment analysis for a gene list | readOnly |
| `discover` | `query: string` | Free-text concept resolution | readOnly |
| `search_all` | `query: string`, `limit?: number (1-20, default 5)`, `entities?: ("gene" \| "variant" \| "drug" \| "disease" \| "article" \| "trial")[]` | Federated search across all entity types | readOnly |
| `batch_get` | `inputs: { entity: "gene" \| "variant" \| "drug" \| "disease" \| "trial" \| "article", id: string, sections?: string[] }[]` | Get multiple entities in parallel | readOnly |

### Utility Tools (`tools/utility.ts`)

| Tool | Input Schema | Description | Annotations |
|------|-------------|-------------|-------------|
| `biomcp_health` | `apis_only?: boolean (default false)` | Check connectivity to upstream data sources (mygene, myvariant, pubmed, uniprot, clinicaltrials) | readOnly |
| `biomcp_list` | `entity?: string` | List available entities, tools, and operations | readOnly |
| `version` | _(none)_ | Get BioMCP server version info | readOnly |

**Total: 50 tools** across 8 registration modules.

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
| `pmid` | `z.string()` | regex `/^\d+$/` |
| `nctId` | `z.string()` | regex `/^NCT\d{8}$/` |
| `limit` | `z.number()` | int, min 1, max 100 |
| `offset` | `z.number()` | int, min 0 |

### `isValidEntityInput(entity: string, id: string): boolean`

Validates an entity identifier against the appropriate `InputValidation` schema. Supports: `gene`, `variant`, `drug`, `disease`, `trial` (accepts NCT ID or PMID), `article`.

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
    gene.ts           10 gene tools
    variant.ts        6 variant tools
    drug.ts           6 drug tools
    disease.ts        6 disease tools
    article.ts        4 article tools
    trial.ts          5 trial tools
    pivot.ts          10 cross-entity pivot tools
    utility.ts        3 utility tools
```
