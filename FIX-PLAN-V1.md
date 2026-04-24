# FIX-PLAN-V1 — biomcp-ts QC Bug Fixes

**Branch**: `agent/coder/bugfix-260423` (from latest `main`)
**Repo**: `biomcp-ts` (`https://gitee.com/yeyuan98/biomcp-ts.git`)

## Overview

Independent QC subagents found **11 bugs** (4 critical, 4 high, 3 medium) in the current implementation. This plan addresses all of them. Vetted by an independent plan-review subagent.

---

## Fix 1 [P0]: PubTator3 search — wrong endpoint and parameters

**File**: `src/entities/article.ts:145`
**Current**: `/search?q=${encodeURIComponent(query)}&format=json&limit=${limit}&offset=${offset}`
**Correct**: `/search/?text=${encodeURIComponent(query)}`
**Verified**: `curl "https://www.ncbi.nlm.nih.gov/research/pubtator3-api/search?q=BRCA1"` → empty. `curl ".../search/?text=BRCA1"` → results.
**Response shape**: `{ results: [{ _id, pmid, pmcid, title, journal, authors, date, doi, score, text_hl }], facets, page_size, current, count, total_pages }`

**Changes**:
- `searchPubTator()`: Change URL to `/search/?text=${encodeURIComponent(query)}`
- Update `PubTatorResponse` type to match actual response: `{ results: Array<{ _id: string; pmid: number; pmcid?: string; title: string; journal?: string; authors?: string[]; date?: string; doi?: string; score?: number }> }`
- Update `transformPubTator()` to map new fields (pmid as `String(a.pmid)`, authors array, journal, doi)

---

## Fix 2 [P0]: PubTator3 annotations — wrong endpoint

**File**: `src/entities/article.ts:275`
**Current**: `/annotations?pmids=${pmid}&format=json`
**Correct**: `/publications/export/biocjson?pmids=${pmid}`
**Verified**: No `/annotations` endpoint exists in PubTator3 API.
**Response shape**: BioC-JSON format — `[{ pmid, passages: [{ text, annotations: [{ infons: { type, identifier }, text, locations: [{ offset, length }] }] }] }]`

**Changes**:
- `fetchAnnotations()`: Change URL to `/publications/export/biocjson?pmids=${pmid}`
- Update `PubTatorAnnotationsResponse` type for BioC-JSON structure
- Update transform logic to extract from BioC format

---

## Fix 3 [P0]: LitSense — wrong endpoint and parameters

**File**: `src/entities/article.ts:159`
**Current**: `/search?q=${encodeURIComponent(query)}&format=json&limit=${limit}`
**Correct**: `/sentences/?query=${encodeURIComponent(query)}&size=${limit}`
**Verified**: `curl ".../search?q=BRCA1"` → `{"detail": "This resource is not available"}`. `curl ".../sentences/?query=BRCA1&size=1"` → results.
**Response shape**: Array of `{ annotations, text, pmcid, pmid, score, section }`

**Changes**:
- `searchLitSense()`: Change URL to `/sentences/?query=${encodeURIComponent(query)}&size=${limit}`
- Update `LitSenseResponse` type: `Array<{ pmid: number; pmcid?: string; text: string; score: number; section: string; annotations: string[] }>`
- Update `transformLitSense()` to map `text` → `abstract`, `score` → `score`, `String(a.pmid)` → `pmid`

---

## Fix 4 [P0]: `ols3` not in registry — runtime crash

**File**: `src/entities/cross-entity.ts:260`
**Current**: `connectionManager.getConnection('ols3')` then calls `/search?q=...&format=json&rows=3`
**Registry**: Only `ols4` exists (`https://www.ebi.ac.uk/ols4`)

**Fix**: 
- Change `'ols3'` → `'ols4'`
- **Also update the API path**: OLS3 uses `/search?q=...`, OLS4 uses `/api/search?q=...`. Change path to `/api/search?q=${encodeURIComponent(query)}&size=3`
- **Verify/update `OLSResponse` type** (lines ~473-483): OLS4 response fields may differ from OLS3 (`obo_namespace`, `ontology_type` etc.)

---

## Fix 5 [P1]: GraphQL variables not passed — 5 locations

**Files**: `src/entities/gene.ts` (4 calls), `src/entities/cross-entity.ts` (1 call)
**Pattern**: `conn.request(query)` should be `conn.request(query, { variables: vars })`

