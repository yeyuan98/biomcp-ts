# FIX-PLAN-V1 — biomcp-ts Bug Fixes & PubMed Pipeline Rewrite

## Overview

This plan addresses 4 categories of bugs discovered in the biomcp-ts codebase and implements a PubMed pipeline rewrite to fetch full article content via EFetch XML instead of truncated ESummary data.

---

## Fix A: Server Crash — Duplicate Tool Names

**Impact**: MCP SDK throws `"Tool X is already registered"` at startup, preventing Claude Desktop or any MCP client from connecting.

**Root cause**: 5 tool names are registered in both entity-specific files and `pivot.ts`:

| Tool name | Entity file | pivot.ts line |
|-----------|------------|---------------|
| `gene_pathways` | `gene.ts:62` | `pivot.ts:53` |
| `disease_drugs` | `disease.ts:116` | `pivot.ts:143` |
| `disease_genes` | `disease.ts:74` | `pivot.ts:158` |
| `disease_trials` | `disease.ts:142` | `pivot.ts:173` |
| `drug_adverse_events` | `drug.ts:102` | `pivot.ts:128` |

**Implementation difference**: The 5 duplicates have **different implementations** in each location:

| Tool | Entity file (uses) | pivot.ts (uses) |
|------|-------------------|-----------------|
| `gene_pathways` | `geneGet(symbol, ['pathways'])` — detailed, multi-source | `geneToPathways(symbol)` — Reactome only |
| `disease_drugs` | `diseaseGet(id, ['drug_associations'])` — detailed, multi-source | `diseaseToDrugs(query)` — ChEMBL only |
| `disease_genes` | `diseaseGet(id, ['gene_associations'])` — detailed, multi-source | `diseaseToGenes(id)` — DisGeNET only |
| `disease_trials` | `diseaseGet(name, ['trials'])` — ClinicalTrials.gov | `diseaseToTrials(query)` — cross-entity |
| `drug_adverse_events` | `drugGet(name, ['safety'])` — OpenFDA | `drugToAdverseEvents(drug)` — cross-entity |

**Decision**: Keep the entity-file registrations (they call the richer `*Get()` functions that aggregate from multiple sources). Remove the 5 pivot.ts duplicates. The cross-entity functions (`geneToPathways`, etc.) remain available for import but are not exposed as duplicate tools.

**Fix**: Remove all 5 duplicate `server.registerTool()` calls from `pivot.ts` (lines 52-65, 127-140, 142-155, 157-170, 172-185).

**Files modified**:
- `src/server/tools/pivot.ts` — remove 5 blocks
- `src/__tests__/integration/tool-registration.test.ts` — update expected total from 55 to 50
- `src/server/tools/utility.ts` — update `biomcp_list` tool list (lines 101-116): remove `gene_pathways` duplicate at line 110, remove `pathway_search`/`pathway_get` ghost entries (line 109, never registered anywhere)

---

## Fix B: PubMed Pipeline — Full Content via EFetch XML

**User requirement**: "fetch full article content, not just truncated information, and fully exploit API capabilities of PubMed (e.g., batch search, etc.)"

### NCBI E-utilities API facts (verified against official docs)

| Endpoint | db=pubmed | retmode=json | Response format |
|----------|-----------|-------------|-----------------|
| ESearch | Yes | Yes | `{ esearchresult: { idlist: [...], count, ... } }` |
| ESummary | Yes | Yes | `{ result: { uids: ["123"], "123": { uid, title, ... } } }` — object with UID keys, NOT array |
| EFetch | Yes | **No** | XML only (`retmode=xml` or `retmode=text` with `rettype=medline|abstract|uilist`) |
| ELink | Yes | Yes | `{ linksets: [...] }` |

**EFetch XML** provides: full abstract, MeSH headings, authors with affiliations, publication types, DOI, journal details, grant info, keywords, chemical descriptors, article IDs (PMID, PMCID, DOI, etc.)

**EFetch supports batch**: `id=123,456,789` (comma-separated, up to ~200 per request)

### Bug B1: `searchPubMed()` — ESummary response treated as array

**Location**: `src/entities/article.ts:103`

```typescript
// BUG: summaryResponse.result is an object { uids: [...], "123": {...} }, not an array
return (summaryResponse.result || []).map(transformPubMedArticle);
```

**Fix**: Replace ESummary with EFetch XML for the search pipeline. Use ESearch to get IDs, then EFetch with `db=pubmed&id=COMMA_SEPARATED_IDS&rettype=abstract&retmode=xml` to get full article data including abstracts, authors, MeSH terms, DOIs, etc. Parse the XML response with `fast-xml-parser`.

### Bug B2: `fetchPubMedArticle()` — uses unsupported `retmode=json`

**Location**: `src/entities/article.ts:224-225`

```typescript
// BUG: EFetch pubmed does NOT support retmode=json — returns XML, .json() fails
const response = await conn.request(
  `/efetch.fcgi?db=pubmed&id=${pmid}&retmode=json`
) as PubMedFetchResponse;
```

