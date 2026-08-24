# Patent Entity

Worldwide patent search and detail access for biomcp-ts, following the repo's
search/get/sections pattern. Sources are ordered by stability; credentials
degrade gracefully (see ladder below).

> **Migration note:** the legacy USPTO PatentsView API
> (`api.patentsview.org` / `search.patentsview.org`) was shut down on
> March 20, 2026 (data migrated to USPTO Open Data Portal bulk datasets).
> None of the code here touches PatentsView.

## Architecture

```
patent/
├── index.ts            Public re-exports
├── types.ts            All public types
├── ops-client.ts       EPO OPS OAuth2 session client (entity-managed)
├── ppubs-client.ts     USPTO PPUBS session client (entity-managed, keyless)
├── search/
│   ├── index.ts        patentSearch() federated orchestrator + auto-selection
│   ├── ops.ts          EPO OPS CQL search (BadgerFish transforms)
│   ├── odp.ts          USPTO ODP Lucene search
│   ├── ppubs.ts        USPTO PPUBS full-text search
│   ├── google-patents.ts  Google Patents XHR (circuit-breaker gated)
│   ├── query.ts        Shared free-text tokenizer (terms vs quoted phrases)
│   ├── seminal.ts      Co-citation mining for foundational prior art
│   └── dedup.ts        Publication-number normalization + federated dedup
└── detail/
    ├── index.ts        patentGet() per-section priority chains
    ├── ops.ts          biblio/abstract/claims/citations/family
    ├── odp.ts          application-file-wrapper core
    ├── ppubs.ts        claims HTML / usRef citations / family
    ├── google-patents.ts  Live → Wayback fallback detail fetch
    ├── wayback.ts      Wayback availability probe + id_ fetch (gzip sniff)
    └── parse.ts        Google Patents HTML parser (DC meta + itemprop)
```

## Source Ladder

