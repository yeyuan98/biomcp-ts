# FIX-PLAN-V2 — biomcp-ts Bug Fix Implementation Plan

**Branch**: `agent/coder/bugfix-260423`
**Repo**: `https://gitee.com/yeyuan98/biomcp-ts.git`
**Base commit**: `73c9fdc`
**Revised**: After independent subagent review (code + API verification)

17 fixes across 10 files, organized in 4 phases by risk and dependency.

---

## Phase 1 — String renames and one-liners (Low risk, ~6 fixes)

### 1.1 ClinicalTrials.gov module name mapping

**File**: `src/entities/trial.ts`
**Tools affected**: `trial_get`, `trial_eligibility`, `trial_locations`

The ClinicalTrials.gov v2 API returns these module names under `protocolSection`:

| Module name to use |
|---|
| `identificationModule` |
| `statusModule` |
| `descriptionModule` |
| `armsInterventionsModule` |
| `contactsLocationsModule` |
| `eligibilityModule` |
| `outcomesModule` |

Rename all module key accesses throughout the file:
- `trialGet()` lines 96-100
- `fetchEligibility()` line 173
- `fetchLocations()` line 199
- `transformTrialSearchResult()` line 313
- `transformTrialResponse()` line 330
- All 4 TypeScript interfaces: `ClinicalTrialsSearchResponse`, `ClinicalTrialsDetailResponse`, `ClinicalTrialsSearchStudy`, `ClinicalTrialsDetailStudy`

Required renames:
| Current | Correct |
|---------|---------|
| `identModule` | `identificationModule` |
| `descModule` | `descriptionModule` |
| `armsModule` | `armsInterventionsModule` |
| `contactsModule` | `contactsLocationsModule` |
| `eligModule` | `eligibilityModule` |
| `statusModule` | `statusModule` (unchanged) |
| `outcomesModule` | `outcomesModule` (unchanged) |

### 1.2 RestConnection JSON content-type detection

**File**: `src/connections/rest.ts:52`
**Tool affected**: `gene_interactions`

Change the content-type check to match any response containing `json`:
```ts
if (!contentType || contentType.includes('json')) {
```

### 1.3 OpenFDA drug search by generic name

**File**: `src/entities/drug.ts`
**Tools affected**: `drug_adverse_events`, `drug_regulatory`

Change `fetchUSRegulatory()` and `fetchSafety()` to search OpenFDA by `openfda.generic_name` instead of `openfda.uichem.accession`. Pass `drug.name` as the search parameter instead of `drug.uichem`:

```ts
async function fetchUSRegulatory(drugName: string): Promise<...> {
  const conn = connectionManager.getConnection('openfda');
  const response = await conn.request(
    `/drug/label.json?search=openfda.generic_name:${encodeURIComponent(drugName)}&limit=1`
  ) as OpenFDAResponse;
  ...
}
```

Apply same pattern to `fetchSafety()`. Update callers in `drugGet()` to pass `name` instead of `drug.uichem`.

**Also fix**: `brand_name` is under `openfda`, not top-level. At line ~158, change `label.brand_name?.[0]` to `label.openfda?.brand_name?.[0]`. Update `OpenFDAResponse` interface accordingly.

### 1.4 gnomAD variant frequency — use MyVariant data directly

**File**: `src/entities/variant.ts:227-272`
**Tools affected**: `variant_frequency`, `variant_get`

Remove the broken gnomAD GraphQL frequency query. Use the frequency data already present in the MyVariant response (`variant.gnomad`):

```ts
async function fetchFrequencySection(variant: MyVariantGetResponse): Promise<FrequencySection | null> {
  if (variant.gnomad) {
    return {
      gnomad_af: variant.gnomad.af,
      exac_af: variant.gnomad.exac_af,
      population_breakdown: variant.gnomad.populations || {},
    };
  }
  return null;
}
```

### 1.5 gnomAD constraint query — update to v4 schema

**File**: `src/entities/gene.ts:394-418`
**Tool affected**: `gene_constraint`

Replace the GraphQL query with the correct gnomAD v4 schema:

```ts
const query = `query($symbol: String!, $refGenome: ReferenceGenomeId!) {
  gene(gene_symbol: $symbol, reference_genome: $refGenome) {
    gnomad_constraint {
      oe_lof
      oe_lof_upper
      oe_mis
      oe_syn
    }
  }
}`;
const vars = { symbol: geneSymbol, refGenome: 'GRCh38' };
```

Parse response from `data.gene.gnomad_constraint`:
```ts
const data = response.data?.gene?.gnomad_constraint;
return {
  lof: { oe_score: data?.oe_lof || 0, oe_lof_upper: data?.oe_lof_upper || 0, mis_bad_loe: data?.oe_mis || 0 },
  syn: { oe_score: data?.oe_syn || 0 },
};
```

