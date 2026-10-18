import type { ArticleSearchOptions, ArticleSearchError, ArticleSearchResponse, Article, ParsedDateRange } from '../types.js';
import { withTimeout } from '../../../connections/fetch-utils.js';
import { deduplicateAndRank, dedupKeys, isAboveLitsenseFloor, LITSENSE_RELEVANCE_FLOOR } from './dedup.js';
import { searchPubMed, type PubMedQueryOutcome } from './pubmed.js';
import { searchEuropePMC } from './europepmc.js';
import { searchSemanticScholar } from './semantic-scholar.js';
import { searchPubTator } from './pubtator.js';
import { searchLitSense } from './litsense.js';
import { searchPreprints } from './preprint.js';
import { searchArxiv } from './arxiv.js';
import { fetchPmidArticles } from '../citation/pubmed.js';

const FEDERATED_SEARCH_TIMEOUT_MS = 20000;

/** Human-facing names for the federated fan-out legs (crowd-out warning). */
const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  pubmed: 'PubMed',
  europepmc: 'Europe PMC',
  semantic_scholar: 'Semantic Scholar',
  arxiv: 'arXiv',
  pubtator: 'PubTator',
  litsense: 'LitSense',
};

export function parseDateRange(dateRange: string): ParsedDateRange {
  const [from, to] = dateRange.split('/');
  return {
    from: from || undefined,
    to: to || undefined,
  };
}

/**
 * Split a backend's output into real rows and out-of-band errors. Backends
 * report failures as `[{ _error: ... }]` rows (backendErrorRow contract,
 * consumed by dedup); this is where those rows leave the array and become
 * envelope `errors` entries, keeping their honest wording verbatim.
 */
function splitErrorRows(
  rows: Article[],
  source: string,
  errors: ArticleSearchError[]
): Article[] {
  const real: Article[] = [];
  for (const row of rows) {
    if (row._error !== undefined) {
      errors.push({ source, message: row._error });
      continue;
    }
    real.push(row);
  }
  return real;
}

/**
 * LitSense rows carry only pmid/pmcid/score/sentence — no bibliographic
 * metadata (issue #87). Batch-enrich titles/abstracts by PMID via PubMed
 * efetch (best-effort): on failure keep the sparse rows and surface a
 * warning instead of dropping them. Only runs when LitSense rows made the
 * final page, and only for the rows the caller will return.
 */
async function enrichLitSenseRows(results: Article[], warnings: string[]): Promise<void> {
  const litsenseRows = results.filter(r => r.source === 'litsense' && r.pmid);
  if (litsenseRows.length === 0) return;
  try {
    const pmids = Array.from(new Set(litsenseRows.map(r => r.pmid!)));
    const articles = await fetchPmidArticles(pmids);
    if (articles.size === 0) {
      // No thrown error but also nothing usable (e.g. an HTML block page
      // that parses to zero records) — treat as enrichment unavailability.
      warnings.push(
        'litsense metadata enrichment unavailable: PubMed efetch returned no records for the matched PMIDs ' +
        '(rows keep pmid/sentence/score only)'
      );
      return;
    }
    for (const row of litsenseRows) {
      const meta = row.pmid ? articles.get(row.pmid) : undefined;
      if (!meta) continue;
      if (row.title === undefined && meta.title !== undefined) row.title = meta.title;
      if (row.abstract === undefined && meta.abstract !== undefined) row.abstract = meta.abstract;
      if (row.journal === undefined && meta.journal !== undefined) row.journal = meta.journal;
      if (row.doi === undefined && meta.doi !== undefined) row.doi = meta.doi;
      if (row.publication_date === undefined && meta.publication_date !== undefined) row.publication_date = meta.publication_date;
      if ((row.authors === undefined || row.authors.length === 0) && meta.authors !== undefined) row.authors = meta.authors;
    }
  } catch (error) {
    warnings.push(
      `litsense metadata enrichment unavailable: ${error instanceof Error ? error.message : String(error)} ` +
      `(rows keep pmid/sentence/score only)`
    );
  }
}

/**
 * Clean-envelope article search (issues #87/#78): `results` NEVER contains
 * `_error`/marker rows — per-source failures ride in `errors`, degradation
 * notes (PubMed term-dropping, LitSense relevance floor, enrichment
 * unavailability) in `warnings`.
 */