| Source | Auth (env) | Coverage | Registry |
|---|---|---|---|
| EPO OPS | `EPO_OPS_CONSUMER_KEY` + `EPO_OPS_CONSUMER_SECRET` | 100M+ worldwide | entity-managed (OAuth2 doesn't fit static AuthConfig) |
| USPTO ODP | `USPTO_API_KEY` | US applications + grants | `uspto_odp` connection |
| USPTO PPUBS | none | US full-text, daily | entity-managed (session token) |
| Google Patents | none | worldwide | `google_patents` connection + Wayback fallback |

`patentSearch` auto-selects: worldwide = OPS (if creds) else Google Patents
(breaker-gated); US = PPUBS always. PPUBS is keyless, full-text, and
relevance-ranked (`sort: 'score desc'` by default — `sort_by: 'recency'`
switches to `date_publ desc`), which makes it the right default for
conceptual queries; USPTO ODP is bibliographic-only (file-wrapper metadata)
and is opt-in via `source: 'uspto_odp'` (useful for inventor/CPC/continuity-
rich metadata lookups). With OPS configured, Google Patents search is
opt-in only (`source: 'google_patents'`) — Google hard-IP-blocks automated
clients (verified: 503 block page lasting 24h+), so it is never load-bearing
and there is no OPS→Google fallback. When the default PPUBS backend fails
hard (never on 0 hits) and a USPTO ODP key exists, one budget-guarded retry
(≤12s elapsed) runs on ODP and its results are tagged with a `{ _note }`
provenance marker. A failed backend appends a `{ _error }` element to
results instead of failing the search; a clean 0-hit search appends a
`{ _hint }` with refinement guidance. Marker elements (`_error`/`_note`/
`_hint`) never count toward `limit` or `total_hits`, and the response
carries `total_hits_basis` documenting each backend's counting semantics.

Federated results are deduplicated by publication number and, when any
backend supplied `relevance_score` (ppubs `score desc`), re-ordered by score
descending with unscored backends' results after. Queries with explicit
boolean/Lucene syntax pass through verbatim on ODP; plain multi-word queries
are AND-joined there (the upstream default operator is OR, which produced
367k noise hits for "mRNA display"). EPO OPS retries once when it reports
`total > 0` but returns an empty document array (observed live: "24 total
hits, empty results").

## Seminal Prior-Art Discovery (`search/seminal.ts`, default on)

Foundational prior art whose vocabulary predates the query concept can never
be retrieved by text matching — verified: the Szostak mRNA-display family
("Selection of proteins using RNA-protein fusions", US6261804B1 et al.)
contains "mRNA display" zero times and is absent from the entire relevance
batch. Co-citation mining closes that gap:

1. Own PPUBS relevance search (`pageCount` 100 — the score-desc batch scales
   with `pageCount`).
2. **Diversity sampling**: up to 10 granted docs, max 2 per assignee.
   Naive top-N mining fails on real data — one patent family's 4+ top hits
   block-cite a 30+ reference blob that drowns foundational art (Szostak
   PCT WO98/31700: count 2/8 naive vs 4 across 3 distinct assignees
   diversity-sampled — rank #1).
3. Backward references (`usRef*`/`foreignRef*`) fetched concurrently
   (client rate limiter paces them); refs counted per canonical key
   (`parsePatentRef` handles all observed raw forms: `WO98/56915`, bare
   `9856915`, `WO-2014180569`, `2015/103037`, `90/02809`, `5,034,506`),
   excluding anything already on the visible page.
4. **Cross-assignee threshold**: cited by ≥ 3 sampled docs AND ≥ 2 distinct
   assignees (single-family block-citation blobs never qualify); ranked by
   assignee breadth then count; capped at 5 `seminal_prior_art` entries.
5. WO→US resolution, deadline-bounded (adaptive budget: the 60 s tool
   budget minus elapsed search time, capped at ~30 s): EPO OPS
   INPADOC family (earliest granted US member + title + assignee via
   biblio) → Google Patents detail keylessly (PCT-kind variants A1/A2/
   kindless, with **page-identity validation** — Google sometimes redirects
   kindless WO URLs to unrelated documents, and 503-blocks shared proxy
   exit IPs; a mismatched page is rejected) → WO display form + actionable
   note (inventor-search fallback, patent_get pointer).

`seminal: false` opts out. Failures degrade to `seminal_note` hints
carrying the real cause (deadline exceeded with the budget, PPUBS mining
HTTP status, malformed payload, too few grants, no common refs,
unquoted-query precision tip, budget-exhausted skip) and never break the
main search. The docs phase is degrade-to-partial: references already
fetched when the deadline hits are counted rather than discarded.

## Proxy-aware fetch

All outbound fetch is proxy-aware via `connections/proxy.ts` (undici
`EnvHttpProxyAgent` global dispatcher; `HTTP(S)_PROXY`/`NO_PROXY` honored).
Details and limitations are documented in `src/connections/README.md`.

## Resilience

The Google Patents search breaker trips with class-specific windows:
HTTP 503/429 blocks open it for 30 min (blocks last 24h+); network-class
errors (`fetch failed`/`ETIMEDOUT`/…) open it for only 2 min. Earlier
regressions this replaces: network errors retried forever appending a
fresh `_error` per search, then a single transient blip excluded Google
Patents from auto mode for half an hour with no recovery path. OPS
auto-mode selection has 2-strike/15-min backoff (auth-class failures
trip immediately; explicit `source: 'ops'` always attempts); when no
worldwide backend remains, one `_note` explains the US-only coverage
instead of silently dropping it.

`patentGet` sections run per-section priority chains with auth-aware silent
skip and fall-through. Each **source step** is raced against a timeout of
`SECTION_TIMEOUT_MS` × 3 = 24 s (8 s base; claims chains:
`CLAIMS_SECTION_TIMEOUT_MS` × 2 = 30 s):

| Section | Chain |
|---|---|
| `core` (default) | OPS biblio → GP/Wayback detail → PPUBS (US) |
| `abstract` | OPS abstract → GP/Wayback → PPUBS (US) |
| `claims` | PPUBS `claimsHtml` (US — OPS has **no US fulltext**) → OPS claims (EP/WO/EU/CA) → GP/Wayback `[num]` elements |
| `citations` | OPS backward refs + `ct=` forward search → GP/Wayback rows → PPUBS `usRef*`/`foreignRef*` (US) |
| `family` | OPS INPADOC family → GP/Wayback `docdbFamily` → PPUBS (US) |
| `classifications` | OPS IPC+CPC → GP/Wayback → ODP/PPUBS (US) |

Claims are capped at ~100 KB with a `_warn` field (pdb-download precedent).

## Verified API Contracts (Phase 0, 2026-08-22)

All contracts below were verified live with credentials / from working client
source code. Kept here so future maintainers don't re-verify from scratch.

### EPO OPS (`https://ops.epo.org/3.2`)

- **Auth**: `POST /auth/accesstoken`, Basic key:secret, form body
  `grant_type=client_credentials` → `{access_token, expires_in: 1199}`.
  Anonymous access is denied entirely (403 `AnonymousQuotaPerDay`).
- **Search**: `GET /rest-services/published-data/search/biblio?q=<CQL>&Range=1-N`
  (GET only; POST → 415). Bare `/search` returns only publication references;
  `/search/biblio` returns full biblio per record. CQL operators verified:
  `ti= "phrase"`, `ab=`, `pa=`, `in=`, `pn=`, `cpc=C12N15/11`, `pd=YYYYMMDD`,
  `ct={pn}` (forward citations). `pd within "a,b"` 500s server-side — avoid.
- **Pagination caps**: default 1-25, max 100/page. Deep paging capped at 2000
  reachable results (client-enforced `offset + limit ≤ 2000`, documented in
  `total_hits_basis`); the reported `@total-result-count` passes through to
  `total_hits` as-is and may exceed the reachable window.
- **Detail**: `/rest-services/published-data/publication/epodoc/{PN}/biblio|abstract|claims`.
  Kind codes must be **stripped or dotted** — bare kind (`US11027025B2`)
  404s; `US11027025` and `US11027025.B2` work.
- **Claims**: `ftxt:fulltext-documents.ftxt:fulltext-document.claims.claim[]
  .claim-text[]` (BadgerFish `{$}` values). Fulltext authorities exclude the
  US (EP/WO/EU/CA and others only) — US claims must come from PPUBS.
- **Family**: `GET /family/publication/epodoc/{PN}` →
  `ops:patent-family.ops:family-member[].publication-reference.document-id[]`.
- **Backward refs**: biblio `references-cited.citation[].patcit.document-id[]`.
- **JSON**: universal via `Accept: application/json`, BadgerFish convention.
- **Throttling**: **403 + `X-Rejection-Reason`** (`RegisteredQuotaPerWeek`,
  `IndividualQuotaPerHour`), occasionally HTTP 429. `OpsClient.get()`
  branches on the reason: transient rate limits (reason matching `RateLimit`,
  or plain 429) are retried once after a backoff; quota-class rejections are
  NOT retried — the failure feeds the auto-mode backoff and the request throws
  immediately ("retry will not help until the quota window resets"). Quota
  headers `X-IndividualQuotaPerHour-Used` / `X-RegisteredQuotaPerWeek-Used`;
  free tier 4 GB/week. No `Retry-After` documented.

### USPTO ODP (`https://api.uspto.gov`)

- `POST /api/v1/patent/applications/search`, header `X-API-KEY`, JSON body
  `{"q": <lucene>, "pagination": {"offset", "limit"}}` (GET query filters are
  silently ignored upstream — always POST).
- Lucene fields: `applicationMetaData.patentNumber:"11027025"`,
  `.firstApplicantName:"..."`, `.firstInventorName:"..."`,
  `.filingDate:[YYYY-MM-DD TO YYYY-MM-DD]`; clauses AND-joined.
- Response `{count, patentFileWrapperDataBag[]}`; granted patents surface
  inside applications data (`patentNumber`, `applicationStatus: "patented"`).
  Rich metadata: `cpcClassificationBag`, `inventorBag`, continuity bags,
  `grantDocumentMetaData`, attorney, term adjustment.
- PPUBS-style suffix filters (`(x).as.`) are accepted-but-have-different
  semantics — never use them here.

### USPTO PPUBS (`https://ppubs.uspto.gov`, keyless)

- Session: `POST /api/users/me/session`, body `-1`, header
  `X-Access-Token: null` → `x-access-token` response header + `caseId` from
  body. Cookies NOT required. Sessions work for parallel searches.
- Search: `POST /api/searches/searchWithBeFamily` with the exact template in
  `ppubs-client.ts` — one wrong key (e.g. `showDocFamilyPref` instead of
  `showDocPerFamilyPref`) returns HTTP 500. The counts call is NOT required.
- **Sort (verified 2026-08-23): the `sort` body key is REQUIRED** — omitted
  or empty → HTTP 400. Valid values: `'score desc'` (relevance; adds a
  `score` field per patent record) and `'date_publ desc'` (recency).
  `'relevance'` → HTTP 500 (invalid). Under `score desc` the server returns
  one bounded relevance batch that **scales with `pageCount`** (verified:
  12 docs @ `pageCount` 5; ~104 @ 50; ~107 unquoted @ 50) and **ignores
  `start`** — the webapp pages client-side (`CUSTOM_SORT_PAGE_SIZE`), so
  relevance mode always fetches from `start: 0` and slices
  `[offset, offset+limit)` locally.
- **Count fields (verified): `numberOfFamilies` is the stable match count**
  (e.g. 88,262 families for unquoted `mRNA display`); `totalResults` and
  `numFound` are window/batch sizes that vary with sort mode (24 under
  `score desc`) — never report them as the match count.
- Field syntax: `("11027025").pn.`, `(pfizer).as.`, `(smith).in.`,
  `(C12N15/11).cpc.` (**full CPC symbols only** — truncated symbols silently
  return 0); dates `@pd>=YYYYMMDD<=YYYYMMDD`, `@ad>=`; combine as free-text +
  parenthesized field filters only (two free-text suffixes → 0 results);
  `op: "AND"`; `start` for pagination; `databaseFilters` for granted/applications.
- Documents: `GET /api/patents/highlight/{guid}?queryId=1&source={type}&includeSections=true`
  → `claimsHtml`/`abstractHtml`/`descriptionHtml`; citations live in
  `usRef*`/`foreignRef*` arrays (`refCitedPatentDocNumber` is null).
- Applications have `assigneeName: null` — fall back to `applicantName`.
- 401 **and** 403 both indicate session expiry (refresh and retry once).

### Google Patents + Wayback (last resort)

- `GET /xhr/query?url=<form-encoded inner query>` — multi-word queries MUST be
  quoted (`q="crispr cas9"`), otherwise OR semantics return garbage.
- Detail pages: Dublin Core meta + itemprop spans; claims are `[num]`-
  attributed elements; citations are `backwardReferences`/`forwardReferences`
  `<tr>` rows; family = `docdbFamily` rows; CPC = hierarchical `Code` values.
  Layout varies by jurisdiction (EP lacks ref rows; JP lacks forwardRefs) —
  parser treats every field as optional.
- **IP-blocking is proven**: light probing earned a 503 "automated queries"
  block lasting 24h+. The search circuit breaker (30 min on HTTP blocks,
  2 min on network-class trips) guards `searchGooglePatents` only — detail
  fetches keep their own independent 30-min block state; detail falls back
  to Wayback (`archive.org/wayback/available` →
  `web.archive.org/web/{ts}id_/...`, gzip magic-byte sniff) when coverage
  exists. Snapshot gating: `available: false` or a 4xx/5xx capture `status`
  skips the snapshot before playback (status-page captures can never serve
  playable original bytes).