| # | File | Function | Line | Query variables | Current call |
|---|------|----------|------|----------------|--------------|
| 1 | `gene.ts` | `fetchCivic` | ~251 | `{ symbol }` | `conn.request(query)` — missing vars |
| 2 | `gene.ts` | `fetchConstraint` (gnomad) | ~363 | `{ symbol }` | `conn.request(query)` — missing vars |
| 3 | `gene.ts` | `fetchDruggability` (dgidb) | ~309 | `{ symbol }` | `dgidbConn.request(dgidbQuery)` — missing vars |
| 4 | `gene.ts` | `fetchDruggability` (opentargets) | ~319 | `{ symbol }` | `otConn.request(otQuery)` — missing vars |
| 5 | `cross-entity.ts` | `geneToDrugs` | ~18 | query-specific | `conn.request(query)` — missing vars |

**Note**: `variant.ts` already passes variables correctly (lines 236, 357). Gene.ts and cross-entity.ts do not.

**Fix**: Add `{ variables: { symbol: geneSymbol } }` (or appropriate var names matching each query) as the second argument to each `conn.request()` call.

---

## Fix 6 [P1]: EuropePMC pagination hardcoded to first page

**File**: `src/entities/article.ts:117`
**Current**: Hardcodes `cursorMark=*`; `_offset` parameter ignored
**Fix**:
- Keep `cursorMark=*` as default for first page (this is correct)
- Accept `cursorMark` in `ArticleSearchOptions` as an alternative to numeric `offset`
- Return `nextCursorMark` from the EuropePMC response alongside results
- For MCP tool: keep numeric `offset` param; internally map to `cursorMark=*` for EuropePMC (since multi-page federated search doesn't need cursor advancement)
- **Minimal fix**: Document that EuropePMC always fetches the first page in federated search. For single-source searches, expose cursor-based pagination.

---

## Fix 7 [P1]: parseOaXml uses fragile regex

**File**: `src/entities/article.ts:264-268`
**Current**: Simple regex `<link\s+[^>]*format="pdf"[^>]*>([^<]*)</link>`
**Fix**: Use `fast-xml-parser` (already installed) to parse the OA XML response properly.

---

## Fix 8 [P2]: Silent error swallowing

**Files**: All search functions in `src/entities/article.ts`, `src/entities/gene.ts`, etc.
**Current**: Every function catches all errors and returns `[]` or `{}` silently
**Fix**: Add `console.error()` logging in catch blocks for development/debugging. Don't change the return behavior (empty results are appropriate for federated search — one backend failing shouldn't break the whole query).

---

## Fix 9 [P2]: Dead code — normalizeSummary

**Files**: `src/transform/gene.ts:44-50`, `src/__tests__/transform/gene.test.ts`
**Issue**: Removes ALL bracket and parenthetical content — destructive. Not used anywhere.
**Fix**: 
- Remove the `normalizeSummary` function from `src/transform/gene.ts`
- Remove its import and any test cases from `src/__tests__/transform/gene.test.ts`
- Verify `npm test` still passes

---

## Fix 10 [P2]: Test gaps

**Priority files needing more tests**:
- `src/entities/article.ts` — `fetchOpenAccess`, `fetchAnnotations`, `fetchCitationGraph`, `federatedSearch` are untested
- `src/entities/gene.ts` — `fetchCivic`, `fetchConstraint`, `fetchDruggability` (GraphQL calls) untested
- `src/entities/cross-entity.ts` — most cross-entity functions untested individually
- Update existing tests for PubTator3 and LitSense new endpoints

---

## Execution Order

1. **Fix 4** — one-line change `ols3` → `ols4` (unblocks `gene_enrich`)
2. **Fix 1** — PubTator3 search endpoint
3. **Fix 2** — PubTator3 annotations endpoint
4. **Fix 3** — LitSense endpoint
5. **Fix 5** — GraphQL variables in gene.ts
6. **Fix 6** — EuropePMC pagination (minimal: document behavior)
7. **Fix 7** — parseOaXml with fast-xml-parser
8. **Fix 8** — Add console.error logging
9. **Fix 9** — Remove dead code
10. **Fix 10** — Update tests for all fixed endpoints

---

## Files Modified

| File | Changes |
|------|---------|
| `src/entities/article.ts` | Fix 1, 2, 3, 6, 7, 8 — PubTator, LitSense URLs/types, parseOaXml |
| `src/entities/cross-entity.ts` | Fix 4 — `ols3` → `ols4`; Fix 5 — GraphQL variables in `geneToDrugs` |
| `src/entities/gene.ts` | Fix 5, 8 — GraphQL variables (4 calls), error logging |
| `src/transform/gene.ts` | Fix 9 — remove dead `normalizeSummary` |
| `src/__tests__/transform/gene.test.ts` | Fix 9 — remove normalizeSummary import and tests |
| `src/__tests__/entities/article.test.ts` | Fix 10 — update for new endpoints |
| `src/__tests__/entities/gene.test.ts` | Fix 10 — add GraphQL variable tests |

## Verification

After all fixes:
1. `npx tsc --noEmit` — clean
2. `npm test` — all tests pass
3. Live smoke test with `curl` for each fixed endpoint