**Note**: Update the function's return type annotation to include `oe_lof_upper?: number` in the `lof` sub-object.

### 1.6 healthCheck — accept any HTTP response as "reachable"

**File**: `src/connections/rest.ts:66-73`
**Tool affected**: `biomcp_health`

If the server returns any HTTP response (even 404/403), it's reachable. Only network errors mean "down":

```ts
async healthCheck(): Promise<boolean> {
  try {
    await fetch(this.options.baseUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}
```

---

## Phase 2 — Endpoint migrations (Medium risk, ~5 fixes)

### 2.1 GTEx v2 API

**File**: `src/entities/gene.ts:292-311`
**Tool affected**: `gene_expression`

Two-step lookup:
1. Query MyGene for `ensembl.gene` ID
2. Call GTEx v2: `/api/v2/expression/medianGeneExpression?gencodeId={ensemblId}`

**Important**: Use the `medianGeneExpression` endpoint (NOT `geneExpression`). The `geneExpression` endpoint returns per-sample arrays of hundreds of values — unsuitable for summary. The `medianGeneExpression` endpoint returns `{ median }` per tissue.

```ts
async function fetchExpression(geneSymbol: string) {
  const mygeneConn = connectionManager.getConnection('mygene');
  const geneResponse = await mygeneConn.request(
    `/query?q=symbol:${encodeURIComponent(geneSymbol)}&species=human&fields=ensembl.gene&size=1`
  ) as any;
  const ensemblId = geneResponse?.hits?.[0]?.ensembl?.gene;
  if (!ensemblId) return { _error: `Could not resolve Ensembl ID for '${geneSymbol}'` };

  const conn = connectionManager.getConnection('gtex');
  const response = await conn.request(
    `/api/v2/expression/medianGeneExpression?gencodeId=${encodeURIComponent(ensemblId)}`
  ) as any;
  const tissues = (response.data || []).slice(0, 20).map((r: any) => ({
    tissue: r.tissueSiteDetailId,
    tpm: r.median,
  }));
  return { tissues };
}
```

**Caveat**: GTEx may require a versioned gencodeId (e.g., `ENSG00000141510.11`). If bare IDs fail, probe `/api/v2/reference/gene?geneSymbol={symbol}` to get the versioned ID first.

### 2.2 DGIdb GraphQL endpoint

**Files**: `src/connections/registry.ts:438-442`, `src/entities/gene.ts:334-346`
**Tool affected**: `gene_druggability`

Update `dgidb` baseUrl in registry:
```ts
dgidb: { sourceId: 'dgidb', baseUrl: 'https://dgidb.org/api/graphql', protocol: 'graphql', ... }
```

Update query to use DGIdb's actual GraphQL schema (verified working):
```ts
const dgidbQuery = `query($names: [String!]!) {
  genes(names: $names) {
    nodes {
      interactions {
        drug { name conceptId }
        interactionTypes { type directionality }
      }
    }
  }
}`;
const vars = { names: [geneSymbol] };
```

Key corrections from review:
- Variable type must be `[String!]!` (non-null items), not `[String]`
- Must use `.nodes` wrapper to access gene objects (relay-style connection)
- `interactionTypes` is an object requiring sub-field selections `{ type directionality }`

Update response parsing from `data.genes.nodes[0].interactions[].drug` instead of `data.genes[0].interactions`.

### 2.3 Monarch API endpoint — graceful fallback

**File**: `src/entities/disease.ts:171-187`
**Tool affected**: `disease_phenotypes`

**Status**: All known Monarch API endpoints return 404. The HPO fallback at `ontology.jax.org` also returns 404. No working phenotypes API was found during review.

**Action**: Return a clear graceful error message:
```ts
async function fetchPhenotypes(diseaseId: string) {
  return { _error: 'Monarch phenotypes API is currently unavailable. The service has been reorganized.' };
}
```

**Future**: Re-evaluate when Monarch or HPO restores their API.

### 2.4 PubTator annotations — graceful fallback

**File**: `src/entities/article.ts:316-345`
**Tool affected**: `article_annotations`

**Status**: PubTator3 annotations API returns `"This resource is not available"` for all endpoints tested.

**Action**: Return a graceful error and add `Array.isArray()` guard for safety:
```ts
if (!response || !Array.isArray(response)) {
  return [];
}
```

If the API returns a non-array (error object), this prevents a crash. When the API is restored, it will resume working.

### 2.5 ClinGen dosage sensitivity — graceful fallback

**File**: `src/entities/gene.ts:373-392`, `src/connections/registry.ts:19-24`
**Tool affected**: `gene_clingen`

**Status**: ClinGen does not expose a publicly accessible JSON/GraphQL API.