**Fix**: Change to `retmode=xml` and parse the XML response using `fast-xml-parser`. Extract full article metadata from the parsed XML tree.

### Bug B3: `PubMedSummaryResponse` type — modeled as array instead of object

**Location**: `src/entities/article.ts:321-330`

The `PubMedSummaryResponse.result` type is declared as `Array<{ uid, title, ... }>` but ESummary actually returns `{ uids: string[], [uid: string]: { uid, title, ... } }`.

**Fix**: This type becomes unused after switching to EFetch XML. Remove it and replace with XML-derived types.

### Bug B4: EuropePMC pagination — wrong cursor parameter

**Location**: `src/entities/article.ts:114`

```typescript
// BUG: offset is a number but cursorMark must be a string token (e.g., "*" for first page)
`/search?...&cursorMark=${offset}`
```

**Fix**: Accept `cursorMark` string instead of numeric offset. For the first page use `cursorMark=*`, for subsequent pages use the `nextCursorMark` from the previous response. Add a `cursorMark?: string` field to `ArticleSearchOptions`.

**Note on MCP tool schema**: The `article_search` tool in `src/server/tools/article.ts:13-17` currently exposes `offset: z.number()`. The EuropePMC pagination fix is internal only — the tool will keep the `offset` parameter for other backends (PubMed uses `retstart`, Semantic Scholar uses numeric offset) and internally use `cursorMark=*` for EuropePMC. This avoids requiring MCP clients to understand cursor tokens.

### Bug B5: `fetchOpenAccess()` — PMCID not passed to OA API

**Location**: `src/entities/article.ts:256`

```typescript
// BUG: missing id parameter — should be ?id=PMCID
const oaResponse = await pmcConn.request(
  `?tool=biomcp&format=json`
) as OAResponse;
```

**Fix**: Pass the PMCID: `?id=${response.pmcid}`. Note: PMC OA API returns XML only — there is no JSON format. The `format` parameter on oa.fcgi filters by download file type (pdf/tgz), NOT response serialization. Remove `format=json` and parse the XML response.

### Implementation plan for Fix B

1. **Add dependency**: `fast-xml-parser` (pure JS, ESM-compatible, no native deps) to `package.json` as a regular dependency.

2. **Create `src/transform/pubmed.ts`**: Pure function `parsePubMedXml(xmlString: string): Article[]` that:
   - Uses `fast-xml-parser` to parse the XML
   - Traverses `PubmedArticleSet > PubmedArticle[]` elements
   - Extracts: PMID, title, full abstract (concatenating structured abstract sections), authors (with affiliations), journal (title, ISO abbreviation, volume, issue, pages), publication date, DOI, other article IDs (PMCID, etc.), MeSH headings, publication types, keywords, chemical descriptors, grant info
   - Includes error handling for malformed XML (try/catch with meaningful error including PMID context)
   - Returns `Article[]` array
   - Exported and fully testable without network calls

3. **Create `src/__tests__/transform/pubmed.test.ts`**: Unit tests for `parsePubMedXml()` using real PubMed XML fixtures (one simple article, one with structured abstract, one with MeSH terms, batch of 3 articles).

4. **Rewrite `searchPubMed()` in `src/entities/article.ts`**:
   - Step 1: ESearch to get PMIDs (`/esearch.fcgi?db=pubmed&term=...&retmax=N&retmode=json`)
   - Step 2: EFetch with batch IDs (`/efetch.fcgi?db=pubmed&id=1,2,3&rettype=abstract&retmode=xml`)
   - Step 3: Parse XML with `parsePubMedXml()` — get full article data
   - Return `Article[]` with full abstracts, authors, MeSH, DOI, etc.

5. **Rewrite `fetchPubMedArticle()` in `src/entities/article.ts`**:
   - Use EFetch with `retmode=xml`
   - Parse response XML with `parsePubMedXml()`
   - Return single `Article`

6. **Fix EuropePMC pagination**:
   - Change `searchEuropePMC` to use `cursorMark=*` as default (first page)
   - Pass `cursorMark=${encodeURIComponent(cursorMark)}` instead of numeric offset
   - EuropePMC pagination is internal — MCP tool still exposes numeric `offset` for other backends

7. **Fix `fetchOpenAccess()`**:
   - Pass `id=${response.pmcid}` to the OA API URL
   - Remove `format=json` (not supported by OA API)
   - Handle XML response — parse to extract `<link>` URL and format attributes

8. **Update types in `src/entities/article.ts`**:
   - Remove `PubMedSummaryResponse`, `PubMedFetchResponse`, `PubMedFetchItem`
   - Remove exported `transformPubMedArticle()` (becomes dead code — superseded by `parsePubMedXml()`)
   - Remove exported `transformArticleResponse()` (becomes dead code — same)
   - Add `PubMedEFetchXmlArticle` type for the parsed XML structure (internal to `transform/pubmed.ts`)