export async function searchArticles(
  query: string,
  options: ArticleSearchOptions = {}
): Promise<ArticleSearchResponse> {
  const { source, limit = 10, offset = 0 } = options;
  const dateRange = options.dateRange ? parseDateRange(options.dateRange) : undefined;
  const warnings: string[] = [];
  const errors: ArticleSearchError[] = [];

  let results: Article[];
  if (source) {
    results = await searchSingleSource(query, source, limit, offset, options.cursorMark, dateRange, warnings, errors);
  } else {
    results = await federatedSearch(query, limit, offset, dateRange, warnings, errors);
  }

  // Single-source LitSense never passes through dedup, so the relevance
  // floor (see dedup.ts) is applied here; federated mode already applied it.
  if (source === 'litsense') {
    const litsenseRows = results.filter(r => r.source === 'litsense');
    const aboveFloor = results.filter(isAboveLitsenseFloor);
    if (litsenseRows.length > 0 && aboveFloor.length === 0) {
      warnings.push(
        `all ${litsenseRows.length} litsense matches scored below the relevance floor ` +
        `(${LITSENSE_RELEVANCE_FLOOR}) and were dropped; the query probably has no topically related sentences in LitSense`
      );
    }
    results = aboveFloor;
  }

  await enrichLitSenseRows(results, warnings);

  const response: ArticleSearchResponse = { results };
  if (warnings.length > 0) response.warnings = warnings;
  if (errors.length > 0) response.errors = errors;
  return response;
}

/**
 * Legacy array-returning entry point kept for internal callers built
 * against the old contract (cross-entity federation); the tool layer and
 * new code use searchArticles for the full envelope.
 */
export async function articleSearch(
  query: string,
  options: ArticleSearchOptions = {}
): Promise<Article[]> {
  return (await searchArticles(query, options)).results;
}

async function federatedSearch(
  query: string,
  limit: number,
  offset: number,
  dateRange: ParsedDateRange | undefined,
  warnings: string[],
  errors: ArticleSearchError[]
): Promise<Article[]> {
  // Throw-on-timeout invariant: a hung backend must REJECT so Promise.allSettled
  // records it as an error result — a null would crash `allArticles.push(...null)`.
  // Signal-bearing leg form: when a leg loses the federated deadline race, the
  // signal aborts its in-flight request so the loser stops consuming its
  // connection's semaphore/rate slots instead of retrying in the background.
  // Partial-results semantics are unchanged — the timeout still REJECTS into
  // allSettled as an error result for the losing source.
  const pubmedOutcome: PubMedQueryOutcome = {};
  const leg = (label: string, work: (signal: AbortSignal) => Promise<Article[]>) => ({
    label,
    promise: withTimeout(work, FEDERATED_SEARCH_TIMEOUT_MS, { onTimeout: 'throw', label: `${label} search` }),
  });
  const legs = dateRange
    ? [
        leg('pubmed', (signal) => searchPubMed(query, limit, offset, dateRange, warnings, pubmedOutcome, signal)),
        leg('europepmc', (signal) => searchEuropePMC(query, limit, offset, undefined, dateRange, warnings, signal)),
        leg('semantic_scholar', (signal) => searchSemanticScholar(query, limit, offset, dateRange, signal)),
        leg('arxiv', (signal) => searchArxiv(query, limit, offset, dateRange, signal)),
      ]
    : [
        leg('pubmed', (signal) => searchPubMed(query, limit, offset, undefined, warnings, pubmedOutcome, signal)),
        leg('europepmc', (signal) => searchEuropePMC(query, limit, offset, undefined, undefined, warnings, signal)),
        leg('semantic_scholar', (signal) => searchSemanticScholar(query, limit, offset, undefined, signal)),
        leg('arxiv', (signal) => searchArxiv(query, limit, offset, undefined, signal)),
        leg('pubtator', (signal) => searchPubTator(query, limit, offset, signal)),
        leg('litsense', (signal) => searchLitSense(query, limit, offset, signal)),
      ];

  const settled = await Promise.allSettled(legs.map(l => l.promise));
  const allArticles: Article[] = [];
  // Per-leg rows that entered federation (post-own-filter, error rows split
  // out) — the "offered" side of the crowd-out accounting below.
  const offeredBySource = new Map<string, Article[]>();

  for (let i = 0; i < settled.length; i++) {
    const { label } = legs[i];
    const result = settled[i];
    if (result.status === 'fulfilled') {
      const real = splitErrorRows(result.value, label, errors);
      allArticles.push(...real);
      offeredBySource.set(label, real);
    } else {
      // withTimeout rejections are transient by nature; backend-promise
      // rejections should have been caught by the backend's own error row.
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({ source: label, message, retryable: true });
    }
  }

  // Gibberish guard (issue #78): PubMed's term translation is the closest
  // thing to a biomedical vocabulary arbiter — when it could not recognize
  // a single meaningful token of the query, the OTHER backends' matches on
  // leftover generic words are residue, not citations (live-verified:
  // "qqqzzz impossible term xyzzy" returns arXiv physics papers matching
  // "impossible"/"term"). Suppress the whole federated page and say so;
  // per-source failures still ride in `errors`, and single-source mode is
  // never affected (the caller explicitly picked that backend).
  if (pubmedOutcome.suppressedAsGibberish) {
    warnings.push(
      'federated results suppressed: no query term is recognized by PubMed\'s biomedical vocabulary, ' +
      'so other backends\' matches (e.g. arXiv word matches) would be unrelated noise. ' +
      'Reformulate the query with scientific terminology.'
    );
    return [];
  }

  // Warn only when the relevance floor (not dedup) emptied LitSense's
  // contribution: an above-floor litsense row whose PMID also came from
  // pubmed/europepmc merges into that record and legitimately disappears
  // from the page as a litsense-sourced row — that is NOT a floor drop.
  const litsenseRows = allArticles.filter(r => r.source === 'litsense');
  const belowFloor = litsenseRows.filter(r => !isAboveLitsenseFloor(r));
  if (litsenseRows.length > 0 && belowFloor.length === litsenseRows.length) {
    warnings.push(
      `all ${litsenseRows.length} litsense matches scored below the relevance floor ` +
      `(${LITSENSE_RELEVANCE_FLOOR}) and were dropped; the query probably has no topically related sentences in LitSense`
    );
  }

  const ranked = deduplicateAndRank(allArticles, limit);

  // Crowd-out disclosure (issue #134): ranking is citation-based, but only
  // europepmc/preprint/semantic_scholar populate cited_by — the zero-cited
  // legs tie at 0 and stable-sort keeps federation order, so with limit
  // applied post-dedup a matching secondary source can contribute ZERO rows
  // with no signal. A source is crowded out only when it offered rows that
  // entered the ranking competition (key-bearing and floor-surviving —
  // legs already date-post-filtered before returning, and floor-dropped
  // litsense noise has its own warning) yet NONE of its rows — and none of
  // their dedup-merged twins — appear on the final page. Twinned rows count
  // as represented because they share an identity key with the kept row.
  const finalKeySets = ranked.map(row => new Set(dedupKeys(row)));
  const crowdedOut: string[] = [];
  for (const [label, offered] of offeredBySource) {
    const competing = offered.filter(row => dedupKeys(row).length > 0 && isAboveLitsenseFloor(row));
    if (competing.length === 0) continue;
    const represented = competing.some(row =>
      dedupKeys(row).some(key => finalKeySets.some(keySet => keySet.has(key)))
    );
    if (!represented) crowdedOut.push(label);
  }
  if (crowdedOut.length > 0) {
    const names = crowdedOut.map(s => SOURCE_DISPLAY_NAMES[s] ?? s).join(', ');
    const ids = crowdedOut.map(s => `'${s}'`).join(', ');
    warnings.push(
      `${names} had matches but none made this page — ` +
      `query ${crowdedOut.length === 1 ? `source ${ids}` : `sources ${ids}`} directly if broader coverage is needed.`
    );
  }

  return ranked;
}