**Action**: Return a graceful error:
```ts
async function fetchClingen(geneSymbol: string) {
  return { _error: `ClinGen dosage sensitivity data for '${geneSymbol}' is not available via public API. Visit https://search.clinicalgenome.org for manual lookup.` };
}
```

---

## Phase 3 — GraphQL query fixes (Medium risk, ~4 fixes)

### 3.1 OpenTargets gene_drugs — fix search query AND drug query

**File**: `src/entities/cross-entity.ts:12-50`
**Tool affected**: `gene_drugs`

Two bugs in the same function:

**Bug A** (search query): Replace `targets { id approvedSymbol }` with `hits { id name entity }`:
```ts
const searchQuery = `query($symbol: String!) {
  search(queryString: $symbol, entityNames: ["target"], page: {index: 0, size: 1}) {
    hits { id name entity }
  }
}`;
const targetId = searchData?.data?.search?.hits?.[0]?.id;
```

**Bug B** (drug query): `knownDrugs` is not a valid field on OpenTargets v4. Replace with `drugAndClinicalCandidates`:
```ts
const drugQuery = `query($ensemblId: String!) {
  target(ensemblId: $ensemblId) {
    drugAndClinicalCandidates {
      rows { maxClinicalStage drug { id name drugType } }
    }
  }
}`;
```

Update response parsing to walk `data.target.drugAndClinicalCandidates.rows`.

### ~~3.2 OpenTargets disease_drugs~~ — NOT A BUG

The existing `diseaseToDrugs` code already uses correct `hits` and `disease(efoId:)` queries. No fix needed. **Removed from plan.**

### 3.3 OpenTargets gene_druggability — resolve Ensembl ID via search

**File**: `src/entities/gene.ts:347-365`
**Tool affected**: `gene_druggability` (OpenTargets section)

Resolve gene symbol → Ensembl ID via OpenTargets search before calling `target(ensemblId:)`:

```ts
const searchQuery = `query($symbol: String!) {
  search(queryString: $symbol, entityNames: ["target"], page: {index: 0, size: 1}) {
    hits { id name entity }
  }
}`;
const searchRaw = await otConn.request(searchQuery, { symbol: geneSymbol });
const ensemblId = searchRaw?.data?.search?.hits?.[0]?.id;

let opentargetsData: any = null;
if (ensemblId) {
  const targetQuery = `query($ensemblId: String!) {
    target(ensemblId: $ensemblId) {
      id approvedName
      tractability { label value }
    }
  }`;
  const targetRaw = await otConn.request(targetQuery, { ensemblId });
  const t = targetRaw?.data?.target;
  if (t) {
    opentargetsData = {
      druggability: t.tractability?.map((item: any) => `${item.label}: ${item.value}`),
    };
  }
} else {
  opentargetsData = { _error: `Could not resolve Ensembl ID for '${geneSymbol}'` };
}
```

Key corrections from review:
- `target()` returns a single object, NOT an array — parse `data.target` directly, not `data.target[0]`
- Must handle null `ensemblId` gracefully
- Map `tractability` items to `{label}: {value}` strings

### 3.4 variant_search query parsing

**File**: `src/entities/variant.ts:116-148`
**Tool affected**: `variant_search`

Add query rewriting to convert natural language variant queries to MyVariant structured queries:

```ts
function rewriteVariantQuery(rawQuery: string): string {
  if (rawQuery.includes(':')) return rawQuery;
  if (/^rs\d+$/i.test(rawQuery)) return `dbsnp.rsid:${rawQuery}`;
  const hgvsMatch = rawQuery.match(/^(\w+)\s+([A-Z]\d+[A-Z*])$/i);
  if (hgvsMatch) return `gene:${hgvsMatch[1]} AND hgvs.p:${hgvsMatch[2]}`;
  return rawQuery;
}
```

**Improvement from review**: The protein change is now preserved (`gene:TP53 AND hgvs.p:R175H`) instead of being discarded. Case-insensitive matching added.

### 3.5 NIH Reporter gene_funding — fix invalid JSON

**File**: `src/entities/gene.ts:447`
**Tool affected**: `gene_funding`

The query builds invalid JSON — gene symbol is not quoted:
```ts
// Current (BROKEN):
`/projects/search?criteria={"genes":[${encodeURIComponent(geneSymbol)}]}&format=json`
// Produces: {"genes":[TP53]} — invalid JSON