9. **Update tests**:
   - `src/__tests__/entities/article.test.ts` — update for new pipeline (mock EFetch XML responses instead of ESummary JSON), remove tests for deleted transform functions
   - Add EuropePMC cursorMark tests
   - Add fetchOpenAccess PMCID pass-through test

### Dual content-type for PubMed connection

The `pubmed` source in the registry is used for both ESearch (returns JSON) and EFetch (returns XML). Fix C's response-based content-type detection handles this correctly — the `response.json()` vs `response.text()` decision is based on the actual `Content-Type` header, not the registry config. No need to use the separate `ncbi_efetch` source.

The existing `ncbi_efetch` source (`registry.ts:244-254`) is currently unused anywhere. It should be removed to avoid confusion, or repurposed with `handling: { contentType: 'xml' }` for EFetch calls. **Decision: remove it** — the `pubmed` source works for both via response-based content detection.

---

## Fix C: RestConnection — Content-Type Awareness

**Impact**: `RestConnection.request()` always calls `response.json()` (line 51), which fails on XML/text responses from PubMed EFetch, PMC OA, KEGG, HPA, MedlinePlus.

**Location**: `src/connections/rest.ts:51`

```typescript
// BUG: assumes all responses are JSON
return response.json();
```

**Fix**: Check the response `Content-Type` header and parse accordingly:
- `application/json` → `response.json()`
- `text/xml`, `application/xml` → `response.text()` (caller handles XML parsing)
- `text/plain` → `response.text()`
- Other → `response.text()` (safe fallback)

Also update `buildHeaders()` to respect `contentType` from `ConnectionHandling` in the `Accept` header (currently hardcoded to `application/json` at line 96). The `handling.contentType` field already exists in the registry for `hpa` (line 35), `kegg` (line 83), and `medlineplus` (line 171) sources.

**ConnectionHandling interface** (`src/connections/base.ts:30`):
```typescript
contentType?: 'json' | 'xml' | 'text' | 'binary';
```
The `'binary'` variant should be handled (e.g., return `ArrayBuffer`).

**Files modified**:
- `src/connections/rest.ts` — content-type-aware response parsing + Accept header from `handling.contentType`
- `src/__tests__/connections/rest.test.ts` — add tests for XML and text responses

---

## Fix D: Registry — pmc_oa Source Config + Remove Dead ncbi_efetch Source

**Location**: `src/connections/registry.ts:266-276`

The `pmc_oa` source is registered but its `handling` config lacks `contentType: 'xml'`. The PMC OA API returns XML only.

**Fix**: Add `handling: { contentType: 'xml' }` to the `pmc_oa` entry.

**Also remove** the dead `ncbi_efetch` source (`registry.ts:244-254`) — it duplicates the `pubmed` base URL and is never used.

---

## Execution Order

1. **Fix A** (server crash) — remove 5 duplicate tools from pivot.ts, update integration test count, update utility.ts tool list → unblocks all testing
2. **Fix C** (RestConnection) — add content-type awareness → unblocks XML parsing
3. **Fix D** (registry) — add `contentType: 'xml'` to pmc_oa, remove dead `ncbi_efetch` → enables correct content negotiation
4. **Fix B** (PubMed pipeline) — install fast-xml-parser, create XML parser, rewrite searchPubMed/fetchPubMedArticle, fix EuropePMC pagination, fix fetchOpenAccess, update all types and tests

---

## Test Plan

After all fixes:
1. Run full test suite: `npx jest` — all tests pass
2. Build: `npx tsc --noEmit` — no type errors
3. Integration test: verify tool registration test checks for **no duplicate tool names** (not just count) to catch regressions
4. Smoke test: start the MCP server with `node dist/index.js` and verify it initializes without errors (no "already registered" crash)
5. Manual verification with Claude Desktop or MCP Inspector: call `article_search` with a PubMed query and confirm full abstracts are returned (not empty/truncated)

---

## Files Summary

| File | Change |
|------|--------|
| `src/server/tools/pivot.ts` | Remove 5 duplicate registerTool blocks |
| `src/server/tools/utility.ts` | Update `biomcp_list` tool list — remove duplicates and ghost entries |
| `src/connections/rest.ts` | Add content-type-aware response parsing + Accept header |
| `src/connections/registry.ts` | Add `contentType: 'xml'` to pmc_oa, remove dead `ncbi_efetch` |
| `src/entities/article.ts` | Rewrite PubMed pipeline, fix EuropePMC pagination, fix fetchOpenAccess, remove dead transform functions and types |
| `src/transform/pubmed.ts` | **New** — parsePubMedXml() function with error handling |
| `src/__tests__/transform/pubmed.test.ts` | **New** — XML parser unit tests |
| `src/__tests__/integration/tool-registration.test.ts` | Update expected count to 50, add duplicate-name assertion |
| `src/__tests__/entities/article.test.ts` | Update for new PubMed pipeline, remove dead transform tests |
| `src/__tests__/connections/rest.test.ts` | Add content-type handling tests |
| `package.json` | Add `fast-xml-parser` dependency |
