import { connectionManager } from '../../../connections/manager.js';
import { withTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from '../../../connections/fetch-utils.js';
import {
  EuropePMCPreprintRecord,
  EuropePMCSearchResponse,
  EuropePMCCitationEntry,
  splitAuthors,
  cleanArticleTitle,
  transformCitationEntry,
  epmcPreprintServerLabel,
} from '../europepmc-shared.js';
import type {
  ArticleResult,
  PreprintDetails,
  PreprintFunder,
  PreprintPublishedVersion,
} from '../types.js';
import { summarizeSourceResults } from '../citation/index.js';
import type {
  FederatedCitationResult,
  CitationRecord,
  CitationSourceSummary,
  SourceCitationResult,
} from '../citation/types.js';

/** Citation directions the preprint PPR path honors, mirroring the journal
 * path's `ArticleGetOptions.citationDirection`. */
type PreprintCitationDirection = 'forward' | 'backward' | 'both';

// ---- official api.biorxiv.org response types ----
// All errors are HTTP 200 with a `messages[0].status` string
// ("no posts found", "Server not recognized", ...): branch on the status,
// never on the HTTP code. All record values are strings except `funder`.

interface BiorxivFunder {
  name?: string;
  id?: string;
  'id-type'?: string;
  award?: string;
}

interface BiorxivDetailsRecord {
  doi?: string;
  title?: string;
  /** semicolon-joined "Last, F.; Last, F." — different from EPMC's comma style */
  authors?: string;
  author_corresponding?: string;
  author_corresponding_institution?: string;
  /** posting date of that version; may be unpadded ("2026-8-19") */
  date?: string;
  version?: string;
  type?: string;
  license?: string;
  category?: string;
  jatsxml?: string;
  abstract?: string;
  funder?: BiorxivFunder[] | string;
  /** published DOI or the string "NA" */
  published?: string;
  server?: string;
}

interface BiorxivDetailsResponse {
  messages?: Array<{ status?: string }>;
  collection?: BiorxivDetailsRecord[];
}

interface BiorxivPubsRecord {
  /** NOTE: docs call this `biorxiv_doi`; the actual JSON key is `preprint_doi` (live-verified) */
  preprint_doi?: string;
  published_doi?: string;
  published_journal?: string;
  published_date?: string;
  preprint_date?: string;
}

interface BiorxivPubsResponse {
  messages?: Array<{ status?: string }>;
  collection?: BiorxivPubsRecord[];
}

interface EuropePMCCitationsResponse {
  hitCount?: number;
  citationList?: { citation?: EuropePMCCitationEntry[] };
  citationsArray?: { citation?: EuropePMCCitationEntry[] };
}

interface EuropePMCReferencesResponse {
  hitCount?: number;
  referenceList?: { reference?: EuropePMCCitationEntry[] };
  referencesArray?: { reference?: EuropePMCCitationEntry[] };
}

/** The official API joins authors with "; " — EPMC's comma-style
 * `splitAuthors` would mangle these; use this helper for official records. */
export function splitSemicolonAuthors(authors?: string): string[] | undefined {
  if (!authors) return undefined;
  const parts = authors.split(';').map(p => p.trim()).filter(p => p.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function normalizeServer(server?: string): 'bioRxiv' | 'medRxiv' {
  return String(server || '').toLowerCase() === 'medrxiv' ? 'medRxiv' : 'bioRxiv';
}

function normalizeFunders(funder?: BiorxivFunder[] | string): PreprintFunder[] | undefined {
  if (!Array.isArray(funder)) return undefined; // "NA" or absent
  const out = funder
    .map(f => ({ name: f.name, id: f.id, id_type: f['id-type'], award: f.award }))
    .filter(f => f.name || f.id || f.award);
  return out.length > 0 ? out : undefined;
}

/** The biorxiv API interpolates the DOI into the URL path. parseArticleId
 * admits any non-whitespace DOI, so reserved chars ('?', '#', '%', '&')
 * would silently mutate the URL — encode each '/'-separated segment while
 * keeping the legitimate '/' separators the API path expects. */
function encodeDoiPath(doi: string): string {
  return doi.split('/').map(encodeURIComponent).join('/');
}

/** /details/{server}/{doi} returns one record per version; the DOI's prefix
 * cannot tell biorxiv from medrxiv (10.1101 is shared with CSHL Press
 * journals and the new 10.64898 prefix is shared by both preprint servers),
 * so try biorxiv then medrxiv — a soft miss ("no posts found") is a fast
 * fall-through to the other server (~1–2 s plus 1 req/s limiter spacing).
 *
 * Worst-case timing note: a TRANSPORT-level failure (timeout, network,
 * HTTP error status) aborts the federation immediately — api.biorxiv.org
 * hosts BOTH server collections, so probing medrxiv would only duplicate
 * the failure. Worst case is therefore one server's transport failure
 * (~31 s: 2 attempts × 15 s + 1 s backoff) and no /pubs call
 * (getPreprintArticle skips it when the official API is unreachable).
 * The Europe PMC leg runs in parallel and is untouched. Residual exposure:
 * in the pathological slow-but-succeeding-host case (not an outage — those
 * fast-skip), step 2's /pubs call can still add up to ~31 s after step 1,
 * pushing the theoretical total past the 60 s article_get cap; the tool
 * timeout then surfaces as an error rather than a hang. */
async function fetchOfficialDetails(
  doi: string
): Promise<{ server: 'biorxiv' | 'medrxiv'; records: BiorxivDetailsRecord[] } | undefined> {
  const conn = connectionManager.getConnection('biorxiv');
  for (const server of ['biorxiv', 'medrxiv'] as const) {
    try {
      const response = await conn.request(
        `/details/${server}/${encodeDoiPath(doi)}`
      ) as BiorxivDetailsResponse;
      const status = response.messages?.[0]?.status;
      const records = response.collection ?? [];
      if (status === 'ok' && records.length > 0) {
        return { server, records };
      }
      // Soft miss ("no posts found") or empty collection → try the other server.
    } catch (error) {
      console.error(`[getPreprintArticle] /details/${server} failed:`, error);
      // Transport-level failure: the same host serves both collections,
      // so medrxiv would fail identically — return immediately and let
      // the EPMC fallback cover the data.
      return undefined;
    }
  }
  return undefined;
}

async function fetchEpmcPreprint(doi: string): Promise<EuropePMCPreprintRecord | undefined> {
  try {
    const conn = connectionManager.getConnection('europepmc');
    const response = await withTimeout(
      conn.request(
        `/search?query=${encodeURIComponent(`DOI:"${doi}"`)}&resultType=core&format=json&pageSize=1`
      ) as Promise<EuropePMCSearchResponse<EuropePMCPreprintRecord>>,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      { onTimeout: 'null' }
    );
    return response?.resultList?.result?.[0];
  } catch (error) {
    console.error('[getPreprintArticle] Europe PMC DOI lookup failed:', error);
    return undefined;
  }
}

function buildOfficialCore(
  doi: string,
  records: BiorxivDetailsRecord[]
): { core: ArticleResult; officialPublishedDoi?: string } {
  // Dedupe defensively by numeric version and sort ascending.
  const byVersion = new Map<number, BiorxivDetailsRecord>();
  for (const r of records) {
    const v = Number(r.version);
    if (Number.isFinite(v)) byVersion.set(v, r);
  }
  const sorted = [...byVersion.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  const latest = sorted[sorted.length - 1] ?? records[records.length - 1] ?? {};
  const serverLabel = normalizeServer(latest.server);
  const preprint: PreprintDetails = {
    data_source: 'api.biorxiv.org',
    versions: sorted.map(r => ({
      version: Number(r.version),
      date: r.date,
      type: r.type,
      doi: r.doi,
    })),
  };
  if (latest.author_corresponding || latest.author_corresponding_institution) {
    preprint.corresponding_author = {
      name: latest.author_corresponding,
      institution: latest.author_corresponding_institution,
    };
  }
  const funders = normalizeFunders(latest.funder);
  if (funders) preprint.funders = funders;

  return {
    core: {
      doi: latest.doi ?? doi,
      title: cleanArticleTitle(latest.title),
      abstract: latest.abstract,
      authors: splitSemicolonAuthors(latest.authors),
      journal: serverLabel,
      publication_date: latest.date,
      publication_types: ['preprint'],
      source: serverLabel === 'medRxiv' ? 'medrxiv' : 'biorxiv',
      preprint_server: serverLabel,
      license: latest.license,
      category: latest.category,
      version: Number(latest.version) || undefined,
      jatsxml_url: latest.jatsxml,
      preprint,
    },
    // Official `published` field: the published DOI, or the string "NA"
    officialPublishedDoi: typeof latest.published === 'string' && /^10\./.test(latest.published)
      ? latest.published
      : undefined,
  };
}

function buildEpmcCore(doi: string, rec: EuropePMCPreprintRecord): ArticleResult {
  const serverLabel = epmcPreprintServerLabel(rec.bookOrReportDetails?.publisher);
  return {
    doi: rec.doi ?? doi,
    title: cleanArticleTitle(rec.title),
    abstract: rec.abstractText,
    authors: splitAuthors(rec.authorString),
    journal: serverLabel,
    publication_date: rec.firstPublicationDate,
    cited_by: rec.citedByCount,
    is_open_access: rec.isOpenAccess === 'Y',
    publication_types: ['preprint'],
    source: serverLabel === 'medRxiv' ? 'medrxiv' : 'biorxiv',
    preprint_server: serverLabel,
    ppr_id: rec.id,
    preprint: { data_source: 'europepmc', versions: [] },
  };
}

/** Published-version link. The official DOI-form /pubs lookup is broken
 * upstream for new-prefix (10.64898) DOIs — "no articles found" even for
 * published papers (live-verified 2026-09-19) — so only legacy 10.1101
 * DOIs use it; others fall back to Europe PMC's commentCorrectionList. */
async function fetchPublishedVersion(
  server: 'biorxiv' | 'medrxiv',
  doi: string
): Promise<PreprintPublishedVersion | null> {
  if (!doi.startsWith('10.1101/')) return null;
  try {
    const conn = connectionManager.getConnection('biorxiv');
    const response = await conn.request(
      `/pubs/${server}/${encodeDoiPath(doi)}/na`
    ) as BiorxivPubsResponse;
    const rec = response.collection?.[0];
    if (response.messages?.[0]?.status !== 'ok' || !rec?.published_doi) return null;
    return {
      doi: rec.published_doi,
      journal: rec.published_journal,
      published_date: rec.published_date,
      preprint_date: rec.preprint_date,
      source: 'biorxiv_pubs',
    };
  } catch (error) {
    console.error('[getPreprintArticle] /pubs lookup failed:', error);
    return null;
  }
}

function publishedFromEpmc(rec?: EuropePMCPreprintRecord): PreprintPublishedVersion | null {
  const links = rec?.commentCorrectionList?.commentCorrection ?? [];
  const link = links.find(c => c?.type === 'Preprint of');
  if (!link?.id) return null;
  return { pmid: String(link.id), source: 'europepmc' };
}

/** Citation section for a preprint, reusing the FederatedCitationResult
 * SHAPE (so article_get consumers see one consistent envelope); the data
 * comes from Europe PMC's /PPR/ endpoints, not the PMID-based federation.
 *
 * `direction` gates which PPR endpoint is REQUESTED (not post-filtered —
 * the skipped leg costs no network call), mirroring the journal path's
 * per-direction provider gating. The skipped direction's array key stays
 * present as `[]` so consumers (and the tool layer's applyLimit) see a
 * stable envelope shape. */
async function fetchPprCitationSection(
  doi: string,
  pprId: string | undefined,
  citedByCount: number | undefined,
  limit: number,
  direction: PreprintCitationDirection
): Promise<FederatedCitationResult | { _error: string }> {
  try {
    let forward: CitationRecord[] = [];
    let backward: CitationRecord[] = [];
    let fwdHitCount: number | undefined;

    if (pprId) {
      const conn = connectionManager.getConnection('europepmc');
      const pageSize = Math.max(limit * 3, 10);
      // Only construct the promise for the requested direction(s) — the
      // skipped leg is never sent over the wire.
      const [fwdRes, bwdRes] = await Promise.all([
        direction === 'backward'
          ? null
          : withTimeout(
            conn.request(`/PPR/${pprId}/citations?format=json&pageSize=${pageSize}`) as Promise<EuropePMCCitationsResponse>,
            DEFAULT_PROVIDER_TIMEOUT_MS,
            { onTimeout: 'null' }
          ),
        direction === 'forward'
          ? null
          : withTimeout(
            conn.request(`/PPR/${pprId}/references?format=json&pageSize=${pageSize}`) as Promise<EuropePMCReferencesResponse>,
            DEFAULT_PROVIDER_TIMEOUT_MS,
            { onTimeout: 'null' }
          ),
      ]);
      forward = (fwdRes?.citationList?.citation ?? fwdRes?.citationsArray?.citation ?? [])
        .filter(hit => hit.title || hit.id)
        .map(transformCitationEntry)
        .slice(0, limit);
      backward = (bwdRes?.referenceList?.reference ?? bwdRes?.referencesArray?.reference ?? [])
        .filter(hit => hit.title || hit.id)
        .map(transformCitationEntry)
        .slice(0, limit);
      fwdHitCount = fwdRes?.hitCount;
    }

    const total = citedByCount ?? fwdHitCount ?? forward.length;
    // source_results carries the compact per-provider summary (counts +
    // verbatim error), consistent with the journal federation path since
    // PR #68 — the records live only in the arrays above, never duplicated.
    const sourceRow: SourceCitationResult = {
      source_id: 'europepmc',
      citation_count: { total, source: 'europepmc' },
      forward_citations: forward,
      backward_references: backward,
    };
    const sourceSummaries: CitationSourceSummary[] = summarizeSourceResults([sourceRow]);
    return {
      article_id: { doi },
      citation_counts: [{ total, source: 'europepmc' }],
      forward_citations: forward,
      backward_references: backward,
      source_results: sourceSummaries,
      items_available: forward.length > 0 || backward.length > 0 || total > 0,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { _error: `Preprint citation lookup failed: ${msg}` };
  }
}

/**
 * article_get branch for bioRxiv/medRxiv preprint DOIs. Preprints have no
 * PMID, so the PMID resolution path cannot serve them.
 *
 * Step 1 (parallel): official api.biorxiv.org /details (authoritative:
 * all versions, license, category, funders, JATS URL) ‖ Europe PMC core
 * record (PPR id + citation count + fallback core if the official API is
 * unavailable). Step 2 (parallel): published-version mapping ‖ citations
 * (when requested). Every failure degrades one part of the result instead
 * of failing the call.
 *
 * `citationDirection` is honored by the PPR citation step (the skipped
 * direction costs no request); `citationMode` is meaningless here (single
 * Europe PMC source) and, when passed, is reported via `sections._note`
 * instead of being silently dropped. The same `_note` names any requested
 * sections this path cannot serve (`oa`/`annotations`/`graph`).
 */
export async function getPreprintArticle(
  doi: string,
  options?: {
    sections?: string[];
    limit?: number;
    /** Gates the PPR fetch: 'forward' → /citations only, 'backward' →
     * /references only, 'both' (default) → both endpoints. */
    citationDirection?: PreprintCitationDirection;
    /** No preprint meaning (single Europe PMC source) — when set, a
     * `sections._note` discloses that instead of a silent drop. */
    citationMode?: 'fast' | 'full';
  }
): Promise<ArticleResult> {
  const limit = options?.limit ?? 20;

  const [official, epmc] = await Promise.all([
    fetchOfficialDetails(doi),
    fetchEpmcPreprint(doi),
  ]);

  let result: ArticleResult;
  let server: 'biorxiv' | 'medrxiv';
  let officialPublishedDoi: string | undefined;

  if (official) {
    server = official.server;
    const built = buildOfficialCore(doi, official.records);
    result = built.core;
    officialPublishedDoi = built.officialPublishedDoi;
  } else if (epmc) {
    server = epmcPreprintServerLabel(epmc.bookOrReportDetails?.publisher).toLowerCase() as 'biorxiv' | 'medrxiv';
    result = buildEpmcCore(doi, epmc);
  } else {
    throw new Error(
      `Preprint DOI "${doi}" not found on bioRxiv/medRxiv (official API) or in Europe PMC's preprint index. ` +
      'The DOI may not be a preprint, or both sources are temporarily unavailable.'
    );
  }

  // Merge EPMC-only fields into the official core (official API has no
  // citation counts or OA flag).
  if (epmc) {
    if (result.cited_by === undefined && epmc.citedByCount !== undefined) result.cited_by = epmc.citedByCount;
    if (result.is_open_access === undefined) result.is_open_access = epmc.isOpenAccess === 'Y';
    if (!result.ppr_id && epmc.id) result.ppr_id = epmc.id;
  }

  const wantsCitation = options?.sections?.includes('citation') || options?.sections?.includes('all');

  // Runtime disclosure notes (visible in the tool reply as `sections._note`
  // — the preprint path has no other natural note slot). (a) sections this
  // path cannot serve are named rather than silently ignored; (b) a
  // citation_mode request is reported as meaningless for the single EPMC
  // preprint source. `_note` survives the tool layer's applyLimit untouched
  // (it only visits requested section keys).
  const notes: string[] = [];
  const unsupportedSections = (options?.sections ?? []).filter(
    s => s === 'oa' || s === 'annotations' || s === 'graph'
  );
  if (unsupportedSections.length > 0) {
    const listed = unsupportedSections.map(s => `"${s}"`).join(', ');
    notes.push(
      `sections ${listed} not supported for preprint DOIs and were ignored — ` +
      'only "citation" (Europe PMC PPR citations/references), "fulltext" (link envelope), ' +
      'and the core record are meaningful for preprints'
    );
  }
  if (wantsCitation && options?.citationMode) {
    notes.push(
      `citation_mode="${options.citationMode}" has no effect on preprints — ` +
      'the citation section always comes from the single Europe PMC PPR source ' +
      '(no fast/full provider fan-out)'
    );
  }

  const step2: Promise<void>[] = [];

  if (official) {
    step2.push(
      fetchPublishedVersion(server, doi).then(p => {
        // Fallback chain: official /pubs mapping → EPMC "Preprint of" link →
        // the official /details `published` DOI field → null.
        result.published = p
          ?? publishedFromEpmc(epmc)
          ?? (officialPublishedDoi ? { doi: officialPublishedDoi, source: 'biorxiv_details' } : null);
      })
    );
  } else {
    // Official API unreachable → /pubs on the same host is also unreachable;
    // calling it is pure wasted latency. officialPublishedDoi is undefined
    // in this branch by construction, so only the EPMC link remains.
    result.published = publishedFromEpmc(epmc) ?? null;
  }

  if (wantsCitation) {
    step2.push(
      fetchPprCitationSection(
        doi,
        result.ppr_id ?? epmc?.id,
        result.cited_by,
        limit,
        options?.citationDirection ?? 'both'
      ).then(r => {
        result.sections = result.sections || {};
        (result.sections as Record<string, unknown>)['citation'] = r;
      })
    );
  }

  // Opt-in only, mirroring the journal-article path ("all" excludes fulltext).
  const wantsFullText = options?.sections?.includes('fulltext');
  if (wantsFullText) {
    // Preprint JATS XML is deliberately served as a link only —
    // www.biorxiv.org throttles automated downloads (see jatsxml_url).
    (result.sections = result.sections || {})['fulltext'] = {
      status: 'unavailable',
      reason: 'not_implemented_for_preprints',
      max_chars: 0,
      links: result.jatsxml_url ? { jatsxml_url: result.jatsxml_url } : undefined,
      note: 'Full-text retrieval is not implemented for preprints (www.biorxiv.org throttles automated downloads). '
        + (result.jatsxml_url
          ? 'Fetch links.jatsxml_url directly for the JATS XML, or use article_get on the published version of record.'
          : 'No JATS XML URL is available for this preprint.'),
    };
  }

  await Promise.allSettled(step2);

  if (notes.length > 0) {
    result.sections = result.sections || {};
    (result.sections as Record<string, unknown>)['_note'] = notes.join(' ');
  }

  return result;
}