async function searchSingleSource(
  query: string,
  source: string,
  limit: number,
  offset: number,
  cursorMark: string | undefined,
  dateRange: ParsedDateRange | undefined,
  warnings: string[],
  errors: ArticleSearchError[]
): Promise<Article[]> {
  if (dateRange && (source === 'pubtator' || source === 'litsense')) {
    errors.push({
      source,
      message: `${source} does not support date filtering. Use pubmed, europepmc, semantic_scholar, preprint_only, or arxiv.`,
    });
    return [];
  }
  let rows: Article[];
  switch (source) {
    case 'pubmed': rows = await searchPubMed(query, limit, offset, dateRange, warnings); break;
    case 'europepmc': rows = await searchEuropePMC(query, limit, offset, cursorMark, dateRange, warnings); break;
    case 'semantic_scholar': rows = await searchSemanticScholar(query, limit, offset, dateRange); break;
    case 'pubtator': rows = await searchPubTator(query, limit, offset); break;
    case 'litsense': rows = await searchLitSense(query, limit, offset); break;
    // Preprint-only mode: bioRxiv + medRxiv via Europe PMC's PPR index.
    // Deliberately NOT part of the default federated fan-out — preprints
    // are only returned when explicitly requested.
    case 'preprint_only': rows = await searchPreprints(query, limit, offset, cursorMark, dateRange); break;
    case 'arxiv': rows = await searchArxiv(query, limit, offset, dateRange); break;
    default: return [];
  }
  return splitErrorRows(rows, source, errors);
}