// Fix:
`/projects/search?criteria=${encodeURIComponent(`{"genes":["${geneSymbol}"]}`)}&format=json`
```

Move `encodeURIComponent` to wrap the entire JSON string, and add quotes around the gene symbol inside the JSON.

---

## Phase 4 — Hardening (Low risk, ~2 fixes)

### 4.1 Array.isArray guards on API responses

**Files**: `src/entities/article.ts:326`
**Tool affected**: `article_annotations` (crash prevention)

Replace `(response || [])` iteration pattern with:
```ts
const items = Array.isArray(response) ? response : [];
for (const item of items) { ... }
```

**Note from review**: `article.ts:326` is the only unsafe `(response || [])` iteration across entity files. Other patterns like `response.hits || []` are safe because `|| []` on `undefined/null` correctly produces `[]`.

### 4.2 variant_predictions — add dbnsfp fallback field paths

**File**: `src/entities/variant.ts:274-336`
**Tool affected**: `variant_predictions`

MyVariant returns prediction fields at varying paths. Top-level fields may not exist; many are nested under `dbnsfp`. Add fallback extraction using correct dbnsfp sub-field structure:

```ts
const dbnsfp = (variant as any).dbnsfp;

const cadd = variant.cadd || (dbnsfp?.cadd ? { score: dbnsfp.cadd.rawscore, phred: dbnsfp.cadd.phred } : undefined);
const sift = variant.sift || (dbnsfp?.sift ? { score: dbnsfp.sift.score, pred: dbnsfp.sift.pred } : undefined);
const polyphen = variant.polyphen || (dbnsfp?.polyphen2 ? { score: dbnsfp.polyphen2.score, pred: dbnsfp.polyphen2.pred } : undefined);
const revel = variant.revel || dbnsfp?.revel;
const vest = variant.vest || (dbnsfp?.vest3 ? { score: dbnsfp.vest3.score } : undefined);
const gerp = variant.gerp || dbnsfp?.gerp;
const phylop = variant.phylop || dbnsfp?.phylop;
const phastcons = variant.phastcons || dbnsfp?.phastcons100way;
const alphamissense = variant.alphamissense || dbnsfp?.alphamissense;
const clinpred = variant.clinpred || dbnsfp?.clinpred;
const metarnn = variant.metarnn || dbnsfp?.metarnn;
```

**Key corrections from review**:
- dbnsfp uses `polyphen2` (not `polyphen`)
- dbnsfp uses `vest3`/`vest4` (not `vest`)
- CADD under dbnsfp has `rawscore` and `phred` sub-fields
- SIFT/PolyPhen under dbnsfp have `score` and `pred` sub-fields
- Extend `MyVariantGetResponse` interface with `dbnsfp?` sub-object instead of using `as any`

---

## Execution Order

| Step | Fix | Files Changed |
|------|-----|---------------|
| 1 | 1.1 ClinicalTrials module names | `trial.ts` |
| 2 | 1.2 JSON content-type | `rest.ts` |
| 3 | 1.3 OpenFDA search + brand_name path | `drug.ts` |
| 4 | 1.4 gnomAD frequency | `variant.ts` |
| 5 | 1.5 gnomAD constraint + return type | `gene.ts` |
| 6 | 1.6 healthCheck | `rest.ts` |
| 7 | 2.1 GTEx v2 medianGeneExpression | `gene.ts` |
| 8 | 2.2 DGIdb endpoint + schema | `registry.ts`, `gene.ts` |
| 9 | 2.3 Monarch graceful fallback | `disease.ts` |
| 10 | 2.4 PubTator graceful fallback | `article.ts` |
| 11 | 2.5 ClinGen graceful fallback | `registry.ts`, `gene.ts` |
| 12 | 3.1 OT gene_drugs hits + drugAndClinicalCandidates | `cross-entity.ts` |
| 13 | 3.3 OT druggability Ensembl resolve | `gene.ts` |
| 14 | 3.4 variant query parsing | `variant.ts` |
| 15 | 3.5 NIH Reporter invalid JSON | `gene.ts` |
| 16 | 4.1 Array guards | `article.ts` |
| 17 | 4.2 Predictions dbnsfp fallback (all 11 fields) | `variant.ts` |

---

## Files Modified

| File | Fixes |
|------|-------|
| `src/entities/trial.ts` | 1.1 |
| `src/connections/rest.ts` | 1.2, 1.6 |
| `src/entities/drug.ts` | 1.3 |
| `src/entities/variant.ts` | 1.4, 3.4, 4.2 |
| `src/entities/gene.ts` | 1.5, 2.1, 2.2, 2.5, 3.3, 3.5 |
| `src/connections/registry.ts` | 2.2, 2.5 |
| `src/entities/disease.ts` | 2.3 |
| `src/entities/article.ts` | 2.4, 4.1 |
| `src/entities/cross-entity.ts` | 3.1 |

---

## Verification

After each phase:
1. `npm run build` — clean compilation
2. `npm run typecheck` — no type errors
3. Smoke test each fixed tool with `npx tsx`

After all phases:
1. Re-run full QC test suite (50 tools)
2. Target: 40+ PASS, remaining failures = auth-required only
